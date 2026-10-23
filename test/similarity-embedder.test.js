// similarityEmbedder.js: the DINOv2-small q8 embedder (onnxruntime-node, CPU only).
// The contract cases run against a fake `ort` module; the real-model cases skip with a
// message when models/dinov2-small-q8.onnx has not been fetched (npm run fetch:models).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    createEmbedder,
    embVersionFor,
    readOrtVersion,
    MODEL_BYTES,
    SESSION_OPTIONS
} = require('../similarityEmbedder');

const MODEL_PATH = path.join(__dirname, '..', 'models', 'dinov2-small-q8.onnx');
const FAKE_MODEL = path.join(__dirname, 'no-such-dir', 'fake-model.onnx');
const EXPECTED_OPTIONS = {
    executionProviders: ['cpu'],
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all'
};

const goodStat = () => ({ size: MODEL_BYTES, isFile: () => true });
const fixedVersion = () => '1.24.3';

// A minimal stand-in for onnxruntime-node: InferenceSession.create + session.run + Tensor.
// Token t, channel d of the fake last_hidden_state is (t + 1) * (d % 7 + 1), except token 0
// (CLS), which is a huge spike: pooling that forgot to skip it would point along it.
function fakeOrt({ dims = [1, 257, 384], createError, runImpl, data } = {}) {
    const calls = { create: [], run: [], release: 0, inflight: 0, maxInflight: 0 };
    class Tensor {
        constructor(type, values, shape) {
            this.type = type;
            this.data = values;
            this.dims = shape;
        }
    }
    function hiddenState(shape) {
        const [, T, D] = shape;
        const values = new Float32Array(T * D);
        for (let t = 0; t < T; t++) {
            for (let d = 0; d < D; d++) values[t * D + d] = t === 0 ? (d === 0 ? 1e6 : 0) : (t + 1) * (d % 7 + 1);
        }
        return values;
    }
    const session = {
        inputNames: ['pixel_values'],
        outputNames: ['last_hidden_state', 'pooler_output'],
        async run(feeds) {
            calls.run.push(feeds);
            calls.inflight++;
            calls.maxInflight = Math.max(calls.maxInflight, calls.inflight);
            try {
                await new Promise(resolve => setImmediate(resolve));
                if (runImpl) {
                    const custom = await runImpl(feeds, calls.run.length);
                    if (custom) return custom;
                }
                return { last_hidden_state: new Tensor('float32', data ? data(dims) : hiddenState(dims), dims) };
            } finally {
                calls.inflight--;
            }
        },
        async release() { calls.release++; }
    };
    const ort = {
        Tensor,
        InferenceSession: {
            async create(modelPath, options) {
                calls.create.push({ modelPath, options });
                if (createError) throw createError;
                return session;
            }
        }
    };
    return { ort, calls, session };
}

function fakeEmbedder(fake, overrides = {}) {
    return createEmbedder({
        modelPath: FAKE_MODEL,
        loadOrt: () => fake.ort,
        statSync: goodStat,
        readOrtVersion: fixedVersion,
        ...overrides
    });
}

function norm(vector) {
    let sum = 0;
    for (const value of vector) sum += value * value;
    return Math.sqrt(sum);
}

function whiteRgb224() {
    return Buffer.alloc(224 * 224 * 3, 255);
}

test('constants: model size, session options and the embedding version', () => {
    assert.equal(MODEL_BYTES, 24451943);
    assert.deepEqual(SESSION_OPTIONS, EXPECTED_OPTIONS);
    assert.ok(Object.isFrozen(SESSION_OPTIONS));
    assert.equal(embVersionFor('1.24.3'), 'dinov2s-q8-pad-v1+ort1.24');
    assert.equal(embVersionFor('1.26.0-dev.20260101'), 'dinov2s-q8-pad-v1+ort1.26');
    assert.equal(readOrtVersion(), require('onnxruntime-node/package.json').version);
});

test('a module that cannot be required gives ort-unavailable', async () => {
    const embedder = createEmbedder({
        modelPath: FAKE_MODEL,
        loadOrt: () => { throw new Error('The specified module could not be found.'); },
        statSync: goodStat
    });
    const result = await embedder.load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ort-unavailable');
    assert.match(result.message, /could not be found/);
    assert.equal(embedder.loaded, false);
});

