const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const minimax = require('../imageAdapters/minimaxImage');
const profiles = require('../imageApiProfiles');
const { inferProtocol, PROTOCOLS } = require('../protocolRouter');
const { generateImage } = require('../apiService');

test('recognises MiniMax H3-Image models without stealing other vendors', () => {
    for (const model of ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed', 'minimax-h3-image', 'minimax/MiniMax-H3-Image']) {
        assert.equal(minimax.isMinimaxImageModel(model), true, model);
        assert.equal(profiles.imageApiKind(model), 'minimax', model);
        assert.equal(profiles.isOpenAIImageModel(model), false, model);
        assert.equal(profiles.isGeminiImageModel(model), false, model);
        assert.equal(inferProtocol({ baseUrl: 'https://api.minimax.cn' }, model), PROTOCOLS.OPENAI_IMAGES, model);
    }
    for (const model of ['gpt-image-2', 'gemini-3-pro-image-preview', 'doubao-seedream-5-0', 'MiniMax-H3']) {
        assert.equal(minimax.isMinimaxImageModel(model), false, model);
    }
    const profile = profiles.getImageApiProfile('MiniMax-H3-Image');
    assert.equal(profile.maxReferences, 16);
    assert.deepEqual(profile.imageSizeOptions.map(option => option.value), ['1K', '2K', '4K']);
    assert.ok(profile.dimensionOptions.some(option => option.value === 'auto'));
    assert.ok(profile.controls.outputFormat && profile.controls.compression);
});

test('MiniMax size is either WxH or aspect_ratio + area, never both', () => {
    assert.deepEqual(minimax.resolveDimensions({ ratio: '16:9', imageSize: '2K' }), { aspect_ratio: '16:9', area: '2K' });
    assert.deepEqual(minimax.resolveDimensions({ ratio: 'auto', imageSize: '4K' }), { area: '4K' });
    assert.deepEqual(minimax.resolveDimensions({ ratio: '2720x1536', imageSize: '4K' }), { size: '2720x1536' });
    assert.deepEqual(minimax.resolveDimensions({
        ratio: 'custom', imageSize: 'custom', generationConfig: { gptImageWidth: 1760, gptImageHeight: 2368 }
    }), { size: '1760x2368' });
    assert.deepEqual(minimax.resolveDimensions({ ratio: '9:19.5', imageSize: '1K' }), { aspect_ratio: '18:39', area: '1K' });
    assert.throws(() => minimax.resolveDimensions({ ratio: '1:4' }), /1:3～3:1/);
    assert.throws(() => minimax.resolveDimensions({ ratio: '512x512' }), /面积/);
});

test('MiniMax request body: generations vs edits, output format, official model casing', () => {
    const generate = minimax.buildRequest({ model: 'minimax-h3-image', prompt: 'cat', ratio: '1:1', imageSize: '1K' });
    assert.equal(generate.endpoint, 'generations');
    assert.deepEqual(generate.body, {
        model: 'MiniMax-H3-Image', prompt: 'cat', n: 1, aspect_ratio: '1:1', area: '1K',
        response_format: 'b64_json', aigc_watermark: false
    });
    const edit = minimax.buildRequest({
        model: 'MiniMax-H3-Image-Highspeed', prompt: 'edit', ratio: '4:3', imageSize: '2K',
        referenceImages: [{ base64: 'QUJD', mimeType: 'image/jpeg' }],
        generationConfig: { outputMimeType: 'image/webp', imageCompression: 80 }
    });
    assert.equal(edit.endpoint, 'edits');
    assert.deepEqual(edit.body.images, [{ image_url: 'data:image/jpeg;base64,QUJD' }]);
    assert.equal(edit.body.output_format, 'webp');
    assert.equal(edit.body.output_compression, 80);
    assert.equal(minimax.buildRequest({ model: 'relay/MiniMax-H3-Image', prompt: 'x' }).body.model, 'relay/MiniMax-H3-Image');
    assert.throws(() => minimax.buildRequest({ model: 'MiniMax-H3-Image', prompt: 'x', operation: 'edit' }), /至少需要一张参考图/);
    assert.throws(() => minimax.buildRequest({
        model: 'MiniMax-H3-Image', prompt: 'x',
        referenceImages: Array.from({ length: 17 }, () => ({ base64: 'QQ==' }))
    }), /最多支持 16/);
});

test('MiniMax partial failure picks the successful item; all failed surfaces the reason', () => {
    const result = minimax.extractResult({
        output_format: 'png',
        data: [{ error: { code: '1027', message: 'output image failed content safety check' } }, { b64_json: 'ZmFrZQ==', size: '1024x1024' }],
        usage: { generated_images: 1 }
    });
    assert.equal(result.base64, 'ZmFrZQ==');
    assert.equal(result.mimeType, 'image/png');
    assert.throws(() => minimax.extractResult({ data: [{ error: { code: '1027', message: 'safety' } }] }), /1027 safety/);
});

test('generateImage routes MiniMax H3-Image to /v1/images/generations and /v1/images/edits', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output_format: 'jpeg', data: [{ b64_json: 'ZmFrZQ==', size: '2720x1536' }], usage: { generated_images: 1 } }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const provider = `http://127.0.0.1:${server.address().port}`;
        const generated = await generateImage({ provider, apiKey: 'fixture-key', model: 'MiniMax-H3-Image', prompt: 'p', ratio: '16:9', imageSize: '2K' });
        assert.equal(generated.base64, 'ZmFrZQ==');
        assert.equal(generated.mimeType, 'image/jpeg');
        await generateImage({
            provider, apiKey: 'fixture-key', model: 'MiniMax-H3-Image', prompt: 'p', ratio: '1:1', imageSize: '1K',
            referenceImages: [{ base64: 'QUJD', mimeType: 'image/png' }]
        });
        assert.equal(requests[0].url, '/v1/images/generations');
        assert.equal(requests[0].auth, 'Bearer fixture-key');
        assert.equal(requests[0].body.aspect_ratio, '16:9');
        assert.equal(requests[0].body.area, '2K');
        assert.equal(requests[0].body.prompt, 'p', 'ratio goes upstream natively, not into the prompt');
        assert.equal(requests[1].url, '/v1/images/edits');
        assert.deepEqual(requests[1].body.images, [{ image_url: 'data:image/png;base64,QUJD' }]);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('the workspace groups MiniMax as its own family and marks edits in the image', async () => {
    const { modelFamily, templateForModel } = await import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'workspace', 'workspaceModel.mjs')).href);
    assert.equal(modelFamily('MiniMax-H3-Image'), 'minimax');
    assert.equal(templateForModel('MiniMax-H3-Image-Highspeed'), 'marked');
});
