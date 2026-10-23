const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const fetch = require('node-fetch');

const { generateImage } = require('../apiService');
const ProviderManager = require('../providerManager');
const TaskQueue = require('../taskQueue');
const { FailoverConfigStore } = require('../failoverConfig');
const { ProviderStore } = require('../providerStore');
const { inferProtocol, routeGroupFor } = require('../protocolRouter');
const rendererUtils = require('../rendererUtils');
const { startServer } = require('../server');

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

test('routes Moyu Gemini aliases through the OpenAI Images protocol', () => {
    const provider = { baseUrl: 'https://www.moyu.info', modelRouting: {} };
    assert.equal(inferProtocol(provider, 'gemini-3.1-flash-image-preview (按次)'), 'openai-images');
    assert.equal(routeGroupFor(provider, '[relay] Gemini-Image'), 'gemini-image');
});

test('prefers Gemini native generation when a provider advertises both image protocols', () => {
    const provider = {
        baseUrl: 'https://svip.xuedingmao.com',
        modelCapabilities: {
            'gemini-3.1-flash-image-preview': {
                supported_endpoint_types: ['gemini', 'image-generation']
            }
        }
    };
    assert.equal(inferProtocol(provider, 'gemini-3.1-flash-image-preview'), 'gemini-native');
});

test('resolves prompt mentions by reference order and preserves unknown mentions', () => {
    const prompt = '让 @{帐篷} 位于 @{背景} 前面，保留 @{未知}';
    const references = [{ name: '帐篷.png' }, { name: '背景.jpg' }];
    assert.equal(
        rendererUtils.resolvePromptMentions(prompt, references),
        '让 参考图1 位于 参考图2 前面，保留 @{未知}'
    );
});

test('parses known prompt mentions as atomic reference segments', () => {
    const references = [{ id: 'tent', name: '帐篷.png' }];
    const segments = rendererUtils.promptSegments('把 @{帐篷} 放到床上，保留 @{未知}', references);
    assert.deepEqual(segments.map(segment => segment.type), ['text', 'reference', 'text']);
    assert.equal(segments[1].reference.id, 'tent');
    assert.equal(segments[1].mention, '@{帐篷}');
    assert.equal(segments[2].text, ' 放到床上，保留 @{未知}');
});

test('mention autocomplete indexes uploaded references only and renders previews', () => {
    const desktopSource = fs.readFileSync(require.resolve('../desktop.js'), 'utf8');
    const mentionSection = desktopSource.slice(
        desktopSource.indexOf('function updateMentionMenu()'),
        desktopSource.indexOf('function hideMentionMenu()')
    );
    assert.match(mentionSection, /sequence\.references\.map/);
    assert.match(mentionSection, /className = 'mention-preview'/);
    assert.match(mentionSection, /reference\.base64/);
    assert.doesNotMatch(mentionSection, /state\.recentImages|最近图片|kind:\s*'recent'/);

    const html = require('../scripts/read-ui-source')();
    assert.match(html, /id="promptInput"[^>]+contentEditable=\{true\}/);
    assert.doesNotMatch(html, /<textarea id="promptInput"/);
    assert.match(desktopSource, /className = 'prompt-reference-token'/);
    assert.match(desktopSource, /dataset\.mention/);
});

test('discovered models use a selectable picker while model names remain editable', () => {
    const desktopSource = fs.readFileSync(require.resolve('../desktop.js'), 'utf8');
    const html = require('../scripts/read-ui-source')();
    assert.match(html, /id="discoveredModelSelect"/);
    assert.match(desktopSource, /function addSelectedDiscoveredModel\(\)/);
    assert.match(desktopSource, /modelInput\.type = 'text'/);
    assert.match(desktopSource, /saveProviderConfig\(payload, current\?\.id \|\| null\)/);
});

test('maps pointer coordinates from a scaled mask canvas to source pixels', () => {
    assert.deepEqual(
        rendererUtils.canvasPoint(210, 120, { left: 10, top: 20, width: 400, height: 200 }, 1600, 800),
        { x: 800, y: 400 }
    );
});