test('a missing model gives model-missing and never creates a session', async () => {
    const fake = fakeOrt();
    const missing = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    const embedder = fakeEmbedder(fake, { statSync: () => { throw missing; } });
    const result = await embedder.load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'model-missing');
    assert.equal(fake.calls.create.length, 0);

    const directory = fakeEmbedder(fake, { statSync: () => ({ size: MODEL_BYTES, isFile: () => false }) });
    assert.equal((await directory.load()).reason, 'model-missing');
    assert.equal((await fakeEmbedder(fake, { modelPath: '' }).load()).reason, 'model-missing');
    assert.equal(fake.calls.create.length, 0);
});

test('a model of the wrong size gives model-size and never creates a session', async () => {
    const fake = fakeOrt();
    const embedder = fakeEmbedder(fake, { statSync: () => ({ size: MODEL_BYTES - 1, isFile: () => true }) });
    const result = await embedder.load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'model-size');
    assert.match(result.message, /24451942/);
    assert.equal(fake.calls.create.length, 0);
});

test('a rejected session create gives session-failed', async () => {
    const fake = fakeOrt({ createError: new Error('protobuf parsing failed') });
    const result = await fakeEmbedder(fake).load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'session-failed');
    assert.match(result.message, /protobuf/);
});

test('a self-test with the wrong dims gives self-test-failed and releases the session', async () => {
    const fake = fakeOrt({ dims: [1, 257, 128] });
    const embedder = fakeEmbedder(fake);
    const result = await embedder.load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'self-test-failed');
    assert.match(result.message, /1,257,128/);
    assert.equal(fake.calls.release, 1);
    assert.equal(embedder.loaded, false);
});

test('a self-test with non-finite values or a run error gives self-test-failed', async () => {
    const nan = fakeOrt({ data: shape => new Float32Array(shape[1] * shape[2]).fill(Number.NaN) });
    assert.equal((await fakeEmbedder(nan).load()).reason, 'self-test-failed');
    const throws = fakeOrt({ runImpl: () => { throw new Error('run exploded'); } });
    const result = await fakeEmbedder(throws).load();
    assert.equal(result.reason, 'self-test-failed');
    assert.match(result.message, /run exploded/);
});

test('create gets the model path as a string and exactly the CPU options', async () => {
    const fake = fakeOrt();
    const embedder = fakeEmbedder(fake);
    const result = await embedder.load();
    assert.deepEqual(result, { ok: true, ortVersion: '1.24.3', embVersion: 'dinov2s-q8-pad-v1+ort1.24' });
    assert.equal(embedder.loaded, true);
    assert.equal(fake.calls.create.length, 1);
    const [{ modelPath, options }] = fake.calls.create;
    assert.equal(typeof modelPath, 'string');
    assert.equal(modelPath, FAKE_MODEL);
    assert.deepEqual(options, EXPECTED_OPTIONS);

    // The self-test ran one white 224x224 float32 NCHW tensor through the model's input.
    assert.equal(fake.calls.run.length, 1);
    const tensor = fake.calls.run[0].pixel_values;
    assert.equal(tensor.type, 'float32');
    assert.deepEqual(tensor.dims, [1, 3, 224, 224]);
    assert.ok(tensor.data instanceof Float32Array);
    assert.equal(tensor.data.length, 150528);
    const whiteRed = (1 - 0.485) / 0.229;
    assert.ok(Math.abs(tensor.data[0] - whiteRed) < 1e-5);

    // A second load reuses the session.
    assert.deepEqual(await embedder.load(), result);
    assert.equal(fake.calls.create.length, 1);
});

test('threads sets intraOpNumThreads and nothing else', async () => {
    const fake = fakeOrt();
    await fakeEmbedder(fake, { threads: 1 }).load();
    assert.deepEqual(fake.calls.create[0].options, { ...EXPECTED_OPTIONS, intraOpNumThreads: 1 });
});

test('the ORT version defaults to onnxruntime-node/package.json', async () => {
    const fake = fakeOrt();
    const result = await createEmbedder({ modelPath: FAKE_MODEL, loadOrt: () => fake.ort, statSync: goodStat }).load();
    const { version } = require('onnxruntime-node/package.json');
    assert.equal(result.ortVersion, version);
    assert.equal(result.embVersion, embVersionFor(version));
});

test('an unreadable ORT version is ort-unavailable, and load never throws', async () => {
    const fake = fakeOrt();
    const garbled = await fakeEmbedder(fake, { readOrtVersion: () => 'unknown' }).load();
    assert.equal(garbled.reason, 'ort-unavailable');
    assert.match(garbled.message, /unknown/);
    const missing = await fakeEmbedder(fake, { readOrtVersion: () => { throw new Error('no package.json'); } }).load();
    assert.equal(missing.reason, 'ort-unavailable');
    assert.equal(fake.calls.create.length, 0);
});

