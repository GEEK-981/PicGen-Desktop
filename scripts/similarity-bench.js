'use strict';

// Engine bench for similar images v3.1 (plan-v31 §4 WP6, §2.16, §6.1 "Bench").
//
//   node scripts/similarity-bench.js --n 5820,20000 --out <scratch dir> [--seed 20260924]
//        [--from-real all-dinov2-pad.f32 --from-real-ids all.json]
//        [--from-eval <similarity-eval --out dir> [--eval-variant base|jpeg88|…] [--decode-sample 40]
//         [--model models/dinov2-small-q8.onnx]]
//
// Default input: a synthetic library generated from the library's family statistics (family
// size median 3, p90 6, max 29; 14% promptless; same-family cos ~0.85 ± 0.08; unrelated ~0.3),
// run through the production similarityCluster at every --n. It reports the cold edge build
// with the PCA-32 prefilter on and off, the basis time, linkage, the three cuts, attaching one
// row, a neighbour query, and the engine heap (peak and retained).
//
// --from-real replays the tuning bench: the real evaluation embeddings, scaled past their size
// by rotated copies (v31-hybrid/bench.js). --from-eval adds the real library's production rows
// (written by similarity-eval.js as bench-rows.*): the hd and h engine costs at 5.8k, plus an
// optional serial decode+embed sample over the real files (read-only) for the §2.16 row rows.
//
// Writes only bench.json and bench.md under --out (outside the repo and every data root).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const v8 = require('node:v8');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const REPO = path.resolve(__dirname, '..');
const EMB_DIM = 384;
const ROW_BYTES = 2164;

function evalHelpers() {
    return require('./similarity-eval');
}

function parseArgs(argv) {
    const o = { sizes: [], out: null, seed: 20260924, fromReal: null, fromRealIds: null, fromEval: null, evalVariant: 'base', decodeSample: 0, model: null, attachSamples: 20, neighborSamples: 20 };
    const value = (i, name) => {
        if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) throw new Error(`${name} needs a value`);
        return String(argv[i + 1]);
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--n': o.sizes = value(i++, arg).split(',').map(s => Number(s.trim())); break;
            case '--out': o.out = value(i++, arg); break;
            case '--seed': o.seed = Number(value(i++, arg)); break;
            case '--from-real': o.fromReal = value(i++, arg); break;
            case '--from-real-ids': o.fromRealIds = value(i++, arg); break;
            case '--from-eval': o.fromEval = value(i++, arg); break;
            case '--eval-variant': o.evalVariant = value(i++, arg); break;
            case '--decode-sample': o.decodeSample = Number(value(i++, arg)); break;
            case '--model': o.model = value(i++, arg); break;
            default: throw new Error(`unknown argument ${arg}`);
        }
    }
    if (!o.sizes.length || o.sizes.some(n => !Number.isInteger(n) || n < 2 || n > 200000)) throw new Error('--n must list integers 2..200000');
    if (!o.out) throw new Error('--out is required');
    const E = evalHelpers();
    o.out = E.assertSafeOut(o.out, E.forbiddenRoots({ thumbs: [] }));
    if (Boolean(o.fromReal) !== Boolean(o.fromRealIds)) throw new Error('--from-real and --from-real-ids go together');
    if (!Number.isInteger(o.decodeSample) || o.decodeSample < 0) throw new Error('--decode-sample must be a non-negative integer');
    if (o.decodeSample && !o.fromEval) throw new Error('--decode-sample needs --from-eval');
    if (!o.model) o.model = path.join(REPO, 'models', 'dinov2-small-q8.onnx');
    return o;
}

// --- deterministic randomness -------------------------------------------------------------------------------

function mulberry32(seed) {
    return evalHelpers().mulberry32(seed);
}