test('balances equal-priority providers by reserved capacity for the same model', () => {
    const manager = new ProviderManager();
    manager.syncProviders([
        {
            id: 'a', name: 'A', baseUrl: 'https://a.invalid', apiKey: 'a',
            models: ['shared-image'], priority: 1, weight: 100, maxConcurrent: 1,
            modelRouting: { 'shared-image': { protocol: 'openai-images' } }
        },
        {
            id: 'b', name: 'B', baseUrl: 'https://b.invalid', apiKey: 'b',
            models: ['shared-image'], priority: 1, weight: 100, maxConcurrent: 1,
            modelRouting: { 'shared-image': { protocol: 'openai-images' } }
        }
    ]);
    const task = { providerId: 'a', model: 'shared-image', operation: 'generate' };
    const first = manager.reserve(task);
    const second = manager.reserve(task);
    assert.equal(first.providerId, 'a');
    assert.equal(second.providerId, 'b');
    assert.equal(second.model, 'shared-image');
    manager.releaseReservation(first);
    manager.releaseReservation(second);
    manager.close();
});

test('failover reservations follow provider configuration order', () => {
    const manager = new ProviderManager();
    manager.syncProviders(['a', 'b', 'c'].map(id => ({
        id,
        name: id.toUpperCase(),
        baseUrl: `https://${id}.invalid`,
        apiKey: id,
        models: ['shared-image'],
        priority: 1,
        weight: id === 'c' ? 1000 : 1
    })));
    const reservation = manager.reserve(
        { providerId: 'a', model: 'shared-image', operation: 'generate' },
        ['a']
    );
    assert.equal(reservation.providerId, 'b');
    manager.releaseReservation(reservation);
    manager.close();
});

test('fixed strategy routes only through the selected provider', () => {
    const manager = new ProviderManager({
        strategy: 'fixed',
        selectedProviderId: 'b'
    });
    manager.syncProviders(['a', 'b'].map(id => ({
        id,
        name: id.toUpperCase(),
        baseUrl: `https://${id}.invalid`,
        apiKey: id,
        models: ['shared-image'],
        modelRouting: { 'shared-image': { protocol: 'openai-images' } }
    })));

    const reservation = manager.reserve({ providerId: 'a', model: 'shared-image', operation: 'generate' });
    assert.equal(reservation.providerId, 'b');
    manager.releaseReservation(reservation);
    assert.equal(manager.reserve({ providerId: 'a', model: 'missing-image', operation: 'generate' }), null);
    manager.close();
});

test('fixed strategy resolves queued tasks against the selected provider', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-fixed-provider-'));
    const runtime = await startServer({
        port: 0,
        host: '127.0.0.1',
        providerStoreFile: path.join(directory, 'providers.json'),
        chatProviderStoreFile: path.join(directory, 'chat-providers.json'),
        failoverConfigFile: path.join(directory, 'failover-config.json'),
        proxyConfigFile: path.join(directory, 'proxy-config.json')
    });
    t.after(() => {
        runtime.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    await runtime.providerStore.replace([
        {
            id: 'a', name: 'A', baseUrl: 'https://a.invalid', apiKey: 'a',
            models: ['a-model'], modelRouting: { 'a-model': { protocol: 'openai-images' } }
        },
        {
            id: 'b', name: 'B', baseUrl: 'https://b.invalid', apiKey: 'b',
            models: ['b-model'], modelRouting: { 'b-model': { protocol: 'openai-images' } }
        }
    ]);
    runtime.providerManager.syncProviders(await runtime.providerStore.list());

    const configResponse = await fetch(`${runtime.url}/api/providers/failover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: 'fixed', selectedProviderId: 'b' })
    });
    assert.equal(configResponse.ok, true);

    // Keep the assertion focused on the resolved enqueue payload; the test does
    // not need to perform a real upstream request.
    runtime.taskQueue._scheduleDrain = () => {};
    const taskResponse = await fetch(`${runtime.url}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Simulate a renderer that still has the old active provider/model.
        body: JSON.stringify({
            sequenceId: 'fixed-sequence',
            providerId: 'a',
            model: 'a-model',
            prompt: 'test'
        })
    });
    assert.equal(taskResponse.status, 202);
    const { taskId } = await taskResponse.json();
    const task = runtime.taskQueue.getTask(taskId);
    assert.equal(task.providerId, 'b');
    assert.equal(task.providerName, 'B');
    assert.equal(task.model, 'b-model');
});