test('embed pools tokens 1..256, L2-normalises, and feeds a normalised NCHW tensor', async () => {
    const fake = fakeOrt();
    const embedder = fakeEmbedder(fake);
    assert.equal((await embedder.load()).ok, true);

    const rgb224 = Buffer.alloc(150528);
    rgb224[0] = 255; rgb224[1] = 0; rgb224[2] = 51; // pixel 0: R, G, B
    const vector = await embedder.embed(rgb224);
    assert.ok(vector instanceof Float32Array);
    assert.equal(vector.length, 384);
    assert.ok(Math.abs(norm(vector) - 1) < 1e-5);
    // Without the CLS spike every channel is proportional to (d % 7 + 1).
    assert.ok(Math.abs(vector[1] / vector[0] - 2) < 1e-5, 'token 0 (CLS) must be skipped');
    assert.ok(Math.abs(vector[6] / vector[0] - 7) < 1e-5);

    const tensor = fake.calls.run.at(-1).pixel_values;
    const plane = 224 * 224;
    assert.ok(Math.abs(tensor.data[0] - (1 - 0.485) / 0.229) < 1e-5, 'R plane');
    assert.ok(Math.abs(tensor.data[plane] - (0 - 0.456) / 0.224) < 1e-5, 'G plane');
    assert.ok(Math.abs(tensor.data[2 * plane] - (0.2 - 0.406) / 0.225) < 1e-5, 'B plane');
});

test('embed loads lazily, rejects a wrong-sized input, and throws on a run error', async () => {
    let failRun = false;
    const fake = fakeOrt({ runImpl: () => { if (failRun) throw new Error('bad allocation'); } });
    const embedder = fakeEmbedder(fake);
    assert.equal(embedder.loaded, false);

    const vector = await embedder.embed(whiteRgb224());
    assert.equal(vector.length, 384);
    assert.equal(embedder.loaded, true);
    assert.equal(fake.calls.create.length, 1);

    await assert.rejects(embedder.embed(Buffer.alloc(100)), /150528/);
    failRun = true;
    await assert.rejects(embedder.embed(whiteRgb224()), /bad allocation/);
    failRun = false;
    assert.equal((await embedder.embed(whiteRgb224())).length, 384, 'a run error does not poison the embedder');
});

test('embed throws when the output is malformed or not finite', async () => {
    let mode = 'ok';
    const fake = fakeOrt({
        runImpl: (feeds, count) => {
            if (count === 1 || mode === 'ok') return null;
            const { Tensor } = fake.ort;
            if (mode === 'dims') return { last_hidden_state: new Tensor('float32', new Float32Array(257 * 128), [1, 257, 128]) };
            if (mode === 'missing') return { pooler_output: new Tensor('float32', new Float32Array(384), [1, 384]) };
            return { last_hidden_state: new Tensor('float32', new Float32Array(257 * 384).fill(Number.NaN), [1, 257, 384]) };
        }
    });
    const embedder = fakeEmbedder(fake);
    await embedder.load();
    mode = 'dims';
    await assert.rejects(embedder.embed(whiteRgb224()), /dims/);
    mode = 'missing';
    await assert.rejects(embedder.embed(whiteRgb224()), /last_hidden_state/);
    mode = 'nan';
    await assert.rejects(embedder.embed(whiteRgb224()), /finite/);
});

test('embed with a failing lazy load throws with the reason', async () => {
    const embedder = createEmbedder({
        modelPath: FAKE_MODEL,
        loadOrt: () => { throw new Error('missing VC runtime'); },
        statSync: goodStat
    });
    await assert.rejects(embedder.embed(whiteRgb224()), error => error.reason === 'ort-unavailable');
});

test('at most one session.run is in flight', async () => {
    const fake = fakeOrt();
    const embedder = fakeEmbedder(fake);
    const results = await Promise.all(Array.from({ length: 6 }, () => embedder.embed(whiteRgb224())));
    assert.equal(results.length, 6);
    assert.equal(fake.calls.maxInflight, 1);
    assert.equal(fake.calls.create.length, 1, 'concurrent first calls share one load');
});

