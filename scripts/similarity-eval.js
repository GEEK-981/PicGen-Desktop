'use strict';

// Offline GO / NO-GO gates for similar images v3.1 (plan-v31 §4 WP6, §6.1 O1–O9).
//
// Reads a real history library IN PLACE and READ-ONLY (the index JSON, the history JPEGs and
// the originals). Everything it writes goes under --out, which must lie outside the repo and
// outside every data root; feature rows are cached there, so a re-run only re-analyses what
// changed.
//
//   node scripts/similarity-eval.js --index <recent-images.json> --thumbs <dir> [--thumbs <dir>…]
//        --model models/dinov2-small-q8.onnx --lanes 6 --out <scratch dir>
//        [--ref-hd ref-groups-final-009.json] [--ref-h ref-groups-Hw-0125.json]
//        [--judge all-mobileclip-pad.f32 --judge-ids all.json] [--sheets]
//        [--variant base|jpeg88|noenlarge|rotate] [--shuffles 5] [--no-dense] [--limit N]
//
// Rows are built with the production modules (similarityDecode, similarityEmbedder,
// similarityFeatures packRow/unpackRow, similarityCluster, similarityDistance) in two variants:
//   B  source B (the 256px decode of the original) for every image: the reference variant;
//   P  the production source rule: the history JPEG for opaque originals that have one
//      (source A), source B otherwise.
// Gate mapping (the report states it too): O1 and O8 are fidelity gates of the decode chain,
// measured on B; O2 compares P with B (and int8 with float); O3–O6 describe what users get,
// measured on P; O7 is structural, on P.
//
// --variant only changes source B, in the order the plan lists as O1 fallbacks:
//   jpeg88     DINOv2 input from an in-memory JPEG q88 round trip of the 256px buffer
//   noenlarge  withoutEnlargement on the 256px resize, DINOv2 path only
//   rotate     .rotate() (EXIF orientation) on source B
//
// The MobileCLIP judge (--judge) is evaluation-only (research licence): it never enters the
// repo or the app. Its vectors are aligned with --judge-ids (the tuning's all.json list).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const REPO = path.resolve(__dirname, '..');
const VARIANTS = Object.freeze(['base', 'jpeg88', 'noenlarge', 'rotate']);
const PRESET_NAMES = Object.freeze(['strict', 'standard', 'loose']);
const EMB_DIM = 384;
const CACHE_VERSION = 1;
const STAT_CONCURRENCY = 16;
const JUDGE = Object.freeze({ NEAR_J: 0.7692, POS_PROMPT: 0.8, POS_NOP: 0.9, NEG: 0.5 });

// --- arguments and safety ------------------------------------------------------------------------

function parseArgs(argv) {
    const o = {
        index: null, thumbs: [], model: null, lanes: 6, out: null, refHd: null, refH: null,
        judge: null, judgeIds: null, sheets: false, variant: 'base', shuffles: 5, dense: true, limit: 0
    };
    const value = (i, name) => {
        if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) throw new Error(`${name} needs a value`);
        return String(argv[i + 1]);
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--index': o.index = value(i++, arg); break;
            case '--thumbs': o.thumbs.push(value(i++, arg)); break;
            case '--model': o.model = value(i++, arg); break;
            case '--lanes': o.lanes = Number(value(i++, arg)); break;
            case '--out': o.out = value(i++, arg); break;
            case '--ref-hd': o.refHd = value(i++, arg); break;
            case '--ref-h': o.refH = value(i++, arg); break;
            case '--judge': o.judge = value(i++, arg); break;
            case '--judge-ids': o.judgeIds = value(i++, arg); break;
            case '--variant': o.variant = value(i++, arg); break;
            case '--shuffles': o.shuffles = Number(value(i++, arg)); break;
            case '--limit': o.limit = Number(value(i++, arg)); break;
            case '--sheets': o.sheets = true; break;
            case '--no-dense': o.dense = false; break;
            default: throw new Error(`unknown argument ${arg}`);
        }
    }
    if (!o.out) throw new Error('--out is required');
    if (!o.index) throw new Error('--index is required');
    if (!o.model) o.model = path.join(REPO, 'models', 'dinov2-small-q8.onnx');
    if (!VARIANTS.includes(o.variant)) throw new Error(`--variant must be one of ${VARIANTS.join(', ')}`);
    if (!Number.isInteger(o.lanes) || o.lanes < 1 || o.lanes > 32) throw new Error('--lanes must be an integer 1..32');
    if (!Number.isInteger(o.shuffles) || o.shuffles < 0) throw new Error('--shuffles must be a non-negative integer');
    if (!Number.isInteger(o.limit) || o.limit < 0) throw new Error('--limit must be a non-negative integer');
    if (Boolean(o.judge) !== Boolean(o.judgeIds)) throw new Error('--judge and --judge-ids go together');
    return o;
}

function normPath(p) {
    const resolved = path.resolve(String(p));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(child, parent) {
    const rel = path.relative(normPath(parent), normPath(child));
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// Throws unless `out` lies outside every forbidden root; returns the resolved path.
function assertSafeOut(out, forbiddenRoots) {
    for (const root of forbiddenRoots) {
        if (root && isInside(out, root)) throw new Error(`refusing --out ${out}: it lies inside ${root}`);
    }
    return path.resolve(String(out));
}

// The repo, both known data roots, and the profile folder of every input (the grandparent of
// the index file and of each thumbnails folder: <profile>/desktop-cache/<x>).
function forbiddenRoots(o, env = process.env) {
    const roots = [REPO, 'D:/PicGen-Desktop/dist/release/PicGenData'];
    if (env.APPDATA) roots.push(path.join(env.APPDATA, 'PicGen'));
    if (o.index) roots.push(path.dirname(path.resolve(o.index)), path.dirname(path.dirname(path.resolve(o.index))));
    for (const t of o.thumbs || []) roots.push(path.resolve(t), path.dirname(path.dirname(path.resolve(t))));
    return roots;
}

// --- small utilities ---------------------------------------------------------------------------------

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

function shuffled(array, seed) {
    const out = array.slice();
    const rng = mulberry32(seed);
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = out[i];
        out[i] = out[j];
        out[j] = t;
    }
    return out;
}

function inRange(value, lo, hi, decimals = null) {
    const v = decimals === null ? value : Math.round(value * 10 ** decimals) / 10 ** decimals;
    return v >= lo && v <= hi;
}

function median(values) {
    if (!values.length) return null;
    const s = values.slice().sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
}

function round(value, digits) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

async function runPool(jobs, lanes, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(lanes, jobs.length)) }, async () => {
        while (next < jobs.length) {
            const job = jobs[next++];
            await fn(job);
        }
    });
    await Promise.all(workers);
}

// --- partition metrics ---------------------------------------------------------------------------------

// Port of sim-eval-hash/lib.js clusterMetrics: groups are arrays of item indices covering 0..n-1,
// labels[i] the weak label (exact prompt, or unique for promptless images).
function clusterMetrics(groups, labels) {
    const n = labels.length;
    const multi = groups.filter(g => g.length > 1);
    const covered = multi.reduce((s, g) => s + g.length, 0);
    let pureSum = 0;
    for (const g of multi) {
        const c = new Map();
        for (const i of g) c.set(labels[i], (c.get(labels[i]) || 0) + 1);
        pureSum += Math.max(...c.values());
    }
    const labCount = new Map();
    for (const l of labels) labCount.set(l, (labCount.get(l) || 0) + 1);
    let bp = 0;
    let br = 0;
    let famImgs = 0;
    let famHit = 0;
    for (const g of groups) {
        const c = new Map();
        for (const i of g) c.set(labels[i], (c.get(labels[i]) || 0) + 1);
        for (const i of g) {
            const same = c.get(labels[i]);
            bp += same / g.length;
            br += same / labCount.get(labels[i]);
            if (labCount.get(labels[i]) > 1) {
                famImgs++;
                if (same > 1) famHit++;
            }
        }
    }
    bp /= n;
    br /= n;
    return {
        groups: groups.length,
        multi: multi.length,
        coverage: covered / n,
        largest: Math.max(...groups.map(g => g.length)),
        purity: covered ? pureSum / covered : 1,
        bcP: bp,
        bcR: br,
        bcF: 2 * bp * br / (bp + br),
        famRecall: famImgs ? famHit / famImgs : 1
    };
}

