const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const sharp = require('sharp');

const {
    colourFeatures,
    phash256,
    toNchw,
    poolTokens,
    quantizeEmbedding,
    packRow,
    unpackRow,
    crc32,
    ROW_BYTES,
    OFFSETS,
    FLAGS,
    H_VERSION,
    EMB_VERSION_BASE
} = require('../similarityFeatures');

function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function solid(r, g, b, size = 64) {
    const buffer = Buffer.alloc(size * size * 3);
    for (let i = 0; i < size * size; i++) {
        buffer[3 * i] = r;
        buffer[3 * i + 1] = g;
        buffer[3 * i + 2] = b;
    }
    return buffer;
}

function randomRgb(seed, size = 64) {
    const rand = mulberry32(seed);
    return Buffer.from(Array.from({ length: size * size * 3 }, () => Math.floor(rand() * 256)));
}

function sumSquares(values) {
    let total = 0;
    for (const value of values) total += value * value;
    return total;
}

// A synthetic scene with energy across the whole low-frequency band: random 12x12
// pixels upscaled to 256x256. (A plain gradient leaves most of the 16x16 DCT block
// near zero, where the median threshold is noise.)
function syntheticScene(seed, size = 256) {
    const rand = mulberry32(seed);
    const small = Buffer.from(Array.from({ length: 12 * 12 * 3 }, () => Math.floor(rand() * 256)));
    return sharp(small, { raw: { width: 12, height: 12, channels: 3 } })
        .resize(size, size, { fit: 'fill', kernel: 'cubic' })
        .raw()
        .toBuffer();
}

async function to64(raw, size, via) {
    let pipeline = sharp(raw, { raw: { width: size, height: size, channels: 3 } });
    if (via) {
        const mid = await pipeline.resize(via, via, { fit: 'fill' }).raw().toBuffer();
        pipeline = sharp(mid, { raw: { width: via, height: via, channels: 3 } });
    }
    return pipeline.resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
}

function popcount(words) {
    let total = 0;
    for (const word of words) {
        let x = word >>> 0;
        while (x) {
            x &= x - 1;
            total++;
        }
    }
    return total;
}

function hamming(a, b) {
    return popcount(Array.from(a, (word, i) => (word ^ b[i]) >>> 0));
}

// --- colour features ---------------------------------------------------------

test('a pure-white buffer gives whiteFrac 1 and unit-norm sqrt histograms', () => {
    const features = colourFeatures(solid(255, 255, 255));
    assert.equal(features.hsv.length, 128);
    assert.equal(features.lab.length, 256);
    assert.equal(features.layout.length, 48);
    assert.ok(features.hsv instanceof Float32Array);
    assert.ok(features.lab instanceof Float32Array);
    assert.ok(features.layout instanceof Float32Array);
    assert.equal(features.whiteFrac, 1);
    assert.ok(Math.abs(sumSquares(features.hsv) - 1) < 1e-6);
    assert.ok(Math.abs(sumSquares(features.lab) - 1) < 1e-6);
});

test('histograms sum to 1 (sqrt rows have unit norm) on random pixels', () => {
    for (const seed of [11, 12, 13]) {
        const features = colourFeatures(randomRgb(seed));
        // The rows hold sqrt(p); their squares are the histogram, which must sum to 1.
        assert.ok(Math.abs(sumSquares(features.hsv) - 1) < 1e-5);
        assert.ok(Math.abs(sumSquares(features.lab) - 1) < 1e-5);
        assert.ok(features.hsv.every(v => v >= 0 && v <= 1));
        assert.ok(features.whiteFrac >= 0 && features.whiteFrac < 0.5);
    }
});

test('whiteFrac counts only the near-white Lab bins', () => {
    const half = solid(255, 255, 255);
    for (let i = 0; i < 64 * 32; i++) half[3 * i] = half[3 * i + 1] = half[3 * i + 2] = 0;
    assert.equal(colourFeatures(half).whiteFrac, 0.5);
    assert.equal(colourFeatures(solid(0, 0, 0)).whiteFrac, 0);
    assert.equal(colourFeatures(solid(255, 0, 0)).whiteFrac, 0);
});