test('fixed strategy bypasses an already open provider breaker', async () => {
    const manager = new ProviderManager({ failoverThreshold: 1 });
    manager.syncProviders([{
        id: 'a', name: 'A', baseUrl: 'https://a.invalid', apiKey: 'a',
        models: ['shared-image'],
        modelRouting: { 'shared-image': { protocol: 'openai-images' } }
    }]);

    const automaticReservation = manager.reserve({
        providerId: 'a', model: 'shared-image', operation: 'generate'
    });
    await assert.rejects(
        manager.executeReservation(automaticReservation, async () => {
            throw new Error('upstream failed');
        }),
        /upstream failed/
    );
    assert.equal(manager.getStatus()[0].circuit, 'open');

    manager.setFailoverOptions({ strategy: 'fixed', selectedProviderId: 'a' });
    const fixedReservation = manager.reserve({
        providerId: 'a', model: 'shared-image', operation: 'generate'
    });
    assert.equal(fixedReservation.bypassBreaker, true);
    assert.equal(
        await manager.executeReservation(fixedReservation, async () => 'success'),
        'success'
    );
    assert.equal(manager.getStatus()[0].circuit, 'closed');
    manager.close();
});

test('fixed strategy failures do not open or cool down the provider breaker', async () => {
    const manager = new ProviderManager({
        failoverThreshold: 1,
        strategy: 'fixed',
        selectedProviderId: 'a'
    });
    manager.syncProviders([{
        id: 'a', name: 'A', baseUrl: 'https://a.invalid', apiKey: 'a',
        models: ['shared-image'],
        modelRouting: { 'shared-image': { protocol: 'openai-images' } }
    }]);

    for (let index = 0; index < 3; index += 1) {
        const reservation = manager.reserve({
            providerId: 'a', model: 'shared-image', operation: 'generate'
        });
        await assert.rejects(
            manager.executeReservation(reservation, async () => {
                throw new Error(`upstream failed ${index}`);
            }),
            /upstream failed/
        );
    }

    const status = manager.getStatus()[0];
    assert.equal(status.circuit, 'closed');
    assert.equal(status.cooldownUntil, 0);
    assert.equal(status.consecutiveFailures, 0);
    assert.match(status.lastError, /upstream failed 2/);
    manager.close();
});

test('migrates the legacy failover config into the portable data directory', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-failover-migration-'));
    const legacyFilePath = path.join(directory, 'legacy.json');
    const filePath = path.join(directory, 'portable', 'failover-config.json');
    fs.writeFileSync(legacyFilePath, JSON.stringify({
        enabled: false,
        strategy: 'price',
        maxAttempts: 4
    }));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const store = new FailoverConfigStore({ filePath, legacyFilePath });
    const config = await store.get();
    assert.equal(config.enabled, false);
    assert.equal(config.strategy, 'price');
    assert.equal(config.maxAttempts, 4);
    assert.equal(config.maxGlobalConcurrent, 12);
    assert.equal(fs.existsSync(filePath), true);
});

test('persists and clamps the global task concurrency limit', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-global-concurrency-'));
    const filePath = path.join(directory, 'failover-config.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const store = new FailoverConfigStore({ filePath });
    assert.equal((await store.update({ maxGlobalConcurrent: 24 })).maxGlobalConcurrent, 24);
    assert.equal((await store.update({ maxGlobalConcurrent: 1000 })).maxGlobalConcurrent, 64);
    assert.equal((await new FailoverConfigStore({ filePath }).get()).maxGlobalConcurrent, 64);
});

test('updates the running queue global concurrency limit without cancelling tasks', () => {
    const queue = new TaskQueue({ maxConcurrentPerSequence: 3, maxGlobalConcurrent: 1 });
    assert.equal(queue.maxGlobalConcurrent, 1);
    assert.equal(queue.setMaxGlobalConcurrent(18), 18);
    assert.equal(queue.setMaxGlobalConcurrent(0), 1);
    assert.equal(queue.setMaxGlobalConcurrent(200), 64);
});

