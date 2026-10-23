const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
    CLUSTER,
    buildItems,
    buildEdges,
    edgesFor,
    remapEdges,
    mergeEdges,
    buildPcaBasis,
    sparseAverage,
    cutGroups,
    cutLabels,
    anchorId,
    subgroups,
    attachProvisional,
    neighbors
} = require('../similarityCluster');
const { HD, H, boundsHD, distanceHD, distanceH, visualH, cosQ } = require('../similarityDistance');
const { quantizeEmbedding, packRow, unpackRow, FLAGS } = require('../similarityFeatures');
const { bigrams, jaccard } = require('../similarityPrompt');

// --- deterministic fixtures -------------------------------------------------------------
// Synthetic only: random unit vectors, random histograms and prompts drawn from a small
// character set. No real prompts or images.

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

function gaussian(rand) {
    let u = 0;
    while (!u) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function normalise(vec) {
    let norm = 0;
    for (const x of vec) norm += x * x;
    norm = Math.sqrt(norm);
    return vec.map(x => x / norm);
}

function direction(rand, dim = 384) {
    return normalise(Float64Array.from({ length: dim }, () => gaussian(rand)));
}

function mix(parts, dim = 384) {
    const out = new Float64Array(dim);
    for (const [vec, weight] of parts) for (let d = 0; d < dim; d++) out[d] += weight * vec[d];
    return normalise(out);
}

function pick(rand, list) {
    return list[Math.floor(rand() * list.length)];
}

const ALPHABET = Array.from('猫狗山水花月星云风雨雪海天光影树林城夜梦红蓝金银白黑古新大小');

function randomPrompt(rand, min = 6, max = 30) {
    const length = min + Math.floor(rand() * (max - min + 1));
    return Array.from({ length }, () => pick(rand, ALPHABET)).join('');
}

function editPrompt(rand, prompt, edits = 1) {
    const chars = Array.from(prompt);
    for (let k = 0; k < edits; k++) chars[Math.floor(rand() * chars.length)] = pick(rand, ALPHABET);
    return chars.join('');
}

function rowPrompt(rand, family, families, promptless) {
    const r = rand();
    if (r < promptless) return '';
    if (r < promptless + 0.2) return editPrompt(rand, family.prompt, 1 + Math.floor(rand() * 2));
    if (r < promptless + 0.25) return pick(rand, families).prompt;
    return family.prompt;
}

// hd rows: a shared mean direction (like DINOv2's), families around it, near families
// derived from a parent, exact duplicates (ties) and promptless rows.
function hdRows(rand, n, { promptless = 0.15, dupRate = 0.03, cannotPairs = 0 } = {}) {
    const mean = direction(rand);
    const families = [];
    const rows = [];
    while (rows.length < n) {
        if (rows.length && rand() < dupRate) {
            const src = pick(rand, rows);
            rows.push({ ...src, key: `k${rows.length}`, createdAt: src.createdAt + (rand() < 0.5 ? 0 : 1) });
            continue;
        }
        let family;
        if (!families.length || rand() < 0.3) {
            const parent = families.length && rand() < 0.25 ? pick(rand, families) : null;
            family = parent
                ? { base: mix([[parent.base, 0.9], [direction(rand), 0.35]]), sigma: 0.2 + 0.4 * rand(), prompt: editPrompt(rand, parent.prompt, 1), t: parent.t + 1000 }
                : { base: mix([[mean, 0.55], [direction(rand), 0.8]]), sigma: 0.2 + 0.5 * rand(), prompt: randomPrompt(rand), t: Math.floor(rand() * 1e6) };
            families.push(family);
        } else {
            family = pick(rand, families);
        }
        const vec = mix([[family.base, 1], [direction(rand), family.sigma]]);
        const { q, inv } = quantizeEmbedding(Float32Array.from(vec));
        rows.push({ key: `k${rows.length}`, createdAt: family.t + Math.floor(rand() * 50), np: rowPrompt(rand, family, families, promptless), q, inv, family: families.indexOf(family) });
    }
    return { rows, cannotLink: cannotPairsFor(rand, rows, cannotPairs) };
}

function randomHistogram(rand, bins) {
    const raw = Array.from({ length: bins }, () => rand() ** 4);
    const total = raw.reduce((s, v) => s + v, 0);
    return raw.map(v => v / total);
}

function sqrtPerturbed(rand, hist, sigma) {
    const raw = hist.map(v => v * Math.exp(sigma * gaussian(rand)) + 1e-6);
    const total = raw.reduce((s, v) => s + v, 0);
    return Float32Array.from(raw, v => Math.sqrt(v / total));
}

const RATIOS = [0, 0, 0, 0.405, -0.405, 0.56];

// H rows: family histograms, layouts, ratios, white flags and pHashes with per-item noise.
function hRows(rand, n, { promptless = 0.15, dupRate = 0.03, cannotPairs = 0 } = {}) {
    const families = [];
    const rows = [];
    while (rows.length < n) {
        if (rows.length && rand() < dupRate) {
            const src = pick(rand, rows);
            rows.push({ ...src, key: `k${rows.length}`, createdAt: src.createdAt + (rand() < 0.5 ? 0 : 1) });
            continue;
        }
        let family;
        if (!families.length || rand() < 0.3) {
            family = {
                hsv: randomHistogram(rand, 128),
                lab: randomHistogram(rand, 256),
                layout: Array.from({ length: 48 }, (_, i) => (i % 3 === 0 ? rand() * 100 : rand() * 60 - 30)),
                logR: pick(rand, RATIOS),
                white: rand() < 0.25,
                phash: Array.from({ length: 8 }, () => Math.floor(rand() * 2 ** 32)),
                sigma: 0.1 + 0.4 * rand(),
                prompt: families.length && rand() < 0.25 ? editPrompt(rand, pick(rand, families).prompt, 1) : randomPrompt(rand),
                t: Math.floor(rand() * 1e6)
            };
            families.push(family);
        } else {
            family = pick(rand, families);
        }
        const s = family.sigma;
        const h = {
            hsv: sqrtPerturbed(rand, family.hsv, s),
            lab: sqrtPerturbed(rand, family.lab, s),
            layout: Float32Array.from(family.layout, v => v + gaussian(rand) * s * 20),
            logR: rand() < 0.9 ? family.logR : pick(rand, RATIOS),
            whiteFrac: family.white ? 0.55 + 0.4 * rand() : 0.4 * rand(),
            phash: Uint32Array.from(family.phash, w => {
                let x = w;
                for (let b = 0; b < 32; b++) if (rand() < s * 0.3) x ^= 1 << b;
                return x >>> 0;
            })
        };
        rows.push({ key: `k${rows.length}`, createdAt: family.t + Math.floor(rand() * 50), np: rowPrompt(rand, family, families, promptless), h, family: families.indexOf(family) });
    }
    return { rows, cannotLink: cannotPairsFor(rand, rows, cannotPairs) };
}

// Cannot-link pairs inside families (so they would otherwise tend to group).
function cannotPairsFor(rand, rows, count) {
    const pairs = [];
    for (let tries = 0; pairs.length < count && tries < 1000; tries++) {
        const a = pick(rand, rows);
        const b = pick(rand, rows);
        if (a !== b && a.family === b.family) pairs.push([a.key, b.key]);
    }
    return pairs;
}

const makeRows = (mode, rand, n, options) => (mode === 'hd' ? hdRows(rand, n, options) : hRows(rand, n, options));
const constantsFor = mode => (mode === 'hd' ? HD : H);

function shuffled(rand, list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// --- independent references -----------------------------------------------------------------

function denseMatrix(items) {
    const n = items.n;
    const D = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D[i * n + j] = D[j * n + i] = items.dist(i, j);
    return D;
}

// Naive O(n³) average linkage stopped at T: always merge the pair with the smallest
// (average, minId, maxId); cluster ids follow the sparse convention (n + merge index).
function denseAverage(n, D, T) {
    const capacity = 2 * n;
    const S = new Float64Array(capacity * capacity);
    const size = new Int32Array(capacity);
    const members = [];
    for (let i = 0; i < n; i++) {
        size[i] = 1;
        members[i] = [i];
        for (let j = 0; j < n; j++) if (i !== j) S[i * capacity + j] = D[i * n + j];
    }
    let alive = Array.from({ length: n }, (_, i) => i);
    const merges = [];
    for (;;) {
        let best = null;
        for (let x = 0; x < alive.length; x++) {
            for (let y = x + 1; y < alive.length; y++) {
                const a = alive[x];
                const b = alive[y];
                const v = S[a * capacity + b] / (size[a] * size[b]);
                if (best === null || v < best.v) best = { v, a, b };
            }
        }
        if (!best || !(best.v <= T)) break;
        const { a, b } = best;
        const id = n + merges.length;
        size[id] = size[a] + size[b];
        members[id] = members[a].concat(members[b]);
        for (const z of alive) {
            if (z === a || z === b) continue;
            S[id * capacity + z] = S[z * capacity + id] = S[a * capacity + z] + S[b * capacity + z];
        }
        alive = alive.filter(z => z !== a && z !== b);
        alive.push(id);
        merges.push([a, b, best.v]);
    }
    return { merges, groups: canonicalGroups(alive.map(c => members[c])) };
}

function canonicalGroups(groups) {
    return groups.map(g => g.slice().sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
}

function allPairEdges(items, T) {
    const ei = [];
    const ej = [];
    const ed = [];
    for (let i = 0; i < items.n; i++) {
        for (let j = i + 1; j < items.n; j++) {
            const d = items.dist(i, j);
            if (d <= T) {
                ei.push(i);
                ej.push(j);
                ed.push(d);
            }
        }
    }
    return { ei, ej, ed };
}

const plainEdges = edges => ({ ei: Array.from(edges.ei), ej: Array.from(edges.ej), ed: Array.from(edges.ed) });

async function clusterRows(rows, mode, { cannotLink, cap } = {}) {
    const items = buildItems(rows, { mode, cannotLink });
    const edges = await buildEdges(items);
    const linkage = await sparseAverage(items.n, edges, { T: constantsFor(mode).T_EDGE, dist: items.dist, cap });
    return { items, edges, linkage };
}

function keyGroups(items, groups) {
    return groups.map(g => g.map(i => items.keys[i]));
}

// --- items --------------------------------------------------------------------------------

test('buildItems orders rows by createdAt then key and indexes prompts', () => {
    const q = quantizeEmbedding(Float32Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)));
    const rows = [
        { key: 'b', createdAt: 5, np: 'x', ...q },
        { key: 'a', createdAt: 5, np: '', ...q },
        { key: 'c', createdAt: 1, np: 'x', ...q },
        { key: 'd', createdAt: undefined, np: 'yz', ...q }
    ];
    const items = buildItems(rows, { mode: 'hd' });
    assert.equal(items.mode, 'hd');
    assert.equal(items.n, 4);
    assert.deepEqual(items.keys, ['d', 'c', 'a', 'b']);
    assert.deepEqual(Array.from(items.createdAt), [0, 1, 5, 5]);
    assert.deepEqual(items.prompts, ['yz', 'x']);
    assert.deepEqual(Array.from(items.pi), [0, 1, -1, 1]);
    assert.equal(items.indexOf.get('a'), 2);
    assert.ok(Object.isFrozen(items));

    assert.throws(() => buildItems(rows, { mode: 'x' }), TypeError);
    assert.throws(() => buildItems([...rows, { ...rows[0] }], { mode: 'hd' }), /duplicate key/);
    assert.throws(() => buildItems([{ key: '', ...q }], { mode: 'hd' }), TypeError);
    assert.throws(() => buildItems([{ key: 'z', q: new Int8Array(10), inv: 1 }], { mode: 'hd' }), TypeError);
    assert.throws(() => buildItems([{ key: 'z', h: {} }], { mode: 'h' }), TypeError);
    assert.equal(buildItems([], { mode: 'h' }).n, 0);
});

test('items.dist is the frozen hd1 formula over int8 rows, and accepts float embeddings', () => {
    const rand = mulberry32(7);
    const { rows } = hdRows(rand, 80);
    const cannotLink = [[rows[0].key, rows[1].key]];
    const items = buildItems(rows, { mode: 'hd', cannotLink });
    const byKey = new Map(rows.map(r => [r.key, r]));
    for (let k = 0; k < 400; k++) {
        const i = Math.floor(rand() * items.n);
        const j = Math.floor(rand() * items.n);
        if (i === j) continue;
        const a = byKey.get(items.keys[i]);
        const b = byKey.get(items.keys[j]);
        const both = Boolean(a.np && b.np);
        const cannot = cannotLink.some(([x, y]) => (x === a.key && y === b.key) || (x === b.key && y === a.key));
        const expected = distanceHD({
            cos: cosQ(a.q, a.inv, b.q, b.inv),
            J: both ? jaccard(bigrams(a.np), bigrams(b.np)) : 0,
            bothPrompted: both,
            cannot
        });
        assert.equal(items.dist(i, j), expected, `pair ${i},${j}`);
        assert.equal(items.dist(j, i), expected, 'symmetric');
    }
    assert.equal(items.dist(items.indexOf.get(rows[0].key), items.indexOf.get(rows[1].key)), Infinity);
    assert.ok(items.cannotLinked(items.indexOf.get(rows[1].key), items.indexOf.get(rows[0].key)));

    // Evaluation path: float unit vectors with inv 1 give the float cosine.
    const floats = rows.slice(0, 20).map(r => {
        const f = Float32Array.from(r.q, v => v * r.inv);
        return { key: r.key, createdAt: r.createdAt, np: r.np, q: f, inv: 1 };
    });
    const fItems = buildItems(floats, { mode: 'hd' });
    assert.ok(fItems.q instanceof Float32Array);
    const a = floats.find(r => r.key === fItems.keys[0]);
    const b = floats.find(r => r.key === fItems.keys[1]);
    let dot = 0;
    for (let d = 0; d < 384; d++) dot += a.q[d] * b.q[d];
    assert.equal(fItems.cos(0, 1), dot);
});

test('items.dist is the frozen H formula in h mode', () => {
    const rand = mulberry32(8);
    const { rows } = hRows(rand, 80);
    const items = buildItems(rows, { mode: 'h' });
    const byKey = new Map(rows.map(r => [r.key, r]));
    for (let k = 0; k < 400; k++) {
        const i = Math.floor(rand() * items.n);
        const j = Math.floor(rand() * items.n);
        if (i === j) continue;
        const lo = Math.min(i, j);
        const hi = Math.max(i, j);
        const a = byKey.get(items.keys[lo]);
        const b = byKey.get(items.keys[hi]);
        const both = Boolean(a.np && b.np);
        const expected = distanceH({
            v: visualH(a.h, b.h),
            J: both ? jaccard(bigrams(a.np), bigrams(b.np)) : 0,
            bothPrompted: both
        });
        assert.equal(items.dist(i, j), expected, `pair ${i},${j}`);
        assert.equal(items.dist(j, i), expected, 'symmetric');
    }
});

test('rows unpacked from layout-2 feature rows cluster directly', async () => {
    const rand = mulberry32(9);
    const base = direction(rand);
    const rows = Array.from({ length: 6 }, (_, k) => {
        const e = quantizeEmbedding(Float32Array.from(mix([[base, 1], [direction(rand), 0.15]])));
        const buf = packRow({
            hsv: new Float32Array(128), lab: new Float32Array(256), layout: new Float32Array(48),
            logR: 0, whiteFrac: 0, phash: new Uint32Array(8), q: e.q, inv: e.inv
        }, FLAGS.OK | FLAGS.DINO_OK);
        const row = unpackRow(buf);
        return { key: `r${k}`, createdAt: k, np: k < 3 ? 'same prompt' : '', q: row.q, inv: row.inv };
    });
    const { items, linkage } = await clusterRows(rows, 'hd');
    assert.deepEqual(cutGroups(linkage.merges, items.n, HD.PRESETS.standard), [[0, 1, 2, 3, 4, 5]]);
});

// --- edges ------------------------------------------------------------------------------------

for (const mode of ['hd', 'h']) {
    test(`${mode}: buildEdges returns exactly the pairs with d <= T_EDGE, sorted`, async () => {
        const rand = mulberry32(mode === 'hd' ? 11 : 12);
        const T = constantsFor(mode).T_EDGE;
        let total = 0;
        let crossPrompt = 0;
        for (let f = 0; f < 10; f++) {
            const { rows, cannotLink } = makeRows(mode, rand, 100 + Math.floor(rand() * 200), { cannotPairs: 3 });
            const items = buildItems(rows, { mode, cannotLink });
            const edges = await buildEdges(items);
            assert.ok(edges.ei instanceof Int32Array && edges.ej instanceof Int32Array && edges.ed instanceof Float64Array);
            assert.deepEqual(plainEdges(edges), allPairEdges(items, T), `fixture ${f}`);
            assert.equal(edges.stats.edges, edges.ei.length);
            assert.equal(edges.stats.mode, mode);
            total += edges.ei.length;
            for (let k = 0; k < edges.ei.length; k++) {
                const a = items.pi[edges.ei[k]];
                const b = items.pi[edges.ej[k]];
                if (a >= 0 && b >= 0 && a !== b) crossPrompt++;
            }
            // The prefix-filter join path (more prompts than bruteMax) gives the same edges.
            if (f < 3) assert.deepEqual(plainEdges(await buildEdges(items, { bruteMax: 5 })), plainEdges(edges));
        }
        assert.ok(total > 500, `fixtures have edges (${total})`);
        assert.ok(crossPrompt > 0, 'fixtures have near-prompt edges');
    });

    test(`${mode}: edgesFor gives exactly one item's edges`, async () => {
        const rand = mulberry32(mode === 'hd' ? 13 : 14);
        const { rows } = makeRows(mode, rand, 250);
        const items = buildItems(rows, { mode });
        const edges = await buildEdges(items);
        const basis = mode === 'hd' ? buildPcaBasis(items) : null;
        for (let k = 0; k < 40; k++) {
            const idx = Math.floor(rand() * items.n);
            const expected = { ei: [], ej: [], ed: [] };
            for (let e = 0; e < edges.ei.length; e++) {
                if (edges.ei[e] !== idx && edges.ej[e] !== idx) continue;
                expected.ei.push(edges.ei[e]);
                expected.ej.push(edges.ej[e]);
                expected.ed.push(edges.ed[e]);
            }
            assert.deepEqual(plainEdges(edgesFor(items, idx)), expected, `item ${idx}`);
            if (basis) assert.deepEqual(plainEdges(edgesFor(items, idx, { basis })), expected, `item ${idx} with basis`);
        }
        assert.throws(() => edgesFor(items, items.n), RangeError);
        assert.throws(() => edgesFor(items, 0, { mode: mode === 'hd' ? 'h' : 'hd' }), /mode/);
    });

    test(`${mode}: incremental add, change and remove equal a full rebuild`, async () => {
        const rand = mulberry32(mode === 'hd' ? 15 : 16);
        const T = constantsFor(mode).T_EDGE;
        const { rows } = makeRows(mode, rand, 220);
        const partial = rows.slice(0, 200);
        const oldItems = buildItems(partial, { mode });
        const oldEdges = await buildEdges(oldItems);

        // Add 20 rows one at a time.
        let items = oldItems;
        let edges = oldEdges;
        for (const row of rows.slice(200)) {
            const next = buildItems([...items.keys.map(key => rows.find(r => r.key === key)), row], { mode });
            edges = mergeEdges(remapEdges(edges, items, next), edgesFor(next, next.indexOf.get(row.key)));
            items = next;
        }
        const full = buildItems(rows, { mode });
        const fullEdges = await buildEdges(full);
        assert.deepEqual(plainEdges(edges), plainEdges(fullEdges), 'add');
        const incremental = await sparseAverage(items.n, edges, { T, dist: items.dist });
        const rebuilt = await sparseAverage(full.n, fullEdges, { T, dist: full.dist });
        assert.deepEqual(incremental.merges, rebuilt.merges);

        // Remove 15 rows.
        const removed = new Set(shuffled(rand, rows).slice(0, 15).map(r => r.key));
        const kept = rows.filter(r => !removed.has(r.key));
        const smaller = buildItems(kept, { mode });
        assert.deepEqual(plainEdges(remapEdges(fullEdges, full, smaller)), plainEdges(await buildEdges(smaller)), 'remove');

        // Change one row in place (same key, new signal).
        const target = kept[7];
        const other = kept[kept.length - 3];
        const changedRows = kept.map(r => (r === target ? { ...other, key: target.key, createdAt: target.createdAt } : r));
        const changed = buildItems(changedRows, { mode });
        const changedEdges = mergeEdges(
            remapEdges(await buildEdges(smaller), smaller, changed, { dropKeys: [target.key] }),
            edgesFor(changed, changed.indexOf.get(target.key))
        );
        assert.deepEqual(plainEdges(changedEdges), plainEdges(await buildEdges(changed)), 'change');
    });
}

test('mergeEdges keeps the newer value for a repeated pair and sorts', () => {
    const merged = mergeEdges(
        { ei: [0, 2, 1], ej: [5, 3, 4], ed: [0.1, 0.2, 0.3] },
        { ei: [2, 0], ej: [3, 1], ed: [0.05, 0.07] }
    );
    assert.deepEqual(plainEdges(merged), { ei: [0, 0, 1, 2], ej: [1, 5, 4, 3], ed: [0.07, 0.1, 0.3, 0.05] });
});

test('remapEdges drops pairs that became cannot-link', async () => {
    const rand = mulberry32(17);
    const { rows } = hdRows(rand, 120, { promptless: 0 });
    const items = buildItems(rows, { mode: 'hd' });
    const edges = await buildEdges(items);
    const a = items.keys[edges.ei[0]];
    const b = items.keys[edges.ej[0]];
    const linked = buildItems(rows, { mode: 'hd', cannotLink: [[a, b]] });
    const remapped = remapEdges(edges, items, linked);
    assert.equal(remapped.ei.length, edges.ei.length - 1);
    assert.deepEqual(plainEdges(remapped), plainEdges(await buildEdges(linked)));
});

// --- PCA-32 prefilter ------------------------------------------------------------------------

// Promptless-heavy fixture plus pairs whose int8 cosine sits within 1e-4 of noPromptCosMin.
function prefilterRows(rand, n) {
    const { rows } = hdRows(rand, n, { promptless: 0.5, dupRate: 0.01 });
    const cosMin = boundsHD(HD.T_EDGE).noPromptCosMin;
    const target = Math.acos(cosMin);
    let near = 0;
    for (let p = 0; p < 12; p++) {
        const a = rows[Math.floor(rand() * rows.length)];
        const va = Float64Array.from(a.q, v => v * a.inv);
        // A direction orthogonal to a.
        let u = direction(rand);
        let proj = 0;
        for (let d = 0; d < 384; d++) proj += u[d] * va[d];
        u = normalise(u.map((x, d) => x - proj * va[d]));
        for (let tries = 0; tries < 400; tries++) {
            const theta = target + (rand() - 0.5) * 0.01;
            const vb = Float32Array.from(va, (x, d) => Math.cos(theta) * x + Math.sin(theta) * u[d]);
            const e = quantizeEmbedding(vb);
            const c = cosQ(a.q, a.inv, e.q, e.inv);
            if (Math.abs(c - cosMin) <= 1e-4) {
                rows.push({ key: `near${rows.length}`, createdAt: a.createdAt + 1, np: '', q: e.q, inv: e.inv, near: a.key, nearCos: c });
                near++;
                break;
            }
        }
    }
    return { rows, near };
}

test('hd: the PCA-32 prefilter on and off give identical edges on 30 random fixtures', async () => {
    const rand = mulberry32(21);
    const cosMin = boundsHD(HD.T_EDGE).noPromptCosMin;
    let above = 0;
    let below = 0;
    let skipped = 0;
    let shared = null;
    for (let f = 0; f < 30; f++) {
        const { rows } = prefilterRows(rand, 300 + Math.floor(rand() * 501));
        for (const r of rows) if (r.near) (r.nearCos >= cosMin ? above++ : below++);
        const items = buildItems(rows, { mode: 'hd' });
        const off = await buildEdges(items, { prefilter: 'off' });
        assert.equal(off.stats.prefilter, 'off');
        // A few fixtures build their own basis; the rest reuse one (any orthonormal basis is exact).
        const on = await buildEdges(items, f < 4 || !shared ? { prefilter: 'on' } : { prefilter: 'on', basis: shared });
        assert.equal(on.stats.prefilter, 'on', `fixture ${f}`);
        assert.ok(on.basis instanceof Float32Array && on.basis.length === 32 * 384);
        if (!shared) shared = on.basis;
        assert.deepEqual(plainEdges(on), plainEdges(off), `fixture ${f}`);
        skipped += on.stats.prefilterSkipped;
    }
    assert.ok(above > 0 && below > 0, `near-threshold pairs on both sides (${above} above, ${below} below)`);
    assert.ok(skipped > 0, 'the prefilter skipped pairs');
});

// Embeddings inside a random 24-dimensional subspace, so the PCA basis captures them and the
// bound p_a·p_b + r_a·r_b is tight. Near pairs are placed at cosMin + δ for δ across the
// 1e-5 margin, which is where an off-by-margin skip would drop a true edge.
function subspaceRows(rand, n, { int8 }) {
    const span = [];
    for (let k = 0; k < 24; k++) {
        let v = direction(rand);
        for (const b of span) {
            const along = v.reduce((s, x, d) => s + x * b[d], 0);
            v = v.map((x, d) => x - along * b[d]);
        }
        span.push(normalise(v));
    }
    const inSpan = () => normalise(span.reduce((acc, b) => {
        const weight = gaussian(rand);
        return acc.map((x, d) => x + weight * b[d]);
    }, new Float64Array(384)));
    const encode = vec => (int8 ? quantizeEmbedding(Float32Array.from(vec)) : { q: Float32Array.from(vec), inv: 1 });
    const centres = Array.from({ length: 12 }, inSpan);
    const rows = Array.from({ length: n }, (_, k) => {
        const vec = mix([[pick(rand, centres), 1], [inSpan(), 0.2 + 0.4 * rand()]]);
        return { key: `s${k}`, createdAt: k, np: '', ...encode(vec), vec };
    });
    const cosMin = boundsHD(HD.T_EDGE).noPromptCosMin;
    const offsets = int8 ? [-8e-5, -3e-5, -5e-6, 5e-6, 5e-5] : [-8e-5, -3e-5, -1.2e-5, -9e-6, -5e-6, -1e-6, 0, 1e-6, 5e-6, 3e-5];
    for (const delta of offsets) {
        for (let p = 0; p < 3; p++) {
            const a = pick(rand, rows.filter(r => !r.near));
            let u = inSpan();
            const along = u.reduce((s, x, d) => s + x * a.vec[d], 0);
            u = normalise(u.map((x, d) => x - along * a.vec[d]));
            const target = cosMin + delta;
            const theta = Math.acos(target);
            const vec = Float64Array.from(a.vec, (x, d) => Math.cos(theta) * x + Math.sin(theta) * u[d]);
            // Quantisation moves an int8 cosine by ~1e-3, so steer the int8 vector onto the target.
            const e = int8 ? nudgeInt8(a.q, a.inv, quantizeEmbedding(Float32Array.from(vec)).q, target, 4e-6) : encode(vec);
            if (e) rows.push({ key: `near${rows.length}`, createdAt: rows.length, np: '', ...e, vec, near: a.key });
        }
    }
    return rows;
}

// Greedy ±1 steps on single components until cosQ(qa, qb) is within tol of target. Each
// candidate is scored with the same arithmetic as cosQ (exact integer dot, f32 inv).
function nudgeInt8(qa, invA, start, target, tol) {
    const q = Int8Array.from(start);
    let dot = 0;
    let ss = 0;
    for (let d = 0; d < 384; d++) {
        dot += qa[d] * q[d];
        ss += q[d] * q[d];
    }
    const cosFor = (dt, s) => dt * (invA * Math.fround(1 / Math.sqrt(s)));
    for (let step = 0; step < 1000; step++) {
        const err = Math.abs(cosFor(dot, ss) - target);
        if (err <= tol) {
            const inv = Math.fround(1 / Math.sqrt(ss));
            assert.equal(cosQ(qa, invA, q, inv), cosFor(dot, ss));
            return { q, inv };
        }
        let best = null;
        for (let d = 0; d < 384; d++) {
            for (const delta of [-1, 1]) {
                if (Math.abs(q[d] + delta) > 127) continue;
                const e2 = Math.abs(cosFor(dot + delta * qa[d], ss + 2 * delta * q[d] + 1) - target);
                if (best === null || e2 < best.err) best = { err: e2, d, delta };
            }
        }
        if (!best || best.err >= err) return null;
        dot += best.delta * qa[best.d];
        ss += 2 * best.delta * q[best.d] + 1;
        q[best.d] += best.delta;
    }
    return null;
}

// The PCA bound for pair (a, b), recomputed from the returned basis.
function pcaBound(items, basis, a, b) {
    const project = i => {
        const x = Array.from({ length: 384 }, (_, d) => items.q[i * 384 + d] * items.inv[i]);
        const p = Array.from({ length: 32 }, (_, r) => x.reduce((s, v, d) => s + basis[r * 384 + d] * v, 0));
        const xx = x.reduce((s, v) => s + v * v, 0);
        return { p, r: Math.sqrt(Math.max(0, xx - p.reduce((s, v) => s + v * v, 0))) };
    };
    const A = project(a);
    const B = project(b);
    return A.p.reduce((s, v, r) => s + v * B.p[r], 0) + A.r * B.r;
}

for (const int8 of [false, true]) {
    test(`hd: the prefilter stays exact when its bound is tight at the threshold (${int8 ? 'int8' : 'float'} rows)`, async () => {
        const rand = mulberry32(int8 ? 25 : 24);
        const cosMin = boundsHD(HD.T_EDGE).noPromptCosMin;
        const rows = subspaceRows(rand, 300, { int8 });
        const items = buildItems(rows, { mode: 'hd' });
        const off = await buildEdges(items, { prefilter: 'off' });
        const on = await buildEdges(items, { prefilter: 'on' });
        assert.deepEqual(plainEdges(on), plainEdges(off));
        assert.ok(on.stats.prefilterSkipped > 0);
        let worstGap = 0;
        let inMargin = 0;
        let edgesAtThreshold = 0;
        for (const row of rows) {
            if (!row.near) continue;
            const a = Math.min(items.indexOf.get(row.near), items.indexOf.get(row.key));
            const b = Math.max(items.indexOf.get(row.near), items.indexOf.get(row.key));
            const c = items.cos(a, b);
            worstGap = Math.max(worstGap, pcaBound(items, on.basis, a, b) - c);
            if (c < cosMin && c > cosMin - CLUSTER.PCA_MARGIN) inMargin++;
            if (c >= cosMin && c < cosMin + 1e-4) edgesAtThreshold++;
        }
        assert.ok(worstGap < (int8 ? 2e-4 : 1e-6), `the bound is tight on the near pairs (${worstGap})`);
        assert.ok(inMargin > 0 && edgesAtThreshold > 0, `pairs inside the margin (${inMargin}) and just above it (${edgesAtThreshold})`);
    });
}

test('hd: prefilter auto uses the 10M-pair rule; a broken basis is replaced', async () => {
    const rand = mulberry32(22);
    const { rows } = prefilterRows(rand, 300);
    const items = buildItems(rows, { mode: 'hd' });
    const auto = await buildEdges(items);
    assert.equal(auto.stats.prefilter, 'off', 'promptless × n is far below 10M');
    assert.equal(auto.basis, null);

    const broken = new Float32Array(32 * 384).fill(0.01);
    const on = await buildEdges(items, { prefilter: 'on', basis: broken });
    assert.equal(on.stats.prefilter, 'on');
    assert.equal(on.stats.basisSource, 'built');
    assert.notEqual(on.basis, broken);
    assert.deepEqual(plainEdges(on), plainEdges(auto));
    assert.throws(() => edgesFor(items, 0, { T: Number.NaN }), TypeError);
    await assert.rejects(buildEdges(items, { prefilter: 'sometimes' }), TypeError);
});

test('buildPcaBasis is deterministic and orthonormal', () => {
    const rand = mulberry32(23);
    const { rows } = hdRows(rand, 400);
    const items = buildItems(rows, { mode: 'hd' });
    const a = buildPcaBasis(items);
    const b = buildPcaBasis(buildItems(shuffled(rand, rows), { mode: 'hd' }));
    assert.ok(a instanceof Float32Array && a.length === CLUSTER.PCA_DIMS * 384);
    assert.deepEqual(a, b);
    let worst = 0;
    for (let x = 0; x < 32; x++) {
        for (let y = 0; y < 32; y++) {
            let s = 0;
            for (let d = 0; d < 384; d++) s += a[x * 384 + d] * a[y * 384 + d];
            worst = Math.max(worst, Math.abs(s - (x === y ? 1 : 0)));
        }
    }
    assert.ok(worst <= 1e-4, `orthonormal (${worst})`);
    // The top direction captures the shared mean direction of the fixture.
    let energy = 0;
    for (let i = 0; i < items.n; i++) {
        let p = 0;
        for (let d = 0; d < 384; d++) p += a[d] * items.q[i * 384 + d] * items.inv[i];
        energy += p * p;
    }
    assert.ok(energy / items.n > 0.2, `first component energy ${energy / items.n}`);
    // Tiny libraries still get a full orthonormal basis; no embeddings gives null.
    assert.equal(buildPcaBasis(buildItems(rows.slice(0, 3), { mode: 'hd' })).length, 32 * 384);
    assert.equal(buildPcaBasis(buildItems([], { mode: 'hd' })), null);
    assert.equal(buildPcaBasis(buildItems(hRows(rand, 5).rows, { mode: 'h' })), null);
});

// --- linkage ------------------------------------------------------------------------------------

// Random symmetric matrix on a 1/64 grid (exact sums, so ties are real ties) with latent
// families, vetoes and many non-edges.
function tieMatrix(rand, n) {
    const family = Int32Array.from({ length: n }, () => Math.floor(rand() * Math.max(2, n / 4)));
    const D = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            let d;
            if (rand() < 0.05) d = Infinity;
            else if (family[i] === family[j]) d = Math.floor(rand() * 12) / 64;
            else d = (4 + Math.floor(rand() * 60)) / 64;
            D[i * n + j] = D[j * n + i] = d;
        }
    }
    return D;
}