function gaussian(rng) {
    let u = 0;
    let v = 0;
    while (!u) u = rng();
    while (!v) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function unit(v) {
    let s = 0;
    for (let d = 0; d < v.length; d++) s += v[d] * v[d];
    const norm = Math.sqrt(s) || 1;
    for (let d = 0; d < v.length; d++) v[d] /= norm;
    return v;
}

// A random unit vector orthogonal to every unit vector in `against`.
function randomOrthUnit(rng, against) {
    const v = new Float64Array(EMB_DIM);
    for (let d = 0; d < EMB_DIM; d++) v[d] = gaussian(rng);
    for (const a of against) {
        let s = 0;
        for (let d = 0; d < EMB_DIM; d++) s += v[d] * a[d];
        for (let d = 0; d < EMB_DIM; d++) v[d] -= s * a[d];
    }
    return unit(v);
}

// --- synthetic library ------------------------------------------------------------------------------------

// Family size: P(1..6) = .10/.23/.22/.15/.12/.09 (median 3, p90 6), then a geometric tail 7..29.
const SIZE_HEAD = [0.10, 0.23, 0.22, 0.15, 0.12, 0.09];
function sampleFamilySize(rng) {
    let r = rng();
    for (let s = 0; s < SIZE_HEAD.length; s++) {
        if (r < SIZE_HEAD[s]) return s + 1;
        r -= SIZE_HEAD[s];
    }
    let size = 7;
    while (size < 29 && rng() < 0.8) size++;
    return size;
}

function randomPrompt(rng) {
    const length = 10 + Math.floor(rng() * 70);
    let s = '';
    for (let k = 0; k < length; k++) s += String.fromCodePoint(0x4e00 + Math.floor(rng() * 3000));
    return s;
}

function nearVariant(rng, prompt) {
    const points = Array.from(prompt);
    const edits = 1 + Math.floor(rng() * 2);
    for (let e = 0; e < edits; e++) points[Math.floor(rng() * points.length)] = String.fromCodePoint(0x4e00 + 3000 + Math.floor(rng() * 500));
    return points.join('');
}

// Vectors are √0.3·μ + √0.7·v with v ⊥ μ, so unrelated images have cos ≈ 0.3. Inside a family
// v = ρ·u_f + √(1−ρ²)·z with ρ ~ N(0.886, 0.091): cos = 0.3 + 0.7·ρ_iρ_j ≈ 0.85 ± 0.08.
// Prompts: 14% of families have none; 5% reuse an earlier prompt exactly (a generic prompt on
// unrelated pictures); 8% edit one or two characters of an earlier prompt (J ≈ 0.9), half of
// those on the same picture family. The first family has 29 members.
function synthLibrary(N, { seed = 20260924 } = {}) {
    const rng = mulberry32(seed);
    const mu = randomOrthUnit(rng, []);
    const rows = [];
    const families = [];
    const prompts = [];
    let time = 1.78e12;
    while (rows.length < N) {
        const size = Math.min(families.length === 0 ? 29 : sampleFamilySize(rng), N - rows.length);
        let np = '';
        let centre = null;
        if (rng() >= 0.14) {
            const r = rng();
            if (prompts.length && r < 0.05) {
                np = prompts[Math.floor(rng() * prompts.length)].np;
            } else if (prompts.length && r < 0.13) {
                const base = prompts[Math.floor(rng() * prompts.length)];
                np = nearVariant(rng, base.np);
                if (rng() < 0.5) centre = base.centre;
            } else {
                np = randomPrompt(rng);
            }
        }
        if (!centre) centre = randomOrthUnit(rng, [mu]);
        if (np) prompts.push({ np, centre });
        const members = [];
        time += 60000 + rng() * 7200000;
        for (let k = 0; k < size; k++) {
            const rho = Math.max(0.3, Math.min(0.999, 0.886 + 0.091 * gaussian(rng)));
            const z = randomOrthUnit(rng, [mu, centre]);
            const emb = new Float32Array(EMB_DIM);
            const s = Math.sqrt(1 - rho * rho);
            for (let d = 0; d < EMB_DIM; d++) emb[d] = Math.sqrt(0.3) * mu[d] + Math.sqrt(0.7) * (rho * centre[d] + s * z[d]);
            unit(emb);
            members.push(rows.length);
            rows.push({ key: `syn_${seed}_${rows.length}`, createdAt: Math.round(time + k * rng() * 120000), np, emb });
        }
        families.push({ size, members, prompted: Boolean(np) });
    }
    return { rows, families };
}

// --- tuning replay (--from-real) --------------------------------------------------------------------------

function loadRealEmbeddings(f32File, idsFile) {
    const { normalizePrompt } = require('../similarityPrompt');
    const list = JSON.parse(fs.readFileSync(idsFile, 'utf8'));
    const buf = fs.readFileSync(f32File);
    const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const dim = flat.length / list.length;
    if (dim !== EMB_DIM) throw new Error(`--from-real: expected ${EMB_DIM}-d vectors, got ${dim}`);
    return list.map((x, k) => ({ key: x.id, createdAt: Number(x.createdAt), np: normalizePrompt(x.prompt), emb: flat.slice(k * EMB_DIM, (k + 1) * EMB_DIM) }));
}

// v31-hybrid/bench.js synth(): copies of the real items with prompts mapped through a per-copy
// character bijection (J = 0 across copies) and embeddings rotated by a random orthogonal map that
// keeps the library-mean direction.
function scaleReal(real, N, seed) {
    if (N <= real.length) return real.slice(0, N);
    const rng = mulberry32(seed);
    const gs = vs => {
        const outv = [];
        for (const v0 of vs) {
            const v = Float64Array.from(v0);
            for (const b of outv) {
                let s = 0;
                for (let k = 0; k < v.length; k++) s += v[k] * b[k];
                for (let k = 0; k < v.length; k++) v[k] -= s * b[k];
            }
            let nn = 0;
            for (const x of v) nn += x * x;
            nn = Math.sqrt(nn);
            if (nn < 1e-9) continue;
            for (let k = 0; k < v.length; k++) v[k] /= nn;
            outv.push(v);
        }
        return outv;
    };
    const mu = new Float64Array(EMB_DIM);
    for (const it of real) for (let d = 0; d < EMB_DIM; d++) mu[d] += it.emb[d];
    const chars = [...new Set(real.flatMap(it => Array.from(it.np || '')))];
    const items = real.slice();
    let copy = 0;
    while (items.length < N) {
        copy++;
        const B = gs([mu, ...Array.from({ length: EMB_DIM - 1 }, () => Float64Array.from({ length: EMB_DIM }, () => gaussian(rng)))]);
        const Q = gs(Array.from({ length: EMB_DIM - 1 }, () => Float64Array.from({ length: EMB_DIM - 1 }, () => gaussian(rng))));
        const map = new Map(chars.map((c, k) => [c, String.fromCodePoint(0x20000 + copy * chars.length + k)]));
        for (const it of real) {
            if (items.length >= N) break;
            const c = B.map(b => { let s = 0; for (let k = 0; k < EMB_DIM; k++) s += b[k] * it.emb[k]; return s; });
            const c2 = new Float64Array(EMB_DIM);
            c2[0] = c[0];
            for (let r = 0; r < EMB_DIM - 1; r++) { let s = 0; const q = Q[r]; for (let k = 0; k < EMB_DIM - 1; k++) s += q[k] * c[k + 1]; c2[r + 1] = s; }
            const emb = new Float32Array(EMB_DIM);
            for (let r = 0; r < EMB_DIM; r++) { const b = B[r]; for (let k = 0; k < EMB_DIM; k++) emb[k] += c2[r] * b[k]; }
            unit(emb);
            items.push({ key: `${it.key}#${copy}`, createdAt: it.createdAt + copy * 1e10, np: it.np ? Array.from(it.np).map(ch => map.get(ch)).join('') : '', emb });
        }
    }
    return items;
}

// --- memory ------------------------------------------------------------------------------------------------

let gcFn = null;
function gc() {
    if (!gcFn) {
        if (typeof global.gc === 'function') gcFn = global.gc;
        else {
            v8.setFlagsFromString('--expose-gc');
            gcFn = vm.runInNewContext('gc');
        }
    }
    gcFn();
    gcFn();
}

function memMB() {
    const m = process.memoryUsage();
    return (m.heapUsed + m.arrayBuffers) / 1048576;
}

// --- one engine bench -------------------------------------------------------------------------------------

function median(values) {
    const s = values.slice().sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

// rows: [{key, createdAt, np, emb: Float32Array(384) unit}] → hd engine costs.
async function benchLibrary(rows, { label = '', attachSamples = 20, neighborSamples = 20 } = {}) {
    const C = require('../similarityCluster');
    const { HD } = require('../similarityDistance');
    const { quantizeEmbedding } = require('../similarityFeatures');
    const hdRows = rows.map(r => {
        const e = quantizeEmbedding(r.emb);
        return { key: r.key, createdAt: r.createdAt, np: r.np, q: e.q, inv: e.inv };
    });
    gc();
    const base = memMB();
    let peak = base;
    const sample = () => { const m = memMB(); if (m > peak) peak = m; };
    const yieldEvery = async () => { sample(); };

    let t = performance.now();
    const items = C.buildItems(hdRows, { mode: 'hd' });
    const itemsMs = performance.now() - t;
    sample();
    t = performance.now();
    const off = await C.buildEdges(items, { prefilter: 'off', yieldEvery });
    const edgesOffMs = performance.now() - t;
    sample();
    t = performance.now();
    const on = await C.buildEdges(items, { prefilter: 'on', yieldEvery });
    const edgesOnMs = performance.now() - t;
    sample();
    t = performance.now();
    const basis = C.buildPcaBasis(items);
    const basisMs = performance.now() - t;
    const onGiven = await C.buildEdges(items, { prefilter: 'on', basis, yieldEvery });
    const auto = items.promptless.length * items.n > C.CLUSTER.PCA_AUTO_MIN_PAIRS ? 'on' : 'off';
    const E = evalHelpers();
    const edgesIdentical = E.edgesIdentical(off, on) && E.edgesIdentical(off, onGiven);
    sample();
    t = performance.now();
    const lk = await C.sparseAverage(items.n, off, { T: HD.T_EDGE, dist: items.dist, yieldEvery });
    const linkageMs = performance.now() - t;
    sample();
    t = performance.now();
    const cuts = ['strict', 'standard', 'loose'].map(p => C.cutGroups(lk.merges, items.n, HD.PRESETS[p]));
    const cutsMs = performance.now() - t;
    sample();

    const rng = mulberry32(7);
    const picks = Array.from({ length: attachSamples }, () => Math.floor(rng() * items.n));
    const attach = [];
    const attachBasis = [];
    for (const idx of picks) {
        t = performance.now();
        C.edgesFor(items, idx);
        attach.push(performance.now() - t);
    }
    C.edgesFor(items, picks[0], { basis }); // projections are cached per items: warm them first
    for (const idx of picks) {
        t = performance.now();
        C.edgesFor(items, idx, { basis });
        attachBasis.push(performance.now() - t);
    }
    const labels = C.cutLabels(lk.merges, items.n, HD.PRESETS.standard);
    const nb = [];
    for (let k = 0; k < neighborSamples; k++) {
        const idx = Math.floor(rng() * items.n);
        t = performance.now();
        C.neighbors(items, idx, { mode: 'combined', groupOf: labels });
        nb.push(performance.now() - t);
    }
    sample();
    gc();
    const retained = memMB() - base;
    // Keep the engine structures alive until after the retained measurement.
    const keep = [items, off, on, onGiven, lk, cuts, labels, basis].length;
    void keep;
    const multi = cuts.map(g => g.filter(x => x.length > 1).length);
    return {
        label,
        n: items.n,
        promptless: items.promptless.length,
        prompts: items.prompts.length,
        edges: off.ei.length,
        candPromptPairs: off.stats.candPromptPairs,
        autoPrefilter: auto,
        edgesIdentical,
        itemsMs: r1(itemsMs),
        edgesOffMs: r1(edgesOffMs),
        edgesOnMs: r1(edgesOnMs),
        edgesAutoMs: r1(auto === 'on' ? edgesOnMs : edgesOffMs),
        edgeParts: { off: roundParts(off.stats.ms), on: roundParts(on.stats.ms) },
        prefilterExactDots: on.stats.exactDots,
        prefilterSkipped: on.stats.prefilterSkipped,
        basisMs: r1(basisMs),
        linkageMs: r1(linkageMs),
        cutsMs: r2(cutsMs),
        linkagePlusCutsMs: r1(linkageMs + cutsMs),
        pairEvals: lk.pairEvals,
        capHits: lk.capHits,
        multi,
        largest: cuts.map(g => Math.max(...g.map(x => x.length))),
        attachMedianMs: r2(median(attach)),
        attachMaxMs: r2(Math.max(...attach)),
        attachBasisMedianMs: r2(median(attachBasis)),
        neighborsMedianMs: r2(median(nb)),
        heapPeakMB: r1(peak - base),
        heapRetainedMB: r1(retained),
        heapAbsolutePeakMB: r1(peak),
        featureStoreMB: r1((16 + items.n * ROW_BYTES) / 1e6)
    };
}

function roundParts(ms) {
    return Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, r1(v)]));
}