test('release frees the session and the next embed re-creates it with a new self-test', async () => {
    const fake = fakeOrt();
    const embedder = fakeEmbedder(fake);
    await embedder.embed(whiteRgb224());
    const runsBefore = fake.calls.run.length;

    await embedder.release();
    assert.equal(embedder.loaded, false);
    assert.equal(fake.calls.release, 1);
    await embedder.release();
    assert.equal(fake.calls.release, 1, 'release is idempotent');

    await embedder.embed(whiteRgb224());
    assert.equal(embedder.loaded, true);
    assert.equal(fake.calls.create.length, 2);
    assert.equal(fake.calls.run.length, runsBefore + 2, 'self-test plus the embed');
});

test('release waits for an in-flight run', async () => {
    let unblock;
    const gate = new Promise(resolve => { unblock = resolve; });
    const fake = fakeOrt({ runImpl: async (feeds, count) => { if (count === 2) await gate; } });
    const embedder = fakeEmbedder(fake);
    await embedder.load();
    const pending = embedder.embed(whiteRgb224());
    await new Promise(resolve => setImmediate(resolve));
    const released = embedder.release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fake.calls.release, 0, 'the session is still running');
    unblock();
    assert.equal((await pending).length, 384);
    await released;
    assert.equal(fake.calls.release, 1);
    assert.equal(embedder.loaded, false);
});

// ---- Real model -------------------------------------------------------------------------

const MODEL_PRESENT = (() => {
    try { return fs.statSync(MODEL_PATH).size === MODEL_BYTES; } catch { return false; }
})();
const SKIP_REAL = MODEL_PRESENT ? false : 'models/dinov2-small-q8.onnx is absent: run `npm run fetch:models`';

// Deterministic 224x224 test card, integer math only (no image codec involved): a red disc,
// a dark square, and horizontal/vertical ramps with an XOR texture in blue.
function testCard() {
    const S = 224;
    const rgb = Buffer.alloc(S * S * 3);
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const i = (y * S + x) * 3;
            const disc = (x - 80) * (x - 80) + (y - 100) * (y - 100) < 2500;
            const square = x > 130 && x < 200 && y > 40 && y < 110;
            rgb[i] = disc ? 220 : Math.floor(x * 255 / (S - 1));
            rgb[i + 1] = square ? 30 : Math.floor(y * 255 / (S - 1));
            rgb[i + 2] = (x ^ y) & 0xff;
        }
    }
    return rgb;
}

// Recorded once with onnxruntime-node 1.24.3 and the pinned model (sha256 3afdc8bc…d917),
// from the §2.4 math implemented independently of this module: float32 LE, 384 values.
const TEST_CARD_REFERENCE_B64 = [
    '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',
    'BrIFvU0A9zrwyuk7IscFvY2j6Tx1cSE9'
].join('');

function referenceVector() {
    const bytes = Buffer.from(TEST_CARD_REFERENCE_B64, 'base64');
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

test('real model: loads, embeds deterministically, and matches the recorded vector', { skip: SKIP_REAL }, async t => {
    const embedder = createEmbedder({ modelPath: MODEL_PATH });
    t.after(() => embedder.release());
    const loaded = await embedder.load();
    assert.deepEqual(loaded, {
        ok: true,
        ortVersion: require('onnxruntime-node/package.json').version,
        embVersion: embVersionFor(require('onnxruntime-node/package.json').version)
    });

    const first = await embedder.embed(testCard());
    const second = await embedder.embed(testCard());
    assert.equal(first.length, 384);
    assert.ok(Math.abs(norm(first) - 1) <= 1e-5, `norm ${norm(first)}`);
    assert.deepEqual(Array.from(second), Array.from(first), 'two runs are identical');

    const reference = referenceVector();
    assert.equal(reference.length, 384);
    let cos = 0;
    for (let d = 0; d < 384; d++) cos += first[d] * reference[d];
    cos /= norm(reference);
    assert.ok(cos >= 0.9999, `cos ${cos} against the recorded reference`);

    const white = await embedder.embed(whiteRgb224());
    let cosWhite = 0;
    for (let d = 0; d < 384; d++) cosWhite += first[d] * white[d];
    assert.ok(cosWhite < 0.95, `a different image embeds differently (cos ${cosWhite})`);
});

test('real model: release and lazy re-create give the same embedding', { skip: SKIP_REAL }, async t => {
    const embedder = createEmbedder({ modelPath: MODEL_PATH });
    t.after(() => embedder.release());
    const before = await embedder.embed(testCard());
    await embedder.release();
    assert.equal(embedder.loaded, false);
    const after = await embedder.embed(testCard());
    assert.equal(embedder.loaded, true);
    assert.deepEqual(Array.from(after), Array.from(before));
});
