const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const toapis = require('../imageAdapters/toapisImage');
const { _test } = require('../apiService');
const { inferProtocol } = require('../protocolRouter');

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/lmPx0wAAAABJRU5ErkJggg==', 'base64');
const build = (model, extra = {}) => toapis.buildGenerateBody({
    model, prompt: 'p', ratio: '16:9', imageSize: '2K', resolvePixelSize: _test.resolveOpenAIImageSize, ...extra
});

test('recognises ToAPIs hosts and only takes over image routes it understands', () => {
    for (const url of ['https://toapis.cn', 'https://toapis.com/', 'https://api.toapis.cn/v1', 'https://toapis.com/v1/images/generations']) {
        assert.equal(toapis.isToapisProvider(url), true, url);
    }
    for (const url of ['https://grsai.dakka.com.cn', 'https://nottoapis.com', 'https://toapis.cn.evil.example']) {
        assert.equal(toapis.isToapisProvider(url), false, url);
    }
    for (const model of ['gpt-image-2.6-sunburst-official', 'gemini-3.1-flash-image-preview', 'gemini-nano-banana-2.1']) {
        const protocol = inferProtocol({ baseUrl: 'https://toapis.cn' }, model);
        assert.equal(toapis.shouldUse('https://toapis.cn', model, protocol), true, model);
    }
    assert.equal(toapis.shouldUse('https://toapis.cn', 'gpt-image-2', 'openai-chat'), false);
    assert.equal(toapis.generateUrl('https://toapis.cn/v1/'), 'https://toapis.cn/v1/images/generations');
    assert.equal(toapis.taskUrl('https://toapis.cn', 'tsk 1'), 'https://toapis.cn/v1/images/generations/tsk%201');
});

test('GPT Image 2.6 official sends ratio, top-level resolution, quality and image_urls', () => {
    const body = build('gpt-image-2.6-sunburst-official', {
        referenceUrls: ['https://files.example/a.png'],
        generationConfig: { gptQuality: 'xhigh', gptBackground: 'transparent', outputMimeType: 'image/webp', imageCompression: '70' }
    });
    assert.deepEqual(body, {
        model: 'gpt-image-2.6-sunburst-official', prompt: 'p', n: 1, size: '16:9', resolution: '2K',
        image_urls: ['https://files.example/a.png'], quality: 'xhigh', background: 'transparent',
        output_format: 'webp', output_compression: 70
    });
    // Local edits hand over a pixel size; 2.6 accepts it as is.
    assert.equal(build('gpt-image-2.6-flare-official', { ratio: '1536x1024' }).size, '1536x1024');
    assert.equal(build('gpt-image-2.6-flare-official', { ratio: 'custom', generationConfig: { gptImageWidth: 2048, gptImageHeight: 1152 } }).size, '2048x1152');
});

test('GPT Image 2.5 regular uses reference_images and drops the fixed quality', () => {
    const body = build('gpt-image-2.5-sunburst', { referenceUrls: ['u1', 'u2'], generationConfig: { gptQuality: 'max' } });
    assert.deepEqual(body, { model: 'gpt-image-2.5-sunburst', prompt: 'p', n: 1, size: '16:9', resolution: '2K', reference_images: ['u1', 'u2'] });
    assert.throws(() => build('gpt-image-2.5-flare', { generationConfig: { gptBackground: 'opaque' } }), /不支持背景参数/);
});

test('GPT Image 2.5 official needs a pixel size instead of a ratio', () => {
    const body = build('gpt-image-2.5-sunburst-official', { referenceUrls: ['u'], generationConfig: { gptQuality: 'high' } });
    assert.equal(body.size, '2048x1152');
    assert.equal('resolution' in body, false);
    assert.deepEqual(body.image_urls, ['u']);
    assert.equal(body.quality, 'high');
});

test('GPT Image 2 official and VIP keep their own quality tiers and mask support', () => {
    const official = build('gpt-image-2-official', { referenceUrls: ['src'], maskUrl: 'mask', generationConfig: { gptQuality: 'medium' } });
    assert.equal(official.mask_url, 'mask');
    assert.equal(official.quality, 'medium');
    assert.equal(build('gpt-image-2-vip', { generationConfig: { gptQuality: 'xhigh' } }).quality, undefined);
    assert.equal(build('gpt-image-2-vip', { generationConfig: { gptQuality: 'low' } }).quality, 'low');
    assert.throws(() => build('gpt-image-2.5-flare', { referenceUrls: ['src'], maskUrl: 'mask' }), /不支持蒙版/);
});