// h fallback costs on real production rows.
async function benchH(hRows) {
    const C = require('../similarityCluster');
    const { H } = require('../similarityDistance');
    let t = performance.now();
    const items = C.buildItems(hRows, { mode: 'h' });
    const edges = await C.buildEdges(items);
    const edgesMs = performance.now() - t;
    t = performance.now();
    const lk = await C.sparseAverage(items.n, edges, { T: H.T_EDGE, dist: items.dist });
    const linkageMs = performance.now() - t;
    return { n: items.n, edges: edges.ei.length, edgesMs: r1(edgesMs), linkageMs: r1(linkageMs), multi: ['strict', 'standard', 'loose'].map(p => C.cutGroups(lk.merges, items.n, H.PRESETS[p]).filter(g => g.length > 1).length) };
}

// --- real rows from similarity-eval (--from-eval) -------------------------------------------------------------

function loadEvalRows(dir, variant = 'base') {
    const F = require('../similarityFeatures');
    const suffix = variant === 'base' ? '' : `-${variant}`;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `bench-rows${suffix}.json`), 'utf8'));
    const bin = fs.readFileSync(path.join(dir, `bench-rows${suffix}.bin`));
    const hd = [];
    const h = [];
    meta.items.forEach((it, k) => {
        const u = F.unpackRow(bin.subarray(k * ROW_BYTES, (k + 1) * ROW_BYTES));
        if (!u.crcOk) throw new Error(`bench-rows.bin row ${k} fails its CRC`);
        hd.push({ key: it.key, createdAt: it.createdAt, np: it.np, emb: Float32Array.from(u.q, v => v * u.inv), q: u.q, inv: u.inv, flags: u.flags });
        h.push({ key: it.key, createdAt: it.createdAt, np: it.np, h: { hsv: u.hsv, lab: u.lab, layout: u.layout, logR: u.logR, whiteFrac: u.whiteFrac, phash: u.phash } });
    });
    return { meta, hd, h };
}