test('applies the saved global concurrency limit to the live server queue', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-live-concurrency-'));
    const runtime = await startServer({
        port: 0,
        host: '127.0.0.1',
        providerStoreFile: path.join(directory, 'providers.json'),
        chatProviderStoreFile: path.join(directory, 'chat-providers.json'),
        failoverConfigFile: path.join(directory, 'failover-config.json'),
        proxyConfigFile: path.join(directory, 'proxy-config.json')
    });
    t.after(() => {
        runtime.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const response = await fetch(`${runtime.url}/api/providers/failover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxGlobalConcurrent: 7 })
    });
    const result = await response.json();
    assert.equal(response.ok, true);
    assert.equal(result.config.maxGlobalConcurrent, 7);
    assert.equal(runtime.taskQueue.maxGlobalConcurrent, 7);
});

test('rates healthy provider routes as available', () => {
    const manager = new ProviderManager();
    manager.syncProviders([{
        id: 'healthy', name: 'Healthy', baseUrl: 'https://healthy.invalid', apiKey: 'key',
        models: ['image-a'], modelRouting: { 'image-a': { group: 'shared-image' } }
    }]);
    const health = manager.getHealthRatings()[0];
    assert.equal(health.rating, 'available');
    assert.equal(health.availableRouteCount, 1);
    assert.equal(health.directRouteCount, 1);
    manager.close();
});

test('rates a failed direct route with a healthy fallback as degraded', () => {
    const manager = new ProviderManager();
    manager.syncProviders([
        {
            id: 'primary', name: 'Primary', baseUrl: 'https://primary.invalid', apiKey: 'key',
            models: ['shared-image']
        },
        {
            id: 'fallback', name: 'Fallback', baseUrl: 'https://fallback.invalid', apiKey: 'key',
            models: ['shared-image']
        }
    ]);
    manager.recordFailure('primary', Object.assign(new Error('rate limited'), { status: 429 }));
    const health = manager.getHealthRatings().find(item => item.id === 'primary');
    assert.equal(health.rating, 'degraded');
    assert.equal(health.directRouteCount, 0);
    assert.equal(health.fallbackRouteCount, 1);
    manager.close();
});

test('rates routes with no selectable provider as failed', () => {
    const manager = new ProviderManager();
    manager.syncProviders([{
        id: 'failed', name: 'Failed', baseUrl: 'https://failed.invalid', apiKey: 'key',
        models: ['image-a']
    }]);
    manager.recordFailure('failed', Object.assign(new Error('unavailable'), { status: 429 }));
    const health = manager.getHealthRatings()[0];
    assert.equal(health.rating, 'failed');
    assert.equal(health.availableRouteCount, 0);
    manager.close();
});

test('rates a selectable provider with recent failures as degraded', () => {
    const manager = new ProviderManager();
    manager.syncProviders([{
        id: 'recovering', name: 'Recovering', baseUrl: 'https://recovering.invalid', apiKey: 'key',
        models: ['image-a']
    }]);
    manager.recordFailure('recovering', new Error('temporary failure'));
    const health = manager.getHealthRatings()[0];
    assert.equal(health.rating, 'degraded');
    assert.equal(health.availableRouteCount, 1);
    assert.equal(health.consecutiveFailures, 1);
    manager.close();
});

test('explicit protocol sends a Gemini-named model to images/generations', async t => {
    let requestPath = '';
    let requestBody = null;
    const upstream = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            requestPath = request.url;
            requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ data: [{ b64_json: 'YWJj' }] }));
        });
    });
    const baseUrl = await listen(upstream);
    t.after(() => new Promise(resolve => upstream.close(resolve)));

    const result = await generateImage({
        provider: baseUrl,
        apiKey: 'test-key',
        model: 'gemini-3.1-flash-image-preview',
        protocol: 'openai-images',
        prompt: 'test',
        ratio: '1:1'
    });
    assert.equal(requestPath, '/v1/images/generations');
    assert.equal(requestBody.model, 'gemini-3.1-flash-image-preview');
    assert.equal(requestBody.size, '1:1');
    assert.equal(result.base64, 'YWJj');
});

test('retries a transient generated-image download without resubmitting generation', async t => {
    let generationRequests = 0;
    let downloadRequests = 0;
    const downloadServer = http.createServer((request, response) => {
        downloadRequests += 1;
        if (downloadRequests === 1) {
            request.socket.destroy();
            return;
        }
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end('image-bytes');
    });
    const downloadBaseUrl = await listen(downloadServer);
    t.after(() => new Promise(resolve => downloadServer.close(resolve)));

    const generationServer = http.createServer((request, response) => {
        generationRequests += 1;
        request.resume();
        request.on('end', () => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ data: [{ url: `${downloadBaseUrl}/result.png` }] }));
        });
    });
    const generationBaseUrl = await listen(generationServer);
    t.after(() => new Promise(resolve => generationServer.close(resolve)));

    const result = await generateImage({
        provider: generationBaseUrl,
        apiKey: 'test-key',
        model: 'gpt-image-1',
        protocol: 'openai-images',
        prompt: 'test'
    }, {
        downloadRetryDelayMs: 0
    });

    assert.equal(generationRequests, 1);
    assert.equal(downloadRequests, 2);
    assert.equal(Buffer.from(result.base64, 'base64').toString(), 'image-bytes');
});

test('Gemini Images relays preserve aspect ratio and references in multipart edits', async t => {
    let requestPath = '';
    let contentType = '';
    let rawBody = '';
    const upstream = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            requestPath = request.url;
            contentType = request.headers['content-type'];
            rawBody = Buffer.concat(chunks).toString('utf8');
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ data: [{ b64_json: 'cmVmZXJlbmNlZA==' }] }));
        });
    });
    const baseUrl = await listen(upstream);
    t.after(() => new Promise(resolve => upstream.close(resolve)));

    await generateImage({
        provider: baseUrl,
        apiKey: 'test-key',
        model: 'gemini-3.1-flash-image-preview(按次)',
        protocol: 'openai-images',
        prompt: 'keep reference image 1',
        ratio: '16:9',
        referenceImages: [{ base64: 'YWJj', mimeType: 'image/png' }]
    });

    assert.equal(requestPath, '/v1/images/edits');
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    assert.match(rawBody, /name="size"\r\n\r\n16:9/);
    assert.match(rawBody, /宽高比必须严格为 16:9/);
    assert.match(rawBody, /name="image"; filename="ref_0\.png"/);
    assert.match(rawBody, /abc/);
});

test('local edits send source image and alpha mask as multipart', async t => {
    const sharp = require('sharp');
    const fixture = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#2368ac' } }).png().toBuffer();
    const mask = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toBuffer();
    let requestPath = '';
    let contentType = '';
    let rawBody = '';
    const upstream = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            requestPath = request.url;
            contentType = request.headers['content-type'];
            rawBody = Buffer.concat(chunks).toString('utf8');
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ data: [{ b64_json: fixture.toString('base64') }] }));
        });
    });
    const baseUrl = await listen(upstream);
    t.after(() => new Promise(resolve => upstream.close(resolve)));

    await generateImage({
        provider: baseUrl,
        apiKey: 'test-key',
        model: 'gpt-image-1',
        protocol: 'openai-images',
        operation: 'edit',
        prompt: 'replace the selected area',
        referenceImages: [{ base64: fixture.toString('base64'), mimeType: 'image/png' }],
        maskImage: [{ base64: mask.toString('base64'), mimeType: 'image/png' }][0]
    });
    assert.equal(requestPath, '/v1/images/edits');
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    assert.match(rawBody, /name="image"/);
    assert.match(rawBody, /name="mask"/);
    assert.match(rawBody, /宽高比必须严格为 1:1/);
});

test('provider store migrates plaintext API keys through its secret codec', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-provider-store-'));
    const filePath = path.join(directory, 'providers.json');
    fs.writeFileSync(filePath, JSON.stringify({ providers: [{
        id: 'p1', name: 'Provider', baseUrl: 'https://example.invalid', apiKey: 'plain-secret', models: ['image-1']
    }] }));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const codec = {
        encrypt: value => `enc:v1:${Buffer.from(value).toString('base64')}`,
        decrypt: value => Buffer.from(value.slice('enc:v1:'.length), 'base64').toString('utf8')
    };
    const store = new ProviderStore({ filePath, secretCodec: codec });
    const providers = await store.list();
    assert.equal(providers[0].apiKey, 'plain-secret');
    const saved = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(saved, /plain-secret/);
    assert.match(saved, /enc:v1:/);
});

test('task completion events contain result metadata without image base64', async t => {
    const upstream = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: 'bGFyZ2UtaW1hZ2U=' }] }));
    });
    const baseUrl = await listen(upstream);
    t.after(() => new Promise(resolve => upstream.close(resolve)));
    const manager = new ProviderManager();
    manager.syncProviders([{
        id: 'p1', name: 'Provider', baseUrl, apiKey: 'key', models: ['gpt-image-1'],
        modelRouting: { 'gpt-image-1': { protocol: 'openai-images' } }
    }]);
    t.after(() => manager.close());

    let completedEvent = null;
    const completed = new Promise(resolve => {
        const queue = new TaskQueue({
            providerManager: manager,
            resultStore: async task => ({ id: task.id, filePath: 'C:\\cache\\result.png', mimeType: 'image/png' }),
            onTaskEvent(type, data) {
                if (type === 'task:completed') {
                    completedEvent = data;
                    resolve();
                }
            }
        });
        queue.enqueue({ sequenceId: 's1', providerId: 'p1', model: 'gpt-image-1', prompt: 'test' });
    });
    await completed;
    assert.equal(completedEvent.result.filePath, 'C:\\cache\\result.png');
    assert.equal(Object.hasOwn(completedEvent.result, 'base64'), false);
});

test('task queue retries each compatible provider in order and updates health', async t => {
    const attempts = [];
    const makeUpstream = status => http.createServer((request, response) => {
        attempts.push(request.headers.host);
        request.resume();
        request.on('end', () => {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(status === 200
                ? JSON.stringify({ data: [{ b64_json: 'c3VjY2Vzcw==' }] })
                : JSON.stringify({ error: { message: `upstream ${status}` } }));
        });
    });
    const servers = [makeUpstream(404), makeUpstream(429), makeUpstream(200)];
    const urls = [];
    for (const server of servers) urls.push(await listen(server));
    t.after(() => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))));

    const manager = new ProviderManager();
    manager.syncProviders(urls.map((baseUrl, index) => ({
        id: `p${index + 1}`,
        name: `Provider ${index + 1}`,
        baseUrl,
        apiKey: 'key',
        models: ['gpt-image-1'],
        modelRouting: { 'gpt-image-1': { protocol: 'openai-images' } }
    })));
    t.after(() => manager.close());

    const events = [];
    const completed = new Promise(resolve => {
        const queue = new TaskQueue({
            providerManager: manager,
            onTaskEvent(type, data) {
                events.push({ type, data });
                if (type === 'task:completed' || type === 'task:failed') resolve(data);
            }
        });
        queue.enqueue({ sequenceId: 's1', providerId: 'p1', model: 'gpt-image-1', prompt: 'test' });
    });
    const task = await completed;

    assert.equal(task.status, 'completed');
    assert.deepEqual(task.attempts.map(attempt => attempt.providerId), ['p1', 'p2', 'p3']);
    assert.equal(task.attempts[0].error.includes('404'), true);
    assert.equal(task.attempts[1].error.includes('429'), true);
    assert.equal(events.filter(event => event.type === 'provider:status').length >= 2, true);
    assert.equal(manager.getHealthRatings().find(item => item.id === 'p1').rating, 'degraded');
    assert.equal(manager.getHealthRatings().find(item => item.id === 'p2').rating, 'degraded');
});

test('provider editor hides internal route groups', () => {
    const source = fs.readFileSync(require.resolve('../desktop.js'), 'utf8');
    assert.doesNotMatch(source, /data-model-group|跨供应商路由组/);
    // Queue labels are exercised through real renderer functions in
    // renderer-performance.test.js, independent of local variable names.
});
