const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const profiles = require('../imageApiProfiles');
const settings = require('../generationSettings');
const doubaoSeedream = require('../imageAdapters/doubaoSeedream');
const photontide = require('../imageAdapters/photontideImage');
const { inferProtocol, PROTOCOLS } = require('../protocolRouter');
const { generateImage, _test } = require('../apiService');
const { generateMaskedImage } = require('../maskEdit');
const sharp = require('sharp');

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/lmPx0wAAAABJRU5ErkJggg==', 'base64');

test('recognises Doubao Seedream 5.5 across Ark, BytePlus and Photontide model spellings', () => {
    for (const model of [
        'doubao-seedream-5-5-261028',
        'doubao_seedream_5_5_261028',
        'dola-seedream-5-5-261028',
        'doubao-seedream-5.5',
        'seedream-5.5',
        'volcengine/doubao-seedream-5-5-261028'
    ]) {
        assert.equal(doubaoSeedream.isSeedream55Model(model), true, model);
        assert.equal(profiles.imageApiKind(model), 'seedream', model);
        assert.equal(profiles.seedreamImageFamily(model), 'seedream-5.5', model);
        assert.equal(inferProtocol({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }, model), PROTOCOLS.OPENAI_IMAGES, model);
        const profile = profiles.getImageApiProfile(model);
        assert.deepEqual(profile.imageSizeOptions.map(item => item.value), ['1K', '1.5K', '2K', 'custom']);
        assert.equal(profiles.resolveImageSizePreference('4K', profile.imageSizeOptions), '2K', `${model} falls back from 4K to 2K`);
        assert.equal(profiles.resolveImageSizePreference('1.5K', profile.imageSizeOptions), '1.5K');
        assert.equal(profile.maxReferences, 10);
        assert.equal(profile.controls.background, true);
        assert.equal(profile.controls.outputFormat, true);
        assert.equal(profile.controls.customSize, true);
        assert.deepEqual(profile.outputFormatOptions.map(item => item.value), ['', 'image/png', 'image/jpeg']);
    }

    // Seedream 5.0 Lite / Pro / 4.5 / 4.0 and Seedance video models stay distinct.
    assert.equal(profiles.seedreamImageFamily('doubao_seedream_5_0_pro_260628'), 'seedream-5.0-pro');
    assert.equal(profiles.seedreamImageFamily('doubao-seedream-5-0-260128'), 'seedream-5.0');
    assert.equal(profiles.seedreamImageFamily('doubao-seedream-4-5-251128'), 'seedream-4.5');
    assert.equal(profiles.seedreamImageFamily('doubao-seedream-4-0-250828'), 'seedream-4.0');
    assert.equal(profiles.isSeedreamImageModel('doubao_seedance_2_5_260628'), false);
    assert.equal(profiles.isSeedreamImageModel('gpt-image-2.5-flare'), false);
});