// Serial and 2-lane decode + embed samples over the real files (read-only), per source.
// variant: the source-B chain of similarity-eval.js --variant (the adopted O1 chain).
async function decodeSample(meta, count, modelPath, variant = 'base') {
    const sharp = require('sharp');
    sharp.cache(false);
    const { createDecoder } = require('../similarityDecode');
    const { createEmbedder } = require('../similarityEmbedder');
    const decoder = createDecoder({ sharp });
    const decodeB = evalHelpers().createVariantDecoder(variant, sharp, decoder);
    const embedder = createEmbedder({ modelPath });
    let t = performance.now();
    const loaded = await embedder.load();
    const loadMs = performance.now() - t;
    if (!loaded.ok) throw new Error(`embedder unavailable: ${loaded.reason}`);
    const rng = mulberry32(99);
    const pick = (list, k) => {
        const pool = list.slice();
        const outp = [];
        while (outp.length < k && pool.length) outp.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
        return outp;
    };
    const A = pick(meta.items.filter(it => it.source === 'jpeg360'), count);
    const Bs = meta.items.filter(it => it.source !== 'jpeg360');
    const B1 = pick(Bs, count);
    const B2 = pick(Bs, count);
    const one = async it => {
        const t0 = performance.now();
        const d = it.source === 'jpeg360'
            ? await decoder.decode({ originalPath: it.filePath, jpegPath: it.jpegPath, hasAlpha: false })
            : await decodeB({ filePath: it.filePath, hasAlpha: it.hasAlpha, width: Infinity, height: Infinity });
        const t1 = performance.now();
        await embedder.embed(d.rgb224);
        return { decode: t1 - t0, embed: performance.now() - t1 };
    };
    const serial = async list => { const outp = []; for (const it of list) outp.push(await one(it)); return outp; };
    await one(A[0] || B1[0]); // warm-up
    const a = await serial(A);
    const b = await serial(B1);
    t = performance.now();
    let next = 0;
    await Promise.all([0, 1].map(async () => { while (next < B2.length) await one(B2[next++]); }));
    const twoLaneWallPerRow = (performance.now() - t) / Math.max(1, B2.length);
    await embedder.release();
    const mean = v => v.reduce((s, x) => s + x, 0) / (v.length || 1);
    return {
        sessionLoadMs: r1(loadMs),
        A: { n: a.length, decodeMedianMs: r1(median(a.map(x => x.decode))), embedMedianMs: r1(median(a.map(x => x.embed))), rowMeanMs: r1(mean(a.map(x => x.decode + x.embed))) },
        B: { n: b.length, decodeMedianMs: r1(median(b.map(x => x.decode))), embedMedianMs: r1(median(b.map(x => x.embed))), rowMeanMs: r1(mean(b.map(x => x.decode + x.embed))) },
        B2laneWallPerRowMs: r1(twoLaneWallPerRow)
    };
}

