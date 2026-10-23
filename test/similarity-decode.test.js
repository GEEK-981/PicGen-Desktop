// similarityDecode.js: the sharp decode that feeds both the H colour features (rgb64) and the
// DINOv2 embedder (rgb224). Synthetic fixtures only, written to a temp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { createDecoder, RGB64_BYTES, RGB224_BYTES } = require('../similarityDecode');

const RED = { r: 220, g: 40, b: 40 };
const BLUE = { r: 40, g: 40, b: 220 };
const GREEN = { r: 30, g: 160, b: 60 };
const YELLOW = { r: 230, g: 200, b: 40 };

let dir;
const fixtures = {};

function solid(width, height, colour, channels = 3) {
    return sharp({
        create: { width, height, channels, background: channels === 4 ? { ...colour, alpha: 1 } : colour }
    });
}

async function writeFixtures() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-sim-decode-'));
    const file = name => path.join(dir, name);

    // Opaque 600x300 PNG: left half red, right half blue.
    const left = await solid(300, 300, RED).png().toBuffer();
    fixtures.opaque = file('opaque.png');
    const composed = await solid(600, 300, BLUE)
        .composite([{ input: left, left: 0, top: 0 }])
        .raw().toBuffer({ resolveWithObject: true });
    // composite() adds an alpha band; drop it so the PNG header really says "opaque".
    await sharp(composed.data, { raw: composed.info }).removeAlpha().png().toFile(fixtures.opaque);

    // RGBA 600x300 PNG: left half fully transparent (black under alpha 0), right half opaque green.
    const rgba = Buffer.alloc(600 * 300 * 4);
    for (let y = 0; y < 300; y++) {
        for (let x = 300; x < 600; x++) {
            const i = (y * 600 + x) * 4;
            rgba[i] = GREEN.r; rgba[i + 1] = GREEN.g; rgba[i + 2] = GREEN.b; rgba[i + 3] = 255;
        }
    }
    fixtures.rgba = file('rgba.png');
    await sharp(rgba, { raw: { width: 600, height: 300, channels: 4 } }).png().toFile(fixtures.rgba);

    // Semi-transparent 600x300 PNG: colour texture under a horizontal alpha ramp. Resizing
    // premultiplies internally, so this is the fixture that catches a premultiplied mix-up.
    const ramp = Buffer.alloc(600 * 300 * 4);
    for (let y = 0; y < 300; y++) {
        for (let x = 0; x < 600; x++) {
            const i = (y * 600 + x) * 4;
            ramp[i] = x % 256; ramp[i + 1] = y % 256; ramp[i + 2] = (x * y) % 256;
            ramp[i + 3] = Math.round(255 * x / 599);
        }
    }
    fixtures.ramp = file('ramp.png');
    await sharp(ramp, { raw: { width: 600, height: 300, channels: 4 } }).png().toFile(fixtures.ramp);

    // History-style 360x180 JPEGs: one matching the opaque original, one deliberately yellow
    // so a test can tell which source the pixels came from.
    fixtures.jpeg = file('history.jpg');
    await sharp(fixtures.opaque).resize(360, 180).jpeg({ quality: 78 }).toFile(fixtures.jpeg);
    fixtures.yellowJpeg = file('yellow.jpg');
    await solid(360, 180, YELLOW).jpeg({ quality: 78 }).toFile(fixtures.yellowJpeg);

    // Greyscale originals (1 channel, and grey + alpha with a transparent left half).
    fixtures.grey = file('grey.png');
    await sharp(Buffer.alloc(400 * 200, 100), { raw: { width: 400, height: 200, channels: 1 } })
        .toColourspace('b-w').png().toFile(fixtures.grey);
    const greyAlpha = Buffer.alloc(400 * 200 * 2);
    for (let i = 0; i < 400 * 200; i++) {
        greyAlpha[2 * i] = 100;
        greyAlpha[2 * i + 1] = i % 400 < 200 ? 0 : 255;
    }
    fixtures.greyAlpha = file('grey-alpha.png');
    await sharp(greyAlpha, { raw: { width: 400, height: 200, channels: 2 } })
        .toColourspace('b-w').png().toFile(fixtures.greyAlpha);

    // Small opaque 100x50 PNG with texture: source B must enlarge it to 256x128 first, and the
    // texture makes an un-enlarged decode differ from the enlarged one.
    const small = Buffer.alloc(100 * 50 * 3);
    for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 100; x++) {
            const i = (y * 100 + x) * 3;
            small[i] = (x * 5) % 256; small[i + 1] = (y * 11) % 256; small[i + 2] = ((x ^ y) * 7) % 256;
        }
    }
    fixtures.small = file('small.png');
    await sharp(small, { raw: { width: 100, height: 50, channels: 3 } }).png().toFile(fixtures.small);

    // 400x200 JPEG (left red, right blue) tagged EXIF orientation 6. A viewer would show it
    // rotated to 200x400; the decode must not.
    const halves = Buffer.alloc(400 * 200 * 3);
    for (let i = 0; i < 400 * 200; i++) {
        const colour = i % 400 < 200 ? RED : BLUE;
        halves[3 * i] = colour.r; halves[3 * i + 1] = colour.g; halves[3 * i + 2] = colour.b;
    }
    fixtures.oriented = file('oriented.jpg');
    await sharp(halves, { raw: { width: 400, height: 200, channels: 3 } })
        .jpeg({ quality: 90 })
        .withMetadata({ orientation: 6 })
        .toFile(fixtures.oriented);

    fixtures.corrupt = file('corrupt.png');
    fs.writeFileSync(fixtures.corrupt, Buffer.from('this is not an image, only some bytes'.repeat(20)));
    fixtures.corruptJpeg = file('corrupt.jpg');
    fs.writeFileSync(fixtures.corruptJpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]));
}

