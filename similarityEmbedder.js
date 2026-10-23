// DINOv2-small q8 image embedder for the similarity engine (plan v3.1 §2.2, §2.4). Runs in
// the similarity host process, never in main: a native fault here must only cost the host.
//
// - CPU execution provider only. DirectML is never requested (its DLLs are not even packed).
// - The model is loaded by file path; a Buffer would add ~25 MB to peak memory.
// - One session serves every lane. ORT fixes its thread pool at create time, so background
//   politeness comes from the host's lane gaps and process priority, not from here.
// - At most one session.run is in flight: load, embed and release share one serial queue,
//   so a release can never free a session under a running inference.
// - release() frees the ~65 MB session when the host goes idle; the next embed() re-creates
//   it (≈0.13 s plus the self-test).
const fs = require('node:fs');

const MODEL_BYTES = 24451943;
const INPUT_DIMS = Object.freeze([1, 3, 224, 224]);
const INPUT_BYTES = 224 * 224 * 3;
const OUTPUT_NAME = 'last_hidden_state';
const SELF_TEST_DIMS = Object.freeze([1, 257, 384]);
const EMBEDDING_DIM = 384;
const SESSION_OPTIONS = Object.freeze({
    executionProviders: Object.freeze(['cpu']),
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all'
});

let featuresModule = null;
// Required on first use so this module loads (and its failure paths stay testable) without
// the feature-row module.
function features() {
    if (!featuresModule) featuresModule = require('./similarityFeatures');
    return featuresModule;
}

function readOrtVersion() {
    return require('onnxruntime-node/package.json').version;
}

// 'dinov2s-q8-pad-v1+ort1.24': the base name plus ORT major.minor, so an ORT upgrade (whose
// kernels can move embeddings) invalidates stored embeddings and re-embeds automatically.
function embVersionFor(ortVersion) {
    const match = /^(\d+)\.(\d+)/.exec(String(ortVersion || ''));
    if (!match) throw new Error(`unrecognised onnxruntime version "${ortVersion}"`);
    return `${features().EMB_VERSION_BASE}+ort${match[1]}.${match[2]}`;
}

function sameDims(actual, expected) {
    return Array.isArray(actual) || ArrayBuffer.isView(actual)
        ? actual.length === expected.length && expected.every((value, i) => Number(actual[i]) === value)
        : false;
}

function allFinite(values) {
    for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) return false;
    }
    return true;
}

function errorMessage(error) {
    return error && error.message ? error.message : String(error);
}

function failure(reason, message) {
    return { ok: false, reason, message };
}

