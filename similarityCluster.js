'use strict';

// Exact sparse average-linkage clustering for similar-image grouping
// (v3.1 plan §2.1, §2.7, §2.8, §2.11; final.md §3.3, §3.4).
//
// Pure (no fs, no Electron): the similarity host and the offline eval share it.
//
//   buildItems(rows) → buildEdges(items) → sparseAverage(n, edges) → cutGroups(merges, n, t)
//
// - Items are indexed by canonical rank (createdAt ascending, then key). Every loop runs in
//   index order and every tie is broken by index, so input order never changes the result.
// - Edges are every pair with d <= T_EDGE (the loosest preset). Pruning is exact: a pair is
//   skipped only when the formula's bounds (similarityDistance.boundsHD / boundsH) prove
//   d > T, and every surviving candidate is checked with the exact distance.
// - The promptless scan (hd) can use an exact PCA-32 prefilter: with an orthonormal basis W,
//   p = W·x and r = ‖x − Wᵀp‖, so x_a·x_b <= p_a·p_b + r_a·r_b (Cauchy–Schwarz on the
//   residual). A pair is skipped only when that bound plus 1e-5 is below noPromptCosMin.
// - sparseAverage is the lazy exact average linkage of final.md §3.3, ported from
//   v31-hybrid/sparse.js. A partial sum that exceeds T·|A||B| marks only that cluster pair as
//   over; it is not propagated on merge, because (A∪B, X) can still average <= T. Only a true
//   Infinity (veto or cannot-link) propagates. On merge a side's exact sum is used whenever
//   it is known.
// - Long loops are generators. buildEdges and sparseAverage return Promises and await
//   `yieldEvery()` about every `sliceMs` (20 ms); a throw from yieldEvery aborts the run.

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { HD, H, boundsHD, boundsH, distanceHD, distanceH, visualH } = require('./similarityDistance');
const { bigrams, jaccard, promptPairSteps } = require('./similarityPrompt');

const EMB_DIM = 384;

const CLUSTER = Object.freeze({
    EVAL_CAP: 20e6,             // exact pair evaluations per linkage run (final.md §3.3.6)
    SLICE_MS: 20,               // yieldEvery cadence
    PCA_DIMS: 32,
    PCA_MAX_SAMPLES: 2000,
    PCA_AUTO_MIN_PAIRS: 10e6,   // 'auto' prefilter when promptlessCount × n exceeds this
    PCA_MARGIN: 1e-5,
    PCA_ORTHO_TOL: 1e-4,        // a basis is accepted only if max|W·Wᵀ − I| <= this
    PCA_MAX_ITERATIONS: 30,
    SUBGROUP_MIN: 24,           // groups with more members than this try subgroups (§2.1)
    NEIGHBOR_LIMIT: 60
});

// Candidate filters run slightly looser than the algebraic bound, so float rounding in g,
// gInv or J can only admit extra candidates; each one is then checked with the exact d.
const COS_SLACK = 1e-9;
const J_SLACK = 1e-9;
const J_CACHE_MAX = 1 << 20;
// Roughly how much work (pair distances) runs between two generator yields.
const YIELD_WORK = 4096;
// The same for the prompt-pair search, in set lookups (similarityPrompt.promptPairSteps).
const PROMPT_YIELD_WORK = 1 << 16;
// Pair codes for edge maps: i * PAIR_BASE + j stays exact below 2^53 for n < 2^26.
const PAIR_BASE = 2 ** 26;

function compareKeys(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

// Raw dot products of two embedding rows. The int8 sum is an exact integer (at most
// 384·127² < 2^23), so the unrolled order gives exactly the bits of cosQ's plain loop. The
// float rows of the offline eval keep the plain order.
function dotInt8(q, oi, oj) {
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let d = 0; d < EMB_DIM; d += 4) {
        s0 += q[oi + d] * q[oj + d];
        s1 += q[oi + d + 1] * q[oj + d + 1];
        s2 += q[oi + d + 2] * q[oj + d + 2];
        s3 += q[oi + d + 3] * q[oj + d + 3];
    }
    return (s0 + s1) + (s2 + s3);
}

function dotFloat(q, oi, oj) {
    let s = 0;
    for (let d = 0; d < EMB_DIM; d++) s += q[oi + d] * q[oj + d];
    return s;
}

function now() {
    return performance.now();
}

// --- generator drivers ----------------------------------------------------------------------------

function runSync(steps) {
    for (;;) {
        const step = steps.next();
        if (step.done) return step.value;
    }
}

async function drive(steps, yieldEvery, sliceMs = CLUSTER.SLICE_MS) {
    if (typeof yieldEvery !== 'function') return runSync(steps);
    try {
        let last = now();
        for (;;) {
            const step = steps.next();
            if (step.done) return step.value;
            if (now() - last >= sliceMs) {
                await yieldEvery();
                last = now();
            }
        }
    } finally {
        steps.return();
    }
}

// --- items ------------------------------------------------------------------------------------------

function assertEmbedding(row) {
    const q = row.q;
    if (!q || typeof q.length !== 'number' || q.length !== EMB_DIM) {
        throw new TypeError(`buildItems: row ${row.key} needs a ${EMB_DIM}-value embedding q`);
    }
    const inv = Number(row.inv);
    if (!Number.isFinite(inv) || inv < 0) throw new TypeError(`buildItems: row ${row.key} needs a finite inv >= 0`);
    return inv;
}

function assertH(row) {
    const h = row.h;
    const ok = h && typeof h === 'object'
        && h.hsv && h.hsv.length === 128
        && h.lab && h.lab.length === 256
        && h.layout && h.layout.length === 48
        && h.phash && h.phash.length === 8
        && Number.isFinite(h.logR) && Number.isFinite(h.whiteFrac);
    if (!ok) throw new TypeError(`buildItems: row ${row.key} needs H features {hsv, lab, layout, logR, whiteFrac, phash}`);
    return h;
}

