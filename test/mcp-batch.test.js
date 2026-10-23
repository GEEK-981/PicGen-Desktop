const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { McpHttpServer } = require('../mcpServer');
const { createMcpBridge } = require('../mcpBridge');
const { McpDailyQuota } = require('../mcpQuota');
const { McpIdempotencyStore } = require('../mcpIdempotency');

const TOKEN = 'a'.repeat(64);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64');

async function tempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'picgen-batch-'));
}

// A queue and a /api/tasks/batch route good enough to submit to and wait on.
function fakeApp({ rejectPrompt = null, routing = { strategy: 'priority' } } = {}) {
    const tasks = new Map();
    const posts = [];
    let seq = 0;
    const original = global.fetch;
    global.fetch = async (url, options = {}) => {
        if (String(url).includes('/api/providers/failover')) return { ok: true, status: 200, json: async () => routing };
        if (!String(url).includes('/api/tasks/batch')) return original(url, options);
        const body = JSON.parse(options.body);
        posts.push(body);
        if (rejectPrompt && body.prompt.includes(rejectPrompt)) return { ok: false, status: 400, json: async () => ({ error: '上游拒绝' }) };
        const taskIds = Array.from({ length: body.count }, () => `t${++seq}`);
        for (const id of taskIds) tasks.set(id, { id, status: 'pending', prompt: body.prompt, sequenceId: body.sequenceId, providerId: body.providerId, model: body.model, createdAt: Date.now() });
        return { ok: true, status: 200, json: async () => ({ taskIds }) };
    };
    return { tasks, posts, restore: () => { global.fetch = original; } };
}

async function deps(app, overrides = {}) {
    const dir = await tempDir();
    const imagePath = path.join(dir, 'ref.png');
    await fs.writeFile(imagePath, PNG);
    const providers = [
        { id: 'g1', name: '香蕉站', enabled: true, baseUrl: 'https://a.test', apiKey: 'k1', models: ['gemini-3-pro-image-preview'] },
        { id: 'g2', name: 'GPT 站', enabled: true, baseUrl: 'https://b.test', apiKey: 'k2', models: ['gpt-image-1'] },
        { id: 'g3', name: '停用站', enabled: false, baseUrl: 'https://c.test', apiKey: 'k3', models: ['grok-imagine-image'] },
        { id: 'g4', name: '没填 Key', enabled: true, baseUrl: 'https://d.test', apiKey: '', models: ['seedream-4-0'] }
    ];
    return {
        imagePath,
        value: {
            version: '9.9.9',
            serverUrl: 'http://127.0.0.1:9',
            runtime: {
                providerStore: { list: async () => providers },
                unifiedProviderStore: { list: async () => [] },
                taskQueue: {
                    getTask: id => app.tasks.get(id) || null,
                    listTasks: () => [...app.tasks.values()],
                    cancelBySequence: sequenceId => [...app.tasks.values()].filter(task => task.sequenceId === sequenceId).length
                }
            },
            imageProfiles: require('../imageApiProfiles'),
            quota: overrides.quota || new McpDailyQuota({ filePath: path.join(dir, 'mcp-usage.json') }),
            idempotency: overrides.idempotency || new McpIdempotencyStore({ filePath: path.join(dir, 'mcp-idempotency.json') }),
            getDailyLimit: async () => overrides.limit || 0,
            listHistory: async () => [{ id: 'h1', filePath: imagePath }],
            downscale: async buffer => ({ buffer, mimeType: 'image/png' }),
            renderer: {
                listSequences: async () => [{ id: 'seq1', name: '序列1', prompt: '', providerId: 'g1', model: 'gemini-3-pro-image-preview', ratio: '3:4', imageSize: '2K', count: '1', references: [], advanced: { temperature: '0.5' }, current: true }],
                mutateSequence: async () => ({})
            }
        }
    };
}

async function session(server, clientName = 'test-agent') {
    const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: clientName, version: '1' } } })
    });
    return { id: response.headers.get('mcp-session-id'), init: await response.json() };
}

async function call(server, sessionId, name, args) {
    const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'Mcp-Session-Id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
    });
    const result = (await response.json()).result;
    const text = result.content.find(item => item.type === 'text')?.text || '';
    return { isError: result.isError === true, data: result.isError ? text : JSON.parse(text), content: result.content };
}

async function withServer(depsValue, run) {
    const server = new McpHttpServer({ api: createMcpBridge(depsValue), port: 0, token: TOKEN });
    await server.start();
    try { return await run(server); } finally { await server.close(); }
}