function createEmbedder({
    modelPath,
    threads = 2,
    loadOrt = () => require('onnxruntime-node'),
    statSync = fs.statSync,
    readOrtVersion: readVersion = readOrtVersion
} = {}) {
    let ort = null;
    let session = null;
    let inputName = 'pixel_values';
    let loadedResult = null;
    let queue = Promise.resolve();

    function serial(task) {
        const run = queue.then(task, task);
        queue = run.catch(() => {});
        return run;
    }

    function tensorFor(rgb224) {
        return new ort.Tensor('float32', features().toNchw(rgb224), INPUT_DIMS.slice());
    }

    async function releaseSession() {
        const current = session;
        session = null;
        loadedResult = null;
        if (current && typeof current.release === 'function') {
            try { await current.release(); } catch { /* best effort: the process may be going away */ }
        }
    }

    async function selfTest() {
        let output;
        try {
            output = await session.run({ [inputName]: tensorFor(Buffer.alloc(INPUT_BYTES, 255)) });
        } catch (error) {
            return `self-test run failed: ${errorMessage(error)}`;
        }
        const hidden = output && output[OUTPUT_NAME];
        if (!hidden) return `self-test output has no ${OUTPUT_NAME}`;
        if (!sameDims(hidden.dims, SELF_TEST_DIMS)) {
            return `self-test dims [${Array.from(hidden.dims || [])}] instead of [${SELF_TEST_DIMS}]`;
        }
        if (!allFinite(hidden.data)) return 'self-test output is not finite';
        return null;
    }

    async function loadNow() {
        if (session && loadedResult) return loadedResult;
        let ortVersion;
        let embVersion;
        try {
            if (!ort) ort = loadOrt();
            ortVersion = String(readVersion());
            embVersion = embVersionFor(ortVersion);
        } catch (error) {
            ort = null;
            return failure('ort-unavailable', errorMessage(error));
        }

        let stat;
        try {
            if (!modelPath) throw new Error('no model path');
            stat = statSync(modelPath);
        } catch (error) {
            return failure('model-missing', `${modelPath || '(none)'}: ${errorMessage(error)}`);
        }
        if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
            return failure('model-missing', `${modelPath}: not a file`);
        }
        if (stat.size !== MODEL_BYTES) {
            return failure('model-size', `${modelPath}: ${stat.size} bytes, expected ${MODEL_BYTES}`);
        }

        try {
            // A fresh options object per create, so nothing ORT does to it can leak into the
            // frozen constant; only the thread count is configurable.
            session = await ort.InferenceSession.create(String(modelPath), {
                ...SESSION_OPTIONS,
                executionProviders: ['cpu'],
                intraOpNumThreads: threads
            });
        } catch (error) {
            session = null;
            return failure('session-failed', errorMessage(error));
        }
        inputName = (session.inputNames && session.inputNames[0]) || 'pixel_values';

        const problem = await selfTest();
        if (problem) {
            await releaseSession();
            return failure('self-test-failed', problem);
        }
        loadedResult = { ok: true, ortVersion, embVersion };
        return loadedResult;
    }

    async function embedNow(rgb224, mask = null) {
        if (!session) {
            const result = await loadNow();
            if (!result.ok) {
                const error = new Error(`embedder unavailable (${result.reason}): ${result.message}`);
                error.reason = result.reason;
                throw error;
            }
        }
        const output = await session.run({ [inputName]: tensorFor(rgb224) });
        const hidden = output && output[OUTPUT_NAME];
        if (!hidden) throw new Error(`model output has no ${OUTPUT_NAME}`);
        const dims = Array.from(hidden.dims || []);
        if (dims.length !== 3 || dims[0] !== 1 || dims[1] < 2 || dims[2] !== EMBEDDING_DIM) {
            throw new Error(`unexpected ${OUTPUT_NAME} dims [${dims}]`);
        }
        const vector = features().poolTokens(hidden.data, dims, mask);
        let sum = 0;
        for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
        if (vector.length !== EMBEDDING_DIM || !allFinite(vector) || Math.abs(Math.sqrt(sum) - 1) > 1e-3) {
            throw new Error('non-finite or degenerate embedding');
        }
        return vector;
    }

    return {
        // → {ok:true, ortVersion, embVersion} | {ok:false, reason, message}; never throws.
        load() {
            return serial(loadNow);
        },
        // rgb224: 224x224 RGB bytes (the decoder's rgb224) → unit Float32Array(384).
        // mask (optional): 256 patch flags (16x16, row-major); the mean then covers only those patches.
        // Loads lazily; throws on a run error (error.reason is set when the load failed).
        embed(rgb224, mask = null) {
            if (!rgb224 || rgb224.length !== INPUT_BYTES) {
                return Promise.reject(new TypeError(`embed expects ${INPUT_BYTES} RGB bytes, got ${rgb224 ? rgb224.length : rgb224}`));
            }
            return serial(() => embedNow(rgb224, mask));
        },
        release() {
            return serial(releaseSession);
        },
        // True only for a session that passed its self-test.
        get loaded() {
            return session !== null && loadedResult !== null;
        }
    };
}

module.exports = {
    createEmbedder,
    embVersionFor,
    readOrtVersion,
    MODEL_BYTES,
    SESSION_OPTIONS
};