test('layout holds the mean Lab of each 4x4 cell on synthetic quadrants', () => {
    const colours = {
        tl: [255, 0, 0],
        tr: [0, 255, 0],
        bl: [0, 0, 255],
        br: [255, 255, 255]
    };
    // Textbook sRGB (D65) Lab values; the port uses rounded matrix constants, hence the tolerance.
    const lab = {
        tl: [53.24, 80.09, 67.20],
        tr: [87.73, -86.18, 83.18],
        bl: [32.30, 79.19, -107.86],
        br: [100, 0, 0]
    };
    const buffer = Buffer.alloc(64 * 64 * 3);
    for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
            const quadrant = (y < 32 ? 't' : 'b') + (x < 32 ? 'l' : 'r');
            buffer.set(colours[quadrant], (y * 64 + x) * 3);
        }
    }
    const { layout } = colourFeatures(buffer);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            const quadrant = (row < 2 ? 't' : 'b') + (col < 2 ? 'l' : 'r');
            const cell = (row * 4 + col) * 3;
            for (let k = 0; k < 3; k++) {
                const got = layout[cell + k];
                const want = lab[quadrant][k];
                assert.ok(Math.abs(got - want) < 0.3, `cell ${row},${col} channel ${k}: ${got} vs ${want}`);
            }
        }
    }
});

test('colourFeatures rejects a buffer of the wrong size', () => {
    assert.throws(() => colourFeatures(Buffer.alloc(100)), /64x64/);
});

// The single histogram bin a one-colour buffer lands in.
function onlyBin(values) {
    const hit = Array.from(values).flatMap((value, i) => (value > 0 ? [i] : []));
    assert.equal(hit.length, 1, `expected one filled bin, got ${hit.length}`);
    assert.equal(values[hit[0]], 1);
    return hit[0];
}

test('hsv bins are hue x8, saturation x4, value x4 (index hue * 16 + sat * 4 + val)', () => {
    const cases = [
        [[255, 0, 0], 0 * 16 + 3 * 4 + 3],      // h 0
        [[0, 255, 255], 4 * 16 + 3 * 4 + 3],    // h 0.5: bin 4 of 8 (bin 2 with 4 hue bins)
        [[0, 0, 255], 5 * 16 + 3 * 4 + 3],      // h 2/3
        [[100, 50, 50], 0 * 16 + 2 * 4 + 1],    // s 0.5, v 0.39
        [[60, 120, 90], 3 * 16 + 2 * 4 + 1],    // h 5/12
        [[200, 100, 250], 6 * 16 + 2 * 4 + 3],  // h 7/9, s 0.6
        [[128, 128, 128], 0 * 16 + 0 * 4 + 2]   // grey: h 0, s 0, v 0.5
    ];
    for (const [rgb, bin] of cases) assert.equal(onlyBin(colourFeatures(solid(...rgb)).hsv), bin, `rgb ${rgb}`);
});

test('lab bins are floor(L/25) x4, floor((a+80)/20) x8, floor((b+80)/20) x8, clamped', () => {
    const cases = [
        [[255, 255, 255], 3 * 64 + 4 * 8 + 3],  // L 100, a +0.005, b -0.010 (rounded matrix)
        [[128, 128, 128], 2 * 64 + 4 * 8 + 3],  // L 53.6
        [[225, 235, 255], 3 * 64 + 4 * 8 + 3],  // b -10.8 (b bin 2 with an offset of 70)
        [[255, 250, 200], 3 * 64 + 3 * 8 + 5],  // a -6.1, b +24.6
        [[255, 0, 0], 2 * 64 + 7 * 8 + 7],      // a +80.1 clamps to bin 7
        [[0, 0, 255], 1 * 64 + 7 * 8 + 0]       // b -107.9 clamps to bin 0
    ];
    for (const [rgb, bin] of cases) assert.equal(onlyBin(colourFeatures(solid(...rgb)).lab), bin, `rgb ${rgb}`);
});