test('the handshake tells an agent how to work with PicGen', async () => {
    const app = fakeApp();
    try {
        const { value } = await deps(app);
        await withServer(value, async server => {
            const { init } = await session(server);
            assert.match(init.result.instructions, /picgen_generate_batch/);
            assert.match(init.result.instructions, /picgen_wait_tasks/);
        });
    } finally { app.restore(); }
});

test('a batch submits every item at once and fills gaps from the active sequence', async () => {
    const app = fakeApp();
    try {
        const { value, imagePath } = await deps(app);
        await withServer(value, async server => {
            const { id } = await session(server, 'Claude Code');
            const { isError, data } = await call(server, id, 'picgen_generate_batch', {
                items: [
                    { prompt: '一只橘猫', count: 2 },
                    { prompt: '一只柴犬', model: 'gpt-image-1', ratio: '1536x1024', references: [{ filePath: imagePath }, { historyId: 'h1' }], advanced: { quality: 'high', gptQuality: 'high' } }
                ]
            });
            assert.equal(isError, false, data);
            assert.equal(app.posts.length, 2);
            const [cat, dog] = app.posts;
            assert.equal(cat.providerId, 'g1', 'no model given: the active sequence decides');
            assert.equal(cat.model, 'gemini-3-pro-image-preview');
            assert.equal(cat.ratio, '3:4');
            assert.equal(cat.imageSize, '2K');
            assert.equal(cat.generationConfig.temperature, 0.5, 'the active sequence settings apply');
            assert.equal(dog.providerId, 'g2', 'a model picks an enabled group that offers it');
            assert.equal(dog.ratio, '1536x1024');
            assert.equal(dog.referenceImages.length, 2);
            assert.equal(dog.generationConfig.gptQuality, 'high');
            assert.equal('temperature' in dog.generationConfig, false, 'the sequence settings never leak into another model');
            for (const body of app.posts) {
                assert.equal(body.sequenceId, 'agent:Claude Code');
                assert.equal(body.sequenceName, 'Agent · Claude Code');
            }
            assert.equal(data.totalImages, 3);
            assert.deepEqual(data.items.map(item => item.taskIds.length), [2, 1]);
            assert.deepEqual(data.taskIds, ['t1', 't2', 't3'].filter(idValue => data.taskIds.includes(idValue)));
        });
    } finally { app.restore(); }
});

test('a batch with one bad item submits nothing and names the item', async () => {
    const app = fakeApp();
    try {
        const { value } = await deps(app);
        await withServer(value, async server => {
            const { id } = await session(server);
            for (const [items, pattern] of [
                [[{ prompt: '好' }, { prompt: '  ' }], /第 2 项.*提示词/],
                [[{ prompt: '好', model: 'grok-imagine-image' }], /第 1 项.*grok-imagine-image/],
                [[{ prompt: '好', groupId: 'g3' }], /第 1 项.*停用/],
                [[{ prompt: '好', ratio: '7:1' }], /第 1 项.*7:1/],
                [[{ prompt: '好', count: 0 }], /第 1 项.*张数/],
                [[{ prompt: '好', references: [{ base64: Buffer.from('not an image').toString('base64') }] }], /第 1 项.*不是图片/]
            ]) {
                const { isError, data } = await call(server, id, 'picgen_generate_batch', { items });
                assert.equal(isError, true);
                assert.match(data, pattern);
            }
            assert.equal(app.posts.length, 0);
        });
    } finally { app.restore(); }
});

test('the daily limit refuses a batch that would pass it and counts what went through', async () => {
    const app = fakeApp();
    try {
        const { value } = await deps(app, { limit: 3 });
        await withServer(value, async server => {
            const { id } = await session(server);
            const refused = await call(server, id, 'picgen_generate_batch', { items: [{ prompt: '甲', count: 2 }, { prompt: '乙', count: 2 }] });
            assert.equal(refused.isError, true);
            assert.match(refused.data, /还剩 3 张/);
            assert.equal(app.posts.length, 0);
            const accepted = await call(server, id, 'picgen_generate_batch', { items: [{ prompt: '甲', count: 3 }] });
            assert.equal(accepted.data.quota.remaining, 0);
            const single = await call(server, id, 'picgen_generate', { prompt: '丙' });
            assert.equal(single.isError, true, 'the sequence tool shares the same limit');
            assert.match(single.data, /每日上限/);
        });
    } finally { app.restore(); }
});

