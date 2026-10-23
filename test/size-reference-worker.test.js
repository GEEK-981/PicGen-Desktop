const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { SizeReferenceWorker } = require('../sizeReferenceWorker');

async function product() {
    const box = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#2563EB' } }).png().toBuffer();
    return sharp({ create: { width: 400, height: 400, channels: 3, background: '#FFFFFF' } })
        .composite([{ input: box, left: 100, top: 50 }])
        .png()
        .toBuffer();
}

test('prepare caches the photo once; render works from the key alone', async () => {
    const worker = new SizeReferenceWorker();
    const prepared = await worker.prepare(await product());
    assert.match(prepared.key, /^[0-9a-f]{40}$/);
    assert.deepEqual(prepared.image, { w: 400, h: 400 });
    assert.ok(Math.abs(prepared.region.h - 300) <= 3);

    const rendered = await worker.render(prepared.key, {
        region: prepared.region, dimsMm: { heightMm: 250 }, variant: 'clean', alias: 'x'
    });
    assert.ok(Buffer.isBuffer(rendered.buffer));
    assert.equal(rendered.anchor.id, 'hand');
    assert.equal(rendered.scene, undefined, 'scene geometry stays in the worker');
    assert.equal((await sharp(rendered.buffer).metadata()).width, 2048);

    await worker.release(prepared.key);
    await assert.rejects(worker.render(prepared.key, { region: prepared.region, dimsMm: { heightMm: 250 }, variant: 'clean' }), /重新选择/);
    await worker.worker.terminate();
});

test('render errors come back as rejections without killing the worker', async () => {
    const worker = new SizeReferenceWorker();
    const prepared = await worker.prepare(await product());
    await assert.rejects(worker.render(prepared.key, { region: prepared.region, dimsMm: {}, variant: 'clean' }), /高度/);
    const ok = await worker.render(prepared.key, { region: prepared.region, dimsMm: { heightMm: 250 }, variant: 'preview' });
    assert.equal(ok.mimeType, 'image/jpeg');
    await worker.worker.terminate();
});