// rows: [{key, createdAt, np, q, inv}] (hd) or [{key, createdAt, np, h}] (h). `np` is the
// normalised prompt ('' = none). In hd, q is normally the Int8Array(384) of a feature row;
// the offline eval may pass float unit vectors with inv = 1 (stored as Float32Array).
// cannotLink: [[keyA, keyB]…]; pairs with absent keys are ignored.
function buildItems(rows, { mode, cannotLink = null } = {}) {
    if (mode !== 'hd' && mode !== 'h') throw new TypeError(`buildItems: mode must be 'hd' or 'h' (got ${mode})`);
    const hd = mode === 'hd';
    const entries = [];
    const seen = new Set();
    for (const row of rows || []) {
        if (!row || typeof row !== 'object') throw new TypeError('buildItems: every row must be an object');
        const key = row.key === undefined || row.key === null ? '' : String(row.key);
        if (!key) throw new TypeError('buildItems: every row needs a key');
        if (seen.has(key)) throw new Error(`buildItems: duplicate key ${JSON.stringify(key)}`);
        seen.add(key);
        const createdAt = Number(row.createdAt);
        entries.push({ row, key, createdAt: Number.isFinite(createdAt) ? createdAt : 0 });
    }
    entries.sort((a, b) => a.createdAt - b.createdAt || compareKeys(a.key, b.key));

    const n = entries.length;
    const keys = new Array(n);
    const createdAt = new Float64Array(n);
    const np = new Array(n);
    const pi = new Int32Array(n);
    const indexOf = new Map();
    const prompts = [];
    const promptIds = new Map();
    for (let i = 0; i < n; i++) {
        const { row, key } = entries[i];
        keys[i] = key;
        createdAt[i] = entries[i].createdAt;
        indexOf.set(key, i);
        const p = typeof row.np === 'string' ? row.np : '';
        np[i] = p;
        if (!p) {
            pi[i] = -1;
            continue;
        }
        let id = promptIds.get(p);
        if (id === undefined) {
            id = prompts.length;
            promptIds.set(p, id);
            prompts.push(p);
        }
        pi[i] = id;
    }
    const m = prompts.length;
    const promptSets = prompts.map(p => bigrams(p));
    const promptSizes = Int32Array.from(promptSets, set => set.size);
    const families = Array.from({ length: m }, () => []);
    const promptlessList = [];
    for (let i = 0; i < n; i++) (pi[i] >= 0 ? families[pi[i]] : promptlessList).push(i);
    const byPrompt = families.map(list => Int32Array.from(list));
    const promptless = Int32Array.from(promptlessList);

    let q = null;
    let inv = null;
    let h = null;
    if (hd) {
        const int8 = entries.every(e => e.row.q instanceof Int8Array);
        q = int8 ? new Int8Array(n * EMB_DIM) : new Float32Array(n * EMB_DIM);
        inv = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const { row } = entries[i];
            inv[i] = assertEmbedding(row);
            q.set(row.q, i * EMB_DIM);
        }
    } else {
        h = new Array(n);
        for (let i = 0; i < n; i++) h[i] = assertH(entries[i].row);
    }

    const cannot = new Set();
    for (const pair of cannotLink || []) {
        if (!pair || pair.length < 2) continue;
        const a = indexOf.get(String(pair[0]));
        const b = indexOf.get(String(pair[1]));
        if (a === undefined || b === undefined || a === b) continue;
        cannot.add(a < b ? a * n + b : b * n + a);
    }

    const jCache = new Map();
    function promptJ(a, b) {
        if (a === b) return 1;
        const code = a < b ? a * m + b : b * m + a;
        let value = jCache.get(code);
        if (value === undefined) {
            value = jaccard(promptSets[a], promptSets[b]);
            if (jCache.size >= J_CACHE_MAX) jCache.clear();
            jCache.set(code, value);
        }
        return value;
    }
    function primeJ(a, b, value) {
        if (a === b) return;
        if (jCache.size >= J_CACHE_MAX) jCache.clear();
        jCache.set(a < b ? a * m + b : b * m + a, value);
    }

    function cannotLinked(i, j) {
        return cannot.size !== 0 && cannot.has(i < j ? i * n + j : j * n + i);
    }

    // Int8 cosine, bitwise equal to similarityDistance.cosQ: an exact integer dot product
    // times (invA · invB). Symmetric in i and j.
    const dot = q instanceof Int8Array ? dotInt8 : dotFloat;
    function cos(i, j) {
        return dot(q, i * EMB_DIM, j * EMB_DIM) * (inv[i] * inv[j]);
    }

    function visual(i, j) {
        return i < j ? visualH(h[i], h[j]) : visualH(h[j], h[i]);
    }

    // d from an already computed visual value (cos in hd, v in h); equal to the frozen
    // distanceHD / distanceH on the same inputs.
    function distFrom(i, j, value) {
        const a = pi[i];
        const b = pi[j];
        const bothPrompted = a >= 0 && b >= 0;
        if (hd) {
            if (!(value >= HD.VETO_COS)) return Infinity;
            return distanceHD({ cos: value, J: bothPrompted ? promptJ(a, b) : 0, bothPrompted, cannot: cannotLinked(i, j) });
        }
        if (!(value <= H.VETO_V)) return Infinity;
        return distanceH({ v: value, J: bothPrompted ? promptJ(a, b) : 0, bothPrompted, cannot: cannotLinked(i, j) });
    }

    function dist(i, j) {
        if (i > j) {
            const t = i;
            i = j;
            j = t;
        }
        return distFrom(i, j, hd ? cos(i, j) : visual(i, j));
    }

    return Object.freeze({
        mode,
        n,
        dim: EMB_DIM,
        keys,
        createdAt,
        np,
        pi,
        indexOf,
        prompts,
        promptSets,
        promptSizes,
        byPrompt,
        promptless,
        q,
        inv,
        h,
        cannotCount: cannot.size,
        cannotLinked,
        promptJ,
        primeJ,
        cos: hd ? cos : null,
        visual: hd ? null : visual,
        distFrom,
        dist
    });
}

function assertItems(items, mode) {
    if (!items || (items.mode !== 'hd' && items.mode !== 'h') || typeof items.dist !== 'function') {
        throw new TypeError('expected items from buildItems');
    }
    if (mode !== undefined && mode !== items.mode) throw new Error(`mode ${mode} does not match the items (${items.mode})`);
}

function resolveT(items, T) {
    const value = T === undefined ? (items.mode === 'hd' ? HD.T_EDGE : H.T_EDGE) : T;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`T must be a finite number (got ${T})`);
    return value;
}

// --- edge lists -------------------------------------------------------------------------------------------

function sortedEdges(ei, ej, ed) {
    const count = ei.length;
    const order = new Int32Array(count);
    for (let k = 0; k < count; k++) order[k] = k;
    order.sort((x, y) => ei[x] - ei[y] || ej[x] - ej[y]);
    const out = { ei: new Int32Array(count), ej: new Int32Array(count), ed: new Float64Array(count) };
    for (let k = 0; k < count; k++) {
        const s = order[k];
        out.ei[k] = ei[s];
        out.ej[k] = ej[s];
        out.ed[k] = ed[s];
    }
    return out;
}