test('whiteFrac counts L >= 75 with a and b in [-20, 20), slightly negative a/b included', () => {
    const cases = [
        [[240, 255, 255], 1],  // a -4.9, b -1.7: a/b bin 3
        [[245, 255, 250], 1],  // a -4.2, b +1.2
        [[250, 240, 255], 1],  // a +6.0, b -6.0
        [[255, 248, 240], 1],  // a +1.0, b +4.7
        [[225, 235, 255], 1],  // b -10.8
        [[255, 250, 200], 0],  // b +24.6
        [[255, 200, 220], 0],  // a +22.5
        [[170, 170, 170], 0]   // L 69.6
    ];
    for (const [rgb, whiteFrac] of cases) assert.equal(colourFeatures(solid(...rgb)).whiteFrac, whiteFrac, `rgb ${rgb}`);
});

// --- pHash256 ------------------------------------------------------------------

test('phash256 returns 8 words with half the bits set', () => {
    const hash = phash256(randomRgb(21));
    assert.ok(hash instanceof Uint32Array);
    assert.equal(hash.length, 8);
    assert.equal(popcount(hash), 128);
});

test('phash256 is stable under resizing and separates different scenes', async () => {
    for (const seed of [31, 32, 33]) {
        const scene = await syntheticScene(seed);
        const direct = phash256(await to64(scene, 256));
        const viaSmaller = phash256(await to64(scene, 256, 150));
        const viaLarger = phash256(await to64(scene, 256, 400));
        assert.ok(hamming(direct, viaSmaller) <= 16, `seed ${seed}: ${hamming(direct, viaSmaller)} bits differ`);
        assert.ok(hamming(direct, viaLarger) <= 16, `seed ${seed}: ${hamming(direct, viaLarger)} bits differ`);
        const other = phash256(await to64(await syntheticScene(seed + 100), 256));
        assert.ok(hamming(direct, other) >= 64, `seed ${seed}: unrelated scenes only ${hamming(direct, other)} bits apart`);
    }
});

// --- golden vectors: method H semantics ------------------------------------------
//
// H rows persist under H_VERSION and are reused across launches, so any change to the
// bins, the white bins or the pHash bits silently mixes incompatible rows. These values
// were recorded once from the scratch reference functions of the evaluation
// (sim-eval-hash/small-hist.js colourFeatures, the white-bin sum of white.js and
// design-user-first/probe2.js, and probe2.js phash256) and cross-checked against this
// module. If one of them changes, bump H_VERSION; never re-record to make a test pass.
//
// Counts are pixels out of 4,096. hsv index = hue8 * 16 + sat4 * 4 + val4; lab index =
// L4 * 64 + a8 * 8 + b8. whiteBins are the L-bin 3 counts at (a, b) bins (3,3), (3,4),
// (4,3), (4,4), where bin 3 is [-20, 0) and bin 4 is [0, 20). The near-white fixture is
// white-dominant (whiteFrac 0.78, so the H white pHash term applies), and most of its
// white pixels sit in a negative a or b bin; neutral greys do too (b -0.010).

function blockyRgb(seed) {
    // 10-px cells, so no DCT coefficient of the low band is exactly zero (8-px cells
    // zero the whole k = 8 row and column, and the pHash median then sits on rounding noise).
    const rand = mulberry32(seed);
    const cells = Array.from({ length: 7 * 7 * 3 }, () => Math.floor(rand() * 256));
    const buffer = Buffer.alloc(64 * 64 * 3);
    for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
            const cell = (Math.floor(y / 10) * 7 + Math.floor(x / 10)) * 3;
            buffer.set(cells.slice(cell, cell + 3), (y * 64 + x) * 3);
        }
    }
    return buffer;
}

