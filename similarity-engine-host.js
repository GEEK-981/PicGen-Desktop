'use strict';

// Host process for the similarity engine (v3.1 plan §2.10, WP7 host protocol).
//
// Electron starts it with utilityProcess.fork (serviceName "PicGen Similarity"); npm test starts it
// with child_process.fork({serialization:'advanced'}). The whole engine lives here — sharp decode,
// the ORT session, the feature store and the clustering — so killing this process at any moment is
// safe for the app, and a native crash in sharp or ORT only costs this process.
//
// main → host  {id, type:'init', storeDir, thumbnailsDir, scanDirs, modelPath, ort, threads,
//                   ortReason?, backfillDelayMs?, opts?}
//              {id, type:'records', full? | upserts?, removes?}
//              {id, type:'get', preset, foreground, since}
//              {id, type:'neighbors', key, preset, mode, limit, samePromptOnly}
//              {id, type:'neighbors-image', path, limit, match}   (以图搜图; match 'whole' | 'element'; nothing is stored)
//              {id, type:'override', op, key, groupId}
//              {type:'load', saving, onBattery, foreground}
//              {id, type:'status'}   {id, type:'close'}
// host → main  {id, ok:true, result} | {id, ok:false, error}
//              {type:'notice', revision, stage, mode, pending, analyzed, total, groupCount}   (≤ 2/s)
//              {type:'mode', mode, reason, ortVersion, featureVersion}
//              {type:'log', level, message, data}   {type:'fatal', message}
//
// PICGEN_SIMILARITY_ORT=off forces method H (reason 'disabled'). Test hooks exist only with
// PICGEN_SIMILARITY_TEST_HOOKS=1: {type:'__crash'} exits with code 3, {type:'__hang'} never replies.

const os = require('node:os');

const TEST_HOOKS = process.env.PICGEN_SIMILARITY_TEST_HOOKS === '1';
const ORT_OFF = process.env.PICGEN_SIMILARITY_ORT === 'off';
// A utilityProcess postMessage is queued, not flushed synchronously: give it a moment before exit.
const EXIT_FLUSH_MS = 50;

function errorMessage(error) {
    return error && error.message ? error.message : String(error);
}

function createTransport() {
    const parentPort = process.parentPort;
    if (parentPort && typeof parentPort.postMessage === 'function') {
        return {
            kind: 'utility',
            post(message) {
                parentPort.postMessage(message);
            },
            postThen(message, done) {
                try { parentPort.postMessage(message); } catch { /* the parent is gone */ }
                setTimeout(done, EXIT_FLUSH_MS);
            },
            listen(handler) {
                // Electron delivers {data, ports}.
                parentPort.on('message', event => handler(event && typeof event === 'object' && 'data' in event ? event.data : event));
            }
        };
    }
    if (typeof process.send === 'function') {
        return {
            kind: 'child',
            post(message) {
                if (process.connected) process.send(message);
            },
            postThen(message, done) {
                if (!process.connected) {
                    done();
                    return;
                }
                try {
                    process.send(message, () => done());
                } catch {
                    done();
                }
            },
            listen(handler) {
                process.on('message', handler);
                // The parent went away without a close: nothing is left to serve.
                process.on('disconnect', () => process.exit(0));
            }
        };
    }
    return null;
}

const transport = createTransport();

function post(message) {
    if (!transport) return;
    try {
        transport.post(message);
    } catch { /* the channel closed; the process is about to go */ }
}

function exitAfter(message, code) {
    if (!transport) process.exit(code);
    transport.postThen(message, () => process.exit(code));
}

function cloneable(data) {
    if (data === undefined || data === null) return null;
    try {
        return JSON.parse(JSON.stringify(data));
    } catch {
        return String(data);
    }
}

