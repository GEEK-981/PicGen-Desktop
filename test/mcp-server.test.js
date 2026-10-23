const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');

const { McpConfigStore, DEFAULT_MCP_PORT } = require('../mcpConfig');
const { McpHttpServer, PROTOCOL_VERSION } = require('../mcpServer');
const { createMcpBridge } = require('../mcpBridge');

async function tempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'picgen-mcp-'));
}

const TOKEN = 'a'.repeat(64);
// A real 8x8 PNG: file tools only accept bytes that are an image by their header.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64');

test('mcp config defaults to disabled and round-trips the switch', async () => {
    const dir = await tempDir();
    const store = new McpConfigStore({ filePath: path.join(dir, 'mcp-config.json') });
    const initial = await store.get();
    assert.equal(initial.enabled, false);
    assert.equal(initial.port, DEFAULT_MCP_PORT);
    assert.match(initial.token, /^[0-9a-f]{64}$/);
    assert.equal((await store.update({ enabled: true })).enabled, true);
    const reloaded = await new McpConfigStore({ filePath: store.filePath }).get();
    assert.equal(reloaded.enabled, true);
    assert.equal(reloaded.token, initial.token, 'the token survives a restart');
    assert.equal((await store.update({ enabled: 'yes' })).enabled, false);
});

test('mcp config keeps a valid port and can issue a new token', async () => {
    const dir = await tempDir();
    const store = new McpConfigStore({ filePath: path.join(dir, 'mcp-config.json') });
    const { token } = await store.get();
    assert.equal((await store.update({ port: 51234 })).port, 51234);
    assert.equal((await store.update({ port: 80 })).port, 51234, 'privileged or invalid ports are ignored');
    assert.equal((await store.update({ port: 'x' })).port, 51234);
    const rotated = await store.update({ regenerateToken: true });
    assert.notEqual(rotated.token, token);
    assert.match(rotated.token, /^[0-9a-f]{64}$/);
});