// Moves edges from one items index space to another by key. Pairs whose key is absent from
// `toItems`, listed in dropKeys (a changed row), or cannot-linked in `toItems` are dropped.
// Distances are reused, so every kept key's row must be unchanged. After a cannot-link is
// removed, add that pair back with edgesFor.
function remapEdges(edges, fromItems, toItems, { dropKeys = null } = {}) {
    const drop = dropKeys ? new Set(Array.from(dropKeys, String)) : null;
    const map = new Int32Array(fromItems.n).fill(-1);
    for (let i = 0; i < fromItems.n; i++) {
        const key = fromItems.keys[i];
        if (drop && drop.has(key)) continue;
        const k = toItems.indexOf.get(key);
        if (k !== undefined) map[i] = k;
    }
    const ei = [];
    const ej = [];
    const ed = [];
    for (let k = 0; k < edges.ei.length; k++) {
        const a = map[edges.ei[k]];
        const b = map[edges.ej[k]];
        if (a < 0 || b < 0 || a === b || toItems.cannotLinked(a, b)) continue;
        ei.push(a < b ? a : b);
        ej.push(a < b ? b : a);
        ed.push(edges.ed[k]);
    }
    return sortedEdges(ei, ej, ed);
}

// Union of two edge lists in the same index space; for a pair in both, b's value wins.
function mergeEdges(a, b) {
    const byPair = new Map();
    for (const edges of [a, b]) {
        for (let k = 0; k < edges.ei.length; k++) {
            const i = edges.ei[k];
            const j = edges.ej[k];
            if (i === j) continue;
            byPair.set(i < j ? i * PAIR_BASE + j : j * PAIR_BASE + i, edges.ed[k]);
        }
    }
    const codes = Array.from(byPair.keys()).sort((x, y) => x - y);
    const out = { ei: new Int32Array(codes.length), ej: new Int32Array(codes.length), ed: new Float64Array(codes.length) };
    codes.forEach((code, k) => {
        out.ei[k] = Math.floor(code / PAIR_BASE);
        out.ej[k] = code % PAIR_BASE;
        out.ed[k] = byPair.get(code);
    });
    return out;
}

// --- PCA-32 basis ---------------------------------------------------------------------------------------------

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

// Modified Gram–Schmidt, applied twice (re-orthogonalisation). A vector that collapses
// (rank deficiency) is replaced by a fresh deterministic random direction, so the result is
// always a full orthonormal set: any orthonormal basis keeps the prefilter exact.
function orthonormalise(vectors, dim, rand) {
    const out = [];
    for (const input of vectors) {
        let v = Float64Array.from(input);
        const scale = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        for (let attempt = 0; ; attempt++) {
            for (let pass = 0; pass < 2; pass++) {
                for (const b of out) {
                    let dot = 0;
                    for (let d = 0; d < dim; d++) dot += v[d] * b[d];
                    for (let d = 0; d < dim; d++) v[d] -= dot * b[d];
                }
            }
            let norm = 0;
            for (let d = 0; d < dim; d++) norm += v[d] * v[d];
            norm = Math.sqrt(norm);
            if (norm > 1e-9 * scale && norm > 1e-300) {
                for (let d = 0; d < dim; d++) v[d] /= norm;
                break;
            }
            if (attempt > 8) throw new Error('orthonormalise: could not complete the basis');
            v = Float64Array.from({ length: dim }, () => rand() * 2 - 1);
        }
        out.push(v);
    }
    return out;
}

// Top eigenvectors of the uncentred second-moment matrix of at most maxSamples dequantised
// embeddings (a deterministic stride sample), by subspace iteration.
function* pcaBasisSteps(items, { dims = CLUSTER.PCA_DIMS, maxSamples = CLUSTER.PCA_MAX_SAMPLES } = {}) {
    if (items.mode !== 'hd') return null;
    const D = items.dim;
    const k = Math.floor(dims);
    if (!(k >= 1 && k <= D)) throw new RangeError(`buildPcaBasis: dims must be 1..${D}`);
    const usable = [];
    for (let i = 0; i < items.n; i++) if (items.inv[i] > 0) usable.push(i);
    if (!usable.length) return null;

    const count = Math.max(1, Math.min(Math.floor(maxSamples) || 1, usable.length));
    const M = new Float64Array(D * D);
    const x = new Float64Array(D);
    const { q, inv } = items;
    for (let s = 0; s < count; s++) {
        const i = usable[Math.floor((s * usable.length) / count)];
        const offset = i * D;
        for (let d = 0; d < D; d++) x[d] = q[offset + d] * inv[i];
        for (let a = 0; a < D; a++) {
            const xa = x[a];
            if (xa === 0) continue;
            const row = a * D;
            for (let b = a; b < D; b++) M[row + b] += xa * x[b];
        }
        if ((s & 15) === 15) yield;
    }
    for (let a = 0; a < D; a++) for (let b = 0; b < a; b++) M[a * D + b] = M[b * D + a];
    yield;

    const rand = mulberry32(0x5eed32);
    let basis = orthonormalise(Array.from({ length: k }, () => Float64Array.from({ length: D }, () => rand() * 2 - 1)), D, rand);
    let previous = -1;
    for (let it = 0; it < CLUSTER.PCA_MAX_ITERATIONS; it++) {
        let trace = 0;
        const next = basis.map(vec => {
            const z = new Float64Array(D);
            for (let a = 0; a < D; a++) {
                const row = a * D;
                let s = 0;
                for (let b = 0; b < D; b++) s += M[row + b] * vec[b];
                z[a] = s;
            }
            for (let a = 0; a < D; a++) trace += vec[a] * z[a];
            return z;
        });
        basis = orthonormalise(next, D, rand);
        yield;
        if (it >= 2 && Math.abs(trace - previous) <= 1e-10 * Math.abs(trace)) break;
        previous = trace;
    }

    const out = new Float32Array(k * D);
    basis.forEach((vec, r) => out.set(vec, r * D));
    return acceptBasis(out, D) ? out : null;
}

// Validates a stored basis (Float32Array(dims·384), rows = basis vectors) and returns the
// working copy, re-orthonormalised in double precision, or null.
const acceptedBases = new WeakMap();
function acceptBasis(basis, D = EMB_DIM) {
    if (!basis || typeof basis.length !== 'number' || !basis.length || basis.length % D !== 0) return null;
    if (typeof basis === 'object' && acceptedBases.has(basis)) return acceptedBases.get(basis);
    const k = basis.length / D;
    let result = null;
    if (k <= D && Array.prototype.every.call(basis, Number.isFinite)) {
        let worst = 0;
        for (let a = 0; a < k && worst <= CLUSTER.PCA_ORTHO_TOL; a++) {
            for (let b = a; b < k; b++) {
                let s = 0;
                for (let d = 0; d < D; d++) s += basis[a * D + d] * basis[b * D + d];
                worst = Math.max(worst, Math.abs(s - (a === b ? 1 : 0)));
            }
        }
        if (worst <= CLUSTER.PCA_ORTHO_TOL) {
            const rows = Array.from({ length: k }, (_, r) => Float64Array.from(basis.subarray ? basis.subarray(r * D, (r + 1) * D) : basis.slice(r * D, (r + 1) * D)));
            const W = new Float64Array(k * D);
            orthonormalise(rows, D, mulberry32(1)).forEach((vec, r) => W.set(vec, r * D));
            result = { k, W };
        }
    }
    if (typeof basis === 'object') acceptedBases.set(basis, result);
    return result;
}

