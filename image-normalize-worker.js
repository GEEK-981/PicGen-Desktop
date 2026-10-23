'use strict';

// Off-main-thread half of imageOutputNormalizer's resize branch.
//
// Resizing then re-encoding a 3264x2448 frame with `nativeImage` costs ~1.23 s of
// synchronous main-process time (toPNG alone is ~1.2 s of it). sharp runs the same
// operation here, on a worker thread, so the window keeps painting.

const { parentPort } = require('node:worker_threads');
const sharp = require('sharp');

function clampQuality(value) {
    const quality = Math.round(Number(value) || 95);
    return Math.max(1, Math.min(100, quality));
}

parentPort.on('message', async ({ id, source, width, height, mimeType, quality }) => {
    try {
        // `fit: 'fill'` matches what nativeImage.resize does when it is given both
        // a width and a height: the result is exactly that box, even when the
        // provider's aspect ratio is off the requested one by a fraction of a
        // percent (e.g. 3312x2480 -> 3264x2448).
        const pipeline = sharp(source, { failOn: 'none' })
            .resize({ width, height, fit: 'fill', kernel: 'lanczos3' });

        if (/^image\/jpe?g$/i.test(String(mimeType || ''))) {
            const buffer = await pipeline.jpeg({ quality: clampQuality(quality) }).toBuffer();
            parentPort.postMessage({ id, buffer, mimeType: 'image/jpeg' });
            return;
        }
        // `effort` is not optional: on a 2048x2048 photo-like frame sharp's default
        // PNG encode costs 175 ms and writes 9.49 MB — 52% LARGER than the
        // nativeImage output it replaces (6.23 MB). effort:1 costs 885 ms (on this
        // thread, so the window keeps painting) and writes 3.75 MB, which is 40%
        // smaller than nativeImage. Higher effort only buys 0.4 MB for another
        // 2.4 s of latency before the image lands in history.
        const buffer = await pipeline.png({ compressionLevel: 6, effort: 1 }).toBuffer();
        parentPort.postMessage({ id, buffer, mimeType: 'image/png' });
    } catch (error) {
        parentPort.postMessage({ id, error: error.message });
    }
});