function sizeStats(groups) {
    const n = groups.reduce((s, g) => s + g.length, 0);
    const multi = groups.filter(g => g.length > 1);
    const covered = multi.reduce((s, g) => s + g.length, 0);
    return {
        n,
        multi: multi.length,
        covered,
        coverage: n ? covered / n : 0,
        largest: groups.length ? Math.max(...groups.map(g => g.length)) : 0,
        over24: multi.filter(g => g.length > 24).length,
        singles: groups.length - multi.length
    };
}

// Both partitions restricted to `universe` (keys missing from a partition become singles);
// returns the BCubed F1 of one against the other (symmetric) and the number of keys whose
// group differs.
function partitionAgreement(groupsA, groupsB, universe = null) {
    const U = universe ? new Set(universe) : new Set(groupsA.flat());
    const keys = [...U];
    const index = new Map(keys.map((k, i) => [k, i]));
    const restrict = groups => {
        const out = [];
        const seen = new Set();
        for (const g of groups) {
            const h = [];
            for (const k of g) {
                if (!U.has(k) || seen.has(k)) continue;
                seen.add(k);
                h.push(index.get(k));
            }
            if (h.length) out.push(h);
        }
        for (const k of keys) if (!seen.has(k)) out.push([index.get(k)]);
        return out;
    };
    const a = restrict(groupsA);
    const b = restrict(groupsB);
    const labelA = new Int32Array(keys.length);
    a.forEach((g, k) => g.forEach(i => { labelA[i] = k; }));
    const labelB = new Int32Array(keys.length);
    b.forEach((g, k) => g.forEach(i => { labelB[i] = k; }));
    const bcF = keys.length ? clusterMetrics(b, Array.from(labelA)).bcF : 1;
    let differing = 0;
    for (let i = 0; i < keys.length; i++) {
        const ga = a[labelA[i]];
        const gb = b[labelB[i]];
        if (ga.length !== gb.length) {
            differing++;
            continue;
        }
        const set = new Set(ga);
        if (gb.some(x => !set.has(x))) differing++;
    }
    return { bcF, differing, universe: keys.length };
}

function isNested(fine, coarse) {
    const label = new Map();
    coarse.forEach((g, k) => g.forEach(i => label.set(i, k)));
    return fine.every(g => g.every(i => label.get(i) === label.get(g[0])));
}

// --- dense reference linkage ---------------------------------------------------------------------------

// Exact average linkage by NN-chain over the full n×n matrix of dist(i, j) (i < j), for the O7
// "sparse equals dense" check. A cluster whose nearest neighbour is farther than tMax can never
// merge at or below tMax (average linkage is reducible), so it is retired; only merges with
// height <= tMax are returned. Merge [a, b, h]: a and b are cluster representatives (items).
function denseAverageMerges(n, dist, tMax) {
    const D = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const d = dist(i, j);
            const v = d !== d ? Infinity : d;
            D[i * n + j] = v;
            D[j * n + i] = v;
        }
    }
    const size = new Float64Array(n).fill(1);
    const active = new Uint8Array(n).fill(1);
    const merges = [];
    const chain = [];
    let scan = 0;
    for (;;) {
        if (!chain.length) {
            while (scan < n && !active[scan]) scan++;
            if (scan >= n) break;
            chain.push(scan);
        }
        const a = chain[chain.length - 1];
        const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
        let b = -1;
        let bd = Infinity;
        if (prev >= 0) {
            b = prev;
            bd = D[a * n + prev];
        }
        const row = a * n;
        for (let k = 0; k < n; k++) {
            if (active[k] && k !== a && D[row + k] < bd) {
                bd = D[row + k];
                b = k;
            }
        }
        if (b < 0 || !(bd <= tMax)) {
            // Only a chain of one can get here: every pushed link has d <= tMax.
            active[a] = 0;
            chain.pop();
            continue;
        }
        if (b === prev) {
            chain.pop();
            chain.pop();
            merges.push([a, b, bd]);
            const sa = size[a];
            const sb = size[b];
            for (let k = 0; k < n; k++) {
                if (!active[k] || k === a || k === b) continue;
                const v = (sa * D[a * n + k] + sb * D[b * n + k]) / (sa + sb);
                D[b * n + k] = v;
                D[k * n + b] = v;
            }
            active[a] = 0;
            size[b] = sa + sb;
        } else {
            chain.push(b);
        }
    }
    return merges;
}

function cutDense(merges, n, t) {
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = x => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    for (const [a, b, h] of merges) {
        if (!(h <= t)) continue;
        const x = find(a);
        const y = find(b);
        if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(i);
    }
    return [...groups.values()];
}

// --- judge (MobileCLIP silver-2, evaluation only) ---------------------------------------------------

function judgePositive(kind, c) {
    return ((kind === 'same' || kind === 'near') && c >= JUDGE.POS_PROMPT) || (kind === 'nop' && c >= JUDGE.POS_NOP);
}

// v31-hybrid/eval2.js judge(): pairs inside groups are positives (same/near prompt with judge
// cos >= 0.80, or promptless-involved with cos >= 0.90) or false pairs (judge cos < 0.50).
// Cleanup risk: keep the newest member, count moved members whose judge cos to it is < 0.5/0.6.
function judgeMetrics(groups, ctx) {
    let tp = 0;
    let fp = 0;
    let pairs = 0;
    let wrongSum = 0;
    let grouped = 0;
    let trash = 0;
    let risky5 = 0;
    let risky6 = 0;
    for (const g of groups) {
        if (g.length < 2) continue;
        for (let x = 0; x < g.length; x++) {
            for (let y = x + 1; y < g.length; y++) {
                const c = ctx.cos(g[x], g[y]);
                if (c === null || c === undefined) continue;
                pairs++;
                if (judgePositive(ctx.kind(g[x], g[y]), c)) tp++;
                else if (c < JUDGE.NEG) fp++;
            }
        }
        for (const i of g) {
            let wrong = 0;
            let known = 0;
            for (const j of g) {
                if (j === i) continue;
                const c = ctx.cos(i, j);
                if (c === null || c === undefined) continue;
                known++;
                if (c < JUDGE.NEG) wrong++;
            }
            if (known) {
                wrongSum += wrong / known;
                grouped++;
            }
        }
        let cover = g[0];
        for (const i of g) if (ctx.createdAt[i] > ctx.createdAt[cover]) cover = i;
        for (const i of g) {
            if (i === cover) continue;
            trash++;
            const c = ctx.cos(i, cover);
            if (c === null || c === undefined) continue;
            if (c < 0.5) risky5++;
            if (c < 0.6) risky6++;
        }
    }
    const s2P = tp + fp ? tp / (tp + fp) : 1;
    const s2R = ctx.posTotal ? tp / ctx.posTotal : 0;
    return {
        tp,
        s2fp: fp,
        pairs,
        s2P,
        s2R,
        s2F: s2P + s2R ? 2 * s2P * s2R / (s2P + s2R) : 0,
        wrongRate: grouped ? wrongSum / grouped : 0,
        trash,
        risky5,
        risky6
    };
}

// --- gates ------------------------------------------------------------------------------------------------

function fmt(value, digits = 4) {
    return typeof value === 'number' ? String(round(value, digits)) : String(value);
}