test('a rejected item gives its images back to the quota', async () => {
    const app = fakeApp({ rejectPrompt: '违规' });
    try {
        const { value } = await deps(app, { limit: 10 });
        await withServer(value, async server => {
            const { id } = await session(server);
            const { data } = await call(server, id, 'picgen_generate_batch', { items: [{ prompt: '正常', count: 2 }, { prompt: '违规内容', count: 3 }] });
            assert.equal(data.items[1].error, '上游拒绝');
            assert.equal(data.items[1].submitted, false);
            assert.equal(data.quota.used, 2);
        });
    } finally { app.restore(); }
});

test('repeating an idempotency key replays the first result instead of paying twice', async () => {
    const app = fakeApp();
    try {
        const { value } = await deps(app);
        await withServer(value, async server => {
            const { id } = await session(server);
            const request = { idempotencyKey: 'job-42', items: [{ prompt: '甲', count: 2 }] };
            const [first, second] = await Promise.all([call(server, id, 'picgen_generate_batch', request), call(server, id, 'picgen_generate_batch', request)]);
            assert.equal(app.posts.length, 1);
            assert.deepEqual(second.data.taskIds, first.data.taskIds);
            const third = await call(server, id, 'picgen_generate_batch', request);
            assert.equal(third.data.replayed, true);
        });
    } finally { app.restore(); }
});

test('waiting returns as soon as every task ends, with paths and optional previews', async () => {
    const app = fakeApp();
    try {
        const { value, imagePath } = await deps(app);
        await withServer(value, async server => {
            const { id } = await session(server);
            const { data } = await call(server, id, 'picgen_generate_batch', { items: [{ prompt: '甲', count: 2 }] });
            setTimeout(() => {
                app.tasks.get(data.taskIds[0]).status = 'completed';
                app.tasks.get(data.taskIds[0]).result = { filePath: imagePath };
                app.tasks.get(data.taskIds[1]).status = 'failed';
                app.tasks.get(data.taskIds[1]).error = '429 Too Many Requests';
            }, 300);
            const started = Date.now();
            const waited = await call(server, id, 'picgen_wait_tasks', { taskIds: data.taskIds, timeoutSeconds: 10, includeImages: true });
            assert.ok(Date.now() - started < 3000, 'returns when done, not at the timeout');
            assert.equal(waited.data.done, true);
            assert.equal(waited.data.tasks[0].filePath, imagePath);
            assert.equal(waited.data.tasks[1].error, '429 Too Many Requests');
            assert.equal(waited.content.filter(item => item.type === 'image').length, 1);
        });
    } finally { app.restore(); }
});

test('waiting past the timeout reports what is still running', async () => {
    const app = fakeApp();
    try {
        const { value } = await deps(app);
        await withServer(value, async server => {
            const { id } = await session(server);
            const { data } = await call(server, id, 'picgen_generate_batch', { items: [{ prompt: '甲' }] });
            const waited = await call(server, id, 'picgen_wait_tasks', { taskIds: [...data.taskIds, 'nope'], timeoutSeconds: 1 });
            assert.equal(waited.data.done, false);
            assert.deepEqual(waited.data.pending, data.taskIds);
            assert.equal(waited.data.tasks.find(task => task.taskId === 'nope').status, 'unknown');
            assert.deepEqual(waited.data.unknown, ['nope'], 'a typo or an expired id is not a finished task');
        });
    } finally { app.restore(); }
});

test('an agent can cancel everything it submitted', async () => {
    const app = fakeApp();
    try {
        const { value } = await deps(app);
        await withServer(value, async server => {
            const { id } = await session(server, 'Cursor');
            await call(server, id, 'picgen_generate_batch', { items: [{ prompt: '甲', count: 3 }] });
            const { data } = await call(server, id, 'picgen_cancel_my_tasks', {});
            assert.equal(data.cancelled, 3);
        });
    } finally { app.restore(); }
});

test('an idempotency key outlives an MCP restart and refuses a different request', async () => {
    const app = fakeApp();
    try {
        const dir = await tempDir();
        const filePath = path.join(dir, 'mcp-idempotency.json');
        const first = await deps(app, { idempotency: new McpIdempotencyStore({ filePath }) });
        const request = { idempotencyKey: 'job-7', items: [{ prompt: '甲', count: 2 }] };
        const original = await withServer(first.value, async server => call(server, (await session(server)).id, 'picgen_generate_batch', request));
        // A token reset or app restart builds a new bridge and a new store instance.
        const second = await deps(app, { idempotency: new McpIdempotencyStore({ filePath }) });
        await withServer(second.value, async server => {
            const { id } = await session(server);
            const replay = await call(server, id, 'picgen_generate_batch', request);
            assert.equal(replay.data.replayed, true);
            assert.deepEqual(replay.data.taskIds, original.data.taskIds);
            const changed = await call(server, id, 'picgen_generate_batch', { idempotencyKey: 'job-7', items: [{ prompt: '乙' }] });
            assert.equal(changed.isError, true);
            assert.match(changed.data, /idempotencyKey/);
        });
        assert.equal(app.posts.length, 1);
    } finally { app.restore(); }
});