async function statSample(meta) {
    const { historyThumbnailKey } = require('../historyThumbnailKey');
    const list = meta.items;
    const t = performance.now();
    let next = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
        while (next < list.length) {
            const it = list[next++];
            try {
                const st = await fsp.stat(it.filePath);
                historyThumbnailKey(path.resolve(it.filePath), st);
            } catch { /* counted as missing by the engine */ }
        }
    }));
    return r1(performance.now() - t);
}

function provisionalSample(meta) {
    const { provisionalBatches } = require('../similarityPrompt');
    const C = require('../similarityCluster');
    const records = meta.items.map(it => ({ id: it.key, np: it.np, createdAt: it.createdAt }));
    const t = performance.now();
    const batches = provisionalBatches(records);
    const groups = C.attachProvisional([], batches, new Set(records.map(r => r.id)));
    return { ms: r1(performance.now() - t), groups: groups.length };
}

// --- targets ----------------------------------------------------------------------------------------------------

// §2.16 rows with numbers at 5.8k (the limit is +50%), plus the 20k targets of §6.1.
function budgetRows(res) {
    const rows = [];
    // info: reported against the planned figure but not a gate (§6.1 gates 5.8k rows and two 20k rows).
    const add = (row, planned, limit, measured, unit, source, info = false) => rows.push({
        row, planned, limit: `${limit} ${unit}`, measured: measured === null || measured === undefined ? 'n/a' : `${measured} ${unit}`,
        pass: measured === null || measured === undefined ? null : measured <= limit, info, source
    });
    const real = res.real && res.real.hd;
    const syn = res.synthetic.find(r => r.n >= 5000 && r.n <= 7000);
    const big = res.synthetic.find(r => r.n >= 19000);
    const hd58 = real || syn;
    const src = real ? 'real rows' : 'synthetic';
    if (hd58) {
        add('Cold edge build (hd), 5.8k', '1.04 s', 1560, hd58.edgesAutoMs, 'ms', src);
        add('Linkage and 3 cuts (hd), 5.8k', '≈ 70 ms', 105, hd58.linkagePlusCutsMs, 'ms', src);
        // The 0.3 ms of §2.16 / 0.32 ms of §2.8 were measured with the PCA prefilter (tuning bench).
        add('Attach one row, 5.8k, with a PCA basis (as §2.16 was measured)', '0.3 ms', 0.45, hd58.attachBasisMedianMs, 'ms', src);
        add('Attach one row, 5.8k, no basis (the auto path at 5.8k); tuning no-prefilter median 0.47 ms', '0.47 ms', 0.705, hd58.attachMedianMs, 'ms', src, true);
        add('Neighbour query, 5.8k', '≈ 3 ms', 4.5, hd58.neighborsMedianMs, 'ms', src);
        add('Feature store on disk, 5.8k', '12.6 MB', 18.9, hd58.featureStoreMB, 'MB', src);
    }
    if (syn && real) {
        add('Cold edge build (hd), synthetic 5.8k', '1.04 s', 1560, syn.edgesAutoMs, 'ms', 'synthetic');
        add('Linkage and 3 cuts (hd), synthetic 5.8k', '≈ 70 ms', 105, syn.linkagePlusCutsMs, 'ms', 'synthetic');
    }
    if (res.real && res.real.h) {
        add('H fallback edges, 5.8k', '2.1 s', 3150, res.real.h.edgesMs, 'ms', 'real rows');
        add('H fallback linkage, 5.8k', '192 ms', 288, res.real.h.linkageMs, 'ms', 'real rows');
    }
    if (res.real && res.real.decode) {
        const d = res.real.decode;
        const nA = res.real.counts.sourceA;
        const nB = res.real.counts.sourceB;
        add(`Rows from reused JPEGs (${nA} × mean row)`, '≈ 66 s', 99, r1(nA * d.A.rowMeanMs / 1000), 's', 'serial sample');
        add(`Rows from originals, 1 lane + 100 ms gap (${nB} rows)`, '≈ 25–31 min', 46.5, r1(nB * (d.B.rowMeanMs + 100) / 60000), 'min', 'serial sample');
        add(`Rows from originals, 2 lanes (${nB} rows)`, '≈ 12–14 min', 21, r1(nB * d.B2laneWallPerRowMs / 60000), 'min', '2-lane sample');
        add('Session create + self-test (part of host start)', '≈ 0.3–0.6 s', 900, d.sessionLoadMs, 'ms', 'plain Node');
        add('Embedding one image (toNchw + run + pool), 2 threads', '≈ 18 ms', 27, d.A.embedMedianMs, 'ms', 'serial sample');
    }
    if (res.real && Number.isFinite(res.real.statMs)) add('Warm stat validation, 5.8k (concurrency 16)', '≤ 3 s', 4500, res.real.statMs, 'ms', 'real files');
    if (res.real && res.real.provisional) add('Provisional groups, cold, 5.8k', '≤ 100 ms', 150, res.real.provisional.ms, 'ms', 'real records');
    if (big) {
        add('Cold edge build (hd), 20k', '≈ 3.7 s (gate ≤ 20 s)', 20000, big.edgesAutoMs, 'ms', 'synthetic');
        add('Engine heap peak, 20k', '≤ 250 MB', 250, big.heapPeakMB, 'MB', 'synthetic');
        add('Linkage and 3 cuts (hd), 20k', '≈ 147 ms', 220.5, big.linkagePlusCutsMs, 'ms', 'synthetic', true);
        add('Attach one row, 20k, with a PCA basis', '1.07 ms', 1.6, big.attachBasisMedianMs, 'ms', 'synthetic', true);
        add('Neighbour query, 20k', '≈ 10 ms (est.)', 15, big.neighborsMedianMs, 'ms', 'synthetic', true);
    }
    return rows;
}