// p = W·x and r = ‖x − Wᵀp‖ = sqrt(max(0, ‖x‖² − ‖p‖²)) for every item, x = q·inv.
function* projectionSteps(items, accepted) {
    const { k, W } = accepted;
    const D = items.dim;
    const { n, q, inv } = items;
    const P = new Float64Array(n * k);
    const R = new Float64Array(n);
    const x = new Float64Array(D);
    for (let i = 0; i < n; i++) {
        const offset = i * D;
        let xx = 0;
        for (let d = 0; d < D; d++) {
            x[d] = q[offset + d] * inv[i];
            xx += x[d] * x[d];
        }
        let pp = 0;
        for (let r = 0; r < k; r++) {
            const row = r * D;
            let s = 0;
            for (let d = 0; d < D; d++) s += W[row + d] * x[d];
            P[i * k + r] = s;
            pp += s * s;
        }
        R[i] = Math.sqrt(Math.max(0, xx - pp));
        if ((i & 63) === 63) yield;
    }
    return { k, P, R };
}

const projectionCache = new WeakMap();
function* projectionsFor(items, basis) {
    const cached = projectionCache.get(items);
    if (cached && cached.basis === basis) return cached.proj;
    const accepted = acceptBasis(basis, items.dim);
    if (!accepted) return null;
    const proj = yield* projectionSteps(items, accepted);
    projectionCache.set(items, { basis, proj });
    return proj;
}

function upperBound(proj, a, b) {
    const { k, P, R } = proj;
    const oa = a * k;
    const ob = b * k;
    let s = 0;
    for (let r = 0; r < k; r++) s += P[oa + r] * P[ob + r];
    return s + R[a] * R[b];
}

function buildPcaBasis(items, { dims = CLUSTER.PCA_DIMS, maxSamples = CLUSTER.PCA_MAX_SAMPLES } = {}) {
    assertItems(items);
    return runSync(pcaBasisSteps(items, { dims, maxSamples }));
}

// --- edges ---------------------------------------------------------------------------------------------------

function usePrefilter(prefilter, pairs) {
    if (prefilter === 'on') return true;
    if (prefilter === 'off') return false;
    if (prefilter === 'auto') return pairs > CLUSTER.PCA_AUTO_MIN_PAIRS;
    throw new TypeError(`prefilter must be 'auto', 'on' or 'off' (got ${prefilter})`);
}

// One promptless item i against every j (pairs between two promptless items are scanned
// once, from the lower index). Hot loop kept out of the generator.
function scanPromptless(items, i, isPromptless, T, bounds, proj, out, counters) {
    const { n } = items;
    if (items.mode === 'hd') {
        const { q, inv } = items;
        const int8 = q instanceof Int8Array;
        const cosMin = bounds.noPromptCosMin;
        const candidateMin = cosMin - COS_SLACK;
        const oi = i * EMB_DIM;
        for (let j = 0; j < n; j++) {
            if (j === i || (isPromptless[j] === 1 && j < i)) continue;
            const a = i < j ? i : j;
            const b = i < j ? j : i;
            if (proj !== null && upperBound(proj, a, b) + CLUSTER.PCA_MARGIN < cosMin) {
                counters.skipped++;
                continue;
            }
            // Inlined dotInt8 / dotFloat (same order, so the bits match items.cos(a, b)).
            const oj = j * EMB_DIM;
            let s;
            if (int8) {
                let s0 = 0;
                let s1 = 0;
                let s2 = 0;
                let s3 = 0;
                for (let d = 0; d < EMB_DIM; d += 4) {
                    s0 += q[oi + d] * q[oj + d];
                    s1 += q[oi + d + 1] * q[oj + d + 1];
                    s2 += q[oi + d + 2] * q[oj + d + 2];
                    s3 += q[oi + d + 3] * q[oj + d + 3];
                }
                s = (s0 + s1) + (s2 + s3);
            } else {
                s = 0;
                for (let d = 0; d < EMB_DIM; d++) s += q[oi + d] * q[oj + d];
            }
            const c = s * (inv[a] * inv[b]);
            counters.dots++;
            if (!(c >= candidateMin)) continue;
            const dd = items.distFrom(a, b, c);
            if (dd <= T) out.push(a, b, dd);
        }
        return;
    }
    for (let j = 0; j < n; j++) {
        if (j === i || (isPromptless[j] === 1 && j < i)) continue;
        const a = i < j ? i : j;
        const b = i < j ? j : i;
        counters.dots++;
        const dd = items.dist(a, b);
        if (dd <= T) out.push(a, b, dd);
    }
}