// Lab (L, a, b) and whether the pixel counts towards whiteFrac.
const NEAR_WHITE_PALETTE = [
    { rgb: [240, 255, 255], weight: 2 },  // 98.9, -4.9, -1.7   white, a and b slightly negative
    { rgb: [245, 250, 255], weight: 2 },  // 98.0, -0.7, -3.0   white, a and b slightly negative
    { rgb: [245, 255, 250], weight: 2 },  // 99.2, -4.2, +1.2   white
    { rgb: [255, 255, 255], weight: 4 },  // 100, +0.005, -0.010 white
    { rgb: [250, 240, 255], weight: 2 },  // 95.9, +6.0, -6.0   white
    { rgb: [255, 248, 240], weight: 2 },  // 97.9, +1.0, +4.7   white
    { rgb: [225, 235, 255], weight: 3 },  // 92.9, +0.5, -10.8  white (not with an offset of 70)
    { rgb: [255, 250, 200], weight: 1 },  // 97.6, -6.1, +24.6  not white (white with an offset of 70)
    { rgb: [170, 170, 170], weight: 1 },  // 69.6               not white: L < 75
    { rgb: [255, 200, 220], weight: 1 },  // 85.9, +22.5, -2.4  not white
    { rgb: [200, 255, 200], weight: 1 },  // 95.1, -27.5, +20.7 not white
    { rgb: [40, 120, 200], weight: 1 }    // 49.6, +4.6, -48.3  not white
];

function nearWhiteRgb(seed) {
    const rand = mulberry32(seed);
    const total = NEAR_WHITE_PALETTE.reduce((sum, entry) => sum + entry.weight, 0);
    const buffer = Buffer.alloc(64 * 64 * 3);
    for (let i = 0; i < 64 * 64; i++) {
        let pick = rand() * total;
        let k = 0;
        while (pick >= NEAR_WHITE_PALETTE[k].weight) pick -= NEAR_WHITE_PALETTE[k++].weight;
        buffer.set(NEAR_WHITE_PALETTE[k].rgb, 3 * i);
    }
    return buffer;
}

const GOLDEN = {
    noise: {
        make: () => randomRgb(1001),
        sha1: 'cdb558edf659fc8c3c6d74d440169f80b7cd48da',
        hue: [577, 474, 488, 500, 506, 540, 510, 501],
        sat: [264, 770, 1301, 1761],
        val: [49, 435, 1218, 2394],
        L: [221, 1289, 1662, 924],
        a: [261, 422, 565, 552, 551, 554, 584, 607],
        b: [416, 401, 498, 576, 562, 624, 587, 432],
        hsvDigest: '0a59173de01f53a32c63d1c7341544d4318b6979',
        labDigest: '7d611423a8ec0a012823a72e6e13574d84fac372',
        whiteBins: [28, 30, 34, 24],
        layoutSums: [919.0745, 129.4747, 47.9924],
        layoutMoment: 25808.036,
        phash: [0x2535b347, 0x9f57ac8b, 0xda591ccc, 0x12323128, 0x066905f2, 0x30cea71d, 0x927bc61e, 0x63d6d5fe]
    },
    blocky: {
        make: () => blockyRgb(1002),
        sha1: 'a649f2df0c4903d0923d85224349cee6cefdb1cd',
        hue: [696, 340, 100, 680, 740, 940, 280, 320],
        sat: [240, 976, 1020, 1860],
        val: [300, 380, 1020, 2396],
        L: [380, 840, 2280, 596],
        a: [240, 340, 540, 640, 936, 500, 500, 400],
        b: [300, 500, 480, 800, 440, 656, 580, 340],
        hsvDigest: 'e000c55ff7817f4afc0893ed1b328a2bdc326f9d',
        labDigest: '73a9c3cd89c3703e38b22c26d490b9b47a7c1573',
        whiteBins: [40, 0, 0, 0],
        layoutSums: [877.7469, 95.7497, 8.0462],
        layoutMoment: 23420.454,
        phash: [0xab4ac07f, 0x29992f82, 0x4f425c72, 0x90bd6f43, 0xe34eb0bd, 0x907d5667, 0xa94854b7, 0x2b8aab8a]
    },
    nearWhite: {
        make: () => nearWhiteRgb(1003),
        sha1: '890dd6423380c27c8a681dc7c58649614a2385eb',
        hue: [1288, 189, 178, 387, 1488, 0, 365, 201],
        sat: [3914, 0, 0, 182],
        val: [0, 0, 161, 3935],
        L: [0, 182, 161, 3753],
        a: [0, 0, 178, 1327, 2390, 201, 0, 0],
        b: [0, 182, 0, 2781, 766, 367, 0, 0],
        hsvDigest: '74d229b6fba702b7bbd512dccae6f428194b2e29',
        labDigest: 'a30f437c3f94f903e3fa44cda45247cdd1210dfb',
        whiteBins: [751, 387, 1668, 379],
        layoutSums: [1498.6541, -6.023, -33.7482],
        layoutMoment: 34164.125,
        phash: [0x775a09ef, 0x2a489e74, 0x8b22c884, 0xeaea2521, 0x4ce569aa, 0x3d5b923a, 0x51c076df, 0xf6a4dfb0]
    }
};