test.before(writeFixtures);
test.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function pixel(buffer, width, x, y) {
    const i = (y * width + x) * 3;
    return [buffer[i], buffer[i + 1], buffer[i + 2]];
}

function assertWhite(buffer, width, x, y, label) {
    assert.deepEqual(pixel(buffer, width, x, y), [255, 255, 255], `${label} (${x},${y}) should be white`);
}

// Source B feeds rgb224 through a JPEG q88 round trip, so white that was in the image (a
// flattened transparent area) may come back as 254. White padding is added after the round
// trip and stays exactly 255 (see assertWhite).
function assertNearWhite(buffer, width, x, y, label) {
    const value = pixel(buffer, width, x, y);
    assert.ok(value.every(v => v >= 254), `${label} (${x},${y}) = ${value} should be white (>= 254)`);
}

// The reference chains, written out literally so the tests do not share code with the module.
function referenceRgb64(image) {
    return image.flatten({ background: '#ffffff' }).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
}

function referenceRgb224(image) {
    return image.flatten({ background: '#ffffff' }).removeAlpha()
        .resize(224, 224, { fit: 'contain', background: { r: 255, g: 255, b: 255 }, kernel: 'cubic' })
        .raw().toBuffer();
}

// Source B as adopted after gate O1 (WP6): rgb64 straight from the 256px intermediate,
// rgb224 from an in-memory JPEG q88 of that intermediate flattened on white.
async function referenceSourceB(intermediate) {
    const jpeg88 = await sharp(intermediate).flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
    return {
        rgb64: await referenceRgb64(sharp(intermediate)),
        rgb224: await referenceRgb224(sharp(jpeg88))
    };
}

test('exports the exact buffer sizes of the two outputs', () => {
    assert.equal(RGB64_BYTES, 64 * 64 * 3);
    assert.equal(RGB224_BYTES, 224 * 224 * 3);
});

test('probe reads alpha, size and format from the header', async () => {
    const decoder = createDecoder({ sharp });
    assert.deepEqual(await decoder.probe(fixtures.opaque), { hasAlpha: false, width: 600, height: 300, format: 'png' });
    assert.deepEqual(await decoder.probe(fixtures.rgba), { hasAlpha: true, width: 600, height: 300, format: 'png' });
    assert.deepEqual(await decoder.probe(fixtures.jpeg), { hasAlpha: false, width: 360, height: 180, format: 'jpeg' });
    assert.equal((await decoder.probe(fixtures.greyAlpha)).hasAlpha, true);
});

