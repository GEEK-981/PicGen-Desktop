const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizePrompt,
    bigrams,
    jaccard,
    promptPairs,
    promptPairSteps,
    provisionalBatches
} = require('../similarityPrompt');

// Deterministic PRNG so the random fixtures are identical on every run.
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

// --- normalizePrompt --------------------------------------------------------

test('normalizePrompt applies NFKC, lowercases and strips every whitespace', () => {
    assert.equal(normalizePrompt('Ｈｅｌｌｏ　Ｗｏｒｌｄ'), 'helloworld');
    assert.equal(normalizePrompt('A Cat\n\tSits  On\r\nThe Mat'), 'acatsitsonthemat');
    assert.equal(normalizePrompt('ＡＢＣ１２３'), 'abc123');
    // Half-width katakana is widened by NFKC.
    assert.equal(normalizePrompt('ｶﾀｶﾅ'), 'カタカナ');
    assert.equal(normalizePrompt('  一只 猫  在桌上 '), '一只猫在桌上');
});

test('normalizePrompt treats empty, blank and missing input as no prompt', () => {
    assert.equal(normalizePrompt(''), '');
    assert.equal(normalizePrompt('   \n\t　'), '');
    assert.equal(normalizePrompt(null), '');
    assert.equal(normalizePrompt(undefined), '');
});

test('normalizePrompt caps the result at 2,000 code points', () => {
    assert.equal(normalizePrompt('字'.repeat(2500)).length, 2000);
    const astral = normalizePrompt('😀'.repeat(2500));
    assert.equal(Array.from(astral).length, 2000);
    assert.equal(astral.length, 4000);
    // Whitespace is stripped before the cap is applied.
    const spaced = normalizePrompt('a '.repeat(2100));
    assert.equal(spaced.length, 2000);
});

// --- bigrams / jaccard ------------------------------------------------------

test('bigrams works on code points, including CJK and astral characters', () => {
    assert.deepEqual([...bigrams('猫在桌上')], ['猫在', '在桌', '桌上']);
    assert.deepEqual([...bigrams('😀😃😄')], ['😀😃', '😃😄']);
    assert.deepEqual([...bigrams('abab')].sort(), ['ab', 'ba']);
});

test('a one-character prompt gives a single-token set; an empty one gives none', () => {
    assert.deepEqual([...bigrams('猫')], ['猫']);
    assert.deepEqual([...bigrams('😀')], ['😀']);
    assert.equal(bigrams('').size, 0);
});

test('jaccard is intersection over union and 0 when either side is empty', () => {
    assert.equal(jaccard(bigrams('abcd'), bigrams('abce')), 0.5);
    assert.equal(jaccard(bigrams('abcd'), bigrams('abcd')), 1);
    assert.equal(jaccard(bigrams('abcd'), bigrams('wxyz')), 0);
    assert.equal(jaccard(bigrams(''), bigrams('abcd')), 0);
    assert.equal(jaccard(bigrams('abcd'), bigrams('')), 0);
    assert.equal(jaccard(bigrams(''), bigrams('')), 0);
    assert.equal(jaccard(bigrams('ab'), bigrams('abcd')), jaccard(bigrams('abcd'), bigrams('ab')));
});

// --- promptPairs ------------------------------------------------------------

const ALPHABET = Array.from('的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处理府研质京每世元院六军米车')
    .concat(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't', 'u']);

function randomPrompts(count, seed) {
    const rand = mulberry32(seed);
    const pick = () => ALPHABET[Math.floor(rand() * ALPHABET.length)];
    const bases = [];
    const prompts = [];
    while (prompts.length < count) {
        if (!bases.length || rand() < 0.3) {
            const length = 3 + Math.floor(rand() * 60);
            bases.push(Array.from({ length }, pick));
        }
        const base = bases[Math.floor(rand() * bases.length)];
        const chars = base.slice();
        const edits = Math.floor(rand() * 4);
        for (let e = 0; e < edits; e++) {
            const at = Math.floor(rand() * (chars.length + 1));
            const op = rand();
            if (op < 0.34) chars.splice(at, 0, pick());
            else if (op < 0.67 && chars.length > 1) chars.splice(Math.min(at, chars.length - 1), 1);
            else chars[Math.min(at, chars.length - 1)] = pick();
        }
        prompts.push(chars.join(''));
    }
    // A few exact duplicates and short prompts keep the edge cases covered.
    prompts[7] = prompts[3];
    prompts[11] = '猫';
    prompts[12] = '猫';
    prompts[13] = 'ab';
    return prompts;
}