function matrixEdges(n, D, T) {
    const ei = [];
    const ej = [];
    const ed = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (D[i * n + j] <= T) { ei.push(i); ej.push(j); ed.push(D[i * n + j]); }
    return { ei, ej, ed };
}

test('sparseAverage replays naive dense average linkage merge for merge on tie-heavy matrices', async () => {
    const rand = mulberry32(31);
    const T = 0.15;
    let ties = 0;
    for (let f = 0; f < 25; f++) {
        const n = 30 + Math.floor(rand() * 120);
        const D = tieMatrix(rand, n);
        const dist = (i, j) => D[i * n + j];
        const sparse = await sparseAverage(n, matrixEdges(n, D, T), { T, dist });
        const dense = denseAverage(n, D, T);
        assert.deepEqual(sparse.merges, dense.merges, `fixture ${f}`);
        assert.deepEqual(cutGroups(sparse.merges, n, T), dense.groups);
        const heights = sparse.merges.map(m => m[2]);
        ties += heights.length - new Set(heights).size;
    }
    assert.ok(ties > 50, `fixtures exercise ties (${ties})`);
});

for (const mode of ['hd', 'h']) {
    test(`${mode}: sparse linkage equals naive dense average linkage on 50 random fixtures at the three presets`, async () => {
        const rand = mulberry32(mode === 'hd' ? 41 : 42);
        const presets = Object.values(constantsFor(mode).PRESETS);
        let multi = 0;
        let vetoed = 0;
        for (let f = 0; f < 50; f++) {
            const { rows, cannotLink } = makeRows(mode, rand, 60 + Math.floor(rand() * 191), { cannotPairs: 2 });
            const { items, linkage } = await clusterRows(rows, mode, { cannotLink });
            assert.equal(linkage.capHits, 0);
            const D = denseMatrix(items);
            for (const d of D) if (d === Infinity) vetoed++;
            for (const t of presets) {
                const dense = denseAverage(items.n, D, t);
                const groups = cutGroups(linkage.merges, items.n, t);
                assert.deepEqual(groups, dense.groups, `fixture ${f} t=${t}`);
                multi += groups.filter(g => g.length > 1).length;
            }
        }
        assert.ok(multi > 300, `fixtures form groups (${multi})`);
        assert.ok(vetoed > 0, 'fixtures have vetoed pairs');
    });

    test(`${mode}: 20 shuffles give identical partitions and ids; cuts are nested; no group holds a vetoed pair`, async () => {
        const rand = mulberry32(mode === 'hd' ? 51 : 52);
        const { rows, cannotLink } = makeRows(mode, rand, 220, { cannotPairs: 6 });
        const presets = constantsFor(mode).PRESETS;
        const run = async input => {
            const { items, linkage } = await clusterRows(input, mode, { cannotLink });
            return Object.fromEntries(Object.entries(presets).map(([name, t]) => [name,
                keyGroups(items, cutGroups(linkage.merges, items.n, t)).map(g => ({ id: anchorId(g[0]), members: g }))]));
        };
        const base = await run(rows);
        for (let s = 0; s < 20; s++) assert.deepEqual(await run(shuffled(rand, rows)), base, `shuffle ${s}`);

        const { items, linkage } = await clusterRows(rows, mode, { cannotLink });
        const labels = name => cutLabels(linkage.merges, items.n, presets[name]);
        const strict = labels('strict');
        const standard = labels('standard');
        const loose = labels('loose');
        for (let i = 0; i < items.n; i++) {
            for (let j = i + 1; j < items.n; j++) {
                if (strict[i] === strict[j]) assert.equal(standard[i], standard[j], 'strict ⊆ standard');
                if (standard[i] === standard[j]) assert.equal(loose[i], loose[j], 'standard ⊆ loose');
                if (loose[i] === loose[j]) assert.ok(items.dist(i, j) < Infinity, 'no vetoed or cannot-link pair inside a group');
            }
        }
        // The cannot-link pairs are real family pairs and at least one would have grouped otherwise.
        const free = await clusterRows(rows, mode);
        const freeLoose = cutLabels(free.linkage.merges, free.items.n, presets.loose);
        const wouldGroup = cannotLink.filter(([a, b]) => freeLoose[free.items.indexOf.get(a)] === freeLoose[free.items.indexOf.get(b)]);
        assert.ok(wouldGroup.length > 0, 'a cannot-link pair changed the result');
    });
}