test('the history JPEG is the source only when a JPEG is given and the original has no alpha', async () => {
    const decoder = createDecoder({ sharp });
    const decode = input => decoder.decode({ originalPath: fixtures.opaque, ...input });

    const fromJpeg = await decode({ jpegPath: fixtures.yellowJpeg, hasAlpha: false });
    assert.equal(fromJpeg.source, 'jpeg360');
    assert.equal(fromJpeg.originalHasAlpha, false);
    // Every pixel is the JPEG's yellow, none is the original's red or blue.
    for (const [x, y] of [[4, 4], [16, 32], [48, 32], [60, 60]]) {
        const [r, g, b] = pixel(fromJpeg.rgb64, 64, x, y);
        assert.ok(r > 200 && g > 170 && b < 90, `rgb64 (${x},${y}) = ${[r, g, b]} is not the JPEG's yellow`);
    }

    assert.equal((await decode({ jpegPath: fixtures.yellowJpeg, hasAlpha: true })).source, 'original');
    assert.equal((await decode({ jpegPath: null, hasAlpha: false })).source, 'original');
    assert.equal((await decode({ jpegPath: fixtures.yellowJpeg })).source, 'original', 'unknown alpha is never reused');

    const fromOriginal = await decode({ jpegPath: null, hasAlpha: false });
    assert.deepEqual(pixel(fromOriginal.rgb64, 64, 8, 32).map(v => v > 150), [true, false, false], 'left half is red');
    assert.deepEqual(pixel(fromOriginal.rgb64, 64, 56, 32).map(v => v > 150), [false, false, true], 'right half is blue');
});

test('transparent areas become white in both outputs', async () => {
    const decoder = createDecoder({ sharp });
    const result = await decoder.decode({ originalPath: fixtures.rgba, jpegPath: fixtures.jpeg, hasAlpha: true });
    assert.equal(result.source, 'original');
    assert.equal(result.originalHasAlpha, true);

    for (const [x, y] of [[0, 0], [8, 32], [20, 63], [28, 10]]) assertWhite(result.rgb64, 64, x, y, 'rgb64');
    const [r, g, b] = pixel(result.rgb64, 64, 50, 32);
    assert.ok(g > 120 && r < 80 && b < 100, `opaque half stays green, got ${[r, g, b]}`);

    // 2:1 content sits in rows 56..167 of the 224 square; its left half was transparent. The
    // JPEG round trip in front of rgb224 may turn that white into 254, never darker.
    for (let y = 56; y < 168; y += 4) {
        for (let x = 0; x < 100; x += 4) assertNearWhite(result.rgb224, 224, x, y, 'rgb224');
    }
    assert.ok(pixel(result.rgb224, 224, 170, 112)[1] > 120, 'opaque half of rgb224 stays green');

    const grey = await decoder.decode({ originalPath: fixtures.greyAlpha, jpegPath: null, hasAlpha: true });
    assertWhite(grey.rgb64, 64, 8, 32, 'grey rgb64');
    assertNearWhite(grey.rgb224, 224, 40, 112, 'grey rgb224');
    assert.deepEqual(pixel(grey.rgb64, 64, 56, 32), [100, 100, 100]);
});

test('a 2:1 input is padded with white to the 224 square', async () => {
    // The padding is added after source B's JPEG round trip, so it is exactly 255 either way.
    const decoder = createDecoder({ sharp });
    for (const input of [
        { originalPath: fixtures.opaque, jpegPath: null, hasAlpha: false },
        { originalPath: fixtures.opaque, jpegPath: fixtures.jpeg, hasAlpha: false }
    ]) {
        const { rgb224, source } = await decoder.decode(input);
        for (const [x, y] of [[0, 0], [223, 0], [0, 223], [223, 223]]) assertWhite(rgb224, 224, x, y, `${source} corner`);
        for (let x = 0; x < 224; x += 37) {
            assertWhite(rgb224, 224, x, 20, `${source} top pad`);
            assertWhite(rgb224, 224, x, 204, `${source} bottom pad`);
        }
        const [r, g] = pixel(rgb224, 224, 40, 112);
        assert.ok(r > 150 && g < 100, `${source} content is not padding`);
    }
});

test('buffer sizes are exact and logR is ln(w/h) of the intermediate', async () => {
    const decoder = createDecoder({ sharp });
    const cases = [
        [{ originalPath: fixtures.opaque, jpegPath: fixtures.jpeg, hasAlpha: false }, 'jpeg360'],
        [{ originalPath: fixtures.opaque, jpegPath: null, hasAlpha: false }, 'original'],
        [{ originalPath: fixtures.rgba, jpegPath: null, hasAlpha: true }, 'original'],
        [{ originalPath: fixtures.grey, jpegPath: null, hasAlpha: false }, 'original'],
        [{ originalPath: fixtures.greyAlpha, jpegPath: null, hasAlpha: true }, 'original']
    ];
    for (const [input, source] of cases) {
        const result = await decoder.decode(input);
        assert.equal(result.source, source);
        assert.equal(result.rgb64.length, 12288, `${path.basename(input.originalPath)} rgb64`);
        assert.equal(result.rgb224.length, 150528, `${path.basename(input.originalPath)} rgb224`);
        assert.ok(Math.abs(result.logR - Math.LN2) <= 0.01, `logR ${result.logR} for ${path.basename(input.originalPath)}`);
    }
});