test('a bookkeeping failure after queuing still returns the task ids', async () => {
    const app = fakeApp({ rejectPrompt: '违规' });
    try {
        const dir = await tempDir();
        const quota = new McpDailyQuota({ filePath: path.join(dir, 'mcp-usage.json') });
        quota.refund = async () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); };
        const { value } = await deps(app, { quota });
        await withServer(value, async server => {
            const { id } = await session(server);
            const request = { idempotencyKey: 'job-9', items: [{ prompt: '正常', count: 2 }, { prompt: '违规' }] };
            const result = await call(server, id, 'picgen_generate_batch', request);
            assert.equal(result.isError, false, result.data);
            assert.equal(result.data.items[0].taskIds.length, 2);
            const again = await call(server, id, 'picgen_generate_batch', request);
            assert.equal(again.data.replayed, true, 'the key still guards the queued half');
            assert.equal(app.posts.length, 2);
        });
    } finally { app.restore(); }
});

test('fixed routing keeps agents on the pinned group and reports what really runs', async () => {
    const app = fakeApp({ routing: { strategy: 'fixed', selectedProviderId: 'g2' } });
    try {
        const { value } = await deps(app);
        await withServer(value, async server => {
            const { id } = await session(server);
            const models = await call(server, id, 'picgen_list_models', {});
            assert.deepEqual(models.data.map(model => model.providerId), ['g2']);
            const refused = await call(server, id, 'picgen_generate_batch', { items: [{ prompt: '甲', model: 'gemini-3-pro-image-preview' }] });
            assert.equal(refused.isError, true);
            assert.match(refused.data, /GPT 站/);
            const other = await call(server, id, 'picgen_generate_batch', { items: [{ prompt: '甲', groupId: 'g1' }] });
            assert.match(other.data, /GPT 站/);
            const fallback = await call(server, id, 'picgen_generate_batch', { items: [{ prompt: '甲' }] });
            assert.equal(fallback.isError, false, fallback.data);
            assert.equal(fallback.data.items[0].model, 'gpt-image-1', 'the active Gemini sequence does not apply to the pinned GPT group');
            assert.equal(fallback.data.items[0].groupId, 'g2');
            assert.equal(app.posts[0].ratio, 'auto', 'ratio checked against the model that really runs');
        });
    } finally { app.restore(); }
});

test('a group without an API key is refused before it is queued', async () => {
    const app = fakeApp();
    try {
        const { value } = await deps(app);
        await withServer(value, async server => {
            const { id } = await session(server);
            const result = await call(server, id, 'picgen_generate_batch', { items: [{ prompt: '甲', model: 'seedream-4-0' }] });
            assert.equal(result.isError, true);
            assert.match(result.data, /API Key/);
            assert.equal(app.posts.length, 0);
        });
    } finally { app.restore(); }
});

test('item advanced settings add to the defaults instead of replacing them', async () => {
    const app = fakeApp();
    try {
        const { value } = await deps(app);
        await withServer(value, async server => {
            const { id } = await session(server);
            await call(server, id, 'picgen_generate_batch', { defaults: { model: 'gpt-image-1', advanced: { gptQuality: 'high' } }, items: [{ prompt: '甲', advanced: { gptBackground: 'transparent' } }] });
            assert.equal(app.posts[0].generationConfig.gptQuality, 'high');
            assert.equal(app.posts[0].generationConfig.gptBackground, 'transparent');
        });
    } finally { app.restore(); }
});

test('an unconfirmed submit never suggests sending again', async () => {
    const app = fakeApp();
    try {
        const { value } = await deps(app);
        const original = global.fetch;
        global.fetch = async (url, options) => String(url).includes('/api/tasks/batch') ? Promise.reject(new Error('socket hang up')) : original(url, options);
        await withServer(value, async server => {
            const { id } = await session(server);
            const result = await call(server, id, 'picgen_generate_batch', { items: [{ prompt: '甲', model: 'gpt-image-1' }] });
            assert.equal(result.data.items[0].submitted, 'unknown');
            assert.match(result.data.items[0].error, /不要重发/);
            assert.doesNotMatch(result.data.items[0].error, /idempotencyKey 重发/);
            assert.match(result.data.items[0].error, /agent:test-agent/);
        });
        global.fetch = original;
    } finally { app.restore(); }
});