function verdict(b) {
    if (b.pass === null) return 'n/a';
    if (b.info) return b.pass ? 'ok (info)' : 'over (info)';
    return b.pass ? 'PASS' : 'FAIL';
}

async function main(o) {
    fs.mkdirSync(o.out, { recursive: true });
    const log = line => console.log(line);
    const res = { generatedAt: new Date().toISOString(), argv: process.argv.slice(2), node: process.version, synthetic: [], fromReal: [], real: null };
    for (const N of o.sizes) {
        const lib = synthLibrary(N, { seed: o.seed });
        const r = await benchLibrary(lib.rows, { label: `synthetic ${N}` });
        res.synthetic.push(r);
        log(JSON.stringify(r));
    }
    if (o.fromReal) {
        const real = loadRealEmbeddings(o.fromReal, o.fromRealIds);
        for (const N of o.sizes) {
            const r = await benchLibrary(scaleReal(real, N, 99), { label: `tuning replay ${Math.min(N, real.length)}${N > real.length ? `→${N}` : ''}` });
            res.fromReal.push(r);
            log(JSON.stringify(r));
        }
    }
    if (o.fromEval) {
        const { meta, hd, h } = loadEvalRows(o.fromEval, o.evalVariant);
        res.real = { variant: o.evalVariant, counts: { n: hd.length, sourceA: meta.items.filter(it => it.source === 'jpeg360').length, sourceB: meta.items.filter(it => it.source !== 'jpeg360').length } };
        res.real.hd = await benchLibrary(hd, { label: `real ${hd.length} (production rows)` });
        log(JSON.stringify(res.real.hd));
        res.real.h = await benchH(h);
        log(JSON.stringify({ h: res.real.h }));
        res.real.statMs = await statSample(meta);
        res.real.provisional = provisionalSample(meta);
        if (o.decodeSample) res.real.decode = await decodeSample(meta, o.decodeSample, path.resolve(o.model), o.evalVariant);
        log(JSON.stringify({ statMs: res.real.statMs, provisional: res.real.provisional, decode: res.real.decode || null }));
    }
    res.budget = budgetRows(res);
    res.allPass = res.budget.every(b => b.info || b.pass !== false);
    fs.writeFileSync(path.join(o.out, 'bench.json'), JSON.stringify(res, null, 1));
    const E = evalHelpers();
    const cols = ['label', 'n', 'promptless', 'edges', 'autoPrefilter', 'edgesOffMs', 'edgesOnMs', 'basisMs', 'edgesIdentical', 'linkageMs', 'cutsMs', 'attachMedianMs', 'attachBasisMedianMs', 'neighborsMedianMs', 'heapPeakMB', 'heapRetainedMB', 'multi', 'largest'];
    const all = res.synthetic.concat(res.fromReal, res.real ? [res.real.hd] : []).map(r => ({ ...r, multi: r.multi.join('/'), largest: r.largest.join('/') }));
    const md = [
        '# Similar images v3.1: engine bench (WP6)',
        '',
        `Generated ${res.generatedAt} with Node ${res.node}. Engine = production similarityCluster (hd, int8 rows).`,
        '',
        '## Engine runs',
        '',
        E.markdownTable(all, cols),
        res.real && res.real.h ? `h fallback on the real rows: ${res.real.h.edges} edges in ${res.real.h.edgesMs} ms, linkage ${res.real.h.linkageMs} ms, multi ${res.real.h.multi.join('/')}.\n` : '',
        '## Budget (§2.16 at 5.8k within +50%; 20k edge build ≤ 20 s; engine heap at 20k ≤ 250 MB)',
        '',
        E.markdownTable(res.budget.map(b => ({ ...b, pass: verdict(b) })), ['row', 'planned', 'limit', 'measured', 'pass', 'source']),
        `Not measurable offline (need the WP7 host / WP8 service): main cost per get or push, first sync, fork + require of the host, warm start in the host, host RSS.`,
        '',
        `All measured gated budget rows pass: **${res.allPass}** (rows marked info are reported only).`,
        ''
    ].join('\n');
    fs.writeFileSync(path.join(o.out, 'bench.md'), md);
    log(`[bench] wrote ${path.join(o.out, 'bench.md')}`);
    return res;
}

if (require.main === module) {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`similarity-bench: ${error.message}`);
        process.exit(2);
    }
    main(options).catch(error => {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    });
}

module.exports = { parseArgs, mulberry32, synthLibrary, sampleFamilySize, scaleReal, benchLibrary, benchH, budgetRows };