// measured: {O1..O8} as produced by main(); every threshold is plan-v31 §6.1.
function evaluateGates(m) {
    const gates = [];
    const add = (id, criterion, target, measured, pass) => gates.push({ id, criterion, target, measured, pass: Boolean(pass) });
    const o1 = m.O1;
    add('O1', 'hd fidelity at 标准 (source B, int8)', '1,349–1,377 groups; coverage 92.6% ± 0.3 pp; largest ≤ 50; BCubed agreement ≥ 0.995 with ref-groups-final-009',
        `${o1.multi} groups; ${fmt(o1.coverage, 2)}%; largest ${o1.largest}; agreement ${fmt(o1.agreement)}`,
        o1.multi >= 1349 && o1.multi <= 1377 && inRange(o1.coverage, 92.3, 92.9, 1) && o1.largest <= 50 && o1.agreement >= 0.995);
    const o2 = m.O2;
    add('O2', 'Source-A parity (P vs B) and int8 vs float, hd', 'agreement ≥ 0.99 at every preset',
        `source A ${o2.sourceA.map(v => fmt(v)).join(' / ')}; int8 ${o2.int8.map(v => fmt(v)).join(' / ')}`,
        o2.sourceA.every(v => v >= 0.99) && o2.int8.every(v => v >= 0.99));
    const o3 = m.O3;
    add('O3', 'Coverage at 标准 (P, hd)', '≥ 91% grouped; ≤ 500 singles', `${fmt(o3.coverage, 2)}%; ${o3.singles} singles`,
        o3.coverage >= 91 && o3.singles <= 500);
    const o4 = m.O4;
    add('O4', 'Quality (P, hd)', '严格 purity ≥ 0.87; 标准 purity ≥ 0.80; famR ≥ 0.97; judge s2P ≥ 0.998',
        `strict purity ${fmt(o4.strictPurity)}; standard purity ${fmt(o4.standardPurity)}; famR ${fmt(o4.famR)}; s2P ${fmt(o4.s2P)}`,
        o4.strictPurity >= 0.87 && o4.standardPurity >= 0.80 && o4.famR >= 0.97 && o4.s2P >= 0.998);
    const o5 = m.O5;
    add('O5', 'Group sizes at 标准 (P, hd)', 'largest ≤ 60; ≤ 5 groups over 24', `largest ${o5.largest}; ${o5.over24} over 24`,
        o5.largest <= 60 && o5.over24 <= 5);
    const o6 = m.O6;
    const share = o6.total ? o6.grouped / o6.total : 0;
    add('O6', 'Promptless grouped at 标准 (P, hd)', '≥ 70% of the promptless images', `${o6.grouped} of ${o6.total} (${fmt(100 * share, 1)}%)`,
        share >= 0.70);
    const o7 = m.O7;
    add('O7', 'Structure (P)', '5 shuffles identical (partitions + ids); strict ⊆ standard ⊆ loose; sparse = dense at 3 cuts, both modes; prefilter edges = brute force',
        `shuffles ${o7.shuffles}; nested ${o7.nested}; dense ${o7.denseEqualsSparse}; prefilter ${o7.prefilterEqualsBrute}`,
        o7.shuffles === true && o7.nested === true && o7.denseEqualsSparse === true && o7.prefilterEqualsBrute === true);
    const o8 = m.O8;
    add('O8', 'h fallback fidelity at 标准 (source B)', '1,392 ± 1% groups (1,378–1,406); coverage 89.9% ± 0.3 pp; agreement ≥ 0.995 with ref-groups-Hw-0125',
        `${o8.multi} groups; ${fmt(o8.coverage, 2)}%; agreement ${fmt(o8.agreement)}`,
        o8.multi >= 1378 && o8.multi <= 1406 && inRange(o8.coverage, 89.6, 90.2, 1) && o8.agreement >= 0.995);
    return gates;
}

function markdownTable(rows, cols) {
    const head = `| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n`;
    return head + rows.map(r => `| ${cols.map(c => (r[c] === undefined || r[c] === null ? '' : String(r[c]))).join(' | ')} |`).join('\n') + '\n';
}

// --- extraction (production modules) -----------------------------------------------------------------

function sha1(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
}

function fileSha1(file) {
    return sha1(fs.readFileSync(file));
}

// Chains identical to similarityDecode.js (used only by the O1 fallback variants; the base
// variant calls the production decoder itself).
function rgb64Chain(image) {
    return image.flatten({ background: '#ffffff' }).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
}

function rgb224Chain(image) {
    return image.flatten({ background: '#ffffff' }).removeAlpha()
        .resize(224, 224, { fit: 'contain', background: { r: 255, g: 255, b: 255 }, kernel: 'cubic' }).raw().toBuffer();
}

function createVariantDecoder(variant, sharp, decoder) {
    if (variant === 'base') return job => decoder.decode({ originalPath: job.filePath, jpegPath: null, hasAlpha: job.hasAlpha });
    return async job => {
        const base = sharp(job.filePath, { failOn: 'none', sequentialRead: true });
        const { data, info } = await (variant === 'rotate' ? base.rotate() : base)
            .resize(256, 256, { fit: 'inside' }).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
        const raw = { width: info.width, height: info.height, channels: info.channels };
        const rgb64 = await rgb64Chain(sharp(data, { raw }));
        let rgb224;
        if (variant === 'jpeg88') {
            const jpeg = await sharp(data, { raw }).flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
            rgb224 = await rgb224Chain(sharp(jpeg));
        } else if (variant === 'noenlarge' && job.width < 256 && job.height < 256) {
            // Only an original smaller than 256 px on both sides is enlarged by fit:'inside'; for
            // every other image this variant is the base chain.
            const small = await sharp(job.filePath, { failOn: 'none', sequentialRead: true })
                .resize(256, 256, { fit: 'inside', withoutEnlargement: true }).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
            rgb224 = await rgb224Chain(sharp(small.data, { raw: { width: small.info.width, height: small.info.height, channels: small.info.channels } }));
        } else {
            rgb224 = await rgb224Chain(sharp(data, { raw }));
        }
        return {
            rgb64,
            rgb224,
            logR: Math.log(info.width / info.height),
            source: 'original',
            originalHasAlpha: job.hasAlpha === true || info.channels === 2 || info.channels === 4
        };
    };
}

// A cache of packed rows and float embeddings for one source ('A' or 'B-<variant>').
function openRowCache(dir, tag) {
    fs.mkdirSync(dir, { recursive: true });
    const indexFile = path.join(dir, 'index.json');
    let entries = {};
    let rows = [];
    let embs = [];
    try {
        const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        if (index.version === CACHE_VERSION && index.tag === tag) {
            const rowBuf = fs.readFileSync(path.join(dir, 'rows.bin'));
            const embBuf = fs.readFileSync(path.join(dir, 'emb.bin'));
            entries = index.entries;
            for (const e of Object.values(entries)) {
                if (!e.ok) continue;
                rows[e.slot] = rowBuf.subarray(e.slot * 2164, (e.slot + 1) * 2164);
                embs[e.slot] = embBuf.subarray(e.slot * EMB_DIM * 4, (e.slot + 1) * EMB_DIM * 4);
            }
            const valid = Object.values(entries).every(e => !e.ok || (rows[e.slot] && rows[e.slot].length === 2164 && embs[e.slot] && embs[e.slot].length === EMB_DIM * 4));
            if (!valid) { entries = {}; rows = []; embs = []; }
        }
    } catch {
        entries = {};
        rows = [];
        embs = [];
    }
    let dirty = false;
    return {
        get(key) {
            const e = entries[key];
            if (!e) return null;
            if (!e.ok) return { ...e };
            const b = embs[e.slot];
            const emb = new Float32Array(EMB_DIM);
            for (let d = 0; d < EMB_DIM; d++) emb[d] = b.readFloatLE(4 * d);
            return { ...e, row: rows[e.slot], emb };
        },
        put(key, value) {
            const e = { ok: value.ok, source: value.source || null, err: value.err || null, decodeMs: value.decodeMs, embedMs: value.embedMs };
            if (value.ok) {
                e.slot = rows.length;
                rows.push(Buffer.from(value.row));
                const b = Buffer.alloc(EMB_DIM * 4);
                for (let d = 0; d < EMB_DIM; d++) b.writeFloatLE(value.emb[d], 4 * d);
                embs.push(b);
            }
            entries[key] = e;
            dirty = true;
        },
        save() {
            if (!dirty) return;
            const write = (name, data) => {
                const tmp = path.join(dir, `${name}.${process.pid}.tmp`);
                fs.writeFileSync(tmp, data);
                fs.renameSync(tmp, path.join(dir, name));
            };
            write('rows.bin', Buffer.concat(rows.map(r => r || Buffer.alloc(2164))));
            write('emb.bin', Buffer.concat(embs.map(r => r || Buffer.alloc(EMB_DIM * 4))));
            write('index.json', JSON.stringify({ version: CACHE_VERSION, tag, entries }));
            dirty = false;
        }
    };
}

// --- clustering runs -----------------------------------------------------------------------------------

function modeConstants(mode) {
    const { HD, H } = require('../similarityDistance');
    return mode === 'hd' ? HD : H;
}