test('Seedream 5.5 request builder enforces size tiers, custom pixel bounds, native RGBA and forbidden 5.0-only fields', () => {
    // 4K preference narrows to 2K; auto background is omitted; sequential_image_generation is stripped on 5.5.
    const t2i = doubaoSeedream.buildRequest({
        model: 'doubao-seedream-5-5-261028',
        prompt: 'product bottle',
        effectivePrompt: 'product bottle\n\n构图要求：画面宽高比必须严格为 16:9，不要输出其他比例。',
        ratio: '16:9',
        imageSize: '4K',
        generationConfig: {
            gptBackground: 'auto',
            sequentialImageGeneration: 'auto',
            maxImages: 4,
            googleSearch: true
        }
    });
    assert.deepEqual(t2i.body, {
        model: 'doubao-seedream-5-5-261028',
        prompt: 'product bottle\n\n构图要求：画面宽高比必须严格为 16:9，不要输出其他比例。',
        size: '2K',
        output_format: 'png',
        response_format: 'url',
        stream: false,
        watermark: false
    });

    // 1.5K + native RGBA transparent background + standard prompt optimization.
    const rgba = doubaoSeedream.buildRequest({
        model: 'doubao-seedream-5-5-261028',
        prompt: 'rabbit sticker',
        ratio: '1:1',
        imageSize: '1.5K',
        referenceImages: [{ base64: 'YWJj', mimeType: 'IMAGE/PNG; charset=utf-8' }],
        generationConfig: {
            gptBackground: 'transparent',
            optimizePromptMode: 'standard'
        }
    });
    assert.equal(rgba.body.size, '1.5K');
    assert.equal(rgba.body.background, 'transparent');
    assert.equal(rgba.body.output_format, 'png');
    assert.equal(rgba.body.image, 'data:image/png;base64,YWJj');
    assert.deepEqual(rgba.body.optimize_prompt_options, { mode: 'standard' });

    // Transparent + JPEG is rejected locally instead of wasting a request.
    assert.throws(() => doubaoSeedream.buildRequest({
        model: 'doubao-seedream-5-5-261028',
        prompt: 'sticker',
        generationConfig: { gptBackground: 'transparent', outputMimeType: 'image/jpeg' }
    }), /PNG/);

    // Custom pixel bounds: 921,600..4,624,220 px and ratio 1:16..16:1.
    const customOk = doubaoSeedream.buildRequest({
        model: 'doubao-seedream-5-5-261028',
        prompt: 'banner',
        ratio: '1:1',
        imageSize: 'custom',
        generationConfig: { gptImageWidth: 2816, gptImageHeight: 1584 }
    });
    assert.equal(customOk.body.size, '2816x1584');
    assert.throws(() => doubaoSeedream.buildRequest({
        model: 'doubao-seedream-5-5-261028',
        prompt: 'too small',
        ratio: '512x512'
    }), /总像素/);
    assert.throws(() => doubaoSeedream.buildRequest({
        model: 'doubao-seedream-5-5-261028',
        prompt: 'too large',
        ratio: '4096x4096'
    }), /总像素/);

    // Layer decomposition requires exactly 1 image, defaults size to auto, and forbids background.
    const decompose = doubaoSeedream.buildRequest({
        model: 'doubao-seedream-5-5-261028',
        prompt: '',
        referenceUrls: ['https://cdn.example/poster.png'],
        generationConfig: {
            layerDecomposition: true,
            layerMaxImages: 25,
            layerTextRecognition: true
        }
    });
    assert.deepEqual(decompose.body, {
        model: 'doubao-seedream-5-5-261028',
        size: 'auto',
        output_format: 'png',
        response_format: 'url',
        stream: false,
        watermark: false,
        layer_decomposition: true,
        layer_decomposition_options: { max_images: 25, text_recognition: true },
        image: 'https://cdn.example/poster.png'
    });
    assert.throws(() => doubaoSeedream.buildRequest({
        model: 'doubao-seedream-5-5-261028',
        prompt: 'x',
        generationConfig: { layerDecomposition: true }
    }), /1 张输入参考图/);
    assert.throws(() => doubaoSeedream.buildRequest({
        model: 'doubao-seedream-5-5-261028',
        prompt: 'x',
        generationConfig: { optimizePromptMode: 'fast' }
    }), /standard/);
    assert.throws(() => doubaoSeedream.buildRequest({
        model: 'doubao-seedream-5-5-261028',
        prompt: 'x',
        referenceUrls: Array(11).fill('https://cdn.example/ref.png')
    }), /最多支持 10 张/);
});

test('generationSettings wires Seedream 5.5 advanced controls from UI sequences and MCP', () => {
    const config = settings.buildGenerationConfig({
        model: 'doubao_seedream_5_5_261028',
        advanced: {
            gptBackground: 'transparent',
            outputMimeType: 'image/png',
            gptImageWidth: '2048',
            gptImageHeight: '1024',
            nativeResponseFormat: 'b64_json',
            optimizePromptMode: 'standard'
        }
    }, profiles);
    assert.deepEqual(config, {
        outputMimeType: 'image/png',
        gptImageWidth: 2048,
        gptImageHeight: 1024,
        gptBackground: 'transparent',
        responseFormat: 'b64_json',
        optimizePromptMode: 'standard'
    });
    assert.equal(settings.resolveImageSize('doubao_seedream_5_5_261028', '4K', profiles), '2K');
    assert.equal(settings.resolveImageSize('doubao_seedream_5_5_261028', '1.5K', profiles), '1.5K');
});

