const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { generateMaskedImage } = require('../maskEdit');
const { supportsOperation } = require('../protocolRouter');

const W = 16; const H = 16;
async function fixtures() {
    const source = await sharp({ create: { width: W, height: H, channels: 4, background: '#2266aa' } }).png().toBuffer();
    const maskPixels = Buffer.alloc(W * H * 4, 255);
    for (let y = 4; y < 12; y += 1) for (let x = 4; x < 12; x += 1) maskPixels[(y * W + x) * 4 + 3] = 0;
    const mask = await sharp(maskPixels, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
    const extra = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00ff00' } }).png().toBuffer();
    const generated = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ffffff' } }).png().toBuffer();
    return { source, mask, extra, generated };
}
const img = buffer => ({ base64: buffer.toString('base64'), mimeType: 'image/png' });

test('extra references ride along after the source for both native and fallback paths', async () => {
    const f = await fixtures();
    for (const [protocol, model, expected] of [['openai-images', 'gpt-image-2', 2], ['gemini-native', 'gemini-3-pro-image-preview', 3]]) {
        let request;
        await generateMaskedImage({ provider: 'https://x.invalid', protocol, model, prompt: 'p',
            referenceImages: [img(f.source), img(f.extra)], maskImage: img(f.mask) },
        {}, async config => { request = config; return img(f.generated); });
        assert.equal(request.referenceImages.length, expected, protocol);
        assert.equal(request.referenceImages[1].base64, f.extra.toString('base64'), 'extra reference kept in place');
    }
});

test('fallback guide is the source with a red translucent paint over the edit area', async () => {
    const f = await fixtures();
    let request;
    await generateMaskedImage({ provider: 'https://x.invalid', protocol: 'gemini-native', model: 'gemini-3-pro-image-preview', prompt: '换成地球',
        referenceImages: [img(f.source)], maskImage: img(f.mask) },
    {}, async config => { request = config; return img(f.generated); });
    const guide = request.referenceImages[1];
    const { data } = await sharp(Buffer.from(guide.base64, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => [...data.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
    const inside = at(8, 8); const outside = at(0, 0);
    assert.deepEqual(outside, [0x22, 0x66, 0xaa], 'outside the paint the guide equals the source');
    assert.ok(inside[0] > 140 && inside[0] > inside[2] + 20, `inside is painted red: ${inside}`);
    assert.match(request.prompt, /红色半透明涂抹/);
    assert.match(request.prompt, /换成地球/);
    assert.doesNotMatch(request.prompt, /黑白|遮罩/);
});

test('when the client already painted the marks, the server adds no guide of its own', async () => {
    const f = await fixtures();
    let request;
    const out = await generateMaskedImage({ provider: 'https://x.invalid', protocol: 'gemini-native', model: 'gemini-3-pro-image-preview', prompt: 'client prompt',
        referenceImages: [img(f.source), img(f.extra)], maskImage: { ...img(f.mask), composite: true }, maskGuideIncluded: true },
    {}, async config => { request = config; return img(f.generated); });
    assert.equal(request.referenceImages.length, 2);
    assert.equal(request.prompt, 'client prompt');
    assert.equal(out.maskApplied, true);
});

test('every protocol may run a mask edit now that the fallback covers non-native providers', () => {
    for (const [baseUrl, model] of [['https://generativelanguage.googleapis.com', 'gemini-3-pro-image-preview'], ['https://api.openai.com', 'gpt-image-2'],
        ['https://ark.cn-beijing.volces.com/api/v3', 'doubao-seedream-5-0'], ['https://grsai.dakka.com.cn', 'nano-banana-pro'], ['https://api.x.ai', 'grok-imagine-image']]) {
        assert.equal(supportsOperation({ baseUrl }, model, 'mask-edit'), true, model);
    }
    // 显式声明不支持时仍然尊重
    assert.equal(supportsOperation({ baseUrl: 'https://api.openai.com', modelCapabilities: { 'gpt-image-2': { supportsMaskEdit: false } } }, 'gpt-image-2', 'mask-edit'), false);
});

test('the guide-included flag survives the task queue by riding on maskImage', async () => {
    const f = await fixtures();
    let request;
    await generateMaskedImage({ provider: 'https://x.invalid', protocol: 'gemini-native', model: 'gemini-3-pro-image-preview', prompt: 'q',
        referenceImages: [img(f.source)], maskImage: { ...img(f.mask), guideIncluded: true } },
    {}, async config => { request = config; return img(f.generated); });
    assert.equal(request.referenceImages.length, 1);
    assert.equal(request.prompt, 'q');
});

test('non-native providers get a standard N:N ratio (Grsai and friends reject WxH)', async () => {
    const f = await fixtures();
    let native; let fallback;
    await generateMaskedImage({ provider: 'https://x.invalid', protocol: 'openai-images', model: 'gpt-image-2', prompt: 'p', referenceImages: [img(f.source)], maskImage: img(f.mask) }, {}, async c => { native = c; return img(f.generated); });
    await generateMaskedImage({ provider: 'https://x.invalid', protocol: 'grsai-nano-banana', model: 'nano-banana-pro', prompt: 'p', referenceImages: [img(f.source)], maskImage: img(f.mask) }, {}, async c => { fallback = c; return img(f.generated); });
    assert.equal(native.ratio, '16x16');
    assert.equal(fallback.ratio, '1:1');
});

test('the paste-back is inset and feathered inward: outside and the edge band stay exact, the interior is the new image', async () => {
    const S = 96;
    const source = await sharp({ create: { width: S, height: S, channels: 4, background: '#000000' } }).png().toBuffer();
    const maskPixels = Buffer.alloc(S * S * 4, 255);
    for (let y = 24; y < 72; y += 1) for (let x = 24; x < 72; x += 1) maskPixels[(y * S + x) * 4 + 3] = 0;
    const mask = await sharp(maskPixels, { raw: { width: S, height: S, channels: 4 } }).png().toBuffer();
    const generated = await sharp({ create: { width: S, height: S, channels: 4, background: '#ffffff' } }).png().toBuffer();
    const out = await generateMaskedImage({ provider: 'https://x.invalid', protocol: 'openai-images', model: 'gpt-image-2', prompt: 'p',
        referenceImages: [img(source)], maskImage: { ...img(mask), composite: true } }, {}, async () => img(generated));
    const { data } = await sharp(Buffer.from(out.base64, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => data[(y * S + x) * 3];
    assert.equal(at(10, 10), 0, 'outside untouched');
    assert.equal(at(23, 48), 0, 'just outside the edge untouched');
    // 涂抹边缘内侧 2px 留给原图：模型会把这圈画暗，贴回它就是细黑线
    assert.equal(at(24, 48), 0, 'first edge pixel keeps the original');
    assert.equal(at(25, 48), 0, 'second edge pixel keeps the original');
    assert.equal(at(48, 48), 255, 'interior fully replaced');
    assert.ok(at(26, 48) > 0 && at(26, 48) < 255, `blend starts inside the inset: ${at(26, 48)}`);
});

test('by default a non-native model output is used as-is', async () => {
    const f = await fixtures();
    const out = await generateMaskedImage({ provider: 'https://x.invalid', protocol: 'gemini-native', model: 'gemini-3-pro-image-preview', prompt: 'p',
        referenceImages: [img(f.source)], maskImage: img(f.mask) }, {}, async () => img(f.generated));
    assert.equal(out.base64, f.generated.toString('base64'), 'no paste-back: the model output is returned untouched');
    assert.equal(out.maskApplied, false);
});

test('the native mask is sent exactly as painted and the result is always pasted back (relays return only the painted area)', async () => {
    const f = await fixtures();
    let sent;
    const out = await generateMaskedImage({ provider: 'https://x.invalid', protocol: 'openai-images', model: 'gpt-image-2', prompt: 'p',
        referenceImages: [img(f.source)], maskImage: img(f.mask) }, {}, async config => { sent = config.maskImage; return img(f.generated); });
    assert.equal(sent.base64, f.mask.toString('base64'), 'no dilation: the model gets the painted area only');
    assert.equal(out.maskApplied, true);
    const { data } = await sharp(Buffer.from(out.base64, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 3)], [0x22, 0x66, 0xaa], 'outside the painted area the original is kept');
});

test('paste-back only when the strict option is on', async () => {
    const f = await fixtures();
    const strict = await generateMaskedImage({ provider: 'https://x.invalid', protocol: 'gemini-native', model: 'gemini-3-pro-image-preview', prompt: 'p',
        referenceImages: [img(f.source)], maskImage: { ...img(f.mask), composite: true } }, {}, async () => img(f.generated));
    assert.equal(strict.maskApplied, true);
    const { data } = await sharp(Buffer.from(strict.base64, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 3)], [0x22, 0x66, 0xaa], 'outside the painted area the original is kept');
});