test('Gemini models put resolution in metadata and use the documented reference shape', () => {
    const regular = build('gemini-3.1-flash-image-preview', { referenceUrls: ['a', 'b'] });
    assert.deepEqual(regular, { model: 'gemini-3.1-flash-image-preview', prompt: 'p', n: 1, size: '16:9', metadata: { resolution: '2K' }, image_urls: [{ url: 'a' }, { url: 'b' }] });
    const vip = build('gemini-3-pro-image-preview-vip', { referenceUrls: ['a'] });
    assert.deepEqual(vip.image_urls, [{ url: 'a' }]);
    for (const model of ['gemini-3.1-flash-image-official', 'gemini-nano-banana-2.1', 'gemini-nano-banana-2.1-official']) {
        assert.deepEqual(build(model, { referenceUrls: ['a'] }).image_urls, ['a'], model);
    }
    assert.equal('metadata' in build('gemini-2.5-flash-image-official'), false);
    assert.equal(build('gemini-3.1-flash-image-preview', { imageSize: '512' }).metadata.resolution, '0.5K');
    assert.equal('size' in build('gemini-3-pro-image-official', { ratio: 'auto' }), false);
    assert.equal(build('gemini-3-pro-image-official', { ratio: '1200x800' }).size, '3:2');
    // The regular 3.x channels accept at most 6 references; VIP / official take 14.
    assert.throws(() => build('gemini-3-pro-image-preview', { referenceUrls: Array(7).fill('u') }), /最多支持 6 张/);
    assert.equal(build('gemini-3-pro-image-preview-vip', { referenceUrls: Array(14).fill('u') }).image_urls.length, 14);
});

test('reads task ids, states, result URLs and errors from the documented responses', () => {
    const done = { id: 'img_1', status: 'completed', result: { type: 'image', data: [{ url: 'https://files/x.jpg' }] } };
    assert.equal(toapis.extractTaskId(done), 'img_1');
    assert.equal(toapis.isDone(toapis.state(done)), true);
    assert.deepEqual(toapis.extractResultUrls(done), ['https://files/x.jpg']);
    const failed = { id: 'img_2', status: 'failed', error: { code: 'generation_failed', message: 'upstream 422' } };
    assert.equal(toapis.isFailed(toapis.state(failed)), true);
    assert.equal(toapis.errorMessage(failed), 'generation_failed: upstream 422');
    assert.equal(toapis.extractUploadUrl({ success: true, data: { url: 'https://files/up.png' } }), 'https://files/up.png');
});

test('uploads references, submits once, polls and downloads the result', async () => {
    const seen = [];
    let polls = 0;
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'] || '', raw });
        const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.url === '/v1/uploads/images') return json(200, { success: true, data: { id: 'up_1', url: `http://127.0.0.1:${server.address().port}/files/ref.png` } });
        if (req.url === '/v1/images/generations' && req.method === 'POST') return json(200, { id: 'tsk_img_1', object: 'generation.task', status: 'pending', progress: 0 });
        if (req.url === '/v1/images/generations/tsk_img_1') {
            polls += 1;
            if (polls === 1) { res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'application/json' }); return res.end('{"error":{"code":"rate_limit_exceeded"}}'); }
            if (polls === 2) return json(200, { id: 'tsk_img_1', status: 'in_progress', progress: 50 });
            return json(200, { id: 'tsk_img_1', status: 'completed', result: { type: 'image', data: [{ url: `http://127.0.0.1:${server.address().port}/files/out.png` }] } });
        }
        if (req.url === '/files/out.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG_1X1); }
        json(404, { error: 'not found' });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const result = await _test.generateToapisImage({
            provider: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: 'fixture-key',
            model: 'gpt-image-2.6-sunburst-official',
            prompt: 'layout',
            ratio: '3:2',
            imageSize: '1K',
            referenceImages: [{ base64: PNG_1X1.toString('base64'), mimeType: 'image/png' }],
            generationConfig: { gptQuality: 'high' }
        }, { toapisPollIntervalMs: 5 });
        assert.equal(result.base64, PNG_1X1.toString('base64'));
        const upload = seen.find(item => item.url === '/v1/uploads/images');
        assert.match(upload.type, /^multipart\/form-data/);
        assert.equal(upload.auth, 'Bearer fixture-key');
        const submits = seen.filter(item => item.url === '/v1/images/generations' && item.method === 'POST');
        assert.equal(submits.length, 1, 'a rate-limited poll must not resubmit the paid task');
        const body = JSON.parse(submits[0].raw.toString());
        assert.equal(body.model, 'gpt-image-2.6-sunburst-official');
        assert.equal(body.size, '3:2');
        assert.equal(body.resolution, '1K');
        assert.equal(body.quality, 'high');
        assert.deepEqual(body.image_urls, [`http://127.0.0.1:${server.address().port}/files/ref.png`]);
        assert.equal(polls, 3);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('a failed ToAPIs task is reported without resubmitting', async () => {
    let submits = 0;
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'POST') { submits += 1; return res.end(JSON.stringify({ id: 'tsk_bad', status: 'pending' })); }
        res.end(JSON.stringify({ id: 'tsk_bad', status: 'failed', error: { code: 'generation_failed', message: 'content rejected' } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await assert.rejects(_test.generateToapisImage({
            provider: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', model: 'gemini-3-pro-image-official', prompt: 'x'
        }, { toapisPollIntervalMs: 5 }), error => {
            assert.match(error.message, /content rejected/);
            assert.equal(error.retryable, false);
            return true;
        });
        assert.equal(submits, 1);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
