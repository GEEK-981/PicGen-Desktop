'use strict';

// Prompt signal for similar-image grouping (v3.1; final.md §3.2 "Prompt", §3.4 provisional batches).
//
// Pure and dependency-free: used by the similarity host (edges, digest) and by
// main, which serves `provisionalBatches` as its fallback while the host is down.
//
// - `normalizePrompt` → np: NFKC, lower case, every whitespace removed, capped at
//   2,000 code points. '' means "no prompt".
// - `bigrams` works on code points; a one-character prompt is the set {char}.
// - `jaccard` is 0 when either set is empty.
// - `promptPairs` finds every pair of distinct prompts with J >= jMin, exactly.
//   Brute force with a size filter up to `bruteMax` prompts, an exact prefix-filter
//   join above that. Both paths verify with the same `jaccard`, so they return
//   identical results.
// - `promptPairSteps` is the same search as a generator: it yields (no value) about every
//   `yieldWork` units of work (roughly one set lookup each) and returns the array
//   promptPairs returns, so a caller can slice it (similarityCluster's buildEdges).

const MAX_PROMPT_CODE_POINTS = 2000;
const DEFAULT_SESSION_GAP_MS = 15 * 60 * 1000;
const DEFAULT_BRUTE_MAX = 3000;
// About 1 ms of set lookups on a desktop CPU; a time-sliced driver can then keep ~20 ms slices.
const DEFAULT_YIELD_WORK = 1 << 16;

// Candidate generation runs at a slightly lower threshold than verification, so a
// float rounding in `ceil(t * |x|)` can only lengthen a prefix, never drop a pair.
const CANDIDATE_SLACK = 1e-9;

function normalizePrompt(text) {
    if (text === null || text === undefined) return '';
    const np = String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    // UTF-16 length is an upper bound on the code-point count, so short prompts skip the split.
    if (np.length <= MAX_PROMPT_CODE_POINTS) return np;
    const points = Array.from(np);
    return points.length <= MAX_PROMPT_CODE_POINTS ? np : points.slice(0, MAX_PROMPT_CODE_POINTS).join('');
}

function bigrams(np) {
    const set = new Set();
    const points = Array.from(String(np ?? ''));
    if (points.length === 1) set.add(points[0]);
    for (let i = 0; i + 1 < points.length; i++) set.add(points[i] + points[i + 1]);
    return set;
}

function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    const [small, large] = a.size < b.size ? [a, b] : [b, a];
    for (const token of small) if (large.has(token)) inter++;
    return inter / (a.size + b.size - inter);
}

function compareStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

// Non-empty set indices, smallest first (ties by index), so a size filter can break early.
function sizeOrder(sets) {
    const order = [];
    for (let i = 0; i < sets.length; i++) if (sets[i].size) order.push(i);
    order.sort((x, y) => sets[x].size - sets[y].size || x - y);
    return order;
}

function pushPair(out, a, b, value) {
    out.push(a < b ? [a, b, value] : [b, a, value]);
}

// The searches below are generators: `work` counts roughly one set lookup per unit, and a
// bare `yield` hands control back whenever it reaches `budget`. Yielding never changes what
// they compute.

// J(x, y) <= |x| / |y| for |x| <= |y|. Float division is monotone, so when the
// size ratio already rounds below jMin, the rounded J does too: the break is exact.
function* bruteForceSteps(sets, jMin, budget) {
    const order = sizeOrder(sets);
    const out = [];
    let work = order.length;
    for (let x = 0; x < order.length; x++) {
        const a = order[x];
        const sizeA = sets[a].size;
        for (let y = x + 1; y < order.length; y++) {
            const b = order[y];
            if (sizeA / sets[b].size < jMin) break;
            const value = jaccard(sets[a], sets[b]);
            if (value >= jMin) pushPair(out, a, b, value);
            // jaccard walks the smaller set, which is `a` (size order).
            work += sizeA + 1;
            if (work >= budget) {
                work = 0;
                yield;
            }
        }
        if (++work >= budget) {
            work = 0;
            yield;
        }
    }
    return out;
}

// Exact prefix-filter join (tokens ordered by global frequency, rarest first).
// J(x, y) >= t implies |x ∩ y| >= ceil(t · max(|x|, |y|)), so the prefixes of
// length |x| - ceil(t|x|) + 1 of any qualifying pair share a token. That holds for any
// fixed global token order, so frequency ties go to first appearance: a stable counting
// sort, with no long comparison sort to slice.
function* prefixJoinSteps(sets, jMin, budget) {
    let work = 0;
    const idOf = new Map();
    const frequency = [];
    for (const set of sets) {
        for (const token of set) {
            const id = idOf.get(token);
            if (id === undefined) {
                idOf.set(token, frequency.length);
                frequency.push(1);
            } else {
                frequency[id]++;
            }
        }
        work += set.size + 1;
        if (work >= budget) {
            work = 0;
            yield;
        }
    }
    let maxFrequency = 0;
    for (const f of frequency) if (f > maxFrequency) maxFrequency = f;
    const start = new Int32Array(maxFrequency + 2);
    for (const f of frequency) start[f + 1]++;
    for (let f = 1; f < start.length; f++) start[f] += start[f - 1];
    const rankOf = new Int32Array(frequency.length);
    for (let id = 0; id < frequency.length; id++) rankOf[id] = start[frequency[id]]++;
    work += frequency.length;
    const ranked = new Array(sets.length);
    for (let s = 0; s < sets.length; s++) {
        ranked[s] = Int32Array.from(sets[s], token => rankOf[idOf.get(token)]).sort();
        work += 2 * sets[s].size + 1;
        if (work >= budget) {
            work = 0;
            yield;
        }
    }

    const threshold = jMin - CANDIDATE_SLACK;
    const order = sizeOrder(sets);
    const index = new Array(frequency.length); // token rank → the sets holding it in their prefix
    const seen = new Int32Array(sets.length).fill(-1);
    const out = [];
    for (const a of order) {
        const tokensA = ranked[a];
        const sizeA = tokensA.length;
        const prefix = Math.max(1, Math.min(sizeA, sizeA - Math.ceil(threshold * sizeA) + 1));
        const candidates = [];
        for (let p = 0; p < prefix; p++) {
            const list = index[tokensA[p]];
            if (!list) continue;
            for (const b of list) {
                if (seen[b] === a) continue;
                seen[b] = a;
                // Every indexed set is at most as large as `a` (size order).
                if (sets[b].size / sizeA >= threshold) candidates.push(b);
            }
            work += list.length + 1;
            if (work >= budget) {
                work = 0;
                yield;
            }
        }
        for (const b of candidates) {
            const value = jaccard(sets[a], sets[b]);
            if (value >= jMin) pushPair(out, a, b, value);
            work += sets[b].size + 1;
            if (work >= budget) {
                work = 0;
                yield;
            }
        }
        for (let p = 0; p < prefix; p++) {
            let list = index[tokensA[p]];
            if (!list) index[tokensA[p]] = list = [];
            list.push(a);
        }
        work += prefix + 1;
        if (work >= budget) {
            work = 0;
            yield;
        }
    }
    return out;
}

