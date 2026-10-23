const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const adapter = require('../imageAdapters/grsaiNanoBanana');
const { generateImage } = require('../apiService');
const { PROTOCOLS, inferProtocol } = require('../protocolRouter');

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test('detects Grsai Nano Banana and builds reference-image request', () => {
    const provider = 'https://grsai.dakka.com.cn/';
    assert.equal(inferProtocol({ baseUrl: provider }, 'nano-banana-2'), PROTOCOLS.GRSAI_NANO_BANANA);
    assert.equal(inferProtocol({ baseUrl: `${provider}v1/draw/nano-banana`, modelRouting: { 'nano-banana-2': { protocol: 'gemini-native' } } }, 'nano-banana-2'), PROTOCOLS.GRSAI_NANO_BANANA);
    const request = adapter.buildDrawRequest({
        provider,
        model: 'nano-banana-2',
        prompt: 'keep the tent pattern',
        ratio: '16:9',
        imageSize: '2K',
        referenceImages: [{ mimeType: 'image/jpeg', base64: 'YWJj' }]
    });
    assert.equal(request.url, 'https://grsai.dakka.com.cn/v1/draw/nano-banana');
    assert.equal(request.body.model, 'nano-banana-2');
    assert.match(request.body.prompt, /keep the tent pattern/);
    assert.deepEqual(request.body.urls, ['data:image/jpeg;base64,YWJj']);
    assert.equal(request.body.aspectRatio, '16:9');
    assert.equal(request.body.imageSize, '2K');
    assert.equal(request.body.webHook, '-1');
});

test('submits, polls and downloads a Grsai result without a real API call', async t => {
    const requests = [];
    let pollCount = 0;
    const imageBase64 = Buffer.from('grsai-image').toString('base64');
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            requests.push({ path: request.url, auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
            response.setHeader('Content-Type', 'application/json');
            if (request.url === '/v1/draw/nano-banana') {
                response.end(JSON.stringify({ code: 0, data: { id: 'task-1' } }));
                return;
            }
            pollCount += 1;
            response.end(JSON.stringify(pollCount < 2
                ? { code: 0, data: { status: 'running', results: [] } }
                : { code: 0, data: { status: 'succeeded', results: [{ url: `data:image/png;base64,${imageBase64}` }] } }));
        });
    });
    const baseUrl = await listen(server);
    t.after(() => new Promise(resolve => server.close(resolve)));

    const result = await generateImage({
        provider: baseUrl,
        apiKey: 'test-key',
        model: 'nano-banana-2',
        protocol: PROTOCOLS.GRSAI_NANO_BANANA,
        prompt: 'keep reference',
        ratio: '1:1',
        imageSize: '1K',
        referenceImages: [{ mimeType: 'image/png', base64: 'YWJj' }]
    }, { grsaiPollIntervalMs: 1 });

    assert.equal(result.mimeType, 'image/png');
    assert.equal(Buffer.from(result.base64, 'base64').toString(), 'grsai-image');
    assert.equal(requests[0].path, '/v1/draw/nano-banana');
    assert.equal(requests[0].auth, 'Bearer test-key');
    assert.deepEqual(requests[0].body.urls, ['data:image/png;base64,YWJj']);
    assert.equal(requests[1].path, '/v1/draw/result');
    assert.equal(requests[1].body.id, 'task-1');
    assert.equal(pollCount, 2);
});

test('explicit non-Grsai protocol remains authoritative', () => {
    assert.equal(adapter.shouldUse('https://grsai.dakka.com.cn', 'nano-banana-2', 'gemini-native'), false);
    assert.equal(adapter.shouldUse('https://grsai.dakka.com.cn', 'nano-banana-2', 'auto'), true);
});
