'use strict';

// Main-side similarity service (v3.1 plan §2.10, §2.11; WP8). Replaces similarityIndex.js.
//
// It owns the "PicGen Similarity" host (similarity-engine-host.js) from main and does no pixel or
// ORT work itself, so every call returns quickly:
//   - get() asks the host within a short soft deadline, else serves the cached snapshot of that
//     preset, else prompt + session batches from provisionalBatches (`provisional:true`);
//   - neighbors() falls back to same-prompt results (`analyzed:false`) while the host is down;
//   - syncRecords() is synchronous. The first sync after a host (re)start is full, later ones send
//     only the diff keyed by historyKey. Records sharing a key travel together; the host resolves them.
//
// Crash policy (§2.10): a request timeout (10 s; 60 s for init, which loads the model) kills the
// host; any exit close() did not ask for is a crash. A UtilityProcess 'error' event (Electron emits
// it on fatal V8 errors, before the exit) is only recorded: the exit that follows drives the restart. In-flight requests are rejected and the host restarts after 1 / 5 / 30 s. More than 3
// restarts in 10 min degrade the service for the rest of the session: the last snapshot (or the
// provisional batches) is served with `error` set. After 2 crashes within 10 min in hd the next
// start passes ort:false (reason 'unstable'); once the session is in h it never goes back to hd.
//
// Revisions: a restarted host counts from 1 again, so the service serves its own strictly
// increasing revision, one per distinct (host generation, host revision, overlay) state. The
// overlay is what main adds on top of a host snapshot: the service error and the mode.

const crypto = require('node:crypto');
const { normalizePrompt, provisionalBatches } = require('./similarityPrompt');
const { HD, H } = require('./similarityDistance');
const userExperience = require('./userExperience');

const PRESET_NAMES = Object.freeze(['strict', 'standard', 'loose']);
const OVERRIDE_OPS = Object.freeze(['setCover', 'detach', 'reset']);
const SOFT_TIMEOUT = Symbol('soft-timeout');

const SERVICE = Object.freeze({
    requestMs: 10000,
    initMs: 60000,            // init loads the ONNX model: a cold start may take far longer than a request
    errorReportMax: 4000,     // characters of a UtilityProcess 'error' report kept in the log
    getMs: 200,               // a get never waits longer than this for the host
    closeMs: 2000,
    backoffMs: Object.freeze([1000, 5000, 30000]),
    restartWindowMs: 10 * 60 * 1000,
    maxRestarts: 3,
    hdCrashLimit: 2,
    backfillDelayMs: 20000,   // backfill starts this long after the service is created (≈ app ready)
    foregroundMs: 60000,      // a new host inherits a foreground hint this recent
    threads: 2,
    outputLinesPerMinute: 200,
    outputLineMax: 2000,
    neighborLimit: 60,
    revisionMemory: 32
});

const EMPTY_STATS = Object.freeze({
    decoded: 0,
    reused: 0,
    embedded: 0,
    validated: 0,
    cacheHits: 0,
    groupRuns: 0,
    lastClusterMs: 0,
    edgeCount: 0,
    capHits: 0
});

const MODE_FALLBACK_TITLE = '视觉模型未加载，已改用基础相似度';
const DEGRADED_TITLE = '相似分析进程多次异常退出，本次运行已停用';

// userExperience.historyKey is the one definition (WP9); the fallback has the same semantics.
const historyKey = typeof userExperience.historyKey === 'function'
    ? userExperience.historyKey
    : record => String(record?.id || record?.filePath || record?.fileName || '');

// Timers stay referenced: close() clears every one of them, and its 2 s cap must fire even when
// nothing else keeps the event loop alive.
function realClock() {
    return {
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: timer => clearTimeout(timer)
    };
}

function errorMessage(error) {
    return error && error.message ? error.message : String(error);
}

function compareStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function normalisePreset(preset) {
    return PRESET_NAMES.includes(preset) ? preset : 'standard';
}

function anchorId(key) {
    return 'sg_' + crypto.createHash('sha1').update(String(key), 'utf8').digest('hex').slice(0, 12);
}

function timeOf(rec) {
    return rec.createdAt > 0 ? rec.createdAt : 0;
}

// Newest first: createdAt descending, then key descending (the engine's order).
function newestFirst(a, b) {
    return timeOf(b.rec) - timeOf(a.rec) || compareStrings(b.key, a.key);
}

// The fields the host needs (host protocol `rec`). An absent fileName stays '' so the host derives
// it exactly as it does for its own records.
function recordFields(record) {
    return {
        filePath: typeof record.filePath === 'string' ? record.filePath : String(record.filePath || ''),
        fileName: typeof record.fileName === 'string' ? record.fileName : '',
        fileSize: Number(record.fileSize) || 0,
        createdAt: Number(record.createdAt) || 0,
        prompt: typeof record.prompt === 'string' ? record.prompt : (record.prompt ? String(record.prompt) : ''),
        ratio: typeof record.ratio === 'string' ? record.ratio : ''
    };
}

