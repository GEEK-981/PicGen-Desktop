const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const fetch = require('node-fetch');
const { startServer } = require('../server');

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

test('reverse prompt routes an explicitly selected non-default model', async t => {
    const received = [];
    const upstream = http.createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            received.push(JSON.parse(body));
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ choices: [{ message: { content: 'mock reverse result' } }] }));
        });
    });
    const upstreamUrl = await listen(upstream);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-reverse-routing-'));
    const runtime = await startServer({
        port: 0,
        host: '127.0.0.1',
        unifiedProviderStoreFile: path.join(directory, 'unified.json'),
        providerStoreFile: path.join(directory, 'providers.json'),
        chatProviderStoreFile: path.join(directory, 'chat-providers.json'),
        failoverConfigFile: path.join(directory, 'failover.json'),
        proxyConfigFile: path.join(directory, 'proxy.json')
    });
    t.after(() => {
        runtime.close();
        upstream.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const created = await fetch(`${runtime.url}/api/chat-providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: 'reverse-chat', name: 'Loopback Vision', baseUrl: upstreamUrl,
            apiKey: 'loopback-key', models: ['default-model', 'selected-model'], activeModel: 'default-model'
        })
    });
    assert.equal(created.status, 201);

    const response = await fetch(`${runtime.url}/api/prompts/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chatProviderId: 'reverse-chat', model: 'selected-model',
            image: { base64: 'aGVsbG8=', mimeType: 'image/png' }, instruction: 'describe'
        })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { prompt: 'mock reverse result' });
    assert.equal(received.length, 1);
    assert.equal(received[0].model, 'selected-model');
});

test('reverse prompt rejects an unknown model before contacting provider', async t => {
    let requests = 0;
    const upstream = http.createServer((_request, response) => {
        requests += 1;
        response.writeHead(500);
        response.end();
    });
    const upstreamUrl = await listen(upstream);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-reverse-invalid-model-'));
    const runtime = await startServer({
        port: 0,
        host: '127.0.0.1',
        unifiedProviderStoreFile: path.join(directory, 'unified.json'),
        providerStoreFile: path.join(directory, 'providers.json'),
        chatProviderStoreFile: path.join(directory, 'chat-providers.json'),
        failoverConfigFile: path.join(directory, 'failover.json'),
        proxyConfigFile: path.join(directory, 'proxy.json')
    });
    t.after(() => {
        runtime.close();
        upstream.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const created = await fetch(`${runtime.url}/api/chat-providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Loopback Vision', baseUrl: upstreamUrl, apiKey: 'loopback-key', models: ['allowed-model'], activeModel: 'allowed-model' })
    });
    assert.equal(created.status, 201);
    const createdProvider = await created.json();

    const response = await fetch(`${runtime.url}/api/prompts/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chatProviderId: createdProvider.id, model: 'unknown-model',
            image: { base64: 'aGVsbG8=', mimeType: 'image/png' }
        })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /模型/);
    assert.equal(requests, 0);
});