test('recognises Photontide (光脉) hosts and formats Seedream, GPT Image, Nano Banana and Qwen payloads per Photontide docs', () => {
    for (const url of [
        'https://ai.photontide.cn',
        'https://ai.photontide.cn/v1',
        'https://photontide.cn/',
        'https://ai.photontide.cn/v1/images/generations'
    ]) {
        assert.equal(photontide.isPhotontideProvider(url), true, url);
    }
    for (const url of ['https://grsai.dakka.com.cn', 'https://notphotontide.cn', 'https://photontide.cn.evil.example']) {
        assert.equal(photontide.isPhotontideProvider(url), false, url);
    }
    assert.equal(photontide.shouldUse('https://ai.photontide.cn', 'doubao_seedream_5_5_261028', 'openai-images'), true);
    assert.equal(photontide.shouldUse('https://ai.photontide.cn', 'gpt-image-2.5-flare', 'openai-images'), true);
    assert.equal(photontide.shouldUse('https://ai.photontide.cn', 'nano-banana-2', 'openai-images'), true);
    assert.equal(photontide.shouldUse('https://ai.photontide.cn', 'gemini-3-pro-image-preview', 'gemini-native'), false);
    assert.equal(photontide.shouldUse('https://ai.photontide.cn', 'gpt-image-2', 'openai-chat'), false);

    // Seedream 5.5 on Photontide: /v1/images/generations, public HTTP URL in `image`, no `stream` field.
    const seedreamReq = _test.buildPhotontideImageRequest({
        model: 'doubao_seedream_5_5_261028',
        prompt: 'edit painting',
        effectivePrompt: 'edit painting\n\n构图要求：画面宽高比必须严格为 4:3，不要输出其他比例。',
        ratio: '4:3',
        imageSize: '2K',
        referenceUrls: ['https://img.example/1.png', 'https://img.example/2.png'],
        generationConfig: { gptBackground: 'opaque', outputMimeType: 'image/jpeg' }
    });
    assert.equal(seedreamReq.endpoint, 'generations');
    assert.deepEqual(seedreamReq.body, {
        model: 'doubao_seedream_5_5_261028',
        prompt: 'edit painting\n\n构图要求：画面宽高比必须严格为 4:3，不要输出其他比例。',
        size: '2K',
        output_format: 'jpeg',
        background: 'opaque',
        image: ['https://img.example/1.png', 'https://img.example/2.png'],
        response_format: 'url',
        watermark: false
    });

    // GPT Image on Photontide: stays on /v1/images/generations JSON (never multipart /edits), clamps xhigh -> high, puts refs in `images`.
    const gptReq = _test.buildPhotontideImageRequest({
        model: 'gpt-image-2.5-sunburst',
        prompt: 'poster',
        effectivePrompt: 'poster',
        ratio: '2:3',
        imageSize: '2K',
        referenceUrls: ['https://img.example/ref.png'],
        generationConfig: { gptQuality: 'xhigh', gptBackground: 'transparent' },
        resolveOpenAISize: _test.resolveOpenAIImageSize
    });
    assert.equal(gptReq.endpoint, 'generations');
    assert.deepEqual(gptReq.body, {
        model: 'gpt-image-2.5-sunburst',
        prompt: 'poster',
        size: '1344x2016',
        n: 1,
        quality: 'high',
        background: 'transparent',
        images: ['https://img.example/ref.png'],
        response_format: 'url',
        watermark: false
    });

    // gpt-image-2 forces response_format='url' per Photontide docs.
    const gpt2Req = _test.buildPhotontideImageRequest({
        model: 'gpt-image-2',
        prompt: 'couplet',
        effectivePrompt: 'couplet',
        ratio: '2:3',
        imageSize: '1K',
        generationConfig: { responseFormat: 'b64_json', gptQuality: 'high' },
        resolveOpenAISize: _test.resolveOpenAIImageSize
    });
    assert.equal(gpt2Req.body.response_format, 'url');
    assert.equal(gpt2Req.body.size, '1024x1536');

    // Nano Banana on Photontide /v1/images/generations: top-level aspectRatio + imageSize + images[].
    const nanoReq = _test.buildPhotontideImageRequest({
        model: 'nano-banana-2',
        prompt: 'scene',
        effectivePrompt: 'scene',
        ratio: '9:16',
        imageSize: '4K',
        referenceUrls: ['https://img.example/ref.png']
    });
    assert.equal(nanoReq.endpoint, 'generations');
    assert.deepEqual(nanoReq.body, {
        model: 'nano-banana-2',
        prompt: 'scene',
        aspectRatio: '9:16',
        imageSize: '4K',
        n: 1,
        response_format: 'url',
        images: ['https://img.example/ref.png']
    });

    // Qwen Image on Photontide: nested input.messages + parameters, switches to /edits with references.
    const qwenGen = _test.buildPhotontideImageRequest({
        model: 'qwen-image-plus',
        prompt: 'tea cup',
        ratio: '1:1'
    });
    assert.equal(qwenGen.endpoint, 'generations');
    assert.equal(qwenGen.body.parameters.size, '1328*1328');
    const qwenEdit = _test.buildPhotontideImageRequest({
        model: 'qwen-image-edit-plus',
        prompt: 'change cup to blue',
        referenceUrls: ['https://img.example/cup.png']
    });
    assert.equal(qwenEdit.endpoint, 'edits');
    assert.deepEqual(qwenEdit.body.input.messages[0].content, [
        { image: 'https://img.example/cup.png' },
        { text: 'change cup to blue' }
    ]);
});

