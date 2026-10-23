const test = require('node:test');
const assert = require('node:assert/strict');

const {
    HD,
    H,
    g,
    gInv,
    boundsHD,
    boundsH,
    cosQ,
    visualH,
    distanceHD,
    distanceH,
    hamming256
} = require('../similarityDistance');
const { quantizeEmbedding } = require('../similarityFeatures');

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

const close = (actual, expected, tolerance, message) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${message || ''} ${actual} vs ${expected}`);

function randomQ(rand) {
    const v = Float32Array.from({ length: 384 }, () => rand() * 2 - 1);
    return quantizeEmbedding(v);
}

// Sqrt-histogram features built from a random normalised histogram, the same shape a row holds.
function sqrtHistogram(rand, bins, peaky = 1) {
    const raw = Array.from({ length: bins }, () => rand() ** peaky);
    const total = raw.reduce((s, v) => s + v, 0);
    return Float32Array.from(raw, v => Math.sqrt(v / total));
}

function randomH(rand, overrides = {}) {
    return {
        hsv: sqrtHistogram(rand, 128, 3),
        lab: sqrtHistogram(rand, 256, 3),
        layout: Float32Array.from({ length: 48 }, (_, i) => (i % 3 === 0 ? rand() * 100 : rand() * 60 - 30)),
        logR: 0,
        whiteFrac: 0.1,
        phash: Uint32Array.from({ length: 8 }, () => Math.floor(rand() * 2 ** 32)),
        ...overrides
    };
}

// --- constants ------------------------------------------------------------------

test('HD and H constants are frozen and carry the plan values', () => {
    assert.ok(Object.isFrozen(HD) && Object.isFrozen(HD.PRESETS) && Object.isFrozen(HD.NEXT_CUT));
    assert.ok(Object.isFrozen(H) && Object.isFrozen(H.PRESETS) && Object.isFrozen(H.NEXT_CUT));
    assert.equal(HD.E0, 0.696);
    assert.equal(HD.WP, 0.65);
    assert.equal(HD.WV, 0.175);
    assert.equal(HD.S, 0.45);
    assert.equal(HD.VETO_COS, 0.40);
    assert.equal(HD.HINGE_COS, 0.70);
    assert.equal(HD.HINGE_K, 1);
    assert.equal(HD.T_EDGE, 0.11);
    assert.deepEqual({ ...HD.PRESETS }, { strict: 0.07, standard: 0.09, loose: 0.11 });
    assert.deepEqual({ ...HD.NEXT_CUT }, { strict: 0.05, standard: 0.07, loose: 0.09 });
    assert.equal(HD.NEIGHBOR_D_MAX, 0.15);
    assert.equal(HD.VISUAL_COS_MIN, 0.70);
    assert.equal(HD.NEAR_J, 0.8308);

    assert.equal(H.LAB_NORM, 0.7077);
    assert.equal(H.HSV_NORM, 0.7589);
    assert.equal(H.LAYOUT_NORM, 149.0);
    assert.equal(H.RATIO_GATE, 0.1);
    assert.equal(H.RATIO_PENALTY, 0.2);
    assert.equal(H.VETO_V, 1.0);
    assert.equal(H.WP, 0.65);
    assert.equal(H.WV, 0.175);
    assert.equal(H.S, 0.3);
    assert.equal(H.WHITE_MIN, 0.5);
    assert.equal(H.T_EDGE, 0.15);
    assert.deepEqual({ ...H.PRESETS }, { strict: 0.10, standard: 0.125, loose: 0.15 });
    assert.deepEqual({ ...H.NEXT_CUT }, { strict: 0.075, standard: 0.10, loose: 0.125 });
    assert.equal(H.NEIGHBOR_D_MAX, 0.35);
    assert.equal(H.VISUAL_V_MAX, 0.6);
    assert.equal(H.NEAR_J, 0.7692);
    assert.throws(() => { 'use strict'; HD.T_EDGE = 1; }, TypeError);
});

// --- hd1 --------------------------------------------------------------------------

test('g is continuous at the hinge, decreasing, and 0 at cos 1', () => {
    assert.equal(g(1), 0);
    close(g(0.70), 0.30 / 0.696, 1e-15);
    close(g(0.70 - 1e-9), g(0.70), 1e-8, 'left limit');
    close(g(0.70 + 1e-9), g(0.70), 1e-8, 'right limit');
    // Below the hinge the slope doubles (k = 1).
    close(g(0.5), (1 - 0.5 + (0.70 - 0.5)) / 0.696, 1e-15);
    for (let c = 0.40; c < 1; c += 0.01) assert.ok(g(c) > g(c + 0.01), `g decreasing at ${c}`);
});

test('gInv inverts g on [0.40, 1]', () => {
    for (let c = 0.40; c <= 1.0000001; c += 0.001) close(gInv(g(c)), c, 1e-9, `at ${c}`);
    close(gInv(0.30 / 0.696), 0.70, 1e-12);
    close(gInv(1 - 0.696 * 0.5), (1.70 - 0.696 * (1 - 0.696 * 0.5)) / 2, 1e-12);
});

test('boundsHD gives the exact T_EDGE bounds', () => {
    const b = boundsHD(0.11);
    close(b.jMin, 0.8308, 1e-4, 'jMin');
    close(b.sameCosMin, 0.6313, 1e-4, 'sameCosMin');
    close(b.noPromptCosMin, 0.8299, 1e-4, 'noPromptCosMin');
    close(boundsHD(0.09).sameCosMin, 0.671, 1e-3, 'standard sameCosMin');
    assert.deepEqual(boundsHD(), boundsHD(HD.T_EDGE));
    // A very large T never drops below the veto.
    assert.equal(boundsHD(1).noPromptCosMin, 0.40);
});

test('boundsHD values sit exactly on the distance threshold', () => {
    for (const T of [0.07, 0.09, 0.11]) {
        const b = boundsHD(T);
        close(distanceHD({ cos: b.sameCosMin, J: 1, bothPrompted: true }), T, 1e-12, `same-prompt at ${T}`);
        close(distanceHD({ cos: b.noPromptCosMin, J: 0, bothPrompted: false }), T, 1e-12, `promptless at ${T}`);
        close(distanceHD({ cos: 1, J: b.jMin, bothPrompted: true }), T, 1e-12, `prompt at ${T}`);
        assert.ok(distanceHD({ cos: b.sameCosMin - 1e-6, J: 1, bothPrompted: true }) > T);
        assert.ok(distanceHD({ cos: b.noPromptCosMin - 1e-6, J: 0, bothPrompted: false }) > T);
    }
});

test('distanceHD vetoes cos below 0.40 and cannot-link pairs', () => {
    assert.equal(distanceHD({ cos: 0.399, J: 1, bothPrompted: true }), Infinity);
    assert.equal(distanceHD({ cos: 0.399, J: 0, bothPrompted: false }), Infinity);
    assert.equal(distanceHD({ cos: Number.NaN, J: 1, bothPrompted: true }), Infinity);
    assert.equal(distanceHD({ cos: 0.99, J: 1, bothPrompted: true, cannot: true }), Infinity);
    assert.ok(Number.isFinite(distanceHD({ cos: 0.40, J: 1, bothPrompted: true })));
});

test('distanceHD branches: promptless 0.45 g, prompted 0.65 (1 - J) + 0.175 g', () => {
    for (const cos of [0.45, 0.62, 0.70, 0.83, 0.97]) {
        close(distanceHD({ cos, J: 0.3, bothPrompted: false }), 0.45 * g(cos), 1e-15, `promptless ${cos}`);
        close(distanceHD({ cos, J: 0.9, bothPrompted: true }), 0.65 * (1 - 0.9) + 0.175 * g(cos), 1e-15, `prompted ${cos}`);
    }
});

test('cosQ is the int8 cosine, symmetric, and hd1 d is symmetric and 0 on identical rows', () => {
    const rand = mulberry32(7);
    for (let k = 0; k < 50; k++) {
        const a = randomQ(rand);
        const b = randomQ(rand);
        let dot = 0;
        for (let i = 0; i < 384; i++) dot += a.q[i] * b.q[i];
        close(cosQ(a.q, a.inv, b.q, b.inv), dot * a.inv * b.inv, 1e-12);
        assert.equal(cosQ(a.q, a.inv, b.q, b.inv), cosQ(b.q, b.inv, a.q, a.inv));
        const J = rand();
        const ab = distanceHD({ cos: cosQ(a.q, a.inv, b.q, b.inv), J, bothPrompted: true });
        const ba = distanceHD({ cos: cosQ(b.q, b.inv, a.q, a.inv), J, bothPrompted: true });
        assert.equal(ab, ba);
        const self = distanceHD({ cos: cosQ(a.q, a.inv, a.q, a.inv), J: 1, bothPrompted: true });
        close(self, 0, 1e-6, 'self distance');
        close(cosQ(a.q, a.inv, a.q, a.inv), 1, 1e-6, 'self cosine');
    }
    assert.equal(distanceHD({ cos: 1, J: 1, bothPrompted: true }), 0);
    // A row without an embedding (inv 0) can never link in hd.
    const a = randomQ(rand);
    assert.equal(distanceHD({ cos: cosQ(a.q, a.inv, new Int8Array(384), 0), J: 1, bothPrompted: true }), Infinity);
});

// --- H (fallback) ------------------------------------------------------------

test('visualH: d(a,a) is 0 and visualH / distanceH are symmetric', () => {
    const rand = mulberry32(17);
    for (let k = 0; k < 30; k++) {
        const a = randomH(rand, { logR: rand() * 0.3 - 0.15, whiteFrac: rand() });
        const b = randomH(rand, { logR: rand() * 0.3 - 0.15, whiteFrac: rand() });
        // f32 sqrt rows put the self dot product within ~1e-7 of 1; sqrt turns that into ~1e-4.
        close(visualH(a, a), 0, 2e-3, 'self v');
        close(distanceH({ v: visualH(a, a), J: 1, bothPrompted: true }), 0, 1e-3, 'self d');
        assert.equal(visualH(a, b), visualH(b, a));
        const J = rand();
        assert.equal(
            distanceH({ v: visualH(a, b), J, bothPrompted: true }),
            distanceH({ v: visualH(b, a), J, bothPrompted: true })
        );
    }
});

test('visualH matches the final.md formula term by term', () => {
    const rand = mulberry32(19);
    const a = randomH(rand, { logR: 0.02 });
    const b = randomH(rand, { logR: -0.03 });
    const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
    const hl = Math.sqrt(Math.max(0, 1 - dot(a.lab, b.lab))) / 0.7077;
    const hh = Math.sqrt(Math.max(0, 1 - dot(a.hsv, b.hsv))) / 0.7589;
    const l2 = Math.sqrt(a.layout.reduce((s, v, i) => s + (v - b.layout[i]) ** 2, 0));
    close(visualH(a, b), (l2 / 149.0 + 2 * hl + hh) / 4, 1e-12);
});

test('the soft ratio gate applies only above |ΔlogR| 0.1', () => {
    const rand = mulberry32(23);
    const a = randomH(rand, { logR: 0 });
    const other = randomH(rand);
    const hist = { hsv: a.hsv, lab: a.lab, phash: a.phash, whiteFrac: a.whiteFrac };
    // Same histograms, different layout: only the layout term can differ.
    const near = { ...other, ...hist, logR: 0.09 };
    const far = { ...other, ...hist, logR: 0.11 };
    const hl = Math.sqrt(Math.max(0, 1 - a.lab.reduce((s, v, i) => s + v * a.lab[i], 0))) / 0.7077;
    const hh = Math.sqrt(Math.max(0, 1 - a.hsv.reduce((s, v, i) => s + v * a.hsv[i], 0))) / 0.7589;
    close(visualH(a, far), (2 * hl + hh) / 3 + 0.2, 1e-12, 'gated');
    const l2 = Math.sqrt(a.layout.reduce((s, v, i) => s + (v - near.layout[i]) ** 2, 0));
    close(visualH(a, near), (l2 / 149 + 2 * hl + hh) / 4, 1e-12, 'ungated');
    assert.notEqual(visualH(a, near), visualH(a, far));
});

test('the white pHash term applies only when both images are white', () => {
    const rand = mulberry32(29);
    const a = randomH(rand, { whiteFrac: 0.6 });
    const b = randomH(rand, { whiteFrac: 0.7 });
    const plain = visualH({ ...a, whiteFrac: 0.1 }, b);
    close(visualH(a, b), (4 * plain + hamming256(a.phash, b.phash) / 128) / 5, 1e-12, 'both white');
    assert.equal(visualH({ ...a, whiteFrac: 0.4 }, b), plain);
    assert.equal(visualH(a, { ...b, whiteFrac: 0.5 }), plain);
});

test('hamming256 counts differing bits over 8 words', () => {
    const a = new Uint32Array(8);
    const b = new Uint32Array(8);
    assert.equal(hamming256(a, b), 0);
    b[0] = 0xffffffff;
    b[7] = 0x80000001;
    assert.equal(hamming256(a, b), 34);
    assert.equal(hamming256(b, b), 0);
});

test('distanceH vetoes v > 1.0 and cannot-link pairs', () => {
    assert.equal(distanceH({ v: 1.0000001, J: 1, bothPrompted: true }), Infinity);
    assert.equal(distanceH({ v: 1.2, J: 0, bothPrompted: false }), Infinity);
    assert.equal(distanceH({ v: Number.NaN, J: 1, bothPrompted: true }), Infinity);
    assert.equal(distanceH({ v: 0.1, J: 1, bothPrompted: true, cannot: true }), Infinity);
    assert.ok(Number.isFinite(distanceH({ v: 1.0, J: 1, bothPrompted: true })));
});

test('distanceH branches: prompted 0.65 (1 - J) + 0.175 min(v, 2), promptless 0.3 v', () => {
    for (const v of [0, 0.2, 0.5, 0.857, 1.0]) {
        close(distanceH({ v, J: 0.8, bothPrompted: true }), 0.65 * (1 - 0.8) + 0.175 * v, 1e-15, `prompted ${v}`);
        close(distanceH({ v, J: 0.8, bothPrompted: false }), 0.3 * v, 1e-15, `promptless ${v}`);
    }
});

test('boundsH gives 0.7692 / 0.857 / 0.5 at T_EDGE 0.15', () => {
    const b = boundsH(0.15);
    close(b.jMin, 0.7692, 1e-4, 'jMin');
    close(b.sameVMax, 0.857, 1e-3, 'sameVMax');
    close(b.noPromptVMax, 0.5, 1e-12, 'noPromptVMax');
    assert.deepEqual(boundsH(), boundsH(H.T_EDGE));
    // The bounds sit on the threshold.
    close(distanceH({ v: b.sameVMax, J: 1, bothPrompted: true }), 0.15, 1e-12);
    close(distanceH({ v: b.noPromptVMax, J: 0, bothPrompted: false }), 0.15, 1e-12);
    close(distanceH({ v: 0, J: b.jMin, bothPrompted: true }), 0.15, 1e-12);
    // The veto caps the visual bounds.
    assert.equal(boundsH(0.5).noPromptVMax, 1.0);
});