function* allPairSteps(sets, budget) {
    const out = [];
    let work = 0;
    for (let a = 0; a < sets.length; a++) {
        for (let b = a + 1; b < sets.length; b++) {
            out.push([a, b, jaccard(sets[a], sets[b])]);
            work += Math.min(sets[a].size, sets[b].size) + 1;
            if (work >= budget) {
                work = 0;
                yield;
            }
        }
    }
    return out;
}

// promptPairs as a generator: yields (no value) about every `yieldWork` units of work
// (a non-positive or NaN value means the default; Infinity never yields) and returns
// exactly what promptPairs returns.
function* promptPairSteps(prompts, jMin, { bruteMax = DEFAULT_BRUTE_MAX, yieldWork = DEFAULT_YIELD_WORK } = {}) {
    const budget = yieldWork > 0 ? yieldWork : DEFAULT_YIELD_WORK;
    const input = Array.from(prompts || []);
    const sets = new Array(input.length);
    let work = 0;
    for (let k = 0; k < input.length; k++) {
        const p = input[k];
        sets[k] = p instanceof Set ? p : bigrams(p);
        work += sets[k].size + 1;
        if (work >= budget) {
            work = 0;
            yield;
        }
    }
    let out;
    if (Number.isNaN(Number(jMin))) out = [];                  // J >= NaN never holds
    else if (!(jMin > 0)) out = yield* allPairSteps(sets, budget); // every pair qualifies, even disjoint ones
    else if (sets.length <= bruteMax) out = yield* bruteForceSteps(sets, jMin, budget);
    else out = yield* prefixJoinSteps(sets, jMin, budget);
    return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

// prompts: normalised prompt strings (or ready bigram Sets). Returns [i, j, J] with
// i < j, sorted by (i, j), for every pair with J >= jMin.
function promptPairs(prompts, jMin, options) {
    const steps = promptPairSteps(prompts, jMin, options);
    for (;;) {
        const step = steps.next();
        if (step.done) return step.value;
    }
}

function defaultKeyOf(record) {
    return record.id || record.filePath || record.fileName;
}

function defaultNpOf(record) {
    return typeof record.np === 'string' ? record.np : normalizePrompt(record.prompt);
}

function defaultTimeOf(record) {
    return Number(record.createdAt) || Number(record.mtimeMs) || Number(record.mtime) || Number.NaN;
}

// Prompt + session batches, the provisional groups shown before pixels are analysed:
// same np, ordered by time, chained while consecutive gaps are <= gapMs.
// Records without a prompt, key or finite time never batch. Each batch lists its keys
// oldest first; batches are ordered by their oldest member (time, then key).
function provisionalBatches(records, {
    gapMs = DEFAULT_SESSION_GAP_MS,
    keyOf = defaultKeyOf,
    npOf = defaultNpOf,
    timeOf = defaultTimeOf
} = {}) {
    const families = new Map();
    const seenKeys = new Set();
    for (const record of records || []) {
        if (!record) continue;
        const np = npOf(record);
        if (!np) continue;
        const rawKey = keyOf(record);
        if (rawKey === undefined || rawKey === null || rawKey === '') continue;
        const key = String(rawKey);
        if (seenKeys.has(key)) continue;
        const time = Number(timeOf(record));
        if (!Number.isFinite(time)) continue;
        seenKeys.add(key);
        let family = families.get(np);
        if (!family) families.set(np, (family = []));
        family.push({ key, time });
    }

    const batches = [];
    for (const family of families.values()) {
        family.sort((a, b) => a.time - b.time || compareStrings(a.key, b.key));
        let current = [family[0]];
        for (let i = 1; i < family.length; i++) {
            if (family[i].time - family[i - 1].time <= gapMs) {
                current.push(family[i]);
            } else {
                if (current.length >= 2) batches.push(current);
                current = [family[i]];
            }
        }
        if (current.length >= 2) batches.push(current);
    }
    batches.sort((a, b) => a[0].time - b[0].time || compareStrings(a[0].key, b[0].key));
    return batches.map(batch => batch.map(entry => entry.key));
}

module.exports = {
    normalizePrompt,
    bigrams,
    jaccard,
    promptPairs,
    promptPairSteps,
    provisionalBatches,
    MAX_PROMPT_CODE_POINTS,
    DEFAULT_SESSION_GAP_MS
};