test('a 50-item chain does not become one group', async () => {
    // Matrix: adjacent d = 0.1, everything else far apart.
    const n = 50;
    const D = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) D[i * n + j] = Math.abs(i - j) === 1 ? 0.1 : 0.5;
    const chain = await sparseAverage(n, matrixEdges(n, D, 0.15), { T: 0.15, dist: (i, j) => D[i * n + j] });
    assert.ok(Math.max(...cutGroups(chain.merges, n, 0.15).map(g => g.length)) <= 3);

    // hd items: overlapping one-hot kernels give adjacent cos 0.845 (d ≈ 0.10), far pairs vetoed.
    const kernel = [0.3, 0.8, 1, 0.8, 0.3];
    const rows = Array.from({ length: n }, (_, k) => {
        const v = new Float32Array(384);
        kernel.forEach((w, o) => { v[k + o] = w; });
        return { key: `c${String(k).padStart(2, '0')}`, createdAt: k, np: '', ...quantizeEmbedding(normalise(v)) };
    });
    const { items, edges, linkage } = await clusterRows(rows, 'hd');
    assert.ok(edges.ei.length >= n - 1, 'adjacent items are edges');
    const loose = cutGroups(linkage.merges, items.n, HD.PRESETS.loose);
    assert.ok(Math.max(...loose.map(g => g.length)) <= 3, `largest ${Math.max(...loose.map(g => g.length))}`);
});

