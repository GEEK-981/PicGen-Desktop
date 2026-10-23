const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { ImageNormalizeWorker } = require('../imageNormalizeWorker');
const { readImageSizeFromBuffer } = require('../imageHeaderSize');
const { normalizeImage2ResultDimensions } = require('../imageOutputNormalizer');

// 3312x2480 is the real case that motivated `fit: 'fill'`: the provider returned a
// frame whose aspect ratio (1.3355) is off the requested 4:3 (1.3333) by 0.16%, and
// nativeImage.resize({width, height}) stretches to exactly the requested box. Any
// `fit` that preserves aspect ratio would land a few pixels short here.
const OFF_RATIO_SOURCE = { width: 3312, height: 2480 };
const REQUESTED = { width: 3264, height: 2448 };

async function solidPng(width, height) {
    return sharp({
        create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } }
    }).png().toBuffer();
}

function workerCodec(fallback) {
    const worker = new ImageNormalizeWorker(fallback);
    return {
        codec: {
            getSize: readImageSizeFromBuffer,
            resize: (buffer, options) => worker.resize(buffer, options)
        },
        close: () => worker.worker?.terminate()
    };
}

test('resizes an off-ratio frame to exactly the requested box', async t => {
    const { codec, close } = workerCodec(null);
    t.after(close);

    const source = await solidPng(OFF_RATIO_SOURCE.width, OFF_RATIO_SOURCE.height);
    const result = await codec.resize(source, { ...REQUESTED, mimeType: 'image/png', quality: 95 });

    assert.equal(result.mimeType, 'image/png');
    assert.deepEqual(readImageSizeFromBuffer(result.buffer), REQUESTED);
});

test('keeps JPEG input as JPEG at the requested box', async t => {
    const { codec, close } = workerCodec(null);
    t.after(close);

    const source = await sharp(await solidPng(1200, 900)).jpeg({ quality: 90 }).toBuffer();
    const result = await codec.resize(source, { width: 640, height: 480, mimeType: 'image/jpeg', quality: 88 });

    assert.equal(result.mimeType, 'image/jpeg');
    assert.deepEqual(readImageSizeFromBuffer(result.buffer), { width: 640, height: 480 });
});

test('falls back to the synchronous codec when the worker cannot do the work', async t => {
    const worker = new ImageNormalizeWorker(async (source, options) => ({
        buffer: Buffer.from(`fallback:${options.width}x${options.height}`),
        mimeType: 'image/png'
    }));
    t.after(() => worker.worker?.terminate());

    // A non-image payload makes sharp throw, which is what the fallback exists for.
    const result = await worker.resize(Buffer.from('not an image'), {
        width: 8, height: 8, mimeType: 'image/png', quality: 95
    });

    assert.equal(result.buffer.toString(), 'fallback:8x8');
});

// `error` clears the client, so the next resize() spawns a replacement immediately — and the
// dead thread's `exit` lands after that. A stale report must not reach the successor's
// requests, or a healthy worker is orphaned and the image falls back to the 1.2 s synchronous
// encode on the main thread.
test('a dying worker cannot reject requests that belong to its replacement', async t => {
    // No fallback on purpose: resize() swallows a rejection into the synchronous codec
    // when one is configured, which would hide the very failure this test is about.
    const worker = new ImageNormalizeWorker(null);
    t.after(() => worker.worker?.terminate());

    const box = { width: 300, height: 200, mimeType: 'image/png', quality: 95 };
    const source = await solidPng(600, 400);

    // 1) The first worker dies mid-request; its own request is correctly rejected.
    const first = worker.resize(source, box);
    const dead = worker.worker;
    dead.emit('error', new Error('worker died'));
    await assert.rejects(first, /worker died/);
    assert.equal(worker.worker, null, 'a dead worker must not be reused');

    // 2) The successor takes a request. resize() posts synchronously, so the reply cannot
    //    have arrived by the time the next statement runs.
    const second = worker.resize(source, box);
    const replacement = worker.worker;
    assert.notEqual(replacement, dead, 'the second request must use a new thread');

    // 3) The dead worker's `exit` finally arrives. It owns nothing any more.
    dead.emit('exit', 1);

    const result = await second;
    assert.equal(worker.worker, replacement, 'the replacement must remain the current worker');
    assert.deepEqual(readImageSizeFromBuffer(result.buffer), { width: 300, height: 200 });
});

test('normalization reports the requested dimensions end to end', async t => {
    const { codec, close } = workerCodec(null);
    t.after(close);

    const source = await solidPng(OFF_RATIO_SOURCE.width, OFF_RATIO_SOURCE.height);
    const result = await normalizeImage2ResultDimensions({
        model: 'gpt-image-2',
        ratio: '4:3',
        imageSize: 'custom',
        generationConfig: { gptImageWidth: REQUESTED.width, gptImageHeight: REQUESTED.height }
    }, {
        base64: source.toString('base64'),
        mimeType: 'image/png'
    }, codec);

    assert.equal(result.dimensionAdjusted, true);
    assert.equal(result.sourceWidth, OFF_RATIO_SOURCE.width);
    assert.equal(result.sourceHeight, OFF_RATIO_SOURCE.height);
    assert.equal(result.width, REQUESTED.width);
    assert.equal(result.height, REQUESTED.height);
    assert.deepEqual(readImageSizeFromBuffer(Buffer.from(result.base64, 'base64')), REQUESTED);
});