test('mcp server refuses requests without the token, from a browser origin, or for a foreign host', async () => {
    const server = new McpHttpServer({ api: createMcpBridge(bridgeDeps()), port: 0, token: TOKEN });
    await server.start();
    try {
        const body = { jsonrpc: '2.0', id: 1, method: 'initialize' };
        assert.equal((await post(server, body, null, { token: null })).status, 401);
        assert.equal((await post(server, body, null, { token: 'b'.repeat(64) })).status, 401);
        const fromPage = await post(server, body, null, { headers: { Origin: 'https://evil.example' } });
        assert.equal(fromPage.status, 403);
        assert.equal(fromPage.headers.get('access-control-allow-origin'), null);
        const preflight = await fetch(server.url, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
        assert.equal(preflight.headers.get('access-control-allow-origin'), null);
        assert.equal(await rawStatus(server, { Host: `evil.example:${server.port}`, Authorization: `Bearer ${TOKEN}` }), 403);
        assert.equal((await post(server, body)).status, 200);
    } finally {
        await server.close();
    }
});

test('mcp server keeps its preferred port and falls back only when it is taken', async () => {
    const first = new McpHttpServer({ api: createMcpBridge(bridgeDeps()), port: 0, token: TOKEN });
    await first.start();
    const second = new McpHttpServer({ api: createMcpBridge(bridgeDeps()), port: first.port, token: TOKEN });
    try {
        await second.start();
        assert.notEqual(second.port, first.port);
        assert.equal(second.portFallback, true);
        const port = first.port;
        await first.close();
        const third = new McpHttpServer({ api: createMcpBridge(bridgeDeps()), port, token: TOKEN });
        await third.start();
        assert.equal(third.port, port);
        assert.equal(third.portFallback, false);
        await third.close();
    } finally {
        await second.close();
    }
});

// The fake runtime below is shaped by hand, so it once hid a bridge that read
// members the real server never exported. Check the bridge against the real one.
test('mcp bridge only uses runtime members the real server exports', async () => {
    const { createServerApp } = require('../server');
    const dir = await tempDir();
    const file = name => path.join(dir, name);
    const runtime = createServerApp({
        providerStoreFile: file('api-providers.json'),
        chatProviderStoreFile: file('chat-providers.json'),
        unifiedProviderStoreFile: file('providers.json'),
        failoverConfigFile: file('failover-config.json'),
        proxyConfigFile: file('proxy-config.json'),
        mcpConfigFile: file('mcp-config.json')
    });
    try {
        const source = await fs.readFile(path.join(__dirname, '..', 'mcpBridge.js'), 'utf8');
        const used = [...new Set([...source.matchAll(/deps\.runtime\.(\w+)/g)].map(match => match[1]))];
        assert.ok(used.length > 0);
        assert.deepEqual(used.filter(name => !(name in runtime)), []);
    } finally {
        runtime.close();
    }
});

function fakeRuntime() {
    const tasks = new Map();
    return {
        url: 'http://127.0.0.1:9',
        providerStore: { list: async () => [{ id: 'g1', name: '生图', enabled: true, models: ['gemini-test'], baseUrl: 'https://example.test', apiKey: 'sk-test' }], get: async id => id === 'g1' ? { id, models: ['gemini-test'], baseUrl: 'https://example.test', apiKey: 'sk-test' } : null },
        chatProviderStore: { list: async () => [{ id: 'c1', name: '对话', enabled: true, model: 'chat-test', baseUrl: 'https://chat.test', apiKey: 'sk-chat' }], get: async id => id === 'c1' ? { id, model: 'chat-test' } : null },
        unifiedProviderStore: { list: async () => [{ id: 's1', name: '供应商', baseUrl: 'https://example.test', groups: [{ id: 'g1', name: '生图', role: 'image', models: ['gemini-test'], apiKey: 'sk-test', enabled: true }, { id: 'c1', name: '对话', role: 'chat', models: ['chat-test'], apiKey: 'sk-chat' }] }] },
        proxyConfigStore: { config: { mode: 'direct', customProxy: '' }, get: async function () { return this.config; }, update: async function (updates) { if (updates.mode === 'custom' && !updates.customProxy) throw new Error('需要代理地址'); this.config = { ...this.config, ...updates }; return this.config; } },
        providerManager: { getHealthRatings: () => [{ id: 'g1', rating: 'available' }], resetProvider() {}, resetAll() {} },
        taskQueue: {
            listTasks: () => [...tasks.values()],
            getTask: id => tasks.get(id) || null,
            cancel: id => tasks.delete(id),
            cancelBySequence: () => 2
        },
        tasks
    };
}

function bridgeDeps(overrides = {}) {
    const runtime = overrides.runtime || fakeRuntime();
    const sequences = overrides.sequences || [{ id: 'seq1', name: '序列1', prompt: '一只猫', providerId: 'g1', model: 'gemini-test', ratio: '1:1', count: '1', imageSize: '1K', references: [], current: true }];
    return {
        version: '2.3.19',
        mcpUrl: 'http://127.0.0.1:1234/mcp',
        serverUrl: 'http://127.0.0.1:9',
        runtime,
        imageProfiles: { getImageApiProfile: () => ({ dimensionOptions: ['1:1'], imageSizeOptions: ['1K'], maxReferences: 4 }) },
        testImage: async () => ({ success: true, latencyMs: 5 }),
        testChat: async () => ({ success: true }),
        discover: async () => ({ models: ['gemini-test'] }),
        testProxy: async () => ({ ok: true }),
        getOutputDirectory: async () => ({ effectiveDirectory: 'D:/out', isDefault: true }),
        setOutputDirectory: async directory => ({ effectiveDirectory: directory || 'D:/default' }),
        openOutputFolder: async () => ({ filePath: 'D:/out' }),
        listHistory: async () => [{ id: 'h1', fileName: 'cat.png', filePath: overrides.imagePath, mimeType: 'image/png', prompt: '一只猫', model: 'gemini-test', createdAt: 1 }],
        listRecycleBin: async () => ({ items: [], total: 0 }),
        trashImages: async payload => ({ trashed: payload.items.length }),
        restoreImages: async () => ({ restored: 1 }),
        purgeImages: async () => ({ purged: 1 }),
        findSimilar: async () => ({ items: [] }),
        findSimilarByImage: async () => ({ items: [] }),
        similarityGroups: async () => ({ groups: [] }),
        copyImage: async () => ({ copied: true }),
        saveImageCopy: async (_source, destination) => ({ saved: true, filePath: destination }),
        saveReference: async payload => ({ id: 'ref1', filePath: 'D:/ref.png', mimeType: payload.mimeType, name: payload.name }),
        listErrors: async () => [],
        clearErrors: async () => ({ removed: 3 }),
        downscale: async buffer => ({ buffer, mimeType: 'image/png' }),
        renderer: {
            listSequences: async () => sequences,
            mutateSequence: async request => request.action === 'generation-settings'
                ? { imageSize: '1K', generationConfig: { openAIModeration: 'low' } }
                : { action: request.action, id: request.sequenceId || 'seq-new' }
        },
        optimize: async () => '优化后的提示词',
        reverse: async () => '反推出的提示词',
        ...overrides
    };
}

test('mcp handshake exposes the tool list and rejects an unknown tool', async () => {
    const server = new McpHttpServer({ api: createMcpBridge(bridgeDeps()), port: 0, token: TOKEN });
    await server.start();
    try {
        const init = await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        assert.equal(init.body.result.protocolVersion, PROTOCOL_VERSION);
        const session = init.session;
        assert.match(session || '', /^[0-9a-f]{32}$/, 'the session id travels in the Mcp-Session-Id header');
        assert.equal('sessionId' in init.body, false, 'nothing outside JSON-RPC in the reply body');
        const listed = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
        assert.ok(listed.body.result.tools.some(tool => tool.name === 'picgen_generate'));
        const missing = await post(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } }, session);
        assert.equal(missing.body.error.code, -32602);
    } finally {
        await server.close();
    }
});