function* edgeSteps(items, { T, prefilter, basis, bruteMax, dims, maxSamples }) {
    const hd = items.mode === 'hd';
    const { n, pi, byPrompt, promptless, promptSets } = items;
    const bounds = hd ? boundsHD(T) : boundsH(T);
    const sameCosMin = hd ? bounds.sameCosMin - COS_SLACK : 0;
    const stats = {
        mode: items.mode,
        T,
        bounds,
        n,
        promptCount: items.prompts.length,
        promptlessCount: promptless.length,
        candPromptPairs: 0,
        promptedPairs: 0,
        promptlessPairs: 0,
        exactDots: 0,
        prefilter: 'off',
        prefilterSkipped: 0,
        basisSource: null,
        edges: 0,
        ms: { promptPairs: 0, promptedEdges: 0, basis: 0, promptlessScan: 0 }
    };
    // Flat triples (i, j, d) with i < j.
    const out = [];
    const tryPrompted = (i, j) => {
        stats.promptedPairs++;
        if (hd) {
            const c = items.cos(i, j);
            if (!(c >= sameCosMin)) return;
            const d = items.distFrom(i, j, c);
            if (d <= T) out.push(i, j, d);
        } else {
            const d = items.dist(i, j);
            if (d <= T) out.push(i, j, d);
        }
    };

    let t0 = now();
    // The prompt-pair search is sliced too (it was the one unsliced block, WP2 review).
    const pairOptions = bruteMax === undefined || bruteMax === null ? {} : { bruteMax };
    const candidates = yield* promptPairSteps(promptSets, bounds.jMin - J_SLACK, { ...pairOptions, yieldWork: PROMPT_YIELD_WORK });
    let work = 0;
    for (const [a, b, J] of candidates) {
        items.primeJ(a, b, J);
        if (++work >= YIELD_WORK) {
            work = 0;
            yield;
        }
    }
    stats.candPromptPairs = candidates.length;
    stats.ms.promptPairs = now() - t0;
    yield;

    t0 = now();
    work = 0;
    for (const family of byPrompt) {
        for (let x = 0; x < family.length; x++) {
            for (let y = x + 1; y < family.length; y++) tryPrompted(family[x], family[y]);
            work += family.length - x;
            if (work >= YIELD_WORK) {
                work = 0;
                yield;
            }
        }
    }
    for (const [a, b] of candidates) {
        const A = byPrompt[a];
        const B = byPrompt[b];
        for (const i of A) {
            for (const j of B) (i < j ? tryPrompted(i, j) : tryPrompted(j, i));
            work += B.length;
            if (work >= YIELD_WORK) {
                work = 0;
                yield;
            }
        }
    }
    stats.ms.promptedEdges = now() - t0;
    yield;

    let proj = null;
    let basisOut = null;
    if (hd && promptless.length && usePrefilter(prefilter, promptless.length * n)) {
        t0 = now();
        let accepted = basis ? acceptBasis(basis, items.dim) : null;
        if (accepted) {
            basisOut = basis;
            stats.basisSource = 'given';
        } else {
            const built = yield* pcaBasisSteps(items, { dims, maxSamples });
            if (built && acceptBasis(built, items.dim)) {
                basisOut = built;
                stats.basisSource = 'built';
            }
        }
        if (basisOut) proj = yield* projectionsFor(items, basisOut);
        stats.prefilter = proj ? 'on' : 'unavailable';
        stats.ms.basis = now() - t0;
    } else {
        usePrefilter(prefilter, 0); // validates the option in every mode
    }

    t0 = now();
    const isPromptless = new Uint8Array(n);
    for (const i of promptless) isPromptless[i] = 1;
    const counters = { dots: 0, skipped: 0 };
    work = 0;
    for (const i of promptless) {
        scanPromptless(items, i, isPromptless, T, bounds, proj, out, counters);
        work += n;
        if (work >= YIELD_WORK) {
            work = 0;
            yield;
        }
    }
    stats.promptlessPairs = counters.dots + counters.skipped;
    stats.exactDots = counters.dots;
    stats.prefilterSkipped = counters.skipped;
    stats.ms.promptlessScan = now() - t0;

    const ei = [];
    const ej = [];
    const ed = [];
    for (let k = 0; k < out.length; k += 3) {
        ei.push(out[k]);
        ej.push(out[k + 1]);
        ed.push(out[k + 2]);
    }
    const edges = sortedEdges(ei, ej, ed);
    stats.edges = edges.ei.length;
    return { ...edges, stats, basis: basisOut };
}

// Every pair with d <= T (default: the mode's T_EDGE), sorted by (ei, ej), ei < ej.
// Returns a Promise of {ei: Int32Array, ej: Int32Array, ed: Float64Array, stats, basis}:
// `basis` is the Float32Array PCA basis the promptless scan used (given, or built when
// stats.basisSource is 'built', so the caller can persist it), or null.
async function buildEdges(items, {
    mode,
    T,
    prefilter = 'auto',
    basis = null,
    yieldEvery = null,
    sliceMs = CLUSTER.SLICE_MS,
    bruteMax,
    dims = CLUSTER.PCA_DIMS,
    maxSamples = CLUSTER.PCA_MAX_SAMPLES
} = {}) {
    assertItems(items, mode);
    const edgeT = resolveT(items, T);
    return drive(edgeSteps(items, { T: edgeT, prefilter, basis, bruteMax, dims, maxSamples }), yieldEvery, sliceMs);
}

// The edges of one item against all others (attach a new or changed row), with the same
// pruning. Sorted by (ei, ej). With `basis`, the promptless comparisons use the PCA
// prefilter; projections are cached per items object, so pass it only when the same items
// serve many calls. Never pass it for a fresh items object (the incremental path builds one
// per change): projecting every item then costs 140–220 ms, unsliced, against ~2 ms without.
function edgesFor(items, idx, { mode, T, basis = null } = {}) {
    assertItems(items, mode);
    const edgeT = resolveT(items, T);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.n) throw new RangeError(`edgesFor: index ${idx} out of range`);
    const hd = items.mode === 'hd';
    const { n, pi, promptSizes } = items;
    const bounds = hd ? boundsHD(edgeT) : boundsH(edgeT);
    const jMin = bounds.jMin - J_SLACK;
    const sameCosMin = hd ? bounds.sameCosMin - COS_SLACK : 0;
    const noPromptCosMin = hd ? bounds.noPromptCosMin - COS_SLACK : 0;
    const proj = hd && basis ? runSync(projectionsFor(items, basis)) : null;
    const p = pi[idx];
    const status = p >= 0 ? new Int8Array(items.prompts.length) : null; // 0 unknown, 1 candidate, -1 pruned
    if (status) status[p] = 1;

    const ei = [];
    const ej = [];
    const ed = [];
    for (let j = 0; j < n; j++) {
        if (j === idx) continue;
        const a = idx < j ? idx : j;
        const b = idx < j ? j : idx;
        const pj = pi[j];
        const bothPrompted = p >= 0 && pj >= 0;
        if (bothPrompted) {
            let s = status[pj];
            if (s === 0) {
                const x = promptSizes[p];
                const y = promptSizes[pj];
                s = (x < y ? x / y : y / x) < jMin || items.promptJ(p, pj) < jMin ? -1 : 1;
                status[pj] = s;
            }
            if (s < 0) continue;
        }
        let d;
        if (hd) {
            if (!bothPrompted && proj !== null && upperBound(proj, a, b) + CLUSTER.PCA_MARGIN < bounds.noPromptCosMin) continue;
            const c = items.cos(a, b);
            if (!(c >= (bothPrompted ? sameCosMin : noPromptCosMin))) continue;
            d = items.distFrom(a, b, c);
        } else {
            d = items.dist(a, b);
        }
        if (d <= edgeT) {
            ei.push(a);
            ej.push(b);
            ed.push(d);
        }
    }
    // j ascending already yields (ei, ej) order: first (j, idx) for j < idx, then (idx, j).
    return { ei: Int32Array.from(ei), ej: Int32Array.from(ej), ed: Float64Array.from(ed) };
}

