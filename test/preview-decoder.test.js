const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { PreviewDecoder } = require('../previewDecoder');

async function temporaryDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-preview-decoder-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

// Left half fully transparent, right half opaque red: flattening must turn only the left half white.
async function halfTransparentPng(width, height) {
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            if (x >= width / 2) pixels.set([220, 30, 20, 255], offset);
        }
    }
    return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function pixelAt(buffer, x, y) {
    const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const offset = (y * info.width + x) * info.channels;
    return [...data.subarray(offset, offset + 3)];
}

test('jpeg thumbnails flatten transparency onto white and fit the maximum size', async t => {
    const directory = await temporaryDirectory(t);
    const source = path.join(directory, 'transparent.png');
    await fs.writeFile(source, await halfTransparentPng(800, 400));
    let fallbackCalls = 0;
    const decoder = new PreviewDecoder(async () => { fallbackCalls++; throw new Error('fallback must not run'); });

    const jpeg = await decoder.thumbnailJpeg(source, 360);
    assert.ok(Buffer.isBuffer(jpeg));
    assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, 360);
    assert.equal(meta.height, 180);
    assert.equal(meta.hasAlpha, false);
    for (const channel of await pixelAt(jpeg, 40, 90)) assert.ok(channel >= 250, `transparent area should be white, got ${channel}`);
    const [red, green, blue] = await pixelAt(jpeg, 320, 90);
    assert.ok(red > 180 && green < 80 && blue < 80, `opaque area should stay red, got ${[red, green, blue]}`);
    assert.equal(fallbackCalls, 0);
});

test('jpeg thumbnails never enlarge and honour EXIF orientation', async t => {
    const directory = await temporaryDirectory(t);
    const small = path.join(directory, 'small.png');
    await fs.writeFile(small, await halfTransparentPng(120, 60));
    const rotated = path.join(directory, 'rotated.jpg');
    await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 30, g: 120, b: 200 } } })
        .jpeg().withMetadata({ orientation: 6 }).toFile(rotated);
    const decoder = new PreviewDecoder();

    const smallMeta = await sharp(await decoder.thumbnailJpeg(small, 360)).metadata();
    assert.deepEqual([smallMeta.width, smallMeta.height], [120, 60]);
    const rotatedMeta = await sharp(await decoder.thumbnailJpeg(rotated, 360)).metadata();
    assert.deepEqual([rotatedMeta.width, rotatedMeta.height], [180, 360]);
    assert.ok(!rotatedMeta.orientation || rotatedMeta.orientation === 1);
});

test('an undecodable source rejects the jpeg request instead of using the PNG fallback', async t => {
    const directory = await temporaryDirectory(t);
    const broken = path.join(directory, 'broken.png');
    await fs.writeFile(broken, Buffer.from('not an image at all'));
    let fallbackCalls = 0;
    const decoder = new PreviewDecoder(async () => { fallbackCalls++; return null; });
    await assert.rejects(decoder.thumbnailJpeg(broken, 360));
    assert.equal(fallbackCalls, 0);
    // The worker survives a failed request and keeps serving.
    const good = path.join(directory, 'good.png');
    await fs.writeFile(good, await halfTransparentPng(64, 64));
    const meta = await sharp(await decoder.thumbnailJpeg(good, 32)).metadata();
    assert.deepEqual([meta.width, meta.height], [32, 32]);
});

test('the PNG preview path is unchanged', async t => {
    const directory = await temporaryDirectory(t);
    const source = path.join(directory, 'preview.png');
    await fs.writeFile(source, await halfTransparentPng(500, 250));
    const decoder = new PreviewDecoder();
    const image = await decoder.decode(source, { width: 100, height: 100 });
    assert.equal(image.isEmpty(), false);
    assert.deepEqual(image.getSize(), { width: 100, height: 50 });
    const png = image.toPNG();
    const meta = await sharp(png).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.hasAlpha, true);
    const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    assert.equal(data[3], 0, 'the PNG path keeps transparency');
});