// Stands in for the local REST routes the bridge calls (settings page routes).
function fakeLocalApi() {
    const original = global.fetch;
    const calls = [];
    let routing = { strategy: 'order', maxGlobalConcurrent: 12 };
    global.fetch = async (url, options = {}) => {
        const pathname = new URL(String(url)).pathname;
        if (!pathname.startsWith('/api/providers/')) return original(url, options);
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ method: options.method || 'GET', pathname, body });
        const reply = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
        if (pathname === '/api/providers/failover' && body) {
            if (body.strategy === 'fixed' && !body.selectedProviderId) return reply(400, { error: '请选择一个已启用的生图配置组' });
            routing = { ...routing, ...body };
            return reply(200, { success: true, config: routing });
        }
        if (pathname === '/api/providers/failover') return reply(200, routing);
        if (pathname === '/api/providers/proxy') return reply(200, { success: true, config: { mode: body.mode, customProxy: body.customProxy || '' } });
        return reply(404, { error: 'not found' });
    };
    return { calls, restore: () => { global.fetch = original; } };
}

test('mcp tools read status, switch routing, and refuse a missing directory', async () => {
    const deps = bridgeDeps();
    const local = fakeLocalApi();
    const server = new McpHttpServer({ api: createMcpBridge(deps), port: 0, token: TOKEN });
    await server.start();
    try {
        const session = (await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize' })).session;
        const status = await call(server, session, 'picgen_status', {});
        assert.equal(status.version, '2.3.19');
        assert.equal(status.supplierCount, 1);
        const routing = await call(server, session, 'picgen_set_routing', { strategy: 'price' });
        assert.equal(routing.strategy, 'price');
        assert.equal((await call(server, session, 'picgen_get_routing', {})).strategy, 'price');
        assert.match(await call(server, session, 'picgen_set_routing', { strategy: 'fixed' }), /已启用的生图配置组/, 'the REST validation reaches the agent');
        const proxy = await call(server, session, 'picgen_set_proxy', { mode: 'system' });
        assert.equal(proxy.mode, 'system');
        assert.ok(local.calls.some(item => item.method === 'POST' && item.pathname === '/api/providers/proxy'), 'proxy goes through the route that also updates Chromium');
        const suppliers = await call(server, session, 'picgen_list_suppliers', {});
        assert.equal(suppliers[0].groups[0].hasApiKey, true);
        assert.equal('apiKey' in suppliers[0].groups[0], false);
        const refused = await call(server, session, 'picgen_set_output_directory', { directory: path.join(os.tmpdir(), 'picgen-missing-dir') });
        assert.match(refused, /目录不存在/);
    } finally {
        local.restore();
        await server.close();
    }
});

test('mcp generate submits the current sequence and reports a missing prompt', async () => {
    let submitted = null;
    const original = global.fetch;
    global.fetch = async (url, options) => {
        if (!String(url).includes('/api/tasks/batch')) return original(url, options);
        submitted = JSON.parse(options.body);
        return { ok: true, json: async () => ({ taskIds: ['t1'] }) };
    };
    const deps = bridgeDeps();
    const server = new McpHttpServer({ api: createMcpBridge(deps), port: 0, token: TOKEN });
    await server.start();
    try {
        const session = (await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize' })).session;
        const queued = await call(server, session, 'picgen_generate', { count: 2 });
        assert.deepEqual(queued.taskIds, ['t1']);
        assert.equal(submitted.prompt, '一只猫');
        assert.equal(submitted.count, 2);
        assert.equal(submitted.model, 'gemini-test');
        assert.equal(submitted.imageSize, '1K', 'the size the UI would send for this model');
        assert.deepEqual(submitted.generationConfig, { openAIModeration: 'low' }, 'settings built by the UI, not a copied key list');
        deps.renderer.listSequences = async () => [{ id: 'seq1', prompt: '   ', references: [], current: true }];
        const refused = await call(server, session, 'picgen_generate', {});
        assert.match(refused, /没有提示词/);
    } finally {
        global.fetch = original;
        await server.close();
    }
});

test('mcp generate resolves @ mentions like the UI and refuses what the UI refuses', async () => {
    const dir = await tempDir();
    const imagePath = path.join(dir, 'cat.png');
    await fs.writeFile(imagePath, PNG);
    let submitted = null;
    const original = global.fetch;
    global.fetch = async (url, options) => {
        if (!String(url).includes('/api/tasks/batch')) return original(url, options);
        submitted = JSON.parse(options.body);
        return { ok: true, json: async () => ({ taskIds: ['t1'] }) };
    };
    const sequence = { id: 'seq1', name: '序列1', prompt: '把 @{橘猫} 放进客厅', providerId: 'g1', model: 'gemini-test', ratio: '1:1', count: '1', imageSize: '1K', references: [{ id: 'r1', alias: '橘猫', filePath: imagePath, mimeType: 'image/png' }], current: true };
    const deps = bridgeDeps({ sequences: [sequence] });
    const server = new McpHttpServer({ api: createMcpBridge(deps), port: 0, token: TOKEN });
    await server.start();
    try {
        const session = (await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize' })).session;
        await call(server, session, 'picgen_generate', {});
        assert.equal(submitted.prompt, '把 参考图1 放进客厅');
        assert.equal(submitted.referenceImages.length, 1);
        submitted = null;
        assert.match(await call(server, session, 'picgen_generate', { prompt: '把 @{} 放大' }), /空 @/);
        sequence.providerId = 'missing';
        assert.match(await call(server, session, 'picgen_generate', {}), /配置组/);
        sequence.providerId = 'g1';
        sequence.references = [{ id: 'r1', alias: '橘猫', mimeType: 'image/png' }];
        assert.match(await call(server, session, 'picgen_generate', {}), /参考图/, 'a reference without a file must not shift the @ numbering');
        assert.equal(submitted, null);
    } finally {
        global.fetch = original;
        await server.close();
    }
});

test('mcp history tools resolve an image and trash by id', async () => {
    const dir = await tempDir();
    const imagePath = path.join(dir, 'cat.png');
    await fs.writeFile(imagePath, PNG);
    let trashed = null;
    const deps = bridgeDeps({ imagePath, trashImages: async payload => { trashed = payload; return { trashed: payload.items.length }; } });
    const server = new McpHttpServer({ api: createMcpBridge(deps), port: 0, token: TOKEN });
    await server.start();
    try {
        const session = (await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize' })).session;
        const history = await call(server, session, 'picgen_list_history', { query: '猫' });
        assert.equal(history.total, 1);
        const image = await callRaw(server, session, 'picgen_get_image', { historyId: 'h1', maxEdge: 0 });
        assert.equal(image.content[0].type, 'image');
        assert.equal(image.content[0].mimeType, 'image/png');
        const removed = await call(server, session, 'picgen_trash_images', { historyIds: ['h1'], confirmProtected: true });
        assert.equal(removed.trashed, 1);
        assert.equal(trashed.confirmProtected, true);
        const unknown = await call(server, session, 'picgen_trash_images', { historyIds: ['missing'] });
        assert.match(unknown, /没有/);
    } finally {
        await server.close();
    }
});

test('mcp file tools only take real images, save under an image extension, and never overwrite', async () => {
    const dir = await tempDir();
    const imagePath = path.join(dir, 'cat.png');
    const secretPath = path.join(dir, 'id_rsa');
    await fs.writeFile(imagePath, PNG);
    await fs.writeFile(secretPath, '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n');
    let savedReference = null;
    const deps = bridgeDeps({
        imagePath,
        saveImageCopy: async (source, destination) => { await fs.copyFile(source, destination); return { saved: true, filePath: destination }; },
        saveReference: async payload => { savedReference = payload; return { id: 'ref1', filePath: imagePath, mimeType: payload.mimeType, name: payload.name }; }
    });
    const server = new McpHttpServer({ api: createMcpBridge(deps), port: 0, token: TOKEN });
    await server.start();
    try {
        const session = (await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize' })).session;
        assert.match(await call(server, session, 'picgen_get_image', { filePath: secretPath, maxEdge: 0 }), /不是图片/);
        assert.match(await call(server, session, 'picgen_copy_image', { filePath: secretPath }), /不是图片/);
        assert.match(await call(server, session, 'picgen_add_reference', { filePath: secretPath }), /不是图片/);
        assert.match(await call(server, session, 'picgen_add_reference', { base64: Buffer.from('@echo off\r\ncalc').toString('base64') }), /不是图片/);
        assert.equal(savedReference, null, 'nothing that is not an image reaches the reference cache');
        assert.match(await call(server, session, 'picgen_find_similar', { filePath: secretPath }), /不是图片/);
        assert.match(await call(server, session, 'picgen_save_image_as', { filePath: secretPath, destination: path.join(dir, 'out.png') }), /不是图片/);

        const startup = path.join(dir, 'Startup', 'run.cmd');
        const first = await call(server, session, 'picgen_save_image_as', { filePath: imagePath, destination: startup });
        assert.equal(first.filePath, path.join(dir, 'Startup', 'run.png'), 'the extension follows the file header');
        const kept = path.join(dir, 'keep.png');
        await fs.writeFile(kept, 'do not overwrite');
        const second = await call(server, session, 'picgen_save_image_as', { filePath: imagePath, destination: kept });
        assert.equal(second.filePath, path.join(dir, 'keep-1.png'));
        assert.equal(await fs.readFile(kept, 'utf8'), 'do not overwrite');
        assert.match(await call(server, session, 'picgen_save_image_as', { filePath: imagePath, destination: '' }), /destination/);
        assert.match(await call(server, session, 'picgen_save_image_as', { filePath: imagePath, destination: 'relative.png' }), /绝对路径/);
    } finally {
        await server.close();
    }
});

test('mcp purge needs an explicit all to empty the whole bin', async () => {
    let purged = null;
    const deps = bridgeDeps({ purgeImages: async paths => { purged = paths; return { purged: paths ? paths.length : 'all' }; } });
    const server = new McpHttpServer({ api: createMcpBridge(deps), port: 0, token: TOKEN });
    await server.start();
    try {
        const session = (await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize' })).session;
        assert.match(await call(server, session, 'picgen_purge_images', {}), /all/);
        assert.equal(purged, null);
        await call(server, session, 'picgen_purge_images', { paths: ['D:/bin/a.png'] });
        assert.deepEqual(purged, ['D:/bin/a.png']);
        await call(server, session, 'picgen_purge_images', { all: true });
        assert.equal(purged, undefined);
    } finally {
        await server.close();
    }
});

test('mcp server answers a malformed path and an unknown session instead of hanging', async () => {
    const server = new McpHttpServer({ api: createMcpBridge(bridgeDeps()), port: 0, token: TOKEN });
    await server.start();
    try {
        const status = await new Promise((resolve, reject) => {
            const request = http.request({ host: '127.0.0.1', port: server.port, path: 'http://[', method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } }, response => { response.resume(); resolve(response.statusCode); });
            request.setTimeout(3000, () => request.destroy(new Error('hung')));
            request.on('error', reject);
            request.end();
        });
        assert.equal(status, 400);
        const stale = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'f'.repeat(32));
        assert.equal(stale.status, 404, 'a client with a dead session must re-initialize');
    } finally {
        await server.close();
    }
});

async function post(server, message, session, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    const token = options.token === undefined ? TOKEN : options.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (session) headers['Mcp-Session-Id'] = session;
    const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(message) });
    return { status: response.status, headers: response.headers, session: response.headers.get('mcp-session-id'), body: await response.json() };
}

// fetch() will not let a caller set Host, so a DNS-rebinding request is sent raw.
function rawStatus(server, headers) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: server.port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, response => {
            response.resume();
            resolve(response.statusCode);
        });
        request.on('error', reject);
        request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    });
}

async function call(server, session, name, arguments_) {
    const response = await post(server, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: arguments_ } }, session);
    const content = response.body.result.content;
    const text = content[0].text;
    return content[0].type === 'text' && text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text;
}

async function callRaw(server, session, name, arguments_) {
    const response = await post(server, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name, arguments: arguments_ } }, session);
    return response.body.result;
}