// --- linkage -------------------------------------------------------------------------------------------------

class Heap {
    constructor() {
        this.a = [];
    }

    static less(x, y) {
        return x.v < y.v || (x.v === y.v && (x.a < y.a || (x.a === y.a && x.b < y.b)));
    }

    push(x) {
        const a = this.a;
        a.push(x);
        let i = a.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!Heap.less(a[i], a[parent])) break;
            [a[parent], a[i]] = [a[i], a[parent]];
            i = parent;
        }
    }

    pop() {
        const a = this.a;
        const top = a[0];
        const last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let s = i;
                if (l < a.length && Heap.less(a[l], a[s])) s = l;
                if (r < a.length && Heap.less(a[r], a[s])) s = r;
                if (s === i) break;
                [a[s], a[i]] = [a[i], a[s]];
                i = s;
            }
        }
        return top;
    }

    get size() {
        return this.a.length;
    }
}

// Cluster ids: 0..n-1 are the items, merge k creates cluster n + k.
// A record per neighbouring cluster pair: s = known sum, c = known count,
// x = exact sum (undefined while unknown, Infinity when vetoed), over = proven > T for
// this exact pair only.
function* linkageSteps(nItems, edges, T, dist, cap) {
    const members = [];
    const alive = [];
    const nbr = [];
    for (let i = 0; i < nItems; i++) {
        members.push([i]);
        alive.push(true);
        nbr.push(new Map());
    }
    const { ei, ej, ed } = edges;
    for (let k = 0; k < ei.length; k++) {
        const i = ei[k];
        const j = ej[k];
        const d = ed[k];
        if (!(i >= 0 && i < nItems && j >= 0 && j < nItems) || !Number.isInteger(i) || !Number.isInteger(j)) {
            throw new RangeError(`sparseAverage: edge ${k} (${i}, ${j}) is out of range`);
        }
        if (i === j || d !== d) continue;
        const r = { s: d, c: 1, x: d, over: false };
        nbr[i].set(j, r);
        nbr[j].set(i, r);
    }
    const heap = new Heap();
    let evals = 0;
    let pairEvals = 0;
    let capHits = 0;
    const lowerBound = (a, b, r) => {
        const total = members[a].length * members[b].length;
        return r.x !== undefined ? r.x / total : (r.s + (total - r.c) * T) / total;
    };
    const pushRecord = (a, b, r) => {
        if (r.over || r.x === Infinity) return;
        const v = lowerBound(a, b, r);
        if (!(v <= T)) return;
        heap.push({ v, a: Math.min(a, b), b: Math.max(a, b), exact: r.x !== undefined });
    };
    for (let a = 0; a < nItems; a++) for (const [b, r] of nbr[a]) if (a < b) pushRecord(a, b, r);
    yield;

    const merges = [];
    let lastHeight = -Infinity;
    let pops = 0;
    while (heap.size) {
        const e = heap.pop();
        if (e.v > T) break;
        if ((++pops & 63) === 0) yield;
        if (!alive[e.a] || !alive[e.b]) continue;
        const r = nbr[e.a].get(e.b);
        if (!r || r.over || r.x === Infinity) continue;
        if (Math.abs(lowerBound(e.a, e.b, r) - e.v) > 1e-12 || e.exact !== (r.x !== undefined)) continue; // stale
        const A = members[e.a];
        const B = members[e.b];
        const total = A.length * B.length;

        if (r.x === undefined) {
            // Exact evaluation of a lower-bound entry. Past the cap the pair counts as over:
            // nothing is ever merged on an estimate. (It can let another pair merge first,
            // so a capped run is not always a refinement of the uncapped one.)
            if (pairEvals + total > cap) {
                capHits++;
                r.over = true;
                continue;
            }
            evals++;
            pairEvals += total;
            const limit = T * total;
            let sum = 0;
            let veto = false;
            let over = false;
            let work = 0;
            outer: for (const i of A) {
                for (const j of B) {
                    let d = i < j ? dist(i, j) : dist(j, i);
                    if (d !== d) d = Infinity;
                    if (d === Infinity) {
                        veto = true;
                        break outer;
                    }
                    sum += d;
                    if (sum > limit) {
                        over = true;
                        break outer;
                    }
                }
                work += B.length;
                if (work >= YIELD_WORK) {
                    work = 0;
                    yield;
                }
            }
            if (veto) r.x = Infinity;
            else if (over) r.over = true;
            else {
                r.x = sum;
                pushRecord(e.a, e.b, r);
            }
            continue;
        }

        // Exact global minimum: merge.
        const a = e.a;
        const b = e.b;
        const id = members.length;
        const nA = A.length;
        const nB = B.length;
        members.push(A.concat(B));
        alive.push(true);
        alive[a] = false;
        alive[b] = false;
        const merged = new Map();
        nbr.push(merged);
        // Average linkage is reducible, so heights never decrease; the clamp only absorbs
        // float rounding and keeps every cut a prefix of the merge list.
        const height = e.v > lastHeight ? e.v : lastHeight;
        lastHeight = height;
        merges.push([a, b, height]);
        const around = new Set([...nbr[a].keys(), ...nbr[b].keys()]);
        around.delete(a);
        around.delete(b);
        for (const X of around) {
            const ra = nbr[a].get(X);
            const rb = nbr[b].get(X);
            const xa = ra ? ra.x : undefined;
            const xb = rb ? rb.x : undefined;
            const nX = members[X].length;
            const exactA = xa !== undefined && xa !== Infinity;
            const exactB = xb !== undefined && xb !== Infinity;
            const record = {
                s: (ra ? (exactA ? xa : ra.s) : 0) + (rb ? (exactB ? xb : rb.s) : 0),
                c: (ra ? (exactA ? nA * nX : ra.c) : 0) + (rb ? (exactB ? nB * nX : rb.c) : 0),
                x: undefined,
                over: false
            };
            if (xa === Infinity || xb === Infinity) record.x = Infinity;
            else if (xa !== undefined && xb !== undefined) record.x = xa + xb;
            else if (record.c === (nA + nB) * nX) record.x = record.s;
            nbr[X].delete(a);
            nbr[X].delete(b);
            nbr[X].set(id, record);
            merged.set(X, record);
            pushRecord(id, X, record);
        }
        nbr[a] = null;
        nbr[b] = null;
        members[a] = null;
        members[b] = null;
    }
    return { merges, capHits, pairEvals, evals, clusters: members.length };
}

