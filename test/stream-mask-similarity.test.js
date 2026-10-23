const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const { readPromptStream } = require('../promptStream');
const { generateMaskedImage } = require('../maskEdit');
const event = data => `data: ${JSON.stringify(data)}\r\n\r\n`;

test('SSE streams decode split UTF-8, CRLF, metadata, and complete incrementally', async () => {
    const wire = Buffer.from(':keepalive\r\n\r\n' + event({ choices: [{ delta: { content: '你好🌟' } }] })
        + event({ choices: [{ delta: { content: '世界' } }] }) + 'data: [DONE]\r\n\r\n');
    const chunks = Array.from(wire, byte => Buffer.from([byte]));
    const deltas = [];
    assert.deepEqual(await readPromptStream(Readable.from(chunks), 'openai', text => deltas.push(text)), { text: '你好🌟世界' });
    assert.deepEqual(deltas, ['你好🌟', '世界']);
});
test('Gemini and Claude streams exclude reasoning and return text deltas', async () => {
    const gemini = event({ candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'visible' }] } }] })
        + event({ candidates: [{ finishReason: 'STOP' }] });
    assert.equal((await readPromptStream(Readable.from([Buffer.from(gemini)]), 'gemini', () => {})).text, 'visible');
    const claude = event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } })
        + event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'visible' } }) + event({ type: 'message_stop' });
    assert.equal((await readPromptStream(Readable.from([Buffer.from(claude)]), 'claude', () => {})).text, 'visible');
});
test('truncated, malformed and provider-error streams never become successful results', async () => {
    for (const wire of [event({ choices: [{ delta: { content: 'partial' } }] }), 'data: {invalid}\n\n', event({ error: { message: 'quota' } })]) {
        await assert.rejects(readPromptStream(Readable.from([Buffer.from(wire)]), 'openai', () => {}));
    }
});

test('mask edits preserve untouched pixels and use the correct native/visual input contract', async () => {
    const width = 16, height = 16;
    const source = await sharp({ create: { width, height, channels: 4, background: '#ca3412' } }).png().toBuffer();
    const maskPixels = Buffer.alloc(width * height * 4, 255);
    for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) maskPixels[(y * width + x) * 4 + 3] = 0;
    const mask = await sharp(maskPixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const generated = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#145abc' } }).png().toBuffer();
    for (const protocol of ['openai-images', 'gemini-native']) {
        let request;
        const output = await generateMaskedImage({ provider: 'https://example.invalid', protocol, model: protocol === 'openai-images' ? 'gpt-image-1' : 'gemini-image',
            prompt: 'edit', referenceImages: [{ base64: source.toString('base64'), mimeType: 'image/png' }],
            maskImage: { base64: mask.toString('base64'), mimeType: 'image/png', composite: true }
        }, {}, async config => { request = config; return { base64: generated.toString('base64'), mimeType: 'image/png' }; });
        assert.equal(request.referenceImages.length, protocol === 'openai-images' ? 1 : 2);
        assert.equal(!!request.maskImage, protocol === 'openai-images');
        const { data, info } = await sharp(Buffer.from(output.base64, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(info.width, width); assert.equal(info.height, height);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const pixel = [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
            // 贴回先内收 2px 再向内羽化：涂抹区外和边缘内侧 2px 必须原样，涂抹区内部是新图，中间是过渡
            const kept = !(x >= 4 && x < 12 && y >= 4 && y < 12);
            const interior = x >= 7 && x < 9 && y >= 7 && y < 9;
            if (kept) assert.deepEqual(pixel, [202, 52, 18, 255]);
            else if (interior) assert.deepEqual(pixel, [20, 90, 188, 255]);
        }
    }
});
test('invalid and empty masks are rejected before contacting a provider', async () => {
    const base64 = (await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ffffff' } }).png().toBuffer()).toString('base64');
    let calls = 0;
    await assert.rejects(generateMaskedImage({ referenceImages: [{ base64 }], maskImage: { base64 } }, {}, () => { calls++; }), /涂抹/);
    assert.equal(calls, 0);
});