test('source B matches the gated chain exactly: 256px intermediate, JPEG q88 in front of rgb224, alpha included', async () => {
    // The H evaluation ran its chains on a 256px `fit:inside` thumbnail; the DINOv2 tuning
    // embeddings came from JPEG q88 thumbnails, which gate O1 (WP6) showed must be reproduced.
    // The reference here writes the 256px intermediate as a PNG: the module keeps it raw, and
    // must read it back as straight (not premultiplied) alpha or semi-transparent pixels drift.
    const decoder = createDecoder({ sharp });
    for (const original of [fixtures.ramp, fixtures.rgba, fixtures.opaque]) {
        const thumb = await sharp(original, { failOn: 'none' }).resize(256, 256, { fit: 'inside' }).png().toBuffer();
        const expected = await referenceSourceB(thumb);
        const result = await decoder.decode({ originalPath: original, jpegPath: null, hasAlpha: original !== fixtures.opaque });
        assert.ok(result.rgb64.equals(expected.rgb64), `rgb64 differs for ${path.basename(original)}`);
        assert.ok(result.rgb224.equals(expected.rgb224), `rgb224 differs for ${path.basename(original)}`);
    }

    // The round trip is real: without it the textured fixture's rgb224 would be different.
    const thumb = await sharp(fixtures.ramp, { failOn: 'none' }).resize(256, 256, { fit: 'inside' }).png().toBuffer();
    const direct = await referenceRgb224(sharp(thumb));
    const result = await decoder.decode({ originalPath: fixtures.ramp, jpegPath: null, hasAlpha: true });
    assert.ok(!result.rgb224.equals(direct), 'rgb224 must come from the JPEG q88 round trip');
});