function naivePairs(prompts, jMin) {
    const sets = prompts.map(bigrams);
    const out = [];
    for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
            const value = jaccard(sets[i], sets[j]);
            if (value >= jMin) out.push([i, j, value]);
        }
    }
    return out;
}

test('promptPairs brute force and prefix-filter join both equal the naive scan', () => {
    const prompts = randomPrompts(500, 20260924);
    for (const jMin of [0.7692, 1 - 0.11 / 0.65, 0.5]) {
        const expected = naivePairs(prompts, jMin);
        assert.ok(expected.length >= 50, `fixture should have enough pairs at ${jMin}, got ${expected.length}`);
        const brute = promptPairs(prompts, jMin);
        const prefix = promptPairs(prompts, jMin, { bruteMax: 0 });
        assert.deepEqual(brute, expected, `brute force at ${jMin}`);
        assert.deepEqual(prefix, expected, `prefix join at ${jMin}`);
    }
});

test('promptPairs is exact on several random libraries and accepts bigram sets', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
        const prompts = randomPrompts(220, seed);
        const expected = naivePairs(prompts, 0.7692);
        assert.deepEqual(promptPairs(prompts, 0.7692, { bruteMax: 0 }), expected);
        assert.deepEqual(promptPairs(prompts.map(bigrams), 0.7692), expected);
    }
});

test('promptPairs returns sorted [i, j, J] with i < j and skips empty prompts', () => {
    const pairs = promptPairs(['abcd', '', 'abcd', 'abce', 'zzzz'], 0.5);
    assert.deepEqual(pairs, [[0, 2, 1], [0, 3, 0.5], [2, 3, 0.5]]);
    assert.deepEqual(promptPairs([], 0.7692), []);
    assert.deepEqual(promptPairs(['abc'], 0.7692), []);
});

test('promptPairs handles degenerate thresholds exactly', () => {
    const prompts = ['abcd', 'wxyz', 'abcd'];
    assert.deepEqual(promptPairs(prompts, 0), [[0, 1, 0], [0, 2, 1], [1, 2, 0]]);
    assert.deepEqual(promptPairs(prompts, 1), [[0, 2, 1]]);
    assert.deepEqual(promptPairs(prompts, 1, { bruteMax: 0 }), [[0, 2, 1]]);
    assert.deepEqual(promptPairs(prompts, 1.01), []);
    assert.deepEqual(promptPairs(prompts, 1.01, { bruteMax: 0 }), []);
    assert.deepEqual(promptPairs(prompts, Number.NaN), []);
});

// --- promptPairSteps (the sliceable form) -----------------------------------

// Runs a step generator to completion, counting its yields.
function drain(steps) {
    let yields = 0;
    for (;;) {
        const step = steps.next();
        if (step.done) return { value: step.value, yields };
        assert.equal(step.value, undefined, 'steps yield no values');
        yields++;
    }
}

test('promptPairSteps returns exactly the pairs promptPairs returns, on every path', () => {
    const prompts = randomPrompts(500, 20260924);
    for (const jMin of [0.7692, 1 - 0.11 / 0.65, 0.5]) {
        const expected = naivePairs(prompts, jMin);
        for (const options of [undefined, { bruteMax: 0 }, { yieldWork: 7 }, { bruteMax: 0, yieldWork: 1 }]) {
            const label = `jMin ${jMin}, ${JSON.stringify(options)}`;
            assert.deepEqual(drain(promptPairSteps(prompts, jMin, options)).value, expected, label);
            assert.deepEqual(promptPairs(prompts, jMin, options), expected, label);
        }
    }
    // Degenerate thresholds, bigram-set input and empty input take the same paths as promptPairs.
    const small = randomPrompts(60, 9);
    for (const jMin of [0, -1, 1, 1.01, Number.NaN]) {
        for (const options of [undefined, { bruteMax: 0, yieldWork: 3 }]) {
            assert.deepEqual(drain(promptPairSteps(small, jMin, options)).value, promptPairs(small, jMin, options), `jMin ${jMin}`);
        }
    }
    assert.deepEqual(drain(promptPairSteps(small.map(bigrams), 0.7692)).value, naivePairs(small, 0.7692));
    assert.deepEqual(drain(promptPairSteps([], 0.7692)).value, []);
    assert.deepEqual(drain(promptPairSteps(null, 0.7692)).value, []);
});