let fatalSent = false;
function fatal(error) {
    if (fatalSent) return;
    fatalSent = true;
    exitAfter({ type: 'fatal', message: errorMessage(error) }, 1);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

let engine = null;
let initPromise = null;
let simdEnabled = null;
let closed = false;
// Load hints can arrive before init; the latest values are applied when the engine exists.
let pendingLoad = {};

function setPriority(level) {
    try {
        const { PRIORITY_BELOW_NORMAL, PRIORITY_NORMAL } = os.constants.priority;
        os.setPriority(0, level === 'foreground' ? PRIORITY_NORMAL : PRIORITY_BELOW_NORMAL);
    } catch { /* best effort: some platforms and sandboxes refuse priority changes */ }
}

async function init(message) {
    if (initPromise) throw new Error('similarity host already initialised');
    const sharp = require('sharp');
    // A separate process: this never touches the sharp settings of main's preview workers.
    sharp.cache(false);
    // libvips' SIMD (highway) horizontal shrink crashes with 0xC0000005 inside an Electron utility
    // process when a row shrinks by >= 4x while the height does not shrink (e.g. an 8256x2048 PNG:
    // 256x64 -> 64x64 fill). The same call is fine in plain Node, so tests never saw it; users saw the
    // host crash-loop on that one image until similarity was disabled. Measured on 148 real images:
    // SIMD off gives byte-identical rgb64/rgb224 and the same speed, so stored rows stay valid.
    sharp.simd(false);
    simdEnabled = sharp.simd();
    const { createDecoder } = require('./similarityDecode');
    const { createEmbedder } = require('./similarityEmbedder');
    const { createSimilarityEngine } = require('./similarityEngine');
    const ort = message.ort !== false && !ORT_OFF;
    const embedder = ort
        ? createEmbedder({ modelPath: message.modelPath, threads: Number(message.threads) || 2 })
        : null;
    const extra = message.opts && typeof message.opts === 'object' ? message.opts : {};
    engine = createSimilarityEngine({
        storeDir: message.storeDir,
        thumbnailsDir: message.thumbnailsDir || '',
        scanDirs: Array.isArray(message.scanDirs) ? message.scanDirs.map(String) : [],
        decoder: createDecoder({ sharp }),
        embedder,
        log: entry => post({ type: 'log', level: entry.level, message: entry.message, data: cloneable(entry.data) }),
        onNotice: notice => post({ type: 'notice', ...notice }),
        onMode: info => post({ type: 'mode', ...info }),
        setPriority,
        opts: {
            ...extra,
            ort,
            ortReason: ORT_OFF ? 'disabled' : (message.ortReason || 'disabled'),
            backfillDelayMs: Math.max(0, Number(message.backfillDelayMs) || 0)
        }
    });
    engine.setLoad(pendingLoad);
    pendingLoad = {};
    initPromise = engine.init();
    return initPromise;
}

async function ready() {
    if (closed) throw new Error('similarity host closed');
    if (!initPromise) throw new Error('similarity engine not initialised');
    await initPromise;
    return engine;
}

function status() {
    const base = engine ? engine.status() : { initialised: false };
    return {
        ...base,
        pid: process.pid,
        simd: simdEnabled,
        rssMb: Math.round(process.memoryUsage().rss / 104857.6) / 10,
        transport: transport ? transport.kind : 'none'
    };
}

async function dispatch(message) {
    switch (message.type) {
        case 'init':
            return init(message);
        case 'records': {
            const target = await ready();
            return target.syncRecords(Array.isArray(message.full)
                ? { full: message.full }
                : { upserts: message.upserts || [], removes: message.removes || [] });
        }
        case 'get':
            return (await ready()).get({ preset: message.preset, foreground: Boolean(message.foreground), since: message.since });
        case 'neighbors':
            return (await ready()).neighbors({
                key: message.key,
                preset: message.preset,
                mode: message.mode,
                limit: message.limit,
                samePromptOnly: Boolean(message.samePromptOnly)
            });
        case 'neighbors-image':
            return (await ready()).neighborsOfImage({ path: message.path, limit: message.limit, match: message.match });
        case 'override':
            return (await ready()).override({ op: message.op, key: message.key, groupId: message.groupId, preset: message.preset });
        case 'status':
            return status();
        default:
            throw new Error(`unknown similarity host message ${message.type}`);
    }
}

async function close(id) {
    closed = true;
    try {
        if (initPromise) await initPromise.catch(() => {});
        if (engine) await engine.close();
        exitAfter({ id, ok: true, result: { closed: true } }, 0);
    } catch (error) {
        exitAfter({ id, ok: false, error: errorMessage(error) }, 0);
    }
}

function handle(message) {
    if (!message || typeof message !== 'object') return;
    const { id, type } = message;
    if (TEST_HOOKS) {
        if (type === '__crash') process.exit(3);
        if (type === '__hang') return;
    }
    if (type === 'load') {
        const load = { saving: message.saving, onBattery: message.onBattery, foreground: message.foreground };
        if (engine && !closed) engine.setLoad(load);
        else if (!engine) {
            for (const [name, value] of Object.entries(load)) if (value !== undefined && value !== null) pendingLoad[name] = value;
        }
        return;
    }
    if (id === undefined || id === null) return;
    if (type === 'close') {
        void close(id);
        return;
    }
    Promise.resolve()
        .then(() => dispatch(message))
        .then(result => post({ id, ok: true, result }), error => post({ id, ok: false, error: errorMessage(error) }));
}

if (!transport) {
    process.stderr.write('similarity-engine-host.js must be started by utilityProcess.fork or child_process.fork\n');
    process.exit(1);
}
transport.listen(handle);