test('source B enlarges a small original to the 256px intermediate before both chains', async () => {
    // `fit:'inside'` without `withoutEnlargement`: a 100x50 original becomes 256x128 first.
    const decoder = createDecoder({ sharp });
    const enlarged = await sharp(fixtures.small, { failOn: 'none' })
        .resize(256, 256, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
    assert.deepEqual([enlarged.info.width, enlarged.info.height], [256, 128]);
    const expected = await referenceSourceB(enlarged.data);

    const result = await decoder.decode({ originalPath: fixtures.small, jpegPath: null, hasAlpha: false });
    assert.equal(result.source, 'original');
    assert.ok(Math.abs(result.logR - Math.LN2) <= 0.01, `logR ${result.logR}`);
    assert.ok(result.rgb64.equals(expected.rgb64), 'rgb64 differs from the enlarged reference');
    assert.ok(result.rgb224.equals(expected.rgb224), 'rgb224 differs from the enlarged reference');
    // The 2:1 content fills the full 224 width (columns 0 and 223 are content, not padding).
    for (const x of [0, 223]) {
        assert.notDeepEqual(pixel(result.rgb224, 224, x, 112), [255, 255, 255], `column ${x} is content`);
    }

    // Guard against `withoutEnlargement`: decoding the 100x50 original as is gives other pixels.
    const kept = await sharp(fixtures.small, { failOn: 'none' })
        .resize(256, 256, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const unenlarged = await referenceSourceB(kept);
    assert.ok(!result.rgb224.equals(unenlarged.rgb224), 'rgb224 must come from the enlarged intermediate');
});

test('EXIF orientation is ignored: an orientation-6 JPEG is decoded as stored, not rotated', async () => {
    const decoder = createDecoder({ sharp });
    const meta = await sharp(fixtures.oriented).metadata();
    assert.equal(meta.orientation, 6, 'fixture carries EXIF orientation 6');

    // Source B: the oriented JPEG is the original.
    const stored = await sharp(fixtures.oriented, { failOn: 'none' })
        .resize(256, 256, { fit: 'inside' }).png().toBuffer();
    const expected = await referenceSourceB(stored);
    const fromOriginal = await decoder.decode({ originalPath: fixtures.oriented, jpegPath: null, hasAlpha: false });
    assert.equal(fromOriginal.source, 'original');
    assert.ok(Math.abs(fromOriginal.logR - Math.LN2) <= 0.01, `logR ${fromOriginal.logR} (rotated would be -ln 2)`);
    assert.ok(fromOriginal.rgb64.equals(expected.rgb64), 'rgb64 differs from the un-rotated reference');
    assert.ok(fromOriginal.rgb224.equals(expected.rgb224), 'rgb224 differs from the un-rotated reference');
    // Stored layout: red on the left, blue on the right (rotated, they would be top and bottom).
    assert.deepEqual(pixel(fromOriginal.rgb64, 64, 8, 32).map(v => v > 150), [true, false, false], 'left is red');
    assert.deepEqual(pixel(fromOriginal.rgb64, 64, 56, 32).map(v => v > 150), [false, false, true], 'right is blue');

    const rotated = await referenceSourceB(await sharp(fixtures.oriented, { failOn: 'none' })
        .rotate().resize(256, 256, { fit: 'inside' }).png().toBuffer());
    assert.ok(!fromOriginal.rgb64.equals(rotated.rgb64), 'rgb64 must not match the rotated decode');

    // Source A: the oriented JPEG is the history thumbnail.
    const fromJpeg = await decoder.decode({ originalPath: fixtures.opaque, jpegPath: fixtures.oriented, hasAlpha: false });
    assert.equal(fromJpeg.source, 'jpeg360');
    assert.ok(Math.abs(fromJpeg.logR - Math.LN2) <= 0.01, `source A logR ${fromJpeg.logR}`);
    assert.ok(fromJpeg.rgb64.equals(await referenceRgb64(sharp(fixtures.oriented))), 'source A rgb64 is not rotated');
    assert.ok(fromJpeg.rgb224.equals(await referenceRgb224(sharp(fixtures.oriented))), 'source A rgb224 is not rotated');
});

test('source A runs the two chains on the history JPEG', async () => {
    const decoder = createDecoder({ sharp });
    const rgb64 = await sharp(fixtures.jpeg).flatten({ background: '#ffffff' })
        .resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const rgb224 = await sharp(fixtures.jpeg).flatten({ background: '#ffffff' }).removeAlpha()
        .resize(224, 224, { fit: 'contain', background: { r: 255, g: 255, b: 255 }, kernel: 'cubic' })
        .raw().toBuffer();
    const result = await decoder.decode({ originalPath: fixtures.opaque, jpegPath: fixtures.jpeg, hasAlpha: false });
    assert.equal(result.source, 'jpeg360');
    assert.ok(result.rgb64.equals(rgb64));
    assert.ok(result.rgb224.equals(rgb224));
});

test('a corrupt original rejects', async () => {
    const decoder = createDecoder({ sharp });
    await assert.rejects(decoder.decode({ originalPath: fixtures.corrupt, jpegPath: null, hasAlpha: false }));
    await assert.rejects(decoder.decode({ originalPath: path.join(dir, 'missing.png'), jpegPath: null, hasAlpha: false }));
    await assert.rejects(decoder.probe(fixtures.corrupt));
});

test('an unreadable history JPEG falls back to the original', async () => {
    const decoder = createDecoder({ sharp });
    const result = await decoder.decode({ originalPath: fixtures.opaque, jpegPath: fixtures.corruptJpeg, hasAlpha: false });
    assert.equal(result.source, 'original');
    assert.equal(result.rgb64.length, 12288);
    const gone = await decoder.decode({ originalPath: fixtures.opaque, jpegPath: path.join(dir, 'gone.jpg'), hasAlpha: false });
    assert.equal(gone.source, 'original');
});

test('the decoder never touches sharp global settings', async () => {
    const calls = [];
    const spy = (...args) => sharp(...args);
    spy.cache = (...args) => { calls.push(['cache', args]); };
    spy.concurrency = (...args) => { calls.push(['concurrency', args]); };
    spy.simd = (...args) => { calls.push(['simd', args]); };
    const decoder = createDecoder({ sharp: spy });
    await decoder.probe(fixtures.opaque);
    await decoder.decode({ originalPath: fixtures.opaque, jpegPath: fixtures.jpeg, hasAlpha: false });
    await decoder.decode({ originalPath: fixtures.rgba, jpegPath: null, hasAlpha: true });
    assert.deepEqual(calls, []);
});