test('promptPairSteps yields in proportion to its work, so a caller can slice it', () => {
    const prompts = randomPrompts(400, 7);
    for (const bruteMax of [undefined, 0]) {
        const coarse = drain(promptPairSteps(prompts, 0.8308, { bruteMax }));
        const fine = drain(promptPairSteps(prompts, 0.8308, { bruteMax, yieldWork: 256 }));
        assert.deepEqual(fine.value, coarse.value);
        assert.ok(fine.yields >= 50, `bruteMax ${bruteMax}: ${fine.yields} yields at yieldWork 256`);
        assert.ok(fine.yields > 20 * coarse.yields, `bruteMax ${bruteMax}: ${fine.yields} fine vs ${coarse.yields} default yields`);
    }
    // A non-positive or NaN budget means the default; Infinity never yields.
    const byDefault = drain(promptPairSteps(prompts, 0.8308)).yields;
    assert.equal(drain(promptPairSteps(prompts, 0.8308, { yieldWork: 0 })).yields, byDefault);
    assert.equal(drain(promptPairSteps(prompts, 0.8308, { yieldWork: Number.NaN })).yields, byDefault);
    assert.equal(drain(promptPairSteps(prompts, 0.8308, { yieldWork: Infinity })).yields, 0);
});

// --- provisionalBatches -----------------------------------------------------

const MIN = 60 * 1000;

test('provisionalBatches chains same-prompt records while gaps are at most 15 minutes', () => {
    const t0 = 1_700_000_000_000;
    const records = [
        { id: 'a1', prompt: 'Red Car', createdAt: t0 },
        { id: 'a2', prompt: 'red  car', createdAt: t0 + 15 * MIN },          // exactly 15 min: chained
        { id: 'a3', prompt: 'RED CAR', createdAt: t0 + 30 * MIN + 1 },       // 15 min + 1 ms: new batch
        { id: 'a4', prompt: 'red car', createdAt: t0 + 31 * MIN },
        { id: 'b1', prompt: 'blue boat', createdAt: t0 + 1 * MIN },
        { id: 'c1', prompt: 'lonely', createdAt: t0 + 2 * MIN },             // single: not a batch
        { id: 'n1', prompt: '', createdAt: t0 },                             // promptless: never batched
        { id: 'n2', prompt: '  ', createdAt: t0 + 1 }
    ];
    assert.deepEqual(provisionalBatches(records), [['a1', 'a2'], ['a3', 'a4']]);
});

test('provisionalBatches falls back to mtime when createdAt is missing', () => {
    const t0 = 1_700_000_000_000;
    const records = [
        { id: 'x1', prompt: 'forest', createdAt: 0, mtimeMs: t0 + 5 * MIN },
        { id: 'x2', prompt: 'forest', createdAt: t0 },
        { id: 'x3', prompt: 'forest', mtimeMs: t0 + 60 * MIN }
    ];
    assert.deepEqual(provisionalBatches(records), [['x2', 'x1']]);
});

test('provisionalBatches is order-independent and uses the history key by default', () => {
    const t0 = 1_700_000_000_000;
    const records = [
        { filePath: 'D:/img/p2.png', prompt: 'tree', createdAt: t0 + MIN },
        { fileName: 'p3.png', prompt: 'tree', createdAt: t0 + MIN },
        { id: 'p1', filePath: 'D:/img/p1.png', prompt: 'tree', createdAt: t0 }
    ];
    const expected = [['p1', 'D:/img/p2.png', 'p3.png']];
    assert.deepEqual(provisionalBatches(records), expected);
    assert.deepEqual(provisionalBatches(records.slice().reverse()), expected);
});

test('provisionalBatches honours custom gap and accessors', () => {
    const records = [
        { k: 'r1', p: 'same', t: 0 },
        { k: 'r2', p: 'same', t: 100 },
        { k: 'r3', p: 'same', t: 250 }
    ];
    const options = { keyOf: r => r.k, npOf: r => r.p, timeOf: r => r.t };
    assert.deepEqual(provisionalBatches(records, { ...options, gapMs: 100 }), [['r1', 'r2']]);
    assert.deepEqual(provisionalBatches(records, { ...options, gapMs: 150 }), [['r1', 'r2', 'r3']]);
    assert.deepEqual(provisionalBatches([], options), []);
});