// Lazy exact average linkage over an edge list that holds every pair with d <= T.
// dist(i, j) (called with i < j) must be the same distance the edges came from. An edge list
// missing some pair with d <= T (for example one built at a smaller T) is not detected and
// makes the result inexact.
// Returns a Promise of {merges: [[a, b, height]…], capHits, pairEvals, evals, clusters}.
async function sparseAverage(n, edges, { T, dist, cap = CLUSTER.EVAL_CAP, yieldEvery = null, sliceMs = CLUSTER.SLICE_MS } = {}) {
    if (!Number.isInteger(n) || n < 0) throw new TypeError('sparseAverage: n must be a non-negative integer');
    if (typeof T !== 'number' || !Number.isFinite(T)) throw new TypeError('sparseAverage: T must be a finite number');
    if (typeof dist !== 'function') throw new TypeError('sparseAverage: dist must be a function');
    if (!edges || !edges.ei || !edges.ej || !edges.ed) throw new TypeError('sparseAverage: edges must be {ei, ej, ed}');
    // null / undefined / NaN mean the default cap; Infinity disables it.
    const limit = cap === null || cap === undefined ? CLUSTER.EVAL_CAP : Number(cap);
    return drive(linkageSteps(n, edges, T, dist, Number.isNaN(limit) ? CLUSTER.EVAL_CAP : limit), yieldEvery, sliceMs);
}

// --- cuts, ids, subgroups ---------------------------------------------------------------------------------

// Replays the merges with height <= t. Label = the smallest (oldest) item index in the group.
function cutLabels(merges, n, t) {
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = x => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    const rep = new Int32Array(n + merges.length);
    for (let i = 0; i < n; i++) rep[i] = i;
    for (let k = 0; k < merges.length; k++) {
        const [a, b, h] = merges[k];
        rep[n + k] = rep[a];
        if (h <= t) {
            const x = find(rep[a]);
            const y = find(rep[b]);
            if (x !== y) {
                if (x < y) parent[y] = x;
                else parent[x] = y;
            }
        }
    }
    const labels = new Int32Array(n);
    for (let i = 0; i < n; i++) labels[i] = find(i);
    return labels;
}

// The partition at t: every item appears once (singletons included); members ascending;
// groups ordered by their oldest member.
function cutGroups(merges, n, t) {
    const labels = cutLabels(merges, n, t);
    const groups = [];
    const byLabel = new Map();
    for (let i = 0; i < n; i++) {
        let group = byLabel.get(labels[i]);
        if (!group) {
            group = [];
            byLabel.set(labels[i], group);
            groups.push(group);
        }
        group.push(i);
    }
    return groups;
}

function anchorId(historyKey) {
    return 'sg_' + crypto.createHash('sha1').update(String(historyKey), 'utf8').digest('hex').slice(0, 12);
}

const labelCache = new WeakMap();
function cachedLabels(merges, n, t) {
    let byCut = labelCache.get(merges);
    if (!byCut) {
        byCut = new Map();
        labelCache.set(merges, byCut);
    }
    const key = `${n}:${t}`;
    let labels = byCut.get(key);
    if (!labels) {
        labels = cutLabels(merges, n, t);
        byCut.set(key, labels);
    }
    return labels;
}

// §2.1: a group with more than 24 members shows the parts of the next stricter cut, if that
// cut gives at least 2 parts with at least 2 members; its singletons go to `rest`.
// Parts are ordered by size (then oldest member); members keep the order of `members`.
// Returns null when the group stays flat. `merges` is treated as immutable (labels are cached).
function subgroups(members, merges, n, tNext) {
    const list = Array.from(members || [], Number);
    if (list.length <= CLUSTER.SUBGROUP_MIN) return null;
    const labels = cachedLabels(merges, n, tNext);
    const byLabel = new Map();
    for (const i of list) {
        let part = byLabel.get(labels[i]);
        if (!part) {
            part = [];
            byLabel.set(labels[i], part);
        }
        part.push(i);
    }
    const parts = [...byLabel.values()].filter(part => part.length >= 2);
    if (parts.length < 2) return null;
    const oldest = part => part.reduce((min, i) => (i < min ? i : min), Infinity);
    parts.sort((x, y) => y.length - x.length || oldest(x) - oldest(y));
    const rest = list.filter(i => byLabel.get(labels[i]).length < 2);
    return { parts, rest };
}

// final.md §3.4 snapshot composition.
//
// Decision (FIX-cluster, WP2 review; binding for WP7 and WP12): unanalysed keys come in two
// kinds, and only one of them makes a group provisional.
// - `pending`: keys the engine will still analyse in this session (queued, decoding,
//   embedding, or an hd row without DINO_OK waiting for re-extraction).
// - `options.failed`: keys whose row failed and will not be retried this session (§2.9
//   retries a `fail` row only at the next launch while failCount < 3, or after a size change).
//   A key in both sets counts as pending.
// Both kinds attach the same way: a key joins the analysed group holding most of its analysed
// batch-mates (ties go to the older anchor). A failed key attaches like a final member: it is
// listed in the group's `failed` and leaves `provisional` alone, so once every present file is
// analysed or failed the groups are final (never provisional forever). Only a pending member
// makes a group `provisional: true`.
// A batch whose unattached keys have no analysed group forms a new provisional group when it
// has at least 2 such keys and at least one of them is pending. A batch of failed keys only
// forms no group: it has no visual evidence and will never gain any, so a final group would
// let cleanup act on prompt and time alone, and a provisional one would never finish.
// Cleanup (WP12): refuse `provisional` groups as §2.14 says; `failed` members were never
// compared visually, so the plan should keep them (never preselect them), like protected ones.
// The snapshot (WP7) should carry `failed` per group for that purpose.
//
// analysedGroups: arrays of keys, ordered by anchor age (oldest first, as cutGroups orders
// them); groups of fewer than 2 are not groups. batches: provisionalBatches output.
// Returns [{members, provisional, base, pending, failed}], analysed groups first (in order),
// then the new groups: `base` is the analysedGroups index (−1 for a new group), and
// `pending` / `failed` list the attached keys of each kind in batch order.
function attachProvisional(analysedGroups, batches, pending, { failed = null } = {}) {
    const asSet = keys => (keys instanceof Set ? keys : new Set(Array.from(keys || [], String)));
    const pendingSet = asSet(pending);
    const failedSet = asSet(failed);
    const groups = [];
    const groupOf = new Map();
    Array.from(analysedGroups || []).forEach((group, base) => {
        const members = Array.from(group || [], String);
        if (members.length < 2) return;
        const out = { members, provisional: false, base, pending: [], failed: [] };
        groups.push(out);
        for (const key of members) if (!groupOf.has(key)) groupOf.set(key, out);
    });
    const placed = new Set();
    const fresh = [];
    const attach = (group, keys) => {
        for (const key of keys) {
            group.members.push(key);
            if (pendingSet.has(key)) {
                group.pending.push(key);
                group.provisional = true;
            } else {
                group.failed.push(key);
            }
            placed.add(key);
        }
    };
    for (const batch of batches || []) {
        const keys = Array.from(batch || [], String);
        const waiting = keys.filter(key => (pendingSet.has(key) || failedSet.has(key)) && !groupOf.has(key) && !placed.has(key));
        if (!waiting.length) continue;
        const counts = new Map();
        for (const key of keys) {
            const group = groupOf.get(key);
            if (group) counts.set(group, (counts.get(group) || 0) + 1);
        }
        let best = null;
        let bestCount = 0;
        for (const [group, count] of counts) {
            if (count > bestCount || (count === bestCount && group.base < best.base)) {
                best = group;
                bestCount = count;
            }
        }
        if (best) {
            attach(best, waiting);
        } else if (waiting.length >= 2 && waiting.some(key => pendingSet.has(key))) {
            const group = { members: [], provisional: true, base: -1, pending: [], failed: [] };
            attach(group, waiting);
            fresh.push(group);
        }
    }
    return groups.concat(fresh);
}