// The change signature is filePath | fileSize | createdAt | prompt (plus fileName and ratio, which
// the host also reads). The fields are compared directly: exact, and no hashing on main.
function sameFields(rec, record) {
    return rec.filePath === (typeof record.filePath === 'string' ? record.filePath : String(record.filePath || ''))
        && rec.fileSize === (Number(record.fileSize) || 0)
        && rec.createdAt === (Number(record.createdAt) || 0)
        && rec.prompt === (typeof record.prompt === 'string' ? record.prompt : (record.prompt ? String(record.prompt) : ''))
        && rec.fileName === (typeof record.fileName === 'string' ? record.fileName : '')
        && rec.ratio === (typeof record.ratio === 'string' ? record.ratio : '');
}

function sameRecs(a, b) {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function pruneWindow(times, now, windowMs) {
    while (times.length && now - times[0] > windowMs) times.shift();
}

function createSimilarityService({
    hostPath,
    spawnHost,
    storeDir,
    thumbnailsDir = '',
    scanDirs = [],
    modelPath = '',
    ortEnabled = true,
    onPush,
    log,
    recordError,
    now: nowOption,
    clock: clockOption,
    console: out = console,
    backfillAt,
    timeouts = {}
} = {}) {
    if (typeof spawnHost !== 'function') throw new TypeError('createSimilarityService needs spawnHost(args)');
    if (!storeDir) throw new TypeError('createSimilarityService needs a storeDir');
    const clock = clockOption || { ...realClock(), ...(typeof nowOption === 'function' ? { now: nowOption } : {}) };
    const o = { ...SERVICE, ...(timeouts || {}) };
    const now = () => clock.now();
    const backfillStartsAt = Number.isFinite(Number(backfillAt)) && backfillAt !== null
        ? Number(backfillAt)
        : now() + o.backfillDelayMs;

    // --- state -----------------------------------------------------------------------------------------
    let closed = false;
    let closing = null;
    let host = null;             // the current host record, see spawn()
    let generation = 0;
    let nextId = 0;
    let restartTimer = null;
    let degraded = false;
    let serviceError = null;
    let totalCrashes = 0;
    const crashTimes = [];       // crashes (exits, timeouts, failed starts) in the last 10 min
    const hdCrashTimes = [];     // ... of hosts that were asked for hd and never reported h
    let forcedH = null;          // {reason}: the session is in h for good
    let modeLogged = false;
    let lastForegroundAt = -Infinity;
    const load = { saving: 0, onBattery: false };

    let mode = ortEnabled ? 'hd' : 'h';
    let modeReason = ortEnabled ? null : 'disabled';
    let ortVersion = null;
    let featureVersion = null;
    let progress = { stage: 'provisional', pending: 0, analyzed: 0, total: 0, groupCount: 0 };

    let entries = new Map();     // historyKey -> {recs:[rec], np?:string}
    let totalRecords = 0;
    let recordsVersion = 0;

    const cache = new Map();     // preset -> {gen, hostRev, snapshot, reconciled?}
    let fallbackCore = null;     // {version, groups, singles, missing, pending, total}
    let anchorIds = new Map();   // historyKey -> 'sg_…' (one sha1 per provisional group adds up at 20k)
    let servedOnce = false;      // no push is worth sending before someone holds a revision

    let maxRevision = 0;
    let overlayVersion = 0;
    const revisions = new Map(); // state key -> service revision (the most recent few)

    // --- small helpers ---------------------------------------------------------------------------------

    function report(level, message, data) {
        if (typeof log !== 'function') {
            if (level === 'error' || level === 'warn') {
                try { out[level === 'error' ? 'error' : 'warn'](`[similarity] ${message}`, data === undefined ? '' : data); } catch { /* never */ }
            }
            return;
        }
        try {
            Promise.resolve(log({ level, message, data })).catch(() => {});
        } catch { /* logging never breaks the service */ }
    }

    function recordErrorOnce(entry) {
        if (typeof recordError !== 'function') return;
        try {
            Promise.resolve(recordError(entry)).catch(() => {});
        } catch { /* the error log is best effort */ }
    }

    function setTimer(fn, ms) {
        return clock.setTimeout(() => {
            try {
                fn();
            } catch (error) {
                report('error', 'similarity service timer failed', { message: errorMessage(error) });
            }
        }, Math.max(0, ms));
    }

    function clearTimer(timer) {
        if (timer !== null && timer !== undefined) clock.clearTimeout(timer);
        return null;
    }

    function push(summary) {
        if (closed || typeof onPush !== 'function') return;
        try {
            onPush(summary);
        } catch (error) {
            report('warn', 'similarity push failed', { message: errorMessage(error) });
        }
    }

    function expectedMode() {
        if (!ortEnabled) return { mode: 'h', modeReason: 'disabled' };
        if (forcedH) return { mode: 'h', modeReason: forcedH.reason };
        return { mode: 'hd', modeReason: null };
    }

    // --- revisions ---------------------------------------------------------------------------------------

    function revisionFor(stateKey) {
        const key = `${stateKey}#${overlayVersion}`;
        let revision = revisions.get(key);
        if (revision === undefined) {
            revision = ++maxRevision;
            revisions.set(key, revision);
            if (revisions.size > o.revisionMemory) revisions.delete(revisions.keys().next().value);
        }
        return revision;
    }

    function bumpOverlay() {
        overlayVersion++;
        if (!servedOnce || closed || typeof onPush !== 'function') return;
        push(summaryOf(serveLocal('standard')));
    }

    function setServiceError(message) {
        const next = message || null;
        if (next === serviceError) return;
        serviceError = next;
        bumpOverlay();
    }

    function summaryOf(snapshot) {
        return {
            revision: snapshot.revision,
            stage: snapshot.stage,
            mode: snapshot.mode,
            pending: snapshot.pending,
            analyzed: snapshot.analyzed,
            total: snapshot.total,
            groupCount: Array.isArray(snapshot.groups) ? snapshot.groups.length : 0
        };
    }

    // --- mode ---------------------------------------------------------------------------------------------

    function applyMode(rec, info) {
        if (!info || typeof info !== 'object') return;
        const nextMode = info.mode === 'hd' ? 'hd' : 'h';
        const reason = nextMode === 'hd' ? null : String(info.modeReason || info.reason || 'disabled');
        if (rec) rec.mode = nextMode;
        const changed = nextMode !== mode || reason !== modeReason
            || (info.featureVersion !== undefined && info.featureVersion !== featureVersion);
        mode = nextMode;
        modeReason = reason;
        if (info.ortVersion !== undefined) ortVersion = info.ortVersion || null;
        if (info.featureVersion !== undefined) featureVersion = info.featureVersion || null;
        if (nextMode === 'h' && ortEnabled && !forcedH) forcedH = { reason };
        if (nextMode === 'h' && reason !== 'disabled' && !modeLogged) {
            modeLogged = true;
            recordErrorOnce({
                source: 'similarity',
                title: MODE_FALLBACK_TITLE,
                message: `相似图片改用基础模式（原因：${reason}）。下次启动会再尝试加载视觉模型。`,
                operation: 'similarity-mode',
                details: { reason, ortVersion }
            });
        }
        if (changed) bumpOverlay();
    }

    // --- records --------------------------------------------------------------------------------------------

    function syncRecords(records) {
        if (closed) return { changed: 0, upserts: 0, removes: 0, total: totalRecords };
        const list = Array.isArray(records) ? records : [];
        const slots = new Map(); // key -> {recs, changed, prev}
        let total = 0;
        for (const record of list) {
            if (!record || typeof record !== 'object' || !record.filePath) continue;
            const key = historyKey(record);
            if (!key) continue;
            total++;
            let slot = slots.get(key);
            if (!slot) {
                slot = { recs: [], changed: false, prev: entries.get(key) || null };
                slots.set(key, slot);
            }
            const old = slot.prev ? slot.prev.recs[slot.recs.length] : undefined;
            if (old && sameFields(old, record)) {
                slot.recs.push(old);
            } else {
                slot.recs.push({ key, ...recordFields(record) });
                slot.changed = true;
            }
        }
        const next = new Map();
        const upserts = [];
        let upsertKeys = 0;
        for (const [key, slot] of slots) {
            if (!slot.changed && slot.prev && sameRecs(slot.prev.recs, slot.recs)) {
                next.set(key, slot.prev);
                continue;
            }
            next.set(key, { recs: slot.recs });
            upsertKeys++;
            for (const rec of slot.recs) upserts.push(rec);
        }
        const removes = [];
        for (const key of entries.keys()) if (!next.has(key)) removes.push(key);
        entries = next;
        totalRecords = total;
        const changed = upsertKeys + removes.length;
        if (changed) {
            recordsVersion++;
            fallbackCore = null;
        }
        ensureStarted();
        const rec = host;
        if (changed && rec && rec.ready && rec.fullSent && !rec.gone) {
            request(rec, { type: 'records', upserts, removes })
                .catch(error => report('warn', 'similarity record sync failed', { message: errorMessage(error) }));
        }
        return { changed, upserts: upsertKeys, removes: removes.length, total };
    }

    function allRecs() {
        const out = [];
        for (const entry of entries.values()) for (const rec of entry.recs) out.push(rec);
        return out;
    }

    function npOf(entry) {
        if (entry.np === undefined) entry.np = normalizePrompt(entry.recs[0].prompt);
        return entry.np;
    }

    // --- host lifecycle -----------------------------------------------------------------------------------

    function ensureStarted() {
        if (closed || degraded || host || restartTimer !== null) return;
        spawn();
    }

    function spawn() {
        restartTimer = null;
        if (closed || degraded || host) return;
        const gen = ++generation;
        const wanted = expectedMode();
        const ort = wanted.mode === 'hd';
        let handle;
        try {
            handle = spawnHost({ hostPath, serviceName: 'PicGen Similarity', generation: gen });
            if (!handle || typeof handle.postMessage !== 'function' || typeof handle.on !== 'function') {
                throw new TypeError('spawnHost must return {postMessage, on, kill}');
            }
        } catch (error) {
            report('error', 'similarity host could not start', { message: errorMessage(error) });
            // A failed fork says nothing about ORT: it counts as a restart, never toward 'unstable'.
            noteCrash({ ortRequested: false, mode: null }, error);
            return;
        }
        const rec = {
            handle,
            gen,
            pending: new Map(),
            ready: false,
            fullSent: false,
            gone: false,
            exited: false,
            closing: false,
            ortRequested: ort,
            mode: null,
            fatal: null,
            detachers: [],
            exitWaiters: []
        };
        host = rec;
        const onMessage = message => handleMessage(rec, message);
        const onExit = code => handleExit(rec, code);
        // An 'error' with no listener throws ERR_UNHANDLED_ERROR in main and takes the app down.
        const onError = (type, location, errorReport) => handleHostError(rec, type, location, errorReport);
        handle.on('message', onMessage);
        handle.on('exit', onExit);
        handle.on('error', onError);
        rec.detachers.push(() => {
            removeListener(handle, 'message', onMessage);
            removeListener(handle, 'exit', onExit);
            if (rec.exited) {
                removeListener(handle, 'error', onError);
                return;
            }
            // A host ended before its exit (a kill) may still emit 'error': keep the guard until it exits.
            const dropGuard = () => {
                removeListener(handle, 'error', onError);
                removeListener(handle, 'exit', dropGuard);
            };
            try { handle.on('exit', dropGuard); } catch { removeListener(handle, 'error', onError); }
        });
        attachOutput(rec, handle.stdout, 'log');
        attachOutput(rec, handle.stderr, 'warn');

        // The host buffers load hints until init.
        const hint = { type: 'load', saving: load.saving, onBattery: load.onBattery };
        if (now() - lastForegroundAt < o.foregroundMs) hint.foreground = true;
        post(rec, hint);

        Promise.resolve(typeof scanDirs === 'function' ? scanDirs() : scanDirs)
            .catch(error => {
                report('warn', 'similarity scan directories unavailable', { message: errorMessage(error) });
                return [];
            })
            .then(dirs => {
                if (rec.gone) return undefined;
                return request(rec, {
                    type: 'init',
                    storeDir,
                    thumbnailsDir,
                    scanDirs: Array.isArray(dirs) ? dirs.map(String) : [],
                    modelPath,
                    ort,
                    threads: o.threads,
                    ortReason: ort ? undefined : wanted.modeReason,
                    backfillDelayMs: Math.max(0, backfillStartsAt - now())
                }, o.initMs).then(info => onReady(rec, info));
            })
            .catch(error => {
                if (rec.gone) return;
                // A host whose engine failed to initialise can serve nothing: replace it.
                hostGone(rec, new Error(`similarity host failed to initialise: ${errorMessage(error)}`), { crash: true, kill: true });
            });
    }

    function removeListener(emitter, event, listener) {
        try {
            if (typeof emitter.off === 'function') emitter.off(event, listener);
            else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, listener);
        } catch { /* a dead handle */ }
    }

    function onReady(rec, info) {
        if (rec.gone || host !== rec) return;
        rec.ready = true;
        applyMode(rec, info);
        rec.fullSent = true;
        request(rec, { type: 'records', full: allRecs() })
            .catch(error => report('warn', 'similarity record sync failed', { message: errorMessage(error) }));
        setServiceError(null);
    }

    function post(rec, message) {
        if (rec.gone) return false;
        try {
            rec.handle.postMessage(message);
            return true;
        } catch (error) {
            hostGone(rec, new Error(`similarity host channel failed: ${errorMessage(error)}`), { crash: true, kill: true });
            return false;
        }
    }

    function request(rec, message, timeoutMs = o.requestMs) {
        return new Promise((resolve, reject) => {
            if (rec.gone) {
                reject(new Error('similarity host is not running'));
                return;
            }
            const id = ++nextId;
            const entry = { resolve, reject, timer: null };
            entry.timer = setTimer(() => {
                entry.timer = null;
                hostGone(rec, new Error(`similarity host did not answer ${message.type} within ${timeoutMs} ms`), { crash: true, kill: true });
            }, timeoutMs);
            rec.pending.set(id, entry);
            post(rec, { id, ...message });
        });
    }

    function handleMessage(rec, message) {
        if (rec.gone || !message || typeof message !== 'object') return;
        if (message.id !== undefined && message.id !== null && typeof message.ok === 'boolean') {
            const entry = rec.pending.get(message.id);
            if (!entry) return;
            rec.pending.delete(message.id);
            entry.timer = clearTimer(entry.timer);
            if (message.ok) entry.resolve(message.result);
            else entry.reject(new Error(String(message.error || 'similarity host error')));
            return;
        }
        switch (message.type) {
            case 'notice':
                onNotice(rec, message);
                break;
            case 'mode':
                applyMode(rec, message);
                break;
            case 'log':
                report(typeof message.level === 'string' ? message.level : 'info', String(message.message || ''), message.data);
                break;
            case 'fatal':
                rec.fatal = String(message.message || '');
                report('error', 'similarity host fatal error', { message: rec.fatal });
                break;
            default:
        }
    }

    // UtilityProcess 'error' (type, location, report). Recorded only; the exit that follows is the crash.
    function handleHostError(rec, type, location, errorReport) {
        const kind = String(type || 'error');
        const where = location ? String(location) : '';
        // The host's own fatal message, when it managed to send one, says more than the event type.
        if (!rec.gone && !rec.fatal) rec.fatal = where ? `${kind} at ${where}` : kind;
        const text = errorReport ? String(errorReport) : '';
        report('error', 'similarity host fatal error', {
            type: kind,
            location: where,
            report: text.length > o.errorReportMax ? `${text.slice(0, o.errorReportMax)}…` : text,
            generation: rec.gen
        });
    }

    function handleExit(rec, code) {
        rec.exited = true;
        if (rec.closing || closed) {
            for (const resolve of rec.exitWaiters.splice(0)) resolve();
            hostGone(rec, new Error('similarity service closed'), { crash: false });
            return;
        }
        const detail = rec.fatal ? `: ${rec.fatal}` : '';
        hostGone(rec, new Error(`similarity host exited with code ${code}${detail}`), { crash: true });
    }

    // Everything that ends a host goes through here exactly once: listeners off, requests rejected,
    // then (for a crash) the restart policy.
    function hostGone(rec, error, { crash, kill = false }) {
        if (rec.gone) return;
        rec.gone = true;
        rec.ready = false;
        for (const detach of rec.detachers.splice(0)) detach();
        if (kill && !rec.exited) {
            try { rec.handle.kill(); } catch { /* already gone */ }
        }
        for (const entry of rec.pending.values()) {
            entry.timer = clearTimer(entry.timer);
            entry.reject(error);
        }
        rec.pending.clear();
        for (const resolve of rec.exitWaiters.splice(0)) resolve();
        if (host === rec) host = null;
        if (crash && !closed) {
            report('warn', 'similarity host exited', { message: errorMessage(error), generation: rec.gen });
            noteCrash(rec, error);
        }
    }

    function noteCrash(rec, error) {
        const at = now();
        totalCrashes++;
        pruneWindow(crashTimes, at, o.restartWindowMs);
        crashTimes.push(at);
        if (rec.ortRequested && rec.mode !== 'h') {
            pruneWindow(hdCrashTimes, at, o.restartWindowMs);
            hdCrashTimes.push(at);
            if (hdCrashTimes.length >= o.hdCrashLimit && !forcedH) {
                forcedH = { reason: 'unstable' };
                report('warn', 'similarity host crashed repeatedly in hd; restarting in h', { crashes: hdCrashTimes.length });
            }
        }
        if (crashTimes.length > o.maxRestarts) {
            degrade(error);
            return;
        }
        const delay = o.backoffMs[Math.min(crashTimes.length, o.backoffMs.length) - 1];
        restartTimer = clearTimer(restartTimer);
        restartTimer = setTimer(spawn, delay);
        setServiceError(`相似分析进程异常退出，正在重启（${errorMessage(error)}）`);
    }

    function degrade(error) {
        degraded = true;
        restartTimer = clearTimer(restartTimer);
        const message = `相似分析已停用：分析进程在 10 分钟内异常退出 ${crashTimes.length} 次（${errorMessage(error)}）`;
        report('error', 'similarity service degraded', { message: errorMessage(error), crashes: crashTimes.length });
        recordErrorOnce({
            source: 'similarity',
            title: DEGRADED_TITLE,
            message: `${message}。本次运行按提示词分组，重启 PicGen 后会再尝试。`,
            operation: 'similarity-host',
            details: { crashes: crashTimes.length, lastError: errorMessage(error) }
        });
        setServiceError(message);
    }

    // --- output ---------------------------------------------------------------------------------------------

    let outputWindowAt = -Infinity;
    let outputLines = 0;
    let outputSuppressed = 0;

    function emitOutput(level, line) {
        if (!line) return;
        const at = now();
        if (at - outputWindowAt >= 60000) {
            if (outputSuppressed > 0) {
                try { out.warn(`[similarity] ${outputSuppressed} lines suppressed`); } catch { /* never */ }
            }
            outputWindowAt = at;
            outputLines = 0;
            outputSuppressed = 0;
        }
        if (outputLines >= o.outputLinesPerMinute) {
            outputSuppressed++;
            return;
        }
        outputLines++;
        try { out[level](`[similarity] ${line}`); } catch { /* never */ }
    }

    // A piped stream must always be read, or a chatty host would block on a full pipe.
    function attachOutput(rec, stream, level) {
        if (!stream || typeof stream.on !== 'function') return;
        if (typeof stream.setEncoding === 'function') {
            try { stream.setEncoding('utf8'); } catch { /* not a byte stream */ }
        }
        let buffer = '';
        const onData = chunk => {
            buffer += String(chunk);
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
                emitOutput(level, buffer.slice(0, index).replace(/\r$/, ''));
                buffer = buffer.slice(index + 1);
            }
            if (buffer.length > o.outputLineMax) {
                emitOutput(level, buffer.slice(0, o.outputLineMax));
                buffer = '';
            }
        };
        stream.on('data', onData);
        rec.detachers.push(() => {
            removeListener(stream, 'data', onData);
            if (buffer) emitOutput(level, buffer.replace(/\r$/, ''));
            buffer = '';
            // Keep draining until the pipe closes; nothing reads it any more.
            if (typeof stream.resume === 'function') {
                try { stream.resume(); } catch { /* closed */ }
            }
        });
    }

    // --- notices --------------------------------------------------------------------------------------------

    function onNotice(rec, notice) {
        const hostRev = Number(notice.revision);
        if (!Number.isFinite(hostRev)) return;
        progress = {
            stage: notice.stage || progress.stage,
            pending: Number(notice.pending) || 0,
            analyzed: Number(notice.analyzed) || 0,
            total: Number(notice.total) || 0,
            groupCount: Number(notice.groupCount) || 0
        };
        push({
            revision: revisionFor(`host:${rec.gen}:${hostRev}`),
            stage: progress.stage,
            mode: notice.mode === 'hd' || notice.mode === 'h' ? notice.mode : mode,
            pending: progress.pending,
            analyzed: progress.analyzed,
            total: progress.total,
            groupCount: progress.groupCount
        });
    }

    // --- snapshots ---------------------------------------------------------------------------------------------

    function thresholdsFor(name) {
        return { ...(name === 'hd' ? HD : H).PRESETS };
    }

    function decorate(snapshot, revision) {
        return { ...snapshot, revision, error: serviceError || snapshot.error || null };
    }

    function hostIsCurrent(entry) {
        return Boolean(host && host.ready && host.gen === entry.gen);
    }

    // Serves a cached host snapshot. While that host is not serving, the snapshot is reconciled with
    // the current records: departed keys leave their groups, new keys show up as singles.
    function serveEntry(entry) {
        if (hostIsCurrent(entry)) {
            return decorate(entry.snapshot, revisionFor(`host:${entry.gen}:${entry.hostRev}`));
        }
        return decorate(reconciled(entry), revisionFor(`host:${entry.gen}:${entry.hostRev}:r${recordsVersion}`));
    }

    function reconciled(entry) {
        if (entry.reconciled && entry.reconciled.version === recordsVersion) return entry.reconciled.snapshot;
        const snapshot = entry.snapshot;
        const groups = [];
        const released = [];
        const known = new Set();
        for (const group of snapshot.groups || []) {
            const members = [];
            for (const key of group.members || []) {
                known.add(key);
                if (entries.has(key)) members.push(key);
            }
            if (members.length === (group.members || []).length) {
                groups.push(group);
            } else if (members.length >= 2) {
                const present = new Set(members);
                groups.push({
                    ...group,
                    members,
                    pinned: present.has(group.pinned) ? group.pinned : null,
                    parts: null,
                    rest: [],
                    failed: (group.failed || []).filter(key => present.has(key))
                });
            } else {
                released.push(...members);
            }
        }
        const singles = new Set();
        for (const key of snapshot.singles || []) {
            known.add(key);
            if (entries.has(key)) singles.add(key);
        }
        for (const key of released) singles.add(key);
        for (const key of entries.keys()) if (!known.has(key)) singles.add(key);
        const orderedSingles = [...singles]
            .map(key => ({ key, rec: entries.get(key).recs[0] }))
            .sort(newestFirst)
            .map(item => item.key);
        let grouped = 0;
        for (const group of groups) grouped += group.members.length;
        const result = {
            ...snapshot,
            groups,
            singles: orderedSingles,
            total: totalRecords,
            missing: Math.max(0, totalRecords - grouped - orderedSingles.length)
        };
        entry.reconciled = { version: recordsVersion, snapshot: result };
        return result;
    }

    function provisionalCore() {
        if (fallbackCore && fallbackCore.version === recordsVersion) return fallbackCore;
        const items = [];
        const byKey = new Map();
        for (const [key, entry] of entries) {
            const item = { key, rec: entry.recs[0], np: npOf(entry) };
            items.push(item);
            byKey.set(key, item);
        }
        const batches = provisionalBatches(items, {
            keyOf: item => item.key,
            npOf: item => item.np,
            timeOf: item => (item.rec.createdAt > 0 ? item.rec.createdAt : Number.NaN)
        });
        const inGroup = new Set();
        const anchors = new Map();
        const groups = batches.map(keys => {
            const id = anchorIds.get(keys[0]) || anchorId(keys[0]);
            anchors.set(keys[0], id);
            const members = keys.map(key => byKey.get(key)).sort(newestFirst);
            const ratios = [];
            let latestAt = 0;
            for (const item of members) {
                inGroup.add(item.key);
                latestAt = Math.max(latestAt, timeOf(item.rec));
                if (item.rec.ratio && !ratios.includes(item.rec.ratio)) ratios.push(item.rec.ratio);
            }
            return {
                id,
                members: members.map(item => item.key),
                pinned: null,
                latestAt,
                promptVariants: 1,
                ratios,
                provisional: true,
                parts: null,
                rest: [],
                failed: []
            };
        }).sort((a, b) => b.latestAt - a.latestAt || compareStrings(a.id, b.id));
        anchorIds = anchors;
        const singles = items.filter(item => !inGroup.has(item.key)).sort(newestFirst).map(item => item.key);
        fallbackCore = {
            version: recordsVersion,
            groups,
            singles,
            total: totalRecords,
            missing: Math.max(0, totalRecords - items.length),
            pending: items.length
        };
        return fallbackCore;
    }

    function serveProvisional(preset) {
        const core = provisionalCore();
        return {
            version: 3,
            revision: revisionFor(`provisional:${core.version}`),
            mode,
            modeReason: mode === 'hd' ? null : modeReason,
            featureVersion,
            preset,
            thresholds: thresholdsFor(mode),
            stage: 'provisional',
            groups: core.groups,
            singles: core.singles,
            missing: core.missing,
            failed: 0,
            pending: core.pending,
            analyzed: 0,
            total: core.total,
            stats: { ...EMPTY_STATS },
            error: serviceError
        };
    }

    // Without asking the host: the cached snapshot of this preset, else the provisional batches.
    function serveLocal(preset) {
        const entry = cache.get(preset);
        return entry ? serveEntry(entry) : serveProvisional(preset);
    }

    function storeReply(rec, preset, result, cached) {
        if (!result || typeof result !== 'object') return null;
        if (result.notModified) return cached && cached.gen === rec.gen ? cached : null;
        const hostRev = Number(result.revision);
        if (!Number.isFinite(hostRev)) return null;
        const entry = { gen: rec.gen, hostRev, snapshot: result, reconciled: null };
        const current = cache.get(preset);
        if (!current || current.gen < entry.gen || (current.gen === entry.gen && current.hostRev <= entry.hostRev)) {
            cache.set(preset, entry);
            return entry;
        }
        return current;
    }

    function withSoftDeadline(promise, ms) {
        let timer = null;
        const deadline = new Promise(resolve => {
            timer = setTimer(() => {
                timer = null;
                resolve(SOFT_TIMEOUT);
            }, ms);
        });
        return Promise.race([promise, deadline]).finally(() => {
            timer = clearTimer(timer);
        });
    }

    async function fromHost(rec, preset, foreground) {
        const cached = cache.get(preset);
        const since = cached && cached.gen === rec.gen ? cached.hostRev : undefined;
        const reply = request(rec, { type: 'get', preset, foreground, since })
            .then(result => storeReply(rec, preset, result, cached), error => {
                report('warn', 'similarity get failed', { message: errorMessage(error) });
                return null;
            });
        const winner = await withSoftDeadline(reply, o.getMs);
        if (winner !== SOFT_TIMEOUT) return winner ? serveEntry(winner) : null;
        const served = serveLocal(preset);
        // The renderer holds an older revision now: tell it once the host's answer is in.
        void reply.then(entry => {
            if (!entry || closed) return;
            const fresh = serveEntry(entry);
            if (fresh.revision !== served.revision) push(summaryOf(fresh));
        });
        return served;
    }

    async function get(options = {}) {
        const preset = normalisePreset(options && options.preset);
        const foreground = Boolean(options && options.foreground);
        const since = options ? options.since : undefined;
        if (foreground) lastForegroundAt = now();
        ensureStarted();
        const rec = host;
        let served = null;
        if (rec && rec.ready && !closed) served = await fromHost(rec, preset, foreground);
        else if (rec && foreground) post(rec, { type: 'load', foreground: true });
        if (!served) served = serveLocal(preset);
        servedOnce = true;
        if (since !== undefined && since !== null && Number(since) === served.revision) {
            return { notModified: true, revision: served.revision };
        }
        return served;
    }

    // --- neighbours and overrides --------------------------------------------------------------------------------

    function samePromptNeighbors(query) {
        const entry = entries.get(query.key);
        const cap = query.limit;
        if (!entry || cap === 0) return { items: [], analyzed: false, mode };
        const np = npOf(entry);
        if (!np) return { items: [], analyzed: false, mode };
        const snapshot = serveLocal(query.preset);
        const groupOf = new Map();
        snapshot.groups.forEach((group, index) => { for (const key of group.members) groupOf.set(key, index); });
        const own = groupOf.get(query.key);
        const matches = [];
        for (const [key, other] of entries) {
            if (key === query.key || npOf(other) !== np) continue;
            matches.push({ key, rec: other.recs[0] });
        }
        matches.sort(newestFirst);
        return {
            items: matches.slice(0, cap).map(item => ({
                key: item.key,
                similarity: null,
                samePrompt: true,
                nearPrompt: false,
                sameGroup: own !== undefined && groupOf.get(item.key) === own
            })),
            analyzed: false,
            mode
        };
    }

    async function neighbors(input) {
        const q = input && typeof input === 'object' ? input : {};
        const limit = q.limit === undefined || q.limit === null || Number.isNaN(Number(q.limit))
            ? o.neighborLimit
            : Math.max(0, Math.floor(Number(q.limit)));
        const query = {
            key: q.key === undefined || q.key === null ? '' : String(q.key),
            preset: normalisePreset(q.preset),
            mode: q.mode === 'visual' ? 'visual' : 'combined',
            limit,
            samePromptOnly: Boolean(q.samePromptOnly)
        };
        ensureStarted();
        const rec = host;
        if (rec && rec.ready && !closed) {
            try {
                const result = await request(rec, { type: 'neighbors', ...query });
                if (result && Array.isArray(result.items)) return result;
            } catch (error) {
                report('warn', 'similarity neighbours failed', { message: errorMessage(error) });
            }
        }
        return samePromptNeighbors(query);
    }

    // 以图搜图. No fallback: with the host down there is nothing to compare the image against.
    async function neighborsOfImage(input) {
        const q = input && typeof input === 'object' ? input : {};
        const file = typeof q.path === 'string' ? q.path : '';
        if (!file) throw new TypeError('neighborsOfImage needs a path');
        const limit = q.limit === undefined || q.limit === null || Number.isNaN(Number(q.limit))
            ? o.neighborLimit
            : Math.max(0, Math.floor(Number(q.limit)));
        if (closed) throw new Error('similarity service closed');
        ensureStarted();
        const rec = host;
        if (!rec || !rec.ready) return { items: [], analyzed: false, mode, error: '相似分析尚未就绪，请稍后再试' };
        const match = q.match === 'element' ? 'element' : 'whole';
        const result = await request(rec, { type: 'neighbors-image', path: file, limit, match });
        return result && Array.isArray(result.items) ? result : { items: [], analyzed: false, mode };
    }

    async function override(value) {
        const input = value && typeof value === 'object' ? value : {};
        const op = input.op;
        if (!OVERRIDE_OPS.includes(op)) throw new TypeError(`unknown similarity override op ${op}`);
        if (closed) throw new Error('similarity service closed');
        ensureStarted();
        const rec = host;
        if (!rec || !rec.ready) throw new Error('相似分析尚未就绪，请稍后再试');
        const message = {
            type: 'override',
            op,
            key: input.key === undefined || input.key === null ? '' : String(input.key),
            groupId: input.groupId === undefined || input.groupId === null ? '' : String(input.groupId)
        };
        if (input.preset !== undefined) message.preset = normalisePreset(input.preset);
        const result = await request(rec, message);
        const hostRev = Number(result && result.revision);
        return {
            revision: Number.isFinite(hostRev) ? revisionFor(`host:${rec.gen}:${hostRev}`) : serveLocal('standard').revision
        };
    }

    // --- load and status -------------------------------------------------------------------------------------

    function setLoad(partial = {}) {
        if (closed || !partial || typeof partial !== 'object') return;
        const message = { type: 'load' };
        if (partial.saving !== undefined && partial.saving !== null) {
            load.saving = Math.max(0, Number(partial.saving) || 0);
            message.saving = load.saving;
        }
        if (partial.onBattery !== undefined && partial.onBattery !== null) {
            load.onBattery = Boolean(partial.onBattery);
            message.onBattery = load.onBattery;
        }
        if (partial.foreground) {
            lastForegroundAt = now();
            message.foreground = true;
        }
        if (host && Object.keys(message).length > 1) post(host, message);
    }

    function state() {
        if (closed) return 'closed';
        if (degraded) return 'degraded';
        if (host) return host.ready ? 'ready' : 'starting';
        if (restartTimer !== null) return 'restarting';
        return 'idle';
    }

    function status() {
        pruneWindow(crashTimes, now(), o.restartWindowMs);
        return {
            state: state(),
            ready: Boolean(host && host.ready),
            degraded,
            error: serviceError,
            mode,
            modeReason: mode === 'hd' ? null : modeReason,
            ortVersion,
            featureVersion,
            hostPid: host && !host.gone && host.handle.pid !== undefined ? host.handle.pid : null,
            generation,
            restarts: crashTimes.length,
            crashes: totalCrashes,
            revision: maxRevision,
            stage: progress.stage,
            pending: progress.pending,
            analyzed: progress.analyzed,
            total: progress.total,
            groupCount: progress.groupCount,
            records: totalRecords
        };
    }

    // The host's own status (pid, RSS, engine counters), or null while it is not running.
    async function hostStatus() {
        const rec = host;
        if (!rec || rec.gone || closed) return null;
        try {
            return await request(rec, { type: 'status' });
        } catch {
            return null;
        }
    }

    // --- close ---------------------------------------------------------------------------------------------------

    function close() {
        if (closing) return closing;
        closed = true;
        restartTimer = clearTimer(restartTimer);
        closing = (async () => {
            const rec = host;
            if (!rec || rec.gone) return;
            rec.closing = true;
            const exited = new Promise(resolve => rec.exitWaiters.push(resolve));
            // The host flushes its store, replies and exits; nothing waits for the reply itself.
            post(rec, { id: ++nextId, type: 'close' });
            let cap = null;
            const capped = new Promise(resolve => {
                cap = setTimer(resolve, o.closeMs);
            });
            await Promise.race([exited, capped]);
            cap = clearTimer(cap);
            hostGone(rec, new Error('similarity service closed'), { crash: false, kill: !rec.exited });
        })();
        return closing;
    }

    return {
        syncRecords,
        get,
        neighbors,
        neighborsOfImage,
        override,
        setLoad,
        status,
        hostStatus,
        close
    };
}

module.exports = { createSimilarityService, SERVICE };