const WHITE_BIN_INDEX = [3 * 64 + 3 * 8 + 3, 3 * 64 + 3 * 8 + 4, 3 * 64 + 4 * 8 + 3, 3 * 64 + 4 * 8 + 4];

function sha1(data) {
    return crypto.createHash('sha1').update(data).digest('hex');
}

function goldenFixture(name) {
    const buffer = GOLDEN[name].make();
    assert.equal(sha1(buffer), GOLDEN[name].sha1, `${name}: the fixture generator changed, so the golden values no longer apply`);
    return buffer;
}

// sqrt histogram row → pixel counts; every entry must be sqrt(k / 4096) for an integer k.
function pixelCounts(row) {
    return Array.from(row, value => {
        const count = value * value * 4096;
        assert.ok(Math.abs(count - Math.round(count)) < 1e-3, `not a sqrt pixel fraction: ${value}`);
        return Math.round(count);
    });
}

// Row-major marginals: dims [8, 4, 4] gives the hue, sat and val sums.
function marginals(counts, dims) {
    const out = dims.map(size => new Array(size).fill(0));
    counts.forEach((count, index) => {
        let rest = index;
        for (let axis = dims.length - 1; axis >= 0; axis--) {
            out[axis][rest % dims[axis]] += count;
            rest = Math.floor(rest / dims[axis]);
        }
    });
    return out;
}

test('golden: the hsv histogram of each fixture (8 hue x 4 sat x 4 val bins)', () => {
    for (const name of Object.keys(GOLDEN)) {
        const golden = GOLDEN[name];
        const counts = pixelCounts(colourFeatures(goldenFixture(name)).hsv);
        const [hue, sat, val] = marginals(counts, [8, 4, 4]);
        assert.deepEqual(hue, golden.hue, `${name}: hue bins`);
        assert.deepEqual(sat, golden.sat, `${name}: saturation bins`);
        assert.deepEqual(val, golden.val, `${name}: value bins`);
        assert.equal(sha1(counts.join(',')), golden.hsvDigest, `${name}: hsv bin counts`);
    }
});

test('golden: the Lab histogram of each fixture (L/25, (a+80)/20, (b+80)/20 bins)', () => {
    for (const name of Object.keys(GOLDEN)) {
        const golden = GOLDEN[name];
        const counts = pixelCounts(colourFeatures(goldenFixture(name)).lab);
        const [L, a, b] = marginals(counts, [4, 8, 8]);
        assert.deepEqual(L, golden.L, `${name}: L bins`);
        assert.deepEqual(a, golden.a, `${name}: a bins`);
        assert.deepEqual(b, golden.b, `${name}: b bins`);
        assert.equal(sha1(counts.join(',')), golden.labDigest, `${name}: lab bin counts`);
    }
});

test('golden: whiteFrac of each fixture, near-white pixels with slightly negative a/b included', () => {
    for (const name of Object.keys(GOLDEN)) {
        const golden = GOLDEN[name];
        const features = colourFeatures(goldenFixture(name));
        const counts = pixelCounts(features.lab);
        assert.deepEqual(WHITE_BIN_INDEX.map(bin => counts[bin]), golden.whiteBins, `${name}: white bins`);
        const whitePixels = golden.whiteBins.reduce((sum, count) => sum + count, 0);
        assert.equal(features.whiteFrac, whitePixels / 4096, `${name}: whiteFrac`);
    }
});