test('over is per pair: (A,X) above T does not block (A∪B,X) <= T', async () => {
    // Items 0 = a, 1 = b, 2 = x1, 3 = x2; T = 0.15.
    // x1+x2 merge at 0.01; (a, X) is evaluated first (lower bound 0.10) and is over (0.175);
    // a+b merge at 0.12; (a∪b, X) averages 0.14875 <= T and must merge.
    const pairs = { '0,1': 0.12, '0,2': 0.05, '0,3': 0.30, '1,2': 0.12, '1,3': 0.125, '2,3': 0.01 };
    const dist = (i, j) => pairs[`${Math.min(i, j)},${Math.max(i, j)}`];
    const T = 0.15;
    const edges = { ei: [], ej: [], ed: [] };
    for (const [key, d] of Object.entries(pairs)) {
        if (d > T) continue;
        const [i, j] = key.split(',').map(Number);
        edges.ei.push(i);
        edges.ej.push(j);
        edges.ed.push(d);
    }
    const { merges } = await sparseAverage(4, edges, { T, dist });
    assert.equal(merges.length, 3);
    assert.deepEqual(merges.slice(0, 2), [[2, 3, 0.01], [0, 1, 0.12]]);
    assert.deepEqual(merges[2].slice(0, 2), [4, 5]);
    assert.ok(Math.abs(merges[2][2] - 0.595 / 4) < 1e-12);
    assert.deepEqual(cutGroups(merges, 4, T), [[0, 1, 2, 3]]);
    const D = new Float64Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) D[i * 4 + j] = dist(i, j);
    assert.deepEqual(denseAverage(4, D, T).groups, [[0, 1, 2, 3]]);
});