async function clusterRun(rows, mode, { prefilter = 'auto' } = {}) {
    const C = require('../similarityCluster');
    const K = modeConstants(mode);
    const t0 = performance.now();
    const items = C.buildItems(rows, { mode });
    const t1 = performance.now();
    const edges = await C.buildEdges(items, { prefilter });
    const t2 = performance.now();
    const lk = await C.sparseAverage(items.n, edges, { T: K.T_EDGE, dist: items.dist });
    const t3 = performance.now();
    const cuts = {};
    for (const preset of PRESET_NAMES) cuts[preset] = C.cutGroups(lk.merges, items.n, K.PRESETS[preset]);
    const t4 = performance.now();
    return {
        mode, items, edges, lk, cuts,
        ms: { items: t1 - t0, edges: t2 - t1, linkage: t3 - t2, cuts: t4 - t3 }
    };
}

function keyGroups(run, preset) {
    return run.cuts[preset].map(g => g.map(i => run.items.keys[i]));
}

function signature(run, preset) {
    const C = require('../similarityCluster');
    const keys = run.items.keys;
    return run.cuts[preset].filter(g => g.length > 1)
        .map(g => `${C.anchorId(keys[g[0]])}:${g.map(i => keys[i]).sort().join(',')}`).sort().join('\n');
}

function edgesIdentical(a, b) {
    if (a.ei.length !== b.ei.length) return false;
    for (let k = 0; k < a.ei.length; k++) {
        if (a.ei[k] !== b.ei[k] || a.ej[k] !== b.ej[k] || !Object.is(a.ed[k], b.ed[k])) return false;
    }
    return true;
}

// --- contact sheets ------------------------------------------------------------------------------------

const SHEET = Object.freeze({ CELL: 150, PAD: 6, LABEL_W: 250, COLS: 8 });
const escXml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const snip = (s, k = 18) => {
    const t = Array.from(String(s || ''));
    return t.length > k ? t.slice(0, k).join('') + '…' : t.join('');
};

async function writeSheet(sharp, file, title, rows) {
    const { CELL, PAD, LABEL_W, COLS } = SHEET;
    const W = LABEL_W + COLS * (CELL + PAD) + PAD;
    const H = 44 + rows.length * (CELL + PAD) + PAD;
    const comps = [{
        input: Buffer.from(`<svg width="${W}" height="44" xmlns="http://www.w3.org/2000/svg"><text x="8" y="28" font-family="Microsoft YaHei, SimHei, Arial" font-size="17" font-weight="bold">${escXml(title)}</text></svg>`),
        top: 0,
        left: 0
    }];
    for (let r = 0; r < rows.length; r++) {
        const top = 44 + r * (CELL + PAD);
        const lines = rows[r].label.map((l, k) => `<text x="6" y="${20 + k * 18}" font-family="Microsoft YaHei, SimHei, Arial" font-size="${k ? 12 : 14}"${k ? '' : ' font-weight="bold"'}>${escXml(l)}</text>`).join('');
        comps.push({ input: Buffer.from(`<svg width="${LABEL_W}" height="${CELL}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${r % 2 ? '#f4f4f4' : '#e9e9e9'}"/>${lines}</svg>`), top, left: 0 });
        for (let c = 0; c < rows[r].cells.length; c++) {
            const cell = rows[r].cells[c];
            let img;
            try {
                img = await sharp(cell.src, { failOn: 'none' }).flatten({ background: '#ffffff' })
                    .resize(CELL, CELL - 20, { fit: 'contain', background: '#e8e8e8' }).png().toBuffer();
            } catch {
                img = await sharp({ create: { width: CELL, height: CELL - 20, channels: 3, background: '#ff0000' } }).png().toBuffer();
            }
            const svg = Buffer.from(`<svg width="${CELL}" height="${CELL}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${cell.bg}"/><text x="3" y="${CELL - 5}" font-family="Microsoft YaHei, Arial" font-size="12">${escXml(cell.cap)}</text></svg>`);
            const composed = await sharp(svg).composite([{ input: img, top: 0, left: 0 }]).png().toBuffer();
            comps.push({ input: composed, top, left: LABEL_W + PAD + c * (CELL + PAD) });
        }
    }
    await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).composite(comps).png().toFile(file);
    return file;
}

async function contactSheets({ sharp, run, records, judgeCos, outDir, log }) {
    const C = require('../similarityCluster');
    const { HD } = require('../similarityDistance');
    const { items } = run;
    const cos = (a, b) => (a === b ? 1 : items.cos(Math.min(a, b), Math.max(a, b)));
    const std = run.cuts.standard.filter(g => g.length > 1);
    const strictLabels = C.cutLabels(run.lk.merges, items.n, HD.NEXT_CUT.standard);
    const rowFor = (g, extra = []) => {
        let md = g[0];
        let best = -Infinity;
        for (const a of g) {
            let s = 0;
            for (const b of g) s += cos(a, b);
            if (s > best) { best = s; md = a; }
        }
        const ord = g.slice().sort((a, b) => cos(md, b) - cos(md, a) || a - b);
        const shown = ord.length <= SHEET.COLS ? ord : Array.from({ length: SHEET.COLS }, (_, q) => ord[Math.round(q * (ord.length - 1) / (SHEET.COLS - 1))]);
        const tags = new Map();
        for (const i of g) if (items.pi[i] >= 0 && !tags.has(items.pi[i])) tags.set(items.pi[i], `P${tags.size + 1}`);
        const tag = i => (items.pi[i] < 0 ? '--' : tags.get(items.pi[i]));
        let minC = 1;
        let minJ = 1;
        for (const i of g) {
            minC = Math.min(minC, cos(md, i));
            const j = i === md ? null : judgeCos(i, md);
            if (j !== null) minJ = Math.min(minJ, j);
        }
        const nop = g.filter(i => items.pi[i] < 0).length;
        const firstPrompted = g.find(i => items.pi[i] >= 0);
        const rec = records.get(items.keys[firstPrompted === undefined ? g[0] : firstPrompted]);
        return {
            label: [
                `size ${g.length} · ${tags.size} prompt(s) · ${nop} none`,
                `min cos→medoid ${minC.toFixed(2)} (judge ${minJ.toFixed(2)})`,
                C.anchorId(items.keys[g[0]]),
                ...extra,
                `P1: ${snip(rec && rec.prompt ? rec.prompt : '(无提示词)')}`
            ],
            cells: shown.map(i => {
                const r = records.get(items.keys[i]);
                const j = i === md ? null : judgeCos(i, md);
                return {
                    src: r.jpegPath || r.filePath,
                    cap: `${tag(i)} ${cos(md, i).toFixed(2)}${i === md ? ' *' : j === null ? '' : ` m${j.toFixed(2)}`}`,
                    bg: items.pi[i] < 0 ? '#fff3d6' : '#ffffff'
                };
            })
        };
    };
    const rng = mulberry32(20260924);
    const pool = std.slice();
    const random20 = [];
    while (random20.length < 20 && pool.length) random20.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    const largest10 = std.slice().sort((a, b) => b.length - a.length || a[0] - b[0]).slice(0, 10);
    const partsOf = g => {
        const r = C.subgroups(g, run.lk.merges, items.n, HD.NEXT_CUT.standard);
        if (r) return `parts@${HD.NEXT_CUT.standard}: ${r.parts.map(p => p.length).join('/')}${r.rest.length ? ` +${r.rest.length}` : ''}`;
        const sizes = new Map();
        for (const i of g) sizes.set(strictLabels[i], (sizes.get(strictLabels[i]) || 0) + 1);
        return `flat (next cut: ${[...sizes.values()].sort((x, y) => y - x).slice(0, 6).join('/')})`;
    };
    fs.mkdirSync(outDir, { recursive: true });
    const files = [];
    const title = (what) => `hd 标准 t=0.09 (production modules, P): ${what}; * medoid, cos to medoid, m = judge; yellow = no prompt`;
    files.push(await writeSheet(sharp, path.join(outDir, 'hd-standard-random20-1.png'), title(`random groups 1–10 of ${std.length}`), random20.slice(0, 10).map(g => rowFor(g))));
    files.push(await writeSheet(sharp, path.join(outDir, 'hd-standard-random20-2.png'), title('random groups 11–20'), random20.slice(10, 20).map(g => rowFor(g))));
    files.push(await writeSheet(sharp, path.join(outDir, 'hd-standard-largest10.png'), title('10 largest groups (8 shown, spread by cos)'), largest10.map(g => rowFor(g, [partsOf(g)]))));
    for (const f of files) log(`[sheets] wrote ${f}`);
    return {
        files,
        random20: random20.map(g => g.map(i => items.keys[i])),
        largest10: largest10.map(g => g.map(i => items.keys[i]))
    };
}