test('golden: the 4x4 mean-Lab layout of each fixture', () => {
    for (const name of Object.keys(GOLDEN)) {
        const golden = GOLDEN[name];
        const { layout } = colourFeatures(goldenFixture(name));
        const sums = [0, 1, 2].map(k => Array.from(layout).reduce((sum, value, i) => (i % 3 === k ? sum + value : sum), 0));
        const moment = Array.from(layout).reduce((sum, value, i) => sum + (i + 1) * value, 0);
        sums.forEach((sum, k) => assert.ok(Math.abs(sum - golden.layoutSums[k]) < 1e-3, `${name}: channel ${k} sum ${sum}`));
        assert.ok(Math.abs(moment - golden.layoutMoment) < 1e-2, `${name}: layout moment ${moment}`);
    }
});

test('golden: phash256 of each fixture (2-D DCT, top-left 16x16, median threshold)', () => {
    for (const name of Object.keys(GOLDEN)) {
        const words = Array.from(phash256(goldenFixture(name)));
        const hex = words.map(word => word.toString(16).padStart(8, '0')).join(' ');
        assert.deepEqual(words, GOLDEN[name].phash, `${name}: ${hex}`);
    }
});

// --- DINOv2 tensor helpers --------------------------------------------------

test('toNchw gets the channel order and normalisation right on a 2-pixel fixture', () => {
    const rgb = Uint8Array.from([255, 0, 0, 0, 128, 255]);
    const out = toNchw(rgb);
    assert.ok(out instanceof Float32Array);
    const expected = [
        (1 - 0.485) / 0.229, (0 - 0.485) / 0.229,          // R plane
        (0 - 0.456) / 0.224, (128 / 255 - 0.456) / 0.224,  // G plane
        (0 - 0.406) / 0.225, (1 - 0.406) / 0.225           // B plane
    ];
    assert.equal(out.length, 6);
    expected.forEach((value, i) => assert.ok(Math.abs(out[i] - value) < 1e-6, `index ${i}: ${out[i]} vs ${value}`));
});

test('toNchw produces a [1,3,224,224] tensor from a 224x224 RGB buffer', () => {
    const rgb = Buffer.alloc(224 * 224 * 3, 255);
    const out = toNchw(rgb);
    assert.equal(out.length, 150528);
    assert.ok(Math.abs(out[0] - (1 - 0.485) / 0.229) < 1e-6);
    assert.ok(Math.abs(out[150527] - (1 - 0.406) / 0.225) < 1e-6);
    assert.throws(() => toNchw(Buffer.alloc(7)), /multiple of 3/);
});

test('poolTokens skips the CLS token, averages the rest and L2-normalises', () => {
    // dims [1, 3, 2]: token 0 is CLS and must not contribute.
    const data = Float32Array.from([100, -50, 3, 0, 1, 4]);
    const pooled = poolTokens(data, [1, 3, 2]);
    assert.ok(pooled instanceof Float32Array);
    assert.equal(pooled.length, 2);
    assert.ok(Math.abs(pooled[0] - Math.SQRT1_2) < 1e-7);
    assert.ok(Math.abs(pooled[1] - Math.SQRT1_2) < 1e-7);

    const rand = mulberry32(41);
    const big = Float32Array.from({ length: 257 * 384 }, () => rand() * 2 - 1);
    const vector = poolTokens(big, [1, 257, 384]);
    assert.equal(vector.length, 384);
    assert.ok(Math.abs(Math.sqrt(sumSquares(vector)) - 1) < 1e-6);
    assert.throws(() => poolTokens(big, [1, 258, 384]), /dims/);
});

test('poolTokens returns zeros for an all-zero token grid', () => {
    const pooled = poolTokens(new Float32Array(3 * 4), [1, 3, 4]);
    assert.deepEqual(Array.from(pooled), [0, 0, 0, 0]);
});

// --- quantisation -------------------------------------------------------------