test('the evaluation cap only prevents merges it cannot verify', async () => {
    // Two pairs that need an exact evaluation to merge: the cap leaves them split.
    const pairs = { '0,1': 0.01, '2,3': 0.01, '0,2': 0.05, '0,3': 0.16, '1,2': 0.16, '1,3': 0.16 };
    const dist = (i, j) => pairs[`${Math.min(i, j)},${Math.max(i, j)}`];
    const edges = { ei: [0, 2, 0], ej: [1, 3, 2], ed: [0.01, 0.01, 0.05] };
    const full = await sparseAverage(4, edges, { T: 0.15, dist });
    assert.deepEqual(cutGroups(full.merges, 4, 0.15), [[0, 1, 2, 3]]);
    assert.equal(full.capHits, 0);
    assert.equal(full.pairEvals, 4);
    const capped = await sparseAverage(4, edges, { T: 0.15, dist, cap: 3 });
    assert.deepEqual(cutGroups(capped.merges, 4, 0.15), [[0, 1], [2, 3]]);
    assert.equal(capped.capHits, 1);
    // null means the default cap and Infinity disables it; neither caps this run.
    for (const cap of [null, Infinity, Number.NaN]) {
        const run = await sparseAverage(4, edges, { T: 0.15, dist, cap });
        assert.deepEqual(run.merges, full.merges, `cap ${cap}`);
        assert.equal(run.capHits, 0);
    }

    // Random fixtures under a small cap: every merge is still at the exact average of its
    // two clusters (never on an estimate), within T, and heights never decrease.
    const rand = mulberry32(61);
    let hits = 0;
    for (let f = 0; f < 10; f++) {
        const { rows } = hdRows(rand, 150);
        const items = buildItems(rows, { mode: 'hd' });
        const edges2 = await buildEdges(items);
        const run = await sparseAverage(items.n, edges2, { T: HD.T_EDGE, dist: items.dist, cap: 40 });
        hits += run.capHits;
        const members = Array.from({ length: items.n }, (_, i) => [i]);
        let last = -Infinity;
        for (const [a, b, h] of run.merges) {
            let sum = 0;
            for (const i of members[a]) for (const j of members[b]) sum += items.dist(i, j);
            assert.ok(Math.abs(sum / (members[a].length * members[b].length) - h) < 1e-12, 'exact height');
            assert.ok(h <= HD.T_EDGE && h >= last);
            last = h;
            members.push(members[a].concat(members[b]));
        }
    }
    assert.ok(hits > 0, 'the cap fired');
});