// --- main ---------------------------------------------------------------------------------------------

async function main(o) {
    const out = assertSafeOut(o.out, forbiddenRoots(o));
    fs.mkdirSync(out, { recursive: true });
    // Base-variant outputs keep the plain names (the deliverable); fallback variants get a suffix.
    const suffix = o.variant === 'base' ? '' : `-${o.variant}`;
    const logFile = path.join(out, `eval-${o.variant}.log`);
    const log = line => {
        console.log(line);
        fs.appendFileSync(logFile, line + '\n');
    };
    const started = Date.now();
    log(`[eval] ${new Date().toISOString()} variant=${o.variant} lanes=${o.lanes} out=${out}`);

    const sharp = require('sharp');
    sharp.cache(false); // as the host process does; never changes pixels
    const F = require('../similarityFeatures');
    const { HD, H } = require('../similarityDistance');
    const { normalizePrompt, promptPairs } = require('../similarityPrompt');
    const { featureKey } = require('../similarityStore');
    const { historyThumbnailKey } = require('../historyThumbnailKey');
    const { createDecoder } = require('../similarityDecode');
    const { createEmbedder } = require('../similarityEmbedder');

    // 1. index (read-only)
    const index = JSON.parse(fs.readFileSync(o.index, 'utf8'));
    let images = Array.isArray(index) ? index : index.images || [];
    if (o.limit) images = images.slice(0, o.limit);
    const records = new Map();
    for (const r of images) {
        const key = String(r.id || r.filePath || r.fileName || '');
        if (!key || records.has(key) || !r.filePath) continue;
        records.set(key, { key, filePath: String(r.filePath), prompt: r.prompt || '', np: normalizePrompt(r.prompt), createdAt: Number(r.createdAt) });
    }
    log(`[eval] index ${images.length} records, ${records.size} with a key and path`);

    // 2. stat originals and locate history JPEGs (read-only)
    const recList = [...records.values()];
    let missing = 0;
    await runPool(recList, STAT_CONCURRENCY, async rec => {
        try {
            const st = await fsp.stat(rec.filePath);
            if (!st.isFile()) throw new Error('not a file');
            rec.size = st.size;
            rec.mtimeMs = st.mtimeMs;
            if (!Number.isFinite(rec.createdAt) || rec.createdAt <= 0) rec.createdAt = st.mtimeMs;
            rec.fk = featureKey(rec.filePath, st.size);
            const thumbName = historyThumbnailKey(path.resolve(rec.filePath), st);
            rec.jpegPath = null;
            for (const dir of o.thumbs) {
                const candidate = path.join(dir, thumbName);
                try {
                    if ((await fsp.stat(candidate)).isFile()) { rec.jpegPath = candidate; break; }
                } catch { /* not in this folder */ }
            }
        } catch {
            rec.missing = true;
            missing++;
        }
    });
    const present = recList.filter(r => !r.missing);
    const fkCount = new Map();
    for (const r of present) fkCount.set(r.fk, (fkCount.get(r.fk) || 0) + 1);
    const sharedFk = [...fkCount.values()].filter(v => v > 1).length;
    log(`[eval] present ${present.length}, missing ${missing}, with history JPEG ${present.filter(r => r.jpegPath).length}, shared featureKeys ${sharedFk}`);

    // 3. embedder and decoder (production modules)
    const embedder = createEmbedder({ modelPath: path.resolve(o.model) });
    const load = await embedder.load();
    if (!load.ok) throw new Error(`embedder unavailable: ${load.reason}: ${load.message}`);
    log(`[eval] ORT ${load.ortVersion}, embVersion ${load.embVersion}`);
    const decoder = createDecoder({ sharp });
    const decodeB = createVariantDecoder(o.variant, sharp, decoder);
    const codeTag = ['similarityDecode.js', 'similarityFeatures.js', 'similarityEmbedder.js'].map(f => fileSha1(path.join(REPO, f))).join(',');
    const modelSize = fs.statSync(path.resolve(o.model)).size;
    const baseTag = `${F.H_VERSION}|${load.embVersion}|${modelSize}|${codeTag}`;
    const cacheA = openRowCache(path.join(out, 'cache', 'A'), sha1(`A|${baseTag}`));
    const cacheB = openRowCache(path.join(out, 'cache', `B-${o.variant}`), sha1(`B|${o.variant}|${baseTag}`));
    const entryKey = (rec, source) => `${rec.key}|${rec.size}|${rec.mtimeMs}${source === 'A' ? `|${path.basename(rec.jpegPath)}` : ''}`;

    // 4. header probe for every present image (the source rule needs hasAlpha)
    let probeFailed = 0;
    const tProbe = performance.now();
    await runPool(present, STAT_CONCURRENCY, async rec => {
        try {
            const p = await decoder.probe(rec.filePath);
            rec.hasAlpha = p.hasAlpha;
            rec.width = p.width;
            rec.height = p.height;
        } catch (error) {
            rec.probeError = String(error && error.message ? error.message : error);
            probeFailed++;
        }
    });
    log(`[eval] probe ${present.length} headers in ${Math.round(performance.now() - tProbe)} ms (${probeFailed} failed; alpha ${present.filter(r => r.hasAlpha).length})`);

    // 5. extraction jobs
    const jobs = [];
    for (const rec of present) {
        if (rec.probeError) continue;
        if (!cacheB.get(entryKey(rec, 'B'))) jobs.push({ rec, source: 'B' });
        if (rec.jpegPath && rec.hasAlpha === false && !cacheA.get(entryKey(rec, 'A'))) jobs.push({ rec, source: 'A' });
    }
    jobs.sort((a, b) => (a.source === b.source ? 0 : a.source === 'A' ? -1 : 1));
    log(`[eval] extraction jobs: ${jobs.length} (A ${jobs.filter(j => j.source === 'A').length}, B ${jobs.filter(j => j.source === 'B').length}); cached rows are reused`);
    const tExtract = performance.now();
    let done = 0;
    let lastSave = performance.now();
    await runPool(jobs, o.lanes, async ({ rec, source }) => {
        const key = entryKey(rec, source);
        const cache = source === 'A' ? cacheA : cacheB;
        const t0 = performance.now();
        try {
            const decoded = source === 'A'
                ? await decoder.decode({ originalPath: rec.filePath, jpegPath: rec.jpegPath, hasAlpha: false })
                : await decodeB({ filePath: rec.filePath, hasAlpha: rec.hasAlpha, width: rec.width, height: rec.height });
            const t1 = performance.now();
            const colour = F.colourFeatures(decoded.rgb64);
            const phash = F.phash256(decoded.rgb64);
            const emb = await embedder.embed(decoded.rgb224);
            const t2 = performance.now();
            const { q, inv } = F.quantizeEmbedding(emb);
            let flags = F.FLAGS.OK | F.FLAGS.DINO_OK;
            if (decoded.source === 'jpeg360') flags |= F.FLAGS.SRC_JPEG360;
            if (decoded.originalHasAlpha) flags |= F.FLAGS.ORIG_ALPHA;
            const row = F.packRow({ hsv: colour.hsv, lab: colour.lab, layout: colour.layout, logR: decoded.logR, whiteFrac: colour.whiteFrac, phash, q, inv }, flags);
            cache.put(key, { ok: true, row, emb, source: decoded.source, decodeMs: round(t1 - t0, 1), embedMs: round(t2 - t1, 1) });
        } catch (error) {
            cache.put(key, { ok: false, err: String(error && error.message ? error.message : error) });
        }
        done++;
        if (done % 250 === 0 || done === jobs.length) {
            const s = (performance.now() - tExtract) / 1000;
            log(`[extract] ${done}/${jobs.length} in ${s.toFixed(0)} s, eta ${((jobs.length - done) * s / done).toFixed(0)} s`);
        }
        if (performance.now() - lastSave > 60000) {
            lastSave = performance.now();
            cacheA.save();
            cacheB.save();
        }
    });
    cacheA.save();
    cacheB.save();
    await embedder.release();
    const extractS = (performance.now() - tExtract) / 1000;

    // 6. rows per variant (production row format round trip)
    const failed = [];
    const rowsB = { hd: [], h: [], f32: [] };
    const rowsP = { hd: [], h: [], f32: [] };
    const timing = { A: { decode: [], embed: [] }, B: { decode: [], embed: [] } };
    let sourceAUsed = 0;
    let sourceAFellBack = 0;
    let crcBad = 0;
    const benchItems = [];
    const benchRows = [];
    const toRows = (target, rec, entry) => {
        const u = F.unpackRow(entry.row);
        if (!u.crcOk || !(u.flags & F.FLAGS.DINO_OK)) {
            crcBad++;
            return false;
        }
        const base = { key: rec.key, createdAt: rec.createdAt, np: rec.np };
        target.hd.push({ ...base, q: u.q, inv: u.inv });
        target.h.push({ ...base, h: { hsv: u.hsv, lab: u.lab, layout: u.layout, logR: u.logR, whiteFrac: u.whiteFrac, phash: u.phash } });
        target.f32.push({ ...base, q: entry.emb, inv: 1 });
        if (target === rowsP) {
            benchItems.push({ ...base, filePath: rec.filePath, jpegPath: rec.jpegPath, hasAlpha: rec.hasAlpha, source: entry.source });
            benchRows.push(entry.row);
        }
        return true;
    };
    for (const rec of present) {
        const b = rec.probeError ? null : cacheB.get(entryKey(rec, 'B'));
        if (!b || !b.ok) {
            failed.push({ key: rec.key, reason: rec.probeError || (b && b.err) || 'no row' });
            continue;
        }
        if (Number.isFinite(b.decodeMs)) { timing.B.decode.push(b.decodeMs); timing.B.embed.push(b.embedMs); }
        const a = rec.jpegPath && rec.hasAlpha === false ? cacheA.get(entryKey(rec, 'A')) : null;
        if (!toRows(rowsB, rec, b)) {
            failed.push({ key: rec.key, reason: 'row crc' });
            continue;
        }
        if (a && a.ok && a.source === 'jpeg360') {
            if (Number.isFinite(a.decodeMs)) { timing.A.decode.push(a.decodeMs); timing.A.embed.push(a.embedMs); }
            if (toRows(rowsP, rec, a)) { sourceAUsed++; continue; }
        } else if (a) {
            sourceAFellBack++;
        }
        toRows(rowsP, rec, b);
    }
    // The production rows of P, for similarity-bench.js --from-eval (scratch only: holds np).
    fs.writeFileSync(path.join(out, `bench-rows${suffix}.bin`), Buffer.concat(benchRows));
    fs.writeFileSync(path.join(out, `bench-rows${suffix}.json`), JSON.stringify({ variant: o.variant, items: benchItems }));
    log(`[eval] analysed ${rowsB.hd.length}, failed ${failed.length} (${failed.map(f => f.reason).slice(0, 3).join('; ')}), source A used ${sourceAUsed} (fell back ${sourceAFellBack}), crc/dino problems ${crcBad}`);

    // 7. clustering runs
    const runs = {};
    const tCluster = performance.now();
    for (const [name, rows, mode] of [['P-hd', rowsP.hd, 'hd'], ['B-hd', rowsB.hd, 'hd'], ['P-h', rowsP.h, 'h'], ['B-h', rowsB.h, 'h'], ['P-hd-f32', rowsP.f32, 'hd'], ['B-hd-f32', rowsB.f32, 'hd']]) {
        runs[name] = await clusterRun(rows, mode);
        const r = runs[name];
        log(`[cluster] ${name}: n ${r.items.n}, edges ${r.edges.ei.length} (${Math.round(r.ms.edges)} ms, prefilter ${r.edges.stats.prefilter}), linkage ${Math.round(r.ms.linkage)} ms, multi ${PRESET_NAMES.map(p => sizeStats(r.cuts[p]).multi).join('/')}`);
    }
    const keys = runs['P-hd'].items.keys;
    for (const r of Object.values(runs)) {
        if (r.items.keys.length !== keys.length || r.items.keys.some((k, i) => k !== keys[i])) throw new Error('runs disagree on the canonical item order');
    }
    const n = keys.length;
    const itemsP = runs['P-hd'].items;
    const labels = keys.map((k, i) => (itemsP.np[i] ? 'p:' + itemsP.np[i] : 'u:' + k));

    // 8. judge
    let judge = null;
    if (o.judge) {
        const ids = JSON.parse(fs.readFileSync(o.judgeIds, 'utf8')).map(x => (typeof x === 'string' ? x : x.id));
        const buf = fs.readFileSync(o.judge);
        const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        let dim = flat.length / ids.length;
        try { dim = JSON.parse(fs.readFileSync(o.judge.replace(/\.f32$/, '.json'), 'utf8')).dim || dim; } catch { /* derive from size */ }
        const pos = new Map(ids.map((id, k) => [id, k]));
        const vec = keys.map(k => (pos.has(k) ? flat.subarray(pos.get(k) * dim, (pos.get(k) + 1) * dim) : null));
        const cos = (i, j) => {
            const a = vec[i];
            const b = vec[j];
            if (!a || !b) return null;
            let s = 0;
            for (let d = 0; d < dim; d++) s += a[d] * b[d];
            return s;
        };
        const kind = (i, j) => {
            const a = itemsP.pi[i];
            const b = itemsP.pi[j];
            if (a < 0 || b < 0) return 'nop';
            if (a === b) return 'same';
            return itemsP.promptJ(a, b) >= JUDGE.NEAR_J ? 'near' : 'cross';
        };
        // Total silver-2 positives over all pairs: only same/near-prompt and promptless-involved
        // pairs can be positive.
        let posTotal = 0;
        const tJ = performance.now();
        for (const fam of itemsP.byPrompt) for (let x = 0; x < fam.length; x++) for (let y = x + 1; y < fam.length; y++) {
            const c = cos(fam[x], fam[y]);
            if (c !== null && c >= JUDGE.POS_PROMPT) posTotal++;
        }
        for (const [a, b] of promptPairs(itemsP.promptSets, JUDGE.NEAR_J)) {
            for (const i of itemsP.byPrompt[a]) for (const j of itemsP.byPrompt[b]) {
                const c = cos(i, j);
                if (c !== null && c >= JUDGE.POS_PROMPT) posTotal++;
            }
        }
        const isNop = new Uint8Array(n);
        for (const i of itemsP.promptless) isNop[i] = 1;
        for (const i of itemsP.promptless) for (let j = 0; j < n; j++) {
            if (j === i || (isNop[j] && j < i)) continue;
            const c = cos(i, j);
            if (c !== null && c >= JUDGE.POS_NOP) posTotal++;
        }
        const covered = vec.filter(Boolean).length;
        judge = { cos, kind, posTotal, covered, universe: keys.filter((k, i) => vec[i]), createdAt: Array.from(itemsP.createdAt) };
        log(`[judge] ${covered}/${n} items have a judge vector (dim ${dim}); silver-2 positives ${posTotal} (${Math.round(performance.now() - tJ)} ms)`);
    }

    // 9. preset tables
    const presetRows = {};
    for (const [name, run] of Object.entries(runs)) {
        const K = modeConstants(run.mode);
        presetRows[name] = PRESET_NAMES.map(preset => {
            const groups = run.cuts[preset];
            const z = sizeStats(groups);
            const w = clusterMetrics(groups, labels);
            let nopGrouped = 0;
            for (const g of groups) if (g.length > 1) for (const i of g) if (run.items.pi[i] < 0) nopGrouped++;
            const row = {
                run: name, preset, t: K.PRESETS[preset], multi: z.multi, cov: round(100 * z.coverage, 2), largest: z.largest,
                over24: z.over24, singles: z.singles, bcF: round(w.bcF, 4), purity: round(w.purity, 4), famR: round(w.famRecall, 4), nopGrouped
            };
            if (judge) {
                const j = judgeMetrics(groups, { cos: judge.cos, kind: judge.kind, createdAt: judge.createdAt, posTotal: judge.posTotal });
                Object.assign(row, { s2P: round(j.s2P, 4), s2R: round(j.s2R, 3), s2F: round(j.s2F, 3), s2fp: j.s2fp, wrongRate: round(j.wrongRate, 4), trash: j.trash, risky6: j.risky6, risky5: j.risky5 });
            }
            return row;
        });
    }

    // 10. agreements
    const agreement = {};
    const readRef = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    const refUniverse = judge ? judge.universe : keys;
    if (o.refHd) {
        const ref = readRef(o.refHd);
        agreement.refHd = {
            groups: ref.length,
            universe: refUniverse.length,
            B: partitionAgreement(ref, keyGroups(runs['B-hd'], 'standard'), refUniverse),
            P: partitionAgreement(ref, keyGroups(runs['P-hd'], 'standard'), refUniverse),
            Bf32: partitionAgreement(ref, keyGroups(runs['B-hd-f32'], 'standard'), refUniverse)
        };
    }
    if (o.refH) {
        const ref = readRef(o.refH);
        agreement.refH = {
            groups: ref.length,
            universe: refUniverse.length,
            B: partitionAgreement(ref, keyGroups(runs['B-h'], 'standard'), refUniverse),
            P: partitionAgreement(ref, keyGroups(runs['P-h'], 'standard'), refUniverse)
        };
    }
    const pair = (x, y) => PRESET_NAMES.map(p => partitionAgreement(keyGroups(runs[x], p), keyGroups(runs[y], p), keys));
    agreement.sourceA_hd = pair('P-hd', 'B-hd');
    agreement.sourceA_h = pair('P-h', 'B-h');
    agreement.int8_P = pair('P-hd', 'P-hd-f32');
    agreement.int8_B = pair('B-hd', 'B-hd-f32');
    log(`[agree] ref-hd B ${agreement.refHd ? round(agreement.refHd.B.bcF, 4) : '-'} | ref-h B ${agreement.refH ? round(agreement.refH.B.bcF, 4) : '-'} | sourceA hd ${agreement.sourceA_hd.map(a => round(a.bcF, 4)).join('/')} | int8 ${agreement.int8_P.map(a => round(a.bcF, 4)).join('/')}`);

    // 11. structure (O7), on P
    const structure = { shuffles: {}, nested: {}, dense: {}, prefilter: null, ids: {}, subgroups: null };
    const tStruct = performance.now();
    for (const mode of ['hd', 'h']) {
        const base = runs[`P-${mode}`];
        const rows = mode === 'hd' ? rowsP.hd : rowsP.h;
        const baseSig = PRESET_NAMES.map(p => signature(base, p));
        const results = [];
        for (let s = 1; s <= o.shuffles; s++) {
            const r = await clusterRun(shuffled(rows, 1000 + s), mode);
            results.push(PRESET_NAMES.every((p, k) => signature(r, p) === baseSig[k]));
        }
        structure.shuffles[mode] = results;
        structure.nested[mode] = isNested(base.cuts.strict, base.cuts.standard) && isNested(base.cuts.standard, base.cuts.loose);
        const C = require('../similarityCluster');
        const ids = PRESET_NAMES.map(p => {
            const multi = base.cuts[p].filter(g => g.length > 1);
            return new Set(multi.map(g => C.anchorId(base.items.keys[g[0]]))).size === multi.length;
        });
        structure.ids[mode] = ids.every(Boolean);
        if (o.dense) {
            const K = modeConstants(mode);
            const td = performance.now();
            const merges = denseAverageMerges(base.items.n, base.items.dist, K.T_EDGE);
            structure.dense[mode] = PRESET_NAMES.map(p => {
                const dense = cutDense(merges, base.items.n, K.PRESETS[p]).map(g => g.map(i => base.items.keys[i]));
                return partitionAgreement(dense, keyGroups(base, p), keys).differing;
            });
            log(`[structure] dense ${mode}: images differing ${structure.dense[mode].join('/')} (${Math.round(performance.now() - td)} ms)`);
        }
    }
    {
        const C = require('../similarityCluster');
        const items = runs['P-hd'].items;
        const on = await C.buildEdges(items, { prefilter: 'on' });
        const off = await C.buildEdges(items, { prefilter: 'off' });
        structure.prefilter = {
            identical: edgesIdentical(on, off) && edgesIdentical(off, runs['P-hd'].edges),
            edges: off.ei.length,
            autoChoice: runs['P-hd'].edges.stats.prefilter,
            onMs: round(on.stats.ms.basis + on.stats.ms.promptlessScan, 0),
            offScanMs: round(off.stats.ms.promptlessScan, 0),
            skipped: on.stats.prefilterSkipped,
            exactDots: on.stats.exactDots
        };
        const std = runs['P-hd'].cuts.standard.filter(g => g.length > 24);
        structure.subgroups = std.map(g => {
            const r = C.subgroups(g, runs['P-hd'].lk.merges, items.n, HD.NEXT_CUT.standard);
            return r ? `${g.length}→[${r.parts.map(p => p.length).join('/')}]+${r.rest.length}` : `${g.length} flat`;
        });
    }
    log(`[structure] shuffles hd ${structure.shuffles.hd} h ${structure.shuffles.h}; nested ${JSON.stringify(structure.nested)}; ids unique ${JSON.stringify(structure.ids)}; prefilter identical ${structure.prefilter.identical} (${Math.round(performance.now() - tStruct)} ms)`);

    // 12. sheets
    let sheets = null;
    if (o.sheets) {
        const judgeCos = judge ? (i, j) => judge.cos(i, j) : () => null;
        sheets = await contactSheets({ sharp, run: runs['P-hd'], records, judgeCos, outDir: path.join(out, `sheets${suffix}`), log });
        fs.writeFileSync(path.join(out, `sheets${suffix}`, 'picks.json'), JSON.stringify({ random20: sheets.random20, largest10: sheets.largest10 }));
    }

    // 13. gates
    const row = (name, preset) => presetRows[name].find(r => r.preset === preset);
    const pStd = row('P-hd', 'standard');
    const pStrict = row('P-hd', 'strict');
    const bStd = row('B-hd', 'standard');
    const bhStd = row('B-h', 'standard');
    const promptlessTotal = runs['P-hd'].items.promptless.length;
    const measured = {
        O1: { multi: bStd.multi, coverage: bStd.cov, largest: bStd.largest, agreement: agreement.refHd ? agreement.refHd.B.bcF : NaN },
        O2: { sourceA: agreement.sourceA_hd.map(a => a.bcF), int8: agreement.int8_P.map(a => a.bcF) },
        O3: { coverage: pStd.cov, singles: pStd.singles },
        O4: { strictPurity: pStrict.purity, standardPurity: pStd.purity, famR: pStd.famR, s2P: judge ? pStd.s2P : NaN },
        O5: { largest: pStd.largest, over24: pStd.over24 },
        O6: { grouped: pStd.nopGrouped, total: promptlessTotal },
        O7: {
            shuffles: o.shuffles >= 5 && structure.shuffles.hd.every(Boolean) && structure.shuffles.h.every(Boolean) && structure.ids.hd && structure.ids.h,
            nested: structure.nested.hd && structure.nested.h,
            denseEqualsSparse: o.dense ? structure.dense.hd.every(v => v === 0) && structure.dense.h.every(v => v === 0) : 'not run',
            prefilterEqualsBrute: structure.prefilter.identical
        },
        O8: { multi: bhStd.multi, coverage: bhStd.cov, agreement: agreement.refH ? agreement.refH.B.bcF : NaN }
    };
    const gates = evaluateGates(measured);
    const o1Agreement = measured.O1.agreement;
    const o9Required = !(o1Agreement >= 0.998) || o.variant !== 'base';
    gates.push({
        id: 'O9',
        criterion: 'Human gate: contact sheets (20 random + 10 largest at 标准)',
        target: '≤ 1 clearly wrong group among the 20; required only if O1 agreement < 0.998 or a fallback variant was adopted',
        measured: `${o9Required ? 'REQUIRED' : 'not required'} (O1 agreement ${fmt(o1Agreement)}, variant ${o.variant}); sheets ${sheets ? 'written' : 'not written (--sheets)'}`,
        pass: o9Required ? null : true
    });

    const allPass = gates.filter(g => g.id !== 'O9').every(g => g.pass);
    const report = {
        generatedAt: new Date().toISOString(),
        argv: process.argv.slice(2),
        variant: o.variant,
        ortVersion: load.ortVersion,
        embVersion: load.embVersion,
        featureVersion: `${F.H_VERSION}+${load.embVersion}`,
        counts: {
            records: images.length, present: present.length, missing, analysed: n, failed: failed.length,
            withJpeg: present.filter(r => r.jpegPath).length,
            opaqueWithJpeg: present.filter(r => r.jpegPath && r.hasAlpha === false).length,
            alphaWithJpeg: present.filter(r => r.jpegPath && r.hasAlpha === true).length,
            sourceAUsed, sourceAFellBack, promptless: promptlessTotal, sharedFeatureKeys: sharedFk
        },
        failed,
        timing: {
            extractJobs: jobs.length, extractS: round(extractS, 1), lanes: o.lanes, clusterAndStructureS: round((performance.now() - tCluster) / 1000, 1),
            totalS: round((Date.now() - started) / 1000, 1),
            rowMedians: {
                A: { decodeMs: median(timing.A.decode), embedMs: median(timing.A.embed), n: timing.A.decode.length },
                B: { decodeMs: median(timing.B.decode), embedMs: median(timing.B.embed), n: timing.B.decode.length }
            },
            runs: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, Object.fromEntries(Object.entries(r.ms).map(([a, b]) => [a, round(b, 1)]))])),
            edgeStats: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { edges: r.edges.ei.length, prefilter: r.edges.stats.prefilter, candPromptPairs: r.edges.stats.candPromptPairs, ms: Object.fromEntries(Object.entries(r.edges.stats.ms).map(([a, b]) => [a, round(b, 1)])), pairEvals: r.lk.pairEvals, capHits: r.lk.capHits }]))
        },
        judge: judge ? { covered: judge.covered, posTotal: judge.posTotal } : null,
        presets: presetRows,
        agreement,
        structure,
        measured,
        gates,
        o9Required,
        sheets: sheets ? sheets.files : null,
        allAutomaticGatesPass: allPass
    };
    fs.writeFileSync(path.join(out, `report${suffix}.json`), JSON.stringify(report, null, 1));
    // Membership only (task ids, no prompts), for later packages.
    fs.writeFileSync(path.join(out, `groups-hd-standard-${o.variant}.json`), JSON.stringify(keyGroups(runs['P-hd'], 'standard').filter(g => g.length > 1)));

    const cols = ['run', 'preset', 't', 'multi', 'cov', 'largest', 'over24', 'singles', 'bcF', 'purity', 'famR', 'nopGrouped'].concat(judge ? ['s2P', 's2R', 's2fp', 'wrongRate', 'trash', 'risky6', 'risky5'] : []);
    const agreeRows = [];
    const agreeRow = (what, list) => agreeRows.push({ comparison: what, strict: fmt(list[0].bcF), standard: fmt(list[1].bcF), loose: fmt(list[2].bcF), differing: list.map(a => a.differing).join(' / ') });
    agreeRow('source A: P vs B (hd)', agreement.sourceA_hd);
    agreeRow('source A: P vs B (h)', agreement.sourceA_h);
    agreeRow('int8 vs float (P, hd)', agreement.int8_P);
    agreeRow('int8 vs float (B, hd)', agreement.int8_B);
    const refRows = [];
    if (agreement.refHd) for (const v of ['B', 'P', 'Bf32']) refRows.push({ reference: 'ref-groups-final-009 (hd 标准)', variant: v, bcF: fmt(agreement.refHd[v].bcF), differing: agreement.refHd[v].differing, universe: agreement.refHd[v].universe });
    if (agreement.refH) for (const v of ['B', 'P']) refRows.push({ reference: 'ref-groups-Hw-0125 (h 标准)', variant: v, bcF: fmt(agreement.refH[v].bcF), differing: agreement.refH[v].differing, universe: agreement.refH[v].universe });
    const md = [
        `# Similar images v3.1: offline gates (WP6)`,
        ``,
        `Generated ${report.generatedAt} by \`scripts/similarity-eval.js\` (variant \`${o.variant}\`, ORT ${load.ortVersion}, featureVersion \`${report.featureVersion}\`).`,
        ``,
        `Records ${images.length}; present ${present.length}; missing ${missing}; analysed ${n}; failed ${failed.length}. History JPEG under the current key: ${report.counts.withJpeg} (opaque ${report.counts.opaqueWithJpeg}, alpha ${report.counts.alphaWithJpeg}); source A used for ${sourceAUsed}. Promptless analysed: ${promptlessTotal}.`,
        ``,
        `Variants: **B** = source B for every image (reference); **P** = production source rule. O1/O8 on B, O2 compares P with B, O3–O6 and O7 on P.`,
        ``,
        `## Gates`,
        ``,
        markdownTable(gates.map(g => ({ ...g, pass: g.pass === null ? 'HUMAN' : g.pass ? 'PASS' : 'FAIL' })), ['id', 'criterion', 'target', 'measured', 'pass']),
        `## Presets`,
        ``,
        markdownTable(Object.values(presetRows).flat(), cols),
        `## Agreement with the references`,
        ``,
        markdownTable(refRows, ['reference', 'variant', 'bcF', 'differing', 'universe']),
        `## Agreement between variants (BCubed F1; images differing strict / standard / loose)`,
        ``,
        markdownTable(agreeRows, ['comparison', 'strict', 'standard', 'loose', 'differing']),
        `## Structure (P)`,
        ``,
        `- Shuffles (${o.shuffles}): hd ${structure.shuffles.hd.join(', ')}; h ${structure.shuffles.h.join(', ')}. Anchor ids unique: hd ${structure.ids.hd}, h ${structure.ids.h}.`,
        `- Nested strict ⊆ standard ⊆ loose: hd ${structure.nested.hd}, h ${structure.nested.h}.`,
        `- Sparse vs dense NN-chain, images differing (strict / standard / loose): ${o.dense ? `hd ${structure.dense.hd.join(' / ')}; h ${structure.dense.h.join(' / ')}` : 'not run'}.`,
        `- PCA-32 prefilter on vs off: identical ${structure.prefilter.identical}; ${structure.prefilter.edges} edges; auto chose '${structure.prefilter.autoChoice}'; exact dots ${structure.prefilter.exactDots}, skipped ${structure.prefilter.skipped}; basis+scan ${structure.prefilter.onMs} ms vs brute scan ${structure.prefilter.offScanMs} ms.`,
        `- Groups over 24 at 标准 and their parts at ${HD.NEXT_CUT.standard}: ${structure.subgroups.join(', ') || 'none'}.`,
        ``,
        `## Timing`,
        ``,
        `- Extraction: ${jobs.length} jobs in ${round(extractS, 1)} s with ${o.lanes} lanes (cached rows reused). Row medians under lane contention: A decode ${report.timing.rowMedians.A.decodeMs} ms + embed ${report.timing.rowMedians.A.embedMs} ms (n ${report.timing.rowMedians.A.n}); B decode ${report.timing.rowMedians.B.decodeMs} ms + embed ${report.timing.rowMedians.B.embedMs} ms (n ${report.timing.rowMedians.B.n}). Embed times include the wait in the single embed queue.`,
        `- Cluster runs (ms): ${Object.entries(report.timing.runs).map(([k, v]) => `${k} edges ${v.edges} / linkage ${v.linkage}`).join('; ')}.`,
        ``,
        sheets ? `## Contact sheets\n\n${sheets.files.map(f => `- ${f}`).join('\n')}\n` : '',
        `All automatic gates (O1–O8) pass: **${allPass}**. O9: ${o9Required ? 'human review REQUIRED' : 'not required (the tuning sheets stand)'}.`,
        ''
    ].join('\n');
    fs.writeFileSync(path.join(out, `report${suffix}.md`), md);
    log(`[eval] gates: ${gates.map(g => `${g.id} ${g.pass === null ? 'HUMAN' : g.pass ? 'PASS' : 'FAIL'}`).join(', ')}`);
    log(`[eval] wrote ${path.join(out, `report${suffix}.md`)} and report${suffix}.json in ${round((Date.now() - started) / 1000, 1)} s`);
    return report;
}

if (require.main === module) {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`similarity-eval: ${error.message}`);
        process.exit(2);
    }
    // sharp runs its pipelines on the libuv pool: give every lane room for its parallel chains.
    // Must be set before the pool first starts.
    if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = String(Math.max(4, options.lanes * 2 + 2));
    main(options).catch(error => {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    });
}

module.exports = {
    parseArgs,
    assertSafeOut,
    forbiddenRoots,
    isInside,
    mulberry32,
    shuffled,
    inRange,
    clusterMetrics,
    sizeStats,
    partitionAgreement,
    isNested,
    denseAverageMerges,
    cutDense,
    judgeMetrics,
    createVariantDecoder,
    evaluateGates,
    markdownTable,
    edgesIdentical
};