// --- neighbours ---------------------------------------------------------------------------------------------

function labelReader(groupOf) {
    let read = () => null;
    if (typeof groupOf === 'function') read = groupOf;
    else if (groupOf && typeof groupOf.get === 'function') read = i => groupOf.get(i);
    else if (groupOf && typeof groupOf.length === 'number') read = i => groupOf[i];
    return i => {
        const label = read(i);
        return label === undefined || label === null || label === -1 ? null : label;
    };
}

// §2.11 desktop:similarity-neighbors, one query against all items.
// combined: group-mates first (ranked by d), then non-members with d <= NEIGHBOR_D_MAX
// (hd 0.15, h 0.35) ranked by d. visual: hd cos >= 0.70 ranked by cos; h v <= 0.6 ranked by v.
// Ties go to the older item. groupOf: labels by item index (array, typed array or Map;
// −1/null/undefined = single) or a function of the index.
// Each result: {idx, d, cos (hd) | v (h), similarity, samePrompt, nearPrompt, sameGroup};
// nearPrompt is set only for a different prompt with J >= NEAR_J.
function neighbors(items, qIdx, { mode = 'combined', preset, limit = CLUSTER.NEIGHBOR_LIMIT, samePromptOnly = false, groupOf = null } = {}) {
    assertItems(items);
    if (!Number.isInteger(qIdx) || qIdx < 0 || qIdx >= items.n) throw new RangeError(`neighbors: index ${qIdx} out of range`);
    if (mode !== 'combined' && mode !== 'visual') throw new TypeError(`neighbors: mode must be 'combined' or 'visual' (got ${mode})`);
    void preset; // groupOf already reflects the preset
    const hd = items.mode === 'hd';
    const K = hd ? HD : H;
    // null / undefined / NaN mean the default limit; Infinity returns every match.
    const requested = limit === null || limit === undefined ? CLUSTER.NEIGHBOR_LIMIT : Number(limit);
    const cap = Number.isNaN(requested) ? CLUSTER.NEIGHBOR_LIMIT : Math.max(0, Math.floor(requested));
    if (cap === 0) return [];
    const { n, pi, promptSizes } = items;
    const labelOf = labelReader(groupOf);
    const qLabel = labelOf(qIdx);
    const qp = pi[qIdx];
    const valueOf = hd ? (a, b) => items.cos(a, b) : (a, b) => items.visual(a, b);

    // Pruning bounds for non-members in combined mode (d <= dMax).
    const dMax = K.NEIGHBOR_D_MAX;
    const bounds = hd ? boundsHD(dMax) : boundsH(dMax);
    const jMin = bounds.jMin - J_SLACK;
    const status = qp >= 0 ? new Int8Array(items.prompts.length) : null;
    if (status) status[qp] = 1;
    const promptClose = pj => {
        let s = status[pj];
        if (s === 0) {
            const x = promptSizes[qp];
            const y = promptSizes[pj];
            s = (x < y ? x / y : y / x) < jMin || items.promptJ(qp, pj) < jMin ? -1 : 1;
            status[pj] = s;
        }
        return s > 0;
    };

    const mates = [];
    const others = [];
    for (let j = 0; j < n; j++) {
        if (j === qIdx) continue;
        const pj = pi[j];
        if (samePromptOnly && !(qp >= 0 && pj === qp)) continue;
        const a = qIdx < j ? qIdx : j;
        const b = qIdx < j ? j : qIdx;
        const sameGroup = qLabel !== null && labelOf(j) === qLabel;
        if (mode === 'visual') {
            const value = valueOf(a, b);
            if (hd ? value >= HD.VISUAL_COS_MIN : value <= H.VISUAL_V_MAX) others.push({ j, a, b, value, sameGroup, d: 0 });
            continue;
        }
        const bothPrompted = qp >= 0 && pj >= 0;
        if (!sameGroup && bothPrompted && !promptClose(pj)) continue;
        const value = valueOf(a, b);
        if (!sameGroup && hd && !(value >= (bothPrompted ? bounds.sameCosMin : bounds.noPromptCosMin) - COS_SLACK)) continue;
        const d = items.distFrom(a, b, value);
        if (sameGroup) mates.push({ j, a, b, value, sameGroup, d });
        else if (d <= dMax) others.push({ j, a, b, value, sameGroup, d });
    }

    let ranked;
    if (mode === 'visual') {
        others.sort((x, y) => (hd ? y.value - x.value : x.value - y.value) || x.j - y.j);
        ranked = others.slice(0, cap);
        for (const r of ranked) r.d = items.distFrom(r.a, r.b, r.value);
    } else {
        const byD = (x, y) => x.d - y.d || x.j - y.j;
        mates.sort(byD);
        others.sort(byD);
        ranked = mates.concat(others).slice(0, cap);
    }

    return ranked.map(r => {
        const pj = pi[r.j];
        const bothPrompted = qp >= 0 && pj >= 0;
        const samePrompt = bothPrompted && pj === qp;
        const nearPrompt = bothPrompted && !samePrompt && items.promptJ(qp, pj) >= K.NEAR_J;
        const out = { idx: r.j, d: r.d };
        if (hd) {
            out.cos = r.value;
            out.similarity = Math.round(100 * r.value);
        } else {
            out.v = r.value;
            out.similarity = Math.round(100 * (1 - r.value / 2));
        }
        out.samePrompt = samePrompt;
        out.nearPrompt = nearPrompt;
        out.sameGroup = r.sameGroup;
        return out;
    });
}

module.exports = {
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
};