test('the cap is not a partition refinement: a capped pair can open another merge', async () => {
    // Uncapped: A={0,1} and B={2,3} merge (0.125, needs an evaluation), C={4} stays alone.
    // Capped: (A,B) cannot be verified, so A takes C at its exact average 0.13 instead.
    const pairs = {
        '0,1': 0.01, '2,3': 0.01, '0,2': 0.02, '0,3': 0.16, '1,2': 0.16, '1,3': 0.16,
        '0,4': 0.13, '1,4': 0.13, '2,4': 0.5, '3,4': 0.5
    };
    const dist = (i, j) => pairs[`${Math.min(i, j)},${Math.max(i, j)}`];
    const edges = { ei: [], ej: [], ed: [] };
    for (const [key, d] of Object.entries(pairs)) if (d <= 0.15) { const [i, j] = key.split(',').map(Number); edges.ei.push(i); edges.ej.push(j); edges.ed.push(d); }
    const full = await sparseAverage(5, edges, { T: 0.15, dist });
    assert.deepEqual(cutGroups(full.merges, 5, 0.15), [[0, 1, 2, 3], [4]]);
    const capped = await sparseAverage(5, edges, { T: 0.15, dist, cap: 3 });
    assert.deepEqual(cutGroups(capped.merges, 5, 0.15), [[0, 1, 4], [2, 3]]);
    assert.ok(capped.capHits > 0);
});

test('sparseAverage validates its input', async () => {
    await assert.rejects(sparseAverage(3, { ei: [0], ej: [1], ed: [0.1] }, { dist: () => 0 }), TypeError);
    await assert.rejects(sparseAverage(3, { ei: [0], ej: [1], ed: [0.1] }, { T: 0.1 }), TypeError);
    await assert.rejects(sparseAverage(3, { ei: [0], ej: [7], ed: [0.1] }, { T: 0.1, dist: () => 0 }), RangeError);
    const none = await sparseAverage(0, { ei: [], ej: [], ed: [] }, { T: 0.1, dist: () => 0 });
    assert.deepEqual(none.merges, []);
    assert.deepEqual(cutGroups([], 0, 0.1), []);
});

test('yieldEvery is awaited during long loops without changing results; a throw aborts', async () => {
    const rand = mulberry32(71);
    const { rows } = hdRows(rand, 400, { promptless: 0.3 });
    const items = buildItems(rows, { mode: 'hd' });
    const plain = await buildEdges(items, { prefilter: 'on' });
    let calls = 0;
    const yieldEvery = async () => { calls++; await new Promise(resolve => setImmediate(resolve)); };
    const sliced = await buildEdges(items, { prefilter: 'on', yieldEvery, sliceMs: 0 });
    assert.ok(calls > 10, `edge build yielded ${calls} times`);
    assert.deepEqual(plainEdges(sliced), plainEdges(plain));
    assert.deepEqual(sliced.basis, plain.basis);

    const before = calls;
    const a = await sparseAverage(items.n, plain, { T: HD.T_EDGE, dist: items.dist });
    const b = await sparseAverage(items.n, plain, { T: HD.T_EDGE, dist: items.dist, yieldEvery, sliceMs: 0 });
    assert.ok(calls > before, 'linkage yielded');
    assert.deepEqual(b.merges, a.merges);

    const stop = async () => { throw new Error('stale revision'); };
    await assert.rejects(buildEdges(items, { yieldEvery: stop, sliceMs: 0 }), /stale revision/);
    await assert.rejects(sparseAverage(items.n, plain, { T: HD.T_EDGE, dist: items.dist, yieldEvery: stop, sliceMs: 0 }), /stale revision/);
});

// Many distinct prompts of about the same length over a 20-letter alphabet: the size filter
// never stops early and common bigrams fill every prefix, so both prompt-pair paths do O(m²)
// work, while no pair comes near the J bound (few edges, no promptless scan).
function manyPromptRows(rand, m) {
    const letters = Array.from('abcdefghijklmnopqrst');
    return Array.from({ length: m }, (_, k) => {
        const np = Array.from({ length: 36 + Math.floor(rand() * 6) }, () => pick(rand, letters)).join('');
        const { q, inv } = quantizeEmbedding(Float32Array.from(direction(rand)));
        return { key: `m${k}`, createdAt: k, np, q, inv };
    });
}

test('buildEdges yields about every sliceMs, the prompt-pair search included', async () => {
    const items = buildItems(manyPromptRows(mulberry32(97), 1200), { mode: 'hd' });
    assert.equal(items.prompts.length, 1200);
    const sliceMs = 20;
    const results = [];
    for (const bruteMax of [undefined, 0]) { // brute force, then the prefix-filter join
        const gaps = [];
        let last = performance.now();
        const yieldEvery = async () => {
            gaps.push(performance.now() - last);
            await new Promise(resolve => setImmediate(resolve));
            last = performance.now();
        };
        const edges = await buildEdges(items, { yieldEvery, sliceMs, bruteMax });
        gaps.push(performance.now() - last);
        const label = bruteMax === 0 ? 'prefix join' : 'brute force';
        // The fixture must be heavy enough for the bound to mean something (a slower machine only
        // makes it heavier).
        assert.ok(edges.stats.ms.promptPairs > 3 * sliceMs, `${label}: prompt search took only ${edges.stats.ms.promptPairs.toFixed(1)} ms`);
        const worst = Math.max(...gaps);
        assert.ok(worst <= 3 * sliceMs, `${label}: longest unsliced block ${worst.toFixed(1)} ms (sliceMs ${sliceMs}, ${gaps.length} slices)`);
        results.push(plainEdges(edges));
    }
    assert.deepEqual(results[1], results[0], 'both prompt-pair paths give the same edges');
});