test('generateImage uploads base64 references to public HTTP URLs before calling Photontide and uses red guide on mask edits', async (t) => {
    const seen = [];
    let uploadedCount = 0;
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/files/out.png') {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(PNG_1X1);
            return;
        }
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            created: 1795684000,
            model: seen.at(-1).body.model,
            data: [{ url: `http://127.0.0.1:${server.address().port}/files/out.png` }]
        }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));

    const port = server.address().port;
    // Test generatePhotontideImage end-to-end against local server with injected reference uploader.
    const out = await _test.generatePhotontideImage({
        provider: `http://127.0.0.1:${port}/v1`,
        apiKey: 'pt-test-key',
        model: 'doubao_seedream_5_5_261028',
        prompt: '缩小挂画',
        ratio: '1:1',
        imageSize: '2K',
        referenceImages: [{ base64: PNG_1X1.toString('base64'), mimeType: 'image/png' }],
        generationConfig: { gptBackground: 'transparent' }
    }, {
        uploadReference: async () => {
            uploadedCount += 1;
            return `https://cdn.example/uploaded_${uploadedCount}.png`;
        }
    });

    assert.equal(out.mimeType, 'image/png');
    assert.equal(uploadedCount, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/v1/images/generations');
    assert.equal(seen[0].auth, 'Bearer pt-test-key');
    assert.equal(seen[0].body.image, 'https://cdn.example/uploaded_1.png');
    assert.equal(seen[0].body.background, 'transparent');
    assert.equal(seen[0].body.output_format, 'png');
    assert.equal(seen[0].body.size, '2K');

    // Mask edit on Photontide GPT Image uses the red guide image (2 refs, no mask field) rather than multipart /edits.
    const sourcePng = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
    const maskRaw = Buffer.alloc(64 * 64 * 4, 255);
    for (let i = 0; i < 16 * 64; i += 1) maskRaw[i * 4 + 3] = 0; // transparent alpha = edit region
    const maskPng = await sharp(maskRaw, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();

    let capturedConfig = null;
    await generateMaskedImage({
        provider: 'https://ai.photontide.cn',
        apiKey: 'pt-test-key',
        model: 'gpt-image-2.5-flare',
        prompt: '把顶部改成蓝天',
        referenceImages: [{ base64: sourcePng.toString('base64'), mimeType: 'image/png' }],
        maskImage: { base64: maskPng.toString('base64'), mimeType: 'image/png' }
    }, {}, async (forwarded) => {
        capturedConfig = forwarded;
        return { base64: sourcePng.toString('base64'), mimeType: 'image/png' };
    });
    assert.equal(capturedConfig.maskImage, null, 'Photontide does not receive a native mask');
    assert.equal(capturedConfig.referenceImages.length, 2, 'source image + red painted guide image');
    assert.equal(capturedConfig.ratio, '1:1');
});
