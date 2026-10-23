const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fetch = require('node-fetch');
const { startServer } = require('../server');
const { optimizePrompt } = require('../apiService');

test('reverse and optimization forward deltas before completion, handle interruption and cancel upstream', async t => {
    let finish, closed, received;
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            received = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n');
            finish = (broken = false) => res.end(broken ? '' : 'data: {"choices":[{"delta":{"content":"第二段"}}]}\n\ndata: [DONE]\n\n');
            closed = new Promise(resolve => res.once('close', resolve));
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-stream-http-'));
    const runtime = await startServer({ port: 0, host: '127.0.0.1', unifiedProviderStoreFile: path.join(root, 'unified.json'),
        providerStoreFile: path.join(root, 'providers.json'), chatProviderStoreFile: path.join(root, 'chat.json'),
        failoverConfigFile: path.join(root, 'failover.json'), proxyConfigFile: path.join(root, 'proxy.json') });
    t.after(async () => { runtime.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
    const provider = `http://127.0.0.1:${upstream.address().port}`;
    const created = await fetch(`${runtime.url}/api/chat-providers`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'stream', name: 'Mock', baseUrl: provider, apiKey: 'mock-key', models: ['gpt-4o'], activeModel: 'gpt-4o' }) });
    assert.equal(created.status, 201);
    for (const route of ['reverse', 'optimize']) {
        const response = await fetch(`${runtime.url}/api/prompts/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stream: true, prompt: 'test', chatProviderId: 'stream', image: { base64: 'aW1hZ2U=', mimeType: 'image/png' } }) });
        assert.match(response.headers.get('content-type'), /text\/event-stream/);
        const iterator = response.body[Symbol.asyncIterator]();
        const first = await iterator.next();
        assert.match(first.value.toString(), /第一段/); assert.equal(received.stream, true);
        finish(route === 'reverse');
        let rest = ''; for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) rest += chunk.toString();
        if (route === 'reverse') { assert.match(rest, /"type":"error"/); assert.doesNotMatch(rest, /"type":"done"/); }
        else assert.match(rest, /第一段第二段/);
    }
    const controller = new AbortController();
    const response = await fetch(`${runtime.url}/api/prompts/optimize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ stream: true, prompt: 'test', chatProviderId: 'stream' }) });
    response.body.on('error', () => {});
    controller.abort();
    await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream did not cancel')), 2000); timer.unref(); })]);
});

test('Gemini streaming switches to streamGenerateContent and consumes native SSE', async t => {
    let url;
    const upstream = http.createServer((req, res) => {
        url = req.url; req.resume(); req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end('data: {"candidates":[{"content":{"parts":[{"text":"原生输出"}]},"finishReason":"STOP"}]}\n\n');
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => upstream.close());
    const result = await optimizePrompt({ provider: `http://127.0.0.1:${upstream.address().port}/generativelanguage.googleapis.com`, model: 'gemini-2.5-flash', apiKey: 'mock', prompt: 'test', onDelta() {} });
    assert.match(url, /:streamGenerateContent\?/); assert.match(url, /alt=sse/); assert.equal(result.text, '原生输出');
});