// --- cuts, ids, subgroups -------------------------------------------------------------------------

test('cutGroups and cutLabels partition every item, ordered by oldest member', () => {
    const merges = [[1, 3, 0.02], [0, 4, 0.05], [5, 2, 0.2]];
    assert.deepEqual(cutGroups(merges, 5, 0.01), [[0], [1], [2], [3], [4]]);
    assert.deepEqual(cutGroups(merges, 5, 0.02), [[0], [1, 3], [2], [4]]);
    assert.deepEqual(cutGroups(merges, 5, 0.1), [[0, 4], [1, 3], [2]]);
    assert.deepEqual(cutGroups(merges, 5, 1), [[0, 4], [1, 2, 3]]);
    assert.deepEqual(Array.from(cutLabels(merges, 5, 1)), [0, 1, 1, 1, 0]);
});

test('anchorId is sg_ + the first 12 hex digits of sha1(historyKey)', () => {
    assert.equal(anchorId('abc'), 'sg_a9993e364706');
    const key = 'D:\\图片\\task_1.png';
    assert.equal(anchorId(key), 'sg_' + crypto.createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 12));
    assert.match(anchorId(42), /^sg_[0-9a-f]{12}$/);
});

test('anchor ids stay stable when a group grows, and the older id survives a merge or split', async () => {
    const rand = mulberry32(81);
    const { rows } = hdRows(rand, 240);
    const idsAt = (items, merges, t) => keyGroups(items, cutGroups(merges, items.n, t)).filter(g => g.length > 1);
    const { items, linkage } = await clusterRows(rows, 'hd');
    const strict = idsAt(items, linkage.merges, HD.PRESETS.strict);
    const loose = idsAt(items, linkage.merges, HD.PRESETS.loose);
    let splits = 0;
    for (const group of loose) {
        const id = anchorId(group[0]);
        const parts = strict.filter(g => group.includes(g[0]));
        if (!(parts.length === 1 && parts[0].length === group.length)) splits++;
        // The strict part holding the loose anchor keeps the loose group's id; the others are newer.
        for (const part of parts) {
            if (part.includes(group[0])) assert.equal(anchorId(part[0]), id);
            else assert.ok(items.indexOf.get(part[0]) > items.indexOf.get(group[0]));
        }
    }
    assert.ok(splits > 0, 'some loose groups split at strict');

    // Grow: add newer copies of existing members. A group that keeps all its members keeps its
    // id, unless it merged with an older group, whose id survives.
    const newest = Math.max(...rows.map(r => r.createdAt));
    const grown = [...rows, ...rows.slice(0, 30).map((r, k) => ({ ...r, key: `new${k}`, createdAt: newest + 1 + k }))];
    const after = await clusterRows(grown, 'hd');
    const standardBefore = idsAt(items, linkage.merges, HD.PRESETS.standard);
    const standardAfter = idsAt(after.items, after.linkage.merges, HD.PRESETS.standard);
    let grew = 0;
    for (const group of standardBefore) {
        const holder = standardAfter.find(g => group.every(key => g.includes(key)));
        if (!holder) continue;
        if (holder.some(key => key.startsWith('new'))) grew++;
        if (holder[0] === group[0]) assert.equal(anchorId(holder[0]), anchorId(group[0]));
        else assert.ok(after.items.indexOf.get(holder[0]) < after.items.indexOf.get(group[0]), 'only an older anchor can take over');
    }
    assert.ok(grew > 0, 'some groups grew');
});

test('subgroups: >24 members split by the next cut into parts of >= 2 plus the rest', () => {
    // 26 items: 0..13 and 14..23 chain together at 0.01, then everything joins at 0.08.
    const merges = [];
    const n = 26;
    const chain = (from, to) => {
        let id = from;
        for (let i = from + 1; i <= to; i++) {
            merges.push([id, i, 0.01]);
            id = n + merges.length - 1;
        }
        return id;
    };
    const a = chain(0, 13);
    const b = chain(14, 23);
    merges.push([a, b, 0.08]);
    merges.push([n + merges.length - 1, 24, 0.08]);
    merges.push([n + merges.length - 1, 25, 0.085]);
    const [group] = cutGroups(merges, n, HD.PRESETS.standard);
    assert.equal(group.length, 26);
    const newestFirst = group.slice().reverse();
    const result = subgroups(newestFirst, merges, n, HD.NEXT_CUT.standard);
    assert.deepEqual(result.parts.map(p => p.length), [14, 10]);
    assert.deepEqual(result.parts[0], newestFirst.filter(i => i <= 13), 'members keep the input order');
    assert.deepEqual(result.rest, [25, 24]);

    // 25 / 1 stays flat; 24 members or fewer never split.
    const flat = [];
    let id = 0;
    for (let i = 1; i < 25; i++) { flat.push([id, i, 0.01]); id = n + flat.length - 1; }
    flat.push([id, 25, 0.08]);
    assert.equal(subgroups(cutGroups(flat, n, 0.09)[0], flat, n, 0.07), null);
    assert.equal(subgroups(group.slice(0, 24), merges, n, 0.07), null);
});

// --- provisional -----------------------------------------------------------------------------------

test('attachProvisional: pending images join the group of their analysed batch-mates', () => {
    const analysed = [['a1', 'a2', 'a3'], ['b1', 'b2'], ['s1']];
    const batches = [
        ['a1', 'a2', 'p1', 'b1', 'p2'],  // p1, p2 → group a (2 mates beat 1)
        ['b2', 'a3', 'p3'],              // tie 1-1 → the older anchor (analysed order) wins
        ['p4', 'p5', 'p6'],              // no analysed mates → a provisional group
        ['p7', 's1'],                    // an analysed single is not a group; one pending stays single
        ['p8', 'x1']                     // x1 analysed but ungrouped
    ];
    const pending = new Set(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'lonely']);
    const groups = attachProvisional(analysed, batches, pending);
    assert.deepEqual(groups, [
        { members: ['a1', 'a2', 'a3', 'p1', 'p2', 'p3'], provisional: true, base: 0, pending: ['p1', 'p2', 'p3'], failed: [] },
        { members: ['b1', 'b2'], provisional: false, base: 1, pending: [], failed: [] },
        { members: ['p4', 'p5', 'p6'], provisional: true, base: -1, pending: ['p4', 'p5', 'p6'], failed: [] }
    ]);
    // Once everything is analysed the result is exactly the analysed groups.
    assert.deepEqual(attachProvisional(analysed, batches, []).map(g => g.members), [['a1', 'a2', 'a3'], ['b1', 'b2']]);
    assert.ok(attachProvisional(analysed, batches, []).every(g => !g.provisional));
    assert.deepEqual(attachProvisional([], [], ['x']), []);
});