function randomUnit(rand, dim = 384) {
    const v = new Float32Array(dim);
    let norm = 0;
    for (let i = 0; i < dim; i++) {
        // Box-Muller keeps the vectors isotropic.
        const u = Math.max(rand(), 1e-12);
        v[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
        norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < dim; i++) v[i] /= norm;
    return v;
}

function cosF(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

function cosQuantized(a, b) {
    let s = 0;
    for (let i = 0; i < a.q.length; i++) s += a.q[i] * b.q[i];
    return s * a.inv * b.inv;
}

test('quantizeEmbedding keeps cosine within 0.005 on 1,000 random pairs', () => {
    const rand = mulberry32(51);
    let maxError = 0;
    for (let k = 0; k < 1000; k++) {
        const a = randomUnit(rand);
        // Mix in a controlled amount of a so the pairs span the whole cosine range.
        const mix = rand();
        const noise = randomUnit(rand);
        const b = new Float32Array(384);
        let norm = 0;
        for (let i = 0; i < 384; i++) {
            b[i] = mix * a[i] + (1 - mix) * noise[i];
            norm += b[i] * b[i];
        }
        norm = Math.sqrt(norm);
        for (let i = 0; i < 384; i++) b[i] /= norm;
        const qa = quantizeEmbedding(a);
        const qb = quantizeEmbedding(b);
        assert.ok(Number.isFinite(qa.inv) && qa.inv > 0);
        maxError = Math.max(maxError, Math.abs(cosQuantized(qa, qb) - cosF(a, b)));
    }
    assert.ok(maxError <= 0.005, `max cosine error ${maxError}`);
});

test('quantizeEmbedding uses the full int8 range and handles a zero vector', () => {
    const rand = mulberry32(52);
    const { q, inv } = quantizeEmbedding(randomUnit(rand));
    assert.ok(q instanceof Int8Array);
    assert.equal(q.length, 384);
    assert.equal(Math.max(...Array.from(q, Math.abs)), 127);
    assert.equal(inv, Math.fround(inv));

    const zero = quantizeEmbedding(new Float32Array(384));
    assert.ok(zero.q.every(v => v === 0));
    assert.equal(zero.inv, 0);
    assert.throws(() => quantizeEmbedding(Float32Array.from([1, Number.NaN])), /finite/);
});

// --- feature row ----------------------------------------------------------------

test('row layout constants match layout 2', () => {
    assert.equal(ROW_BYTES, 2164);
    assert.equal(OFFSETS.hsv, 0);
    assert.equal(OFFSETS.lab, 512);
    assert.equal(OFFSETS.layout, 1536);
    assert.equal(OFFSETS.logR, 1728);
    assert.equal(OFFSETS.whiteFrac, 1732);
    assert.equal(OFFSETS.phash, 1736);
    assert.equal(OFFSETS.q, 1768);
    assert.equal(OFFSETS.inv, 2152);
    assert.equal(OFFSETS.flags, 2156);
    assert.equal(OFFSETS.crc, 2160);
    assert.deepEqual({ ...FLAGS }, { OK: 1, SRC_JPEG360: 2, ORIG_ALPHA: 4, DINO_OK: 8 });
    assert.ok(Object.isFrozen(OFFSETS) && Object.isFrozen(FLAGS));
    assert.equal(H_VERSION, 'cc4w-64fill-v1');
    assert.equal(EMB_VERSION_BASE, 'dinov2s-q8-pad-v1');
});

function sampleFields(seed) {
    const rand = mulberry32(seed);
    const colour = colourFeatures(randomRgb(seed));
    return {
        ...colour,
        logR: Math.log(16 / 9),
        phash: phash256(randomRgb(seed + 1)),
        ...quantizeEmbedding(randomUnit(rand))
    };
}

test('a row round-trips exactly through packRow / unpackRow, DINO_OK included', () => {
    const fields = sampleFields(61);
    const flags = FLAGS.OK | FLAGS.SRC_JPEG360 | FLAGS.DINO_OK;
    const row = packRow(fields, flags);
    assert.ok(Buffer.isBuffer(row));
    assert.equal(row.length, ROW_BYTES);
    const back = unpackRow(row);
    assert.equal(back.crcOk, true);
    assert.equal(back.flags, flags);
    assert.equal(back.flags & FLAGS.DINO_OK, FLAGS.DINO_OK);
    assert.deepEqual(Array.from(back.hsv), Array.from(fields.hsv));
    assert.deepEqual(Array.from(back.lab), Array.from(fields.lab));
    assert.deepEqual(Array.from(back.layout), Array.from(fields.layout));
    assert.equal(back.logR, Math.fround(fields.logR));
    assert.equal(back.whiteFrac, Math.fround(fields.whiteFrac));
    assert.deepEqual(Array.from(back.phash), Array.from(fields.phash));
    assert.deepEqual(Array.from(back.q), Array.from(fields.q));
    assert.equal(back.inv, fields.inv);
    // Re-packing the unpacked row reproduces the same bytes.
    assert.ok(packRow(back, back.flags).equals(row));
});

test('unpackRow reads a row from any offset of a larger buffer', () => {
    const rows = [sampleFields(71), sampleFields(72), sampleFields(73)];
    const file = Buffer.alloc(16 + 3 * ROW_BYTES + 1);
    rows.forEach((fields, r) => packRow(fields, FLAGS.OK | FLAGS.DINO_OK).copy(file, 16 + r * ROW_BYTES));
    const back = unpackRow(file.subarray(16 + ROW_BYTES, 16 + 2 * ROW_BYTES));
    assert.equal(back.crcOk, true);
    assert.deepEqual(Array.from(back.q), Array.from(rows[1].q));
    // An odd byte offset must work too.
    const odd = Buffer.alloc(ROW_BYTES + 1);
    packRow(rows[2], FLAGS.OK).copy(odd, 1);
    const shifted = unpackRow(odd.subarray(1));
    assert.equal(shifted.crcOk, true);
    assert.deepEqual(Array.from(shifted.hsv), Array.from(rows[2].hsv));
    assert.throws(() => unpackRow(Buffer.alloc(ROW_BYTES - 1)), RangeError);
});

test('flipping any byte in 0..2159 fails the CRC', () => {
    const row = packRow(sampleFields(81), FLAGS.OK | FLAGS.DINO_OK);
    for (let at = 0; at < OFFSETS.crc; at++) {
        const copy = Buffer.from(row);
        copy[at] ^= 0x5a;
        assert.equal(unpackRow(copy).crcOk, false, `byte ${at}`);
    }
    const tamperedCrc = Buffer.from(row);
    tamperedCrc[ROW_BYTES - 1] ^= 1;
    assert.equal(unpackRow(tamperedCrc).crcOk, false);
});

test('the embedding bytes are zero when DINO_OK is clear', () => {
    const fields = sampleFields(91);
    const row = packRow(fields, FLAGS.OK | FLAGS.ORIG_ALPHA);
    assert.ok(row.subarray(OFFSETS.q, OFFSETS.flags).every(byte => byte === 0));
    const back = unpackRow(row);
    assert.equal(back.crcOk, true);
    assert.equal(back.flags & FLAGS.DINO_OK, 0);
    assert.ok(back.q.every(v => v === 0));
    assert.equal(back.inv, 0);
    // q and inv may be omitted entirely without DINO_OK.
    const { q, inv, ...hOnly } = fields;
    assert.ok(packRow(hOnly, FLAGS.OK | FLAGS.ORIG_ALPHA).equals(row));
});

test('packRow rejects malformed input', () => {
    const fields = sampleFields(101);
    assert.throws(() => packRow({ ...fields, hsv: new Float32Array(127) }, FLAGS.OK), /hsv/);
    assert.throws(() => packRow({ ...fields, phash: new Uint32Array(4) }, FLAGS.OK), /phash/);
    assert.throws(() => packRow({ ...fields, logR: Number.NaN }, FLAGS.OK), /logR/);
    assert.throws(() => packRow({ ...fields, q: new Int8Array(10) }, FLAGS.OK | FLAGS.DINO_OK), /q/);
    assert.throws(() => packRow({ ...fields, inv: Number.POSITIVE_INFINITY }, FLAGS.OK | FLAGS.DINO_OK), /inv/);
});

test('crc32 is the standard CRC-32 over a byte range', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(crc32(Buffer.from('xx123456789yy'), 2, 11), 0xcbf43926);
    assert.equal(crc32(Buffer.alloc(0)), 0);
    const random = randomRgb(111);
    if (typeof zlib.crc32 === 'function') assert.equal(crc32(random), zlib.crc32(random) >>> 0);
});