test('attachProvisional: failed images attach like final members and never make a group provisional', () => {
    const analysed = [['a1', 'a2'], ['b1', 'b2', 'b3'], ['c1', 'c2']];
    const batches = [
        ['a1', 'a2', 'f1'],               // failed only → joins a, which stays final
        ['b1', 'b2', 'p1', 'f2'],         // pending + failed → b is provisional because of p1 alone
        ['f3', 'f4'],                     // only failed, no analysed mates → no group (stay single)
        ['p2', 'f5'],                     // pending + failed, no analysed mates → a provisional group
        ['c1', 'f6', 'p3']                // p3 is both pending and failed: pending wins
    ];
    const pending = new Set(['p1', 'p2', 'p3']);
    const failed = new Set(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'p3']);
    assert.deepEqual(attachProvisional(analysed, batches, pending, { failed }), [
        { members: ['a1', 'a2', 'f1'], provisional: false, base: 0, pending: [], failed: ['f1'] },
        { members: ['b1', 'b2', 'b3', 'p1', 'f2'], provisional: true, base: 1, pending: ['p1'], failed: ['f2'] },
        { members: ['c1', 'c2', 'f6', 'p3'], provisional: true, base: 2, pending: ['p3'], failed: ['f6'] },
        { members: ['p2', 'f5'], provisional: true, base: -1, pending: ['p2'], failed: ['f5'] }
    ]);

    // All analysed or failed (final.md §3.4): the analysed groups plus their failed batch-mates,
    // none provisional, and a failed-only batch forms no group.
    const final = attachProvisional(analysed, batches, [], { failed: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'] });
    assert.deepEqual(final, [
        { members: ['a1', 'a2', 'f1'], provisional: false, base: 0, pending: [], failed: ['f1'] },
        { members: ['b1', 'b2', 'b3', 'f2'], provisional: false, base: 1, pending: [], failed: ['f2'] },
        { members: ['c1', 'c2', 'f6'], provisional: false, base: 2, pending: [], failed: ['f6'] }
    ]);
    // Failed keys that were also analysed, or that sit in no batch, change nothing.
    assert.deepEqual(attachProvisional(analysed, [], [], { failed: ['a1', 'zz'] }), attachProvisional(analysed, [], []));
});

// --- neighbours -------------------------------------------------------------------------------------

function expectedNeighbors(items, q, { mode, limit, samePromptOnly, labels }) {
    const hd = items.mode === 'hd';
    const K = constantsFor(items.mode);
    const mates = [];
    const others = [];
    const visual = [];
    for (let j = 0; j < items.n; j++) {
        if (j === q) continue;
        if (samePromptOnly && !(items.pi[q] >= 0 && items.pi[j] === items.pi[q])) continue;
        const value = hd ? items.cos(q, j) : visualH(items.h[Math.min(q, j)], items.h[Math.max(q, j)]);
        const d = items.dist(q, j);
        if (mode === 'visual') {
            if (hd ? value >= K.VISUAL_COS_MIN : value <= K.VISUAL_V_MAX) visual.push({ j, value, d });
        } else if (labels[j] === labels[q] && labels[q] >= 0) {
            mates.push({ j, value, d });
        } else if (d <= K.NEIGHBOR_D_MAX) {
            others.push({ j, value, d });
        }
    }
    const byD = (x, y) => x.d - y.d || x.j - y.j;
    mates.sort(byD);
    others.sort(byD);
    visual.sort((x, y) => (hd ? y.value - x.value : x.value - y.value) || x.j - y.j);
    return (mode === 'visual' ? visual : mates.concat(others)).slice(0, limit);
}

for (const mode of ['hd', 'h']) {
    test(`${mode}: neighbors rank group-mates first, then close images; visual mode ranks by the image alone`, async () => {
        const rand = mulberry32(mode === 'hd' ? 91 : 92);
        const K = constantsFor(mode);
        const { rows } = makeRows(mode, rand, 260);
        const { items, linkage } = await clusterRows(rows, mode);
        const groups = cutGroups(linkage.merges, items.n, K.PRESETS.standard);
        const labels = new Int32Array(items.n).fill(-1);
        groups.forEach((g, k) => { if (g.length > 1) for (const i of g) labels[i] = k; });
        let seen = 0;
        let near = 0;
        for (let k = 0; k < 30; k++) {
            const q = Math.floor(rand() * items.n);
            for (const options of [
                { mode: 'combined', limit: 60, samePromptOnly: false },
                { mode: 'combined', limit: 5, samePromptOnly: false },
                { mode: 'combined', limit: 60, samePromptOnly: true },
                { mode: 'visual', limit: 60, samePromptOnly: false },
                { mode: 'visual', limit: 3, samePromptOnly: true }
            ]) {
                const groupOf = k % 2 ? labels : i => (labels[i] >= 0 ? `g${labels[i]}` : null);
                const got = neighbors(items, q, { ...options, preset: 'standard', groupOf });
                const expected = expectedNeighbors(items, q, { ...options, labels });
                assert.deepEqual(got.map(r => r.idx), expected.map(e => e.j), `${options.mode} q=${q}`);
                for (const [r, e] of got.map((r, x) => [r, expected[x]])) {
                    assert.equal(r.d, e.d);
                    const bothPrompted = items.pi[q] >= 0 && items.pi[r.idx] >= 0;
                    const J = bothPrompted ? items.promptJ(items.pi[q], items.pi[r.idx]) : 0;
                    assert.equal(r.samePrompt, bothPrompted && items.pi[q] === items.pi[r.idx]);
                    assert.equal(r.nearPrompt, bothPrompted && !r.samePrompt && J >= K.NEAR_J);
                    assert.equal(r.sameGroup, labels[q] >= 0 && labels[q] === labels[r.idx]);
                    if (mode === 'hd') {
                        assert.equal(r.cos, e.value);
                        assert.equal(r.similarity, Math.round(100 * e.value));
                    } else {
                        assert.equal(r.v, e.value);
                        assert.equal(r.similarity, Math.round(100 * (1 - e.value / 2)));
                    }
                    if (r.nearPrompt) near++;
                }
                seen += got.length;
            }
        }
        assert.ok(seen > 200, `queries return results (${seen})`);
        assert.ok(near > 0, 'the near-prompt chip fires');
        assert.throws(() => neighbors(items, -1, {}), RangeError);
        assert.throws(() => neighbors(items, 0, { mode: 'fused' }), TypeError);
    });
}

test('hd neighbors: combined keeps d <= 0.15 outside the group, visual keeps cos >= 0.70', () => {
    // Query 0 with prompt P; 1 is its group-mate; 2 shares P but sits outside the group;
    // 3 is promptless and close; 4 is visually close with an unrelated prompt; 5 is far.
    const e0 = direction(mulberry32(3));
    const raw = direction(mulberry32(4));
    const along = raw.reduce((s, x, d) => s + x * e0[d], 0);
    const other = normalise(raw.map((x, d) => x - along * e0[d]));
    const at = c => quantizeEmbedding(Float32Array.from(e0, (x, d) => c * x + Math.sqrt(1 - c * c) * other[d]));
    const rows = [
        { key: 'q', createdAt: 0, np: '同一个提示词', ...at(1) },
        { key: 'm', createdAt: 1, np: '同一个提示词', ...at(0.5) },
        { key: 's', createdAt: 2, np: '同一个提示词', ...at(0.75) },
        { key: 'p', createdAt: 3, np: '', ...at(0.85) },
        { key: 'u', createdAt: 4, np: '完全无关的另一句话', ...at(0.95) },
        { key: 'f', createdAt: 5, np: '', ...at(0.3) }
    ];
    const items = buildItems(rows, { mode: 'hd' });
    const labels = Int32Array.from([0, 0, -1, -1, -1, -1]);
    const combined = neighbors(items, 0, { mode: 'combined', groupOf: labels });
    // 1 comes first as a group-mate even though its d (0.175·g(0.5) ≈ 0.176) is above 0.15.
    // Non-members are ranked by d: 2 (0.175·g(0.75) ≈ 0.063), then 3 (0.45·g(0.85) ≈ 0.097).
    // 4 has an unrelated prompt (J = 0, d > 0.65) and 5 is vetoed.
    assert.deepEqual(combined.map(r => r.idx), [1, 2, 3]);
    assert.deepEqual(neighbors(items, 0, { groupOf: new Map([[0, 'g'], [1, 'g']]) }), combined, 'Map labels');
    assert.ok(combined[0].d > HD.NEIGHBOR_D_MAX && combined[0].sameGroup);
    assert.deepEqual(combined.map(r => r.samePrompt), [true, true, false]);
    const visual = neighbors(items, 0, { mode: 'visual', groupOf: labels });
    assert.deepEqual(visual.map(r => r.idx), [4, 3, 2]);
    assert.deepEqual(visual.map(r => r.similarity), [95, 85, 75]);
    assert.deepEqual(neighbors(items, 0, { mode: 'visual', samePromptOnly: true, groupOf: labels }).map(r => r.idx), [2]);
    assert.deepEqual(neighbors(items, 3, { mode: 'combined', samePromptOnly: true }), [], 'a promptless query has no same-prompt results');
    assert.equal(neighbors(items, 0, { mode: 'visual', limit: 1 }).length, 1);
    assert.equal(neighbors(items, 0, { mode: 'visual', limit: Infinity }).length, 3, 'Infinity returns every match');
    assert.equal(neighbors(items, 0, { mode: 'visual', limit: null }).length, 3, 'null means the default limit');
    assert.equal(neighbors(items, 0, { mode: 'visual', limit: 0 }).length, 0);
});
