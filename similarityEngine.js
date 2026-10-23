'use strict';

// Similar-image engine (v3.1 plan §2.2, §2.4, §2.7–§2.11, §2.17). Runs inside the
// "PicGen Similarity" utility process (similarity-engine-host.js); the tests drive it in-process
// with a fake decoder, a fake embedder, a memory fs and a fake clock.
//
//   records → stat/validate (concurrency 16) → featureKey → row valid for the mode?
//     yes: analysed, the stored row is reused
//     no:  choose the source (history JPEG only for opaque originals) → decode lanes →
//          H features → DINOv2 embedding (hd only) → packRow → writeRow
//   analysed rows → debounced recluster (1 s, at most 5 s): edges (incremental when possible)
//          → exact sparse average linkage → merges
//   get → snapshot composed from the merges, the provisional prompt batches and the overrides
//
// Modes (§2.2): 'hd' (prompt + DINOv2) needs a working embedder; 'h' (method H) covers the
// whole session otherwise. 3 consecutive embedding errors switch hd → h in place. A session
// never goes back to hd.
//
// Unanalysed keys come in two kinds (FIX-cluster decision, see similarityCluster.attachProvisional):
// `pending` keys will still be analysed this session and make their group provisional; `failed`
// keys will not (until the next launch while failCount < 3) and attach as final members, listed in
// the group's `failed` so cleanup never preselects them.

const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const F = require('./similarityFeatures');
const { HD, H, cosQ, visualH } = require('./similarityDistance');
const { normalizePrompt, provisionalBatches } = require('./similarityPrompt');
const C = require('./similarityCluster');
const { openStore, featureKey } = require('./similarityStore');
const { openCropStore } = require('./similarityCropStore');
const { historyThumbnailKey } = require('./historyThumbnailKey');

const PRESET_NAMES = Object.freeze(['strict', 'standard', 'loose']);
const FAIL_LIMIT = 3;
const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif)$/i;
const MAX_WARNINGS = 20;
const STORE_OPEN_ATTEMPTS = 3;
const STORE_RETRY_MS = 200;
// Up to max(this, n/8) changed rows are attached incrementally; more rebuild every edge.
const INCREMENTAL_MIN = 256;

const ENGINE = Object.freeze({
    ort: true,
    ortReason: 'disabled',
    lanes: Object.freeze({ background: 1, foreground: 2 }),
    gaps: Object.freeze({ background: 100, foreground: 0, battery: 300 }),
    foregroundMs: 60000,      // a foreground get keeps 2 lanes and normal priority this long
    backfillDelayMs: 0,       // main passes the rest of its 20 s start delay
    debounceMs: 1000,
    maxWaitMs: 5000,
    idleEdgeMs: 10000,
    sessionIdleMs: 120000,
    runErrorLimit: 3,
    statConcurrency: 16,
    pushIntervalMs: 500,      // notices at most 2 per second
    neighborWaitMs: 3000,
    overrideWaitMs: 5000,     // detach/reset wait this long for their recluster, well inside main's 10 s timeout
    imageQueryMs: 7000,       // 以图搜图 gives up here, well inside main's 10 s timeout (which kills the host)
    crops: true,              // 包含相同元素: 9 crop embeddings per analysed image, made while the host is idle
    cropDelayMs: 3000,        // after the lanes go idle, before the crop pass starts
    cropGapMs: 50,            // at least this between two images of the crop pass
    elementMin: 0.72,         // element search: a match scores at least this …
    elementSpread: 0.10,      // … and at most this far below the best match
    compactIdleMs: 60000,
    groupsSaveMs: 30000,
    sliceMs: 20
});

function realClock() {
    return {
        now: () => Date.now(),
        setTimeout(fn, ms) {
            const timer = setTimeout(fn, ms);
            if (timer && typeof timer.unref === 'function') timer.unref();
            return timer;
        },
        clearTimeout(timer) {
            clearTimeout(timer);
        }
    };
}

function yieldNow() {
    return new Promise(resolve => setImmediate(resolve));
}

function modeConstants(mode) {
    return mode === 'hd' ? HD : H;
}

function finiteTime(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : NaN;
}

function timeOrZero(value) {
    return Number.isFinite(value) ? value : 0;
}

function compareStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

// The canonical item order of similarityCluster.buildItems: createdAt ascending, then key.
function compareCanonical(a, b) {
    return timeOrZero(a.createdAt) - timeOrZero(b.createdAt) || compareStrings(a.key, b.key);
}

function newestFirst(a, b) {
    return compareCanonical(b, a);
}

function errorMessage(error) {
    return error && error.message ? error.message : String(error);
}

function sameRecord(a, b) {
    return a.filePath === b.filePath && a.fileName === b.fileName && a.fileSize === b.fileSize
        && a.createdAt === b.createdAt && a.prompt === b.prompt && a.ratio === b.ratio;
}

function cleanRecord(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const key = rec.key === undefined || rec.key === null ? '' : String(rec.key);
    const filePath = typeof rec.filePath === 'string' ? rec.filePath : '';
    if (!key || !filePath) return null;
    return {
        key,
        filePath,
        fileName: typeof rec.fileName === 'string' && rec.fileName ? rec.fileName : path.win32.basename(filePath),
        fileSize: Number(rec.fileSize) || 0,
        createdAt: Number(rec.createdAt) || 0,
        prompt: typeof rec.prompt === 'string' ? rec.prompt : (rec.prompt ? String(rec.prompt) : ''),
        ratio: typeof rec.ratio === 'string' ? rec.ratio : ''
    };
}

function groupRecords(list) {
    const byKey = new Map();
    for (const raw of list || []) {
        const rec = cleanRecord(raw);
        if (!rec) continue;
        if (!byKey.has(rec.key)) byKey.set(rec.key, []);
        byKey.get(rec.key).push(rec);
    }
    return byKey;
}

// sha1 over the mode, the versions, the mode's constants, the canonical item list
// (key, createdAt, featureKey, np, row CRC) and the cannot-link list (§2.8). The item keys and
// createdAt are included too: stored merges refer to canonical item indices.
function snapshotDigest({ mode, embVersion = '', entries = [], cannotLink = [] }) {
    const hash = crypto.createHash('sha1');
    hash.update(JSON.stringify({
        mode,
        hVersion: F.H_VERSION,
        embVersion: mode === 'hd' ? String(embVersion || '') : '',
        constants: modeConstants(mode)
    }));
    for (const entry of entries) {
        hash.update(`\n${entry.key}\u0000${timeOrZero(entry.createdAt)}\u0000${entry.fk}\u0000${entry.np}\u0000${entry.crc >>> 0}`);
    }
    hash.update(`\n${JSON.stringify(cannotLink || [])}`);
    return hash.digest('hex');
}

function validSavedMerges(merges, n) {
    if (!Array.isArray(merges) || merges.length > Math.max(0, n - 1)) return false;
    let clusters = n;
    for (const merge of merges) {
        if (!Array.isArray(merge) || merge.length < 3) return false;
        const [a, b, h] = merge;
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= clusters || b >= clusters || a === b) return false;
        if (typeof h !== 'number' || !Number.isFinite(h)) return false;
        clusters++;
    }
    return true;
}

function createSimilarityEngine({
    storeDir,
    thumbnailsDir = '',
    scanDirs = [],
    decoder,
    embedder = null,
    fs = require('node:fs/promises'),
    clock = realClock(),
    log,
    onNotice,
    onMode,
    setPriority,
    yieldEvery: yieldHook = yieldNow,
    opts = {}
} = {}) {
    if (!storeDir) throw new TypeError('createSimilarityEngine needs a storeDir');
    if (!decoder || typeof decoder.decode !== 'function' || typeof decoder.probe !== 'function') {
        throw new TypeError('createSimilarityEngine needs a decoder {probe, decode}');
    }
    const o = {
        ...ENGINE,
        ...opts,
        lanes: typeof opts.lanes === 'number'
            ? { background: 1, foreground: Math.max(1, opts.lanes) }
            : { ...ENGINE.lanes, ...(opts.lanes || {}) },
        gaps: { ...ENGINE.gaps, ...(opts.gaps || {}) }
    };

    // --- session state ------------------------------------------------------------------------------
    let mode = 'h';
    let modeReason = 'disabled';
    let ortVersion = null;
    let embVersion = '';
    let featureVersion = F.H_VERSION;
    let store = null;
    let overrides = { covers: {}, cannotLink: [] };
    let pcaBasis = null;
    let initPromise = null;
    let initialised = false;
    let closed = false;
    let closing = null;
    let lastError = null;
    let warnings = 0;

    const keys = new Map(); // historyKey -> KeyState
    const byFk = new Map(); // featureKey -> Set<KeyState> (validated, non-missing)
    const rowCache = new Map(); // featureKey -> {crc, flags, q, inv, h}
    const sessionFailed = new Set(); // featureKeys that failed this session (not retried until the next launch)
    const embedFailed = new Set(); // ... of which the failure was the embedding only (retried if the mode drops to h)
    // Rows whose write failed on a disk error (ENOSPC, EPERM, an EBUSY or antivirus lock): kept in
    // memory and retried on the next debounce, never counted as a row failure (final.md §3.11).
    const unsaved = new Map(); // featureKey -> {row, info}
    let unsavedRetry = null;
    let writeErrorMessage = null; // set while row writes fail: logged once until they recover

    let revision = 1;
    let analysedVersion = 0;
    let recordsVersion = 0;
    let cannotVersion = 0;

    const stats = {
        decoded: 0,
        reused: 0,
        embedded: 0,
        validated: 0,
        cacheHits: 0,
        groupRuns: 0,
        lastClusterMs: 0,
        edgeCount: 0,
        capHits: 0,
        cropped: 0
    };

    // Clustering base: {mode, keys (canonical), index, merges, items|null, edges|null,
    // identities: Map|null, digest, fromSaved, confirmed, analysedVersion, cannotVersion}
    let base = null;
    let baseCuts = new Map();
    let groupsDirty = false;
    let lastGroupsSaveAt = 0;
    let groupsSaveTimer = null;

    // validation
    const validateQueue = [];
    const validateQueued = new Set();
    let validateActive = 0;
    let nameIndex = null;
    let nameIndexPromise = null;
    let orphansWanted = false;

    // extraction
    const queues = { priority: [], jpeg: [], original: [] };
    let lanesRunning = 0;
    const inflight = new Set();
    let backfillOpen = false;
    let backfillTimer = null;
    let savingCount = 0;
    let onBattery = false;
    let lastForegroundAt = -Infinity;
    let foregroundTimer = null;
    let priorityLevel = null;
    let runErrors = 0;
    const waiters = new Map(); // historyKey -> Set<resolve>

    // crops (element search)
    let cropStore = null;
    let cropRunning = false;
    let cropTimer = null;
    const cropFailed = new Set(); // featureKeys whose crops failed this session

    // recluster
    let reclusterWanted = false;
    let reclusterRunning = null;
    let reclusterAgain = false;
    let forceFullEdges = false;
    let debounceTimer = null;
    let burstStartedAt = 0;

    // idle work
    let lastActivityAt = clock.now();
    let lastWorkAt = clock.now();
    let lastEmbedAt = clock.now();
    let releaseTimer = null;
    let idleEdgeTimer = null;
    let idleEdgeRunning = false;
    let compactTimer = null;

    // notices
    let noticeTimer = null;
    let noticeQueued = false;
    let lastNoticeAt = -Infinity;

    // compose cache
    let composeCache = new Map();
    let batchesCache = null;
    let liveCache = null;
    const anchorIds = new Map(); // historyKey -> 'sg_…' (a sha1 per group per compose adds up at 20k)

    function anchorIdOf(key) {
        let id = anchorIds.get(key);
        if (!id) {
            id = C.anchorId(key);
            anchorIds.set(key, id);
        }
        return id;
    }

    // --- small helpers -------------------------------------------------------------------------------

    function report(level, message, data) {
        if (typeof log !== 'function') return;
        try {
            Promise.resolve(log({ level, message, data })).catch(() => {});
        } catch { /* logging never breaks the engine */ }
    }

    function warn(message, data) {
        if (warnings++ < MAX_WARNINGS) report('warn', message, data);
    }

    function now() {
        return clock.now();
    }

    function setTimer(fn, ms) {
        return clock.setTimeout(() => {
            try {
                const result = fn();
                if (result && typeof result.catch === 'function') result.catch(error => fail('timer task failed', error));
            } catch (error) {
                fail('timer task failed', error);
            }
        }, Math.max(0, ms));
    }

    function clearTimer(timer) {
        if (timer !== null && timer !== undefined) clock.clearTimeout(timer);
        return null;
    }

    function fail(message, error) {
        lastError = `${message}: ${errorMessage(error)}`;
        report('error', message, { message: errorMessage(error) });
    }

    async function yieldEvery() {
        if (closed) throw new Error('similarity engine closed');
        await yieldHook();
    }

    function bumpRevision() {
        revision++;
        composeCache = new Map();
        scheduleNotice();
    }

    function activity() {
        lastActivityAt = now();
    }

    function foregroundActive() {
        return now() - lastForegroundAt < o.foregroundMs;
    }

    function laneLimit() {
        return Math.max(1, foregroundActive() ? o.lanes.foreground : o.lanes.background);
    }

    function currentGap() {
        if (onBattery) return o.gaps.battery;
        return foregroundActive() ? o.gaps.foreground : o.gaps.background;
    }

    function validating() {
        return validateActive > 0 || validateQueue.length > 0;
    }

    function hasPendingKeys() {
        for (const st of keys.values()) if (st.status === 'pending' || st.status === 'unvalidated') return true;
        return false;
    }

    function reclusterBusy() {
        return reclusterWanted || reclusterRunning !== null || debounceTimer !== null;
    }

    function updatePriority() {
        const level = foregroundActive() ? 'foreground' : 'background';
        if (level === priorityLevel) return;
        priorityLevel = level;
        if (typeof setPriority === 'function') {
            try { setPriority(level); } catch { /* best effort */ }
        }
    }

    function markForeground() {
        lastForegroundAt = now();
        activity();
        updatePriority();
        foregroundTimer = clearTimer(foregroundTimer);
        foregroundTimer = setTimer(() => {
            foregroundTimer = null;
            updatePriority();
        }, o.foregroundMs);
        openBackfill();
        pumpLanes();
    }

    function openBackfill() {
        backfillTimer = clearTimer(backfillTimer);
        if (!backfillOpen) {
            backfillOpen = true;
            pumpLanes();
        }
    }

    // --- rows ------------------------------------------------------------------------------------------

    function hPart(unpacked) {
        return {
            hsv: unpacked.hsv,
            lab: unpacked.lab,
            layout: unpacked.layout,
            logR: unpacked.logR,
            whiteFrac: unpacked.whiteFrac,
            phash: unpacked.phash
        };
    }

    // The unpacked row of a feature key, cached. hd keeps only q (384 B); h keeps the H part.
    function features(fk) {
        const cached = rowCache.get(fk);
        if (cached && (mode !== 'h' || cached.h)) return cached;
        if (!store) return null;
        const kept = unsaved.get(fk);
        const buffer = kept ? kept.row : store.readRow(fk);
        if (!buffer) {
            rowCache.delete(fk);
            return null;
        }
        const unpacked = F.unpackRow(buffer);
        if (!unpacked.crcOk) {
            rowCache.delete(fk);
            return null;
        }
        const entry = {
            crc: buffer.readUInt32LE(F.OFFSETS.crc),
            flags: unpacked.flags,
            q: unpacked.flags & F.FLAGS.DINO_OK ? Int8Array.from(unpacked.q) : null,
            inv: unpacked.inv,
            h: mode === 'h' ? hPart(unpacked) : null
        };
        rowCache.set(fk, entry);
        return entry;
    }

    function rowValidForMode(row) {
        if (!row || !(row.flags & F.FLAGS.OK)) return false;
        return mode !== 'hd' || Boolean(row.flags & F.FLAGS.DINO_OK && row.q);
    }

    // 'analysed' | 'pending' | 'failed' for a validated key.
    function verdict(st) {
        if (unsaved.has(st.fk)) return rowValidForMode(features(st.fk)) ? 'analysed' : 'pending';
        const meta = store.meta(st.fk);
        if (!meta) return 'pending';
        if (meta.status === 'fail') {
            if (mode === 'h' && meta.row >= 0 && rowValidForMode(features(st.fk))) return 'analysed';
            if (sessionFailed.has(st.fk)) return 'failed';
            return meta.failCount >= FAIL_LIMIT ? 'failed' : 'pending';
        }
        return rowValidForMode(features(st.fk)) ? 'analysed' : 'pending';
    }

    function identity(st) {
        return `${st.fk}|${st.crc >>> 0}|${st.np}|${timeOrZero(st.createdAt)}`;
    }

    function rowFor(st) {
        const row = features(st.fk);
        if (!rowValidForMode(row)) return null;
        return mode === 'hd'
            ? { key: st.key, createdAt: st.createdAt, np: st.np, q: row.q, inv: row.inv }
            : { key: st.key, createdAt: st.createdAt, np: st.np, h: row.h };
    }

    // --- key state ---------------------------------------------------------------------------------------

    function newState(key, recs) {
        const rec = recs[0];
        return {
            key,
            recs,
            rec,
            status: 'unvalidated',
            gen: 0,
            path: rec.filePath,
            size: rec.fileSize,
            mtimeMs: 0,
            stat: null,
            fk: featureKey(rec.filePath, rec.fileSize),
            np: normalizePrompt(rec.prompt),
            createdAt: finiteTime(rec.createdAt),
            ratio: rec.ratio,
            jpegPath: null,
            hasAlpha: undefined,
            crc: 0,
            ident: '',
            queued: false,
            extracting: false,
            requeue: false, // asked for while extracting: a stale run writes nothing, so it re-queues
            priority: false
        };
    }

    function linkFk(st) {
        if (!byFk.has(st.fk)) byFk.set(st.fk, new Set());
        byFk.get(st.fk).add(st);
    }

    function unlinkFk(st) {
        const set = byFk.get(st.fk);
        if (!set) return;
        set.delete(st);
        if (!set.size) byFk.delete(st.fk);
    }

    function wake(st) {
        const set = waiters.get(st.key);
        if (!set) return;
        waiters.delete(st.key);
        for (const resolve of set) resolve();
    }

    function setStatus(st, status) {
        if (st.status === status) return;
        const was = st.status;
        st.status = status;
        // A key leaving 'pending' (a sibling sharing its feature key failed or was analysed) keeps
        // its queue entry until a lane drops it as unusable; clear the flag now, or a later return
        // to 'pending' (switchToH) would skip enqueueExtraction and the key would never be taken.
        if (was === 'pending') st.queued = false;
        if (was === 'analysed' || status === 'analysed') {
            analysedVersion++;
            scheduleRecluster();
        }
        if (was === 'missing' || status === 'missing') recordsVersion++;
        if (status !== 'pending' && status !== 'unvalidated') wake(st);
        bumpRevision();
    }

    function markAnalysed(st) {
        const row = features(st.fk);
        st.crc = row ? row.crc : 0;
        st.ident = identity(st);
        setStatus(st, 'analysed');
    }

    function applyVerdict(st, value) {
        if (value === 'analysed') markAnalysed(st);
        else if (value === 'failed') setStatus(st, 'failed');
        else {
            setStatus(st, 'pending');
            enqueueExtraction(st);
        }
    }

    // --- records -----------------------------------------------------------------------------------------

    function upsertKey(key, recs) {
        let st = keys.get(key);
        if (st && st.recs.length === recs.length && st.recs.every((rec, i) => sameRecord(rec, recs[i]))) return false;
        if (!st) {
            st = newState(key, recs);
            keys.set(key, st);
        } else {
            unlinkFk(st);
            const rec = recs[0];
            Object.assign(st, {
                recs,
                rec,
                path: rec.filePath,
                size: rec.fileSize,
                fk: featureKey(rec.filePath, rec.fileSize),
                np: normalizePrompt(rec.prompt),
                createdAt: finiteTime(rec.createdAt),
                ratio: rec.ratio,
                jpegPath: null,
                hasAlpha: undefined,
                queued: false, // re-queued (by its new age and source) once validated again
                gen: st.gen + 1
            });
            setStatus(st, 'unvalidated');
        }
        recordsVersion++;
        enqueueValidation(st);
        return true;
    }

    function removeKey(key) {
        const st = keys.get(key);
        if (!st) return false;
        keys.delete(key);
        anchorIds.delete(key);
        unlinkFk(st);
        if (!byFk.has(st.fk)) rowCache.delete(st.fk); // the store keeps the row for a restore
        st.gen++;
        st.queued = false;
        if (st.status === 'analysed') {
            analysedVersion++;
            scheduleRecluster();
        }
        st.status = 'removed';
        wake(st);
        recordsVersion++;
        orphansWanted = true;
        return true;
    }

    function syncRecords(payload = {}) {
        if (closed) throw new Error('similarity engine closed');
        activity();
        let changed = 0;
        if (Array.isArray(payload.full)) {
            const next = groupRecords(payload.full);
            for (const key of [...keys.keys()]) if (!next.has(key) && removeKey(key)) changed++;
            for (const [key, recs] of next) if (upsertKey(key, recs)) changed++;
            nameIndex = null;
            orphansWanted = true; // a full list also revives rows whose records came back
        } else {
            for (const key of payload.removes || []) if (removeKey(String(key))) changed++;
            for (const [key, recs] of groupRecords(payload.upserts)) {
                const added = !keys.has(key);
                if (upsertKey(key, recs)) changed++;
                if (added) orphansWanted = true; // a restore from the Recycle Bin clears its row's orphanedAt
            }
        }
        if (changed) bumpRevision();
        if (orphansWanted && !validating()) markOrphans();
        pumpValidation();
        let total = 0;
        for (const st of keys.values()) total += st.recs.length;
        return { total, keys: keys.size, changed };
    }

    // --- validation ----------------------------------------------------------------------------------------

    function enqueueValidation(st) {
        if (validateQueued.has(st.key)) return;
        validateQueued.add(st.key);
        validateQueue.push(st.key);
        pumpValidation();
    }

    function pumpValidation() {
        if (!initialised || closed) return;
        while (validateActive < o.statConcurrency && validateQueue.length) {
            const key = validateQueue.shift();
            validateQueued.delete(key);
            const st = keys.get(key);
            if (!st) continue;
            validateActive++;
            validateKey(st)
                .catch(error => warn('similarity validation failed', { key, message: errorMessage(error) }))
                .finally(() => {
                    validateActive--;
                    // The host treats an unhandled rejection as fatal: nothing may escape here.
                    try {
                        pumpValidation();
                        if (!validating()) onValidationIdle();
                    } catch (error) {
                        fail('similarity validation bookkeeping failed', error);
                    }
                });
        }
    }

    async function getNameIndex() {
        if (nameIndex) return nameIndex;
        if (!nameIndexPromise) {
            nameIndexPromise = (async () => {
                const index = new Map();
                for (const dir of scanDirs || []) {
                    let names;
                    try {
                        names = await fs.readdir(dir);
                    } catch {
                        continue;
                    }
                    for (const raw of names) {
                        const name = String(raw && raw.name ? raw.name : raw);
                        if (!IMAGE_NAME.test(name)) continue;
                        const lower = name.toLowerCase();
                        if (!index.has(lower)) index.set(lower, []);
                        index.get(lower).push(path.join(dir, name));
                    }
                }
                nameIndex = index;
                return index;
            })().finally(() => { nameIndexPromise = null; });
        }
        return nameIndexPromise;
    }

    async function statFile(filePath) {
        try {
            const stat = await fs.stat(filePath);
            return stat && typeof stat.isFile === 'function' && stat.isFile() ? stat : null;
        } catch {
            return null;
        }
    }

    // The first record whose stat succeeds; then, for stale paths (a moved portable folder), a file
    // of the same name in the history scan directories.
    async function locate(recs) {
        for (const rec of recs) {
            const stat = await statFile(rec.filePath);
            if (stat) return { rec, filePath: rec.filePath, stat };
        }
        const index = await getNameIndex();
        for (const rec of recs) {
            const candidates = index.get(String(rec.fileName || path.win32.basename(rec.filePath)).toLowerCase()) || [];
            let fallback = null;
            for (const candidate of candidates) {
                const stat = await statFile(candidate);
                if (!stat) continue;
                if (!rec.fileSize || stat.size === rec.fileSize) return { rec, filePath: candidate, stat };
                fallback = fallback || { rec, filePath: candidate, stat };
            }
            if (fallback) return fallback;
        }
        return null;
    }

    async function classify(st) {
        st.jpegPath = null;
        st.hasAlpha = undefined;
        if (!thumbnailsDir || !st.stat) return;
        const jpegPath = path.join(thumbnailsDir, historyThumbnailKey(path.resolve(st.path), st.stat));
        if (!(await statFile(jpegPath))) return;
        try {
            const probe = await decoder.probe(st.path);
            st.hasAlpha = probe ? probe.hasAlpha : undefined;
            if (st.hasAlpha === false) st.jpegPath = jpegPath;
        } catch {
            // An unreadable header: decode the original, which records the failure if it is corrupt.
        }
    }

    async function validateKey(st) {
        const gen = st.gen;
        const found = await locate(st.recs);
        if (keys.get(st.key) !== st || st.gen !== gen || closed) return;
        stats.validated++;
        if (!found) {
            setStatus(st, 'missing');
            return;
        }
        unlinkFk(st);
        st.rec = found.rec;
        st.path = found.filePath;
        st.stat = found.stat;
        st.size = found.stat.size;
        st.mtimeMs = found.stat.mtimeMs;
        st.fk = featureKey(found.filePath, found.stat.size);
        st.np = normalizePrompt(found.rec.prompt);
        st.createdAt = finiteTime(found.rec.createdAt);
        if (!Number.isFinite(st.createdAt)) st.createdAt = timeOrZero(found.stat.mtimeMs);
        st.ratio = found.rec.ratio;
        linkFk(st);
        recordsVersion++;
        const value = verdict(st);
        if (value === 'pending') {
            await classify(st);
            if (keys.get(st.key) !== st || st.gen !== gen || closed) return;
        }
        applyVerdict(st, value);
    }

    function onValidationIdle() {
        if (closed) return;
        if (base && base.fromSaved && !base.confirmed) confirmSavedBase();
        if (orphansWanted) markOrphans();
        if (reclusterWanted) armDebounce();
        bumpRevision();
        scheduleIdleEdges();
        scheduleCompaction();
        // A library restored whole from the store runs no lane, so this is where its crop pass starts.
        scheduleCrops();
    }

    function markOrphans() {
        orphansWanted = false;
        if (!store) return;
        const present = new Set();
        for (const st of keys.values()) if (st.status !== 'missing' && st.status !== 'unvalidated') present.add(st.fk);
        try {
            store.markOrphans(present, now());
        } catch (error) {
            warn('similarity orphan marking failed', { message: errorMessage(error) });
        }
    }

    // --- extraction lanes -----------------------------------------------------------------------------------

    function usable(st) {
        return st.queued && keys.get(st.key) === st && st.status === 'pending' && !st.extracting;
    }

    // Lists stay sorted oldest first (binary insertion), so pop() takes the newest.
    function insertByAge(list, st) {
        let low = 0;
        let high = list.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (compareCanonical(list[mid], st) <= 0) low = mid + 1;
            else high = mid;
        }
        list.splice(low, 0, st);
    }

    function enqueueExtraction(st) {
        if (st.status !== 'pending') return;
        if (st.extracting) {
            // An upsert re-validated the key while its old extraction runs; that run is now stale
            // and writes nothing, so extract() re-queues the key when it finishes.
            st.requeue = true;
            return;
        }
        if (st.priority) {
            st.priority = false;
            st.queued = true;
            queues.priority.unshift(st);
        } else if (!st.queued) {
            st.queued = true;
            insertByAge(queues[st.jpegPath ? 'jpeg' : 'original'], st);
        }
        pumpLanes();
    }

    function prioritise(st) {
        if (st.status !== 'pending' || st.extracting) {
            // Enqueued at the front once validation (or the extraction in flight) finishes. A queue
            // entry pushed now would be dropped by takeTask and leave st.queued set for good.
            st.priority = true;
            if (st.extracting) st.requeue = true;
            return;
        }
        st.queued = true;
        queues.priority.unshift(st);
        pumpLanes();
    }

    function takeTask({ backfill }) {
        while (queues.priority.length) {
            const st = queues.priority.shift();
            if (usable(st)) {
                st.queued = false;
                return st;
            }
        }
        if (!backfill) return null;
        for (const name of ['jpeg', 'original']) {
            if (name === 'original' && savingCount > 0) continue;
            const list = queues[name];
            while (list.length) {
                const st = list.pop();
                if (usable(st)) {
                    st.queued = false;
                    return st;
                }
            }
        }
        return null;
    }

    function pumpLanes() {
        if (!initialised || closed) return;
        while (lanesRunning < laneLimit()) {
            const st = takeTask({ backfill: backfillOpen });
            if (!st) return;
            lanesRunning++;
            void runLane(st);
        }
    }

    function sleep(ms) {
        return new Promise(resolve => { clock.setTimeout(resolve, ms); });
    }

    async function runLane(first) {
        let st = first;
        try {
            while (st && !closed) {
                const task = extract(st);
                inflight.add(task);
                try {
                    await task;
                } finally {
                    inflight.delete(task);
                }
                if (closed) break;
                const gap = currentGap();
                if (gap > 0) await sleep(gap);
                else await yieldNow();
                if (closed || lanesRunning > laneLimit()) break;
                st = takeTask({ backfill: backfillOpen });
            }
        } catch (error) {
            fail('similarity lane failed', error);
        } finally {
            lanesRunning--;
            try {
                if (!closed && lanesRunning === 0) {
                    pumpLanes();
                    if (lanesRunning === 0) onLanesIdle();
                }
            } catch (error) {
                fail('similarity lane bookkeeping failed', error);
            }
        }
    }

    function onLanesIdle() {
        lastWorkAt = now();
        // The store throttles manifest writes to one per 5 s; once the queue drains, write it now
        // so a host killed right after a backfill loses no rows.
        if (store && !hasPendingKeys()) store.flush().catch(error => warn('similarity manifest flush failed', { message: errorMessage(error) }));
        retryUnsaved();
        scheduleIdleEdges();
        scheduleCompaction();
        scheduleCrops();
    }

    // --- crops (包含相同元素) ---------------------------------------------------------------------------------
    // Lowest priority: runs only while no key waits for its row and nothing is being saved, one image at a
    // time (1 decode + 9 embeds), newest first. Main work arriving stops the pass; the next idle resumes it.

    function cropsEnabled() {
        return !!cropStore && mode === 'hd' && !!embedder && typeof decoder.decodeCrops === 'function';
    }

    function cropsBlocked() {
        return lanesRunning > 0 || savingCount > 0 || hasPendingKeys() || validating();
    }

    function hasCrops(st) {
        return !!cropStore && !!cropStore.get(st.fk, st.crc);
    }

    function scheduleCrops() {
        if (!cropsEnabled() || closed || cropRunning || cropTimer) return;
        cropTimer = setTimer(() => {
            cropTimer = null;
            void runCrops();
        }, o.cropDelayMs);
    }

    function cropTasks() {
        const list = [];
        for (const st of analysedStates()) if (!cropFailed.has(st.fk) && !hasCrops(st)) list.push(st);
        list.sort((a, b) => b.createdAt - a.createdAt);
        return list;
    }

    async function runCrops() {
        if (!cropsEnabled() || closed || cropRunning) return;
        // Validation or rows still running: the next validation-idle / lanes-idle / load hint restarts it.
        if (cropsBlocked()) return;
        cropRunning = true;
        try {
            const tasks = cropTasks();
            for (const st of tasks) {
                if (closed || !cropsEnabled() || cropsBlocked()) return;
                if (keys.get(st.key) !== st || st.status !== 'analysed' || hasCrops(st) || cropFailed.has(st.fk)) continue;
                const task = makeCrops(st);
                inflight.add(task);
                try {
                    await task;
                } finally {
                    inflight.delete(task);
                }
                if (closed) return;
                await sleep(Math.max(currentGap(), o.cropGapMs));
            }
            // Compaction drops the crops of images that left the library, so it only runs on a settled one:
            // mid-validation every key is still 'unvalidated' and would look gone.
            if (!closed && cropStore && !cropsBlocked()) {
                const live = new Set();
                for (const st of keys.values()) if (st.status !== 'missing') live.add(st.fk);
                await cropStore.maybeCompact(live).catch(error => warn('similarity crop store compaction failed', { message: errorMessage(error) }));
            }
        } catch (error) {
            fail('similarity crop pass failed', error);
        } finally {
            cropRunning = false;
        }
    }

    async function makeCrops(st) {
        const { fk, crc } = st;
        let crops;
        try {
            crops = await decoder.decodeCrops({ originalPath: st.path });
        } catch (error) {
            cropFailed.add(fk);
            report('info', 'similarity crops: decode failed', { key: st.key, message: errorMessage(error) });
            return;
        }
        const dim = F.EMB_DIM;
        const q = new Int8Array(crops.length * dim);
        const inv = new Float32Array(crops.length);
        try {
            for (let c = 0; c < crops.length; c++) {
                if (closed) return;
                lastEmbedAt = now();
                const quantized = F.quantizeEmbedding(await embedder.embed(crops[c]));
                touchEmbedder();
                q.set(quantized.q, c * dim);
                inv[c] = quantized.inv;
            }
        } catch (error) {
            touchEmbedder();
            cropFailed.add(fk);
            report('info', 'similarity crops: embed failed', { key: st.key, message: errorMessage(error) });
            return;
        }
        // The image changed (or left) while its crops were made: they would describe the old pixels.
        if (closed || st.crc !== crc || st.status !== 'analysed') return;
        try {
            await cropStore.put(fk, { crc, q, inv });
        } catch (error) {
            // A disk error (full, an antivirus lock): not retried this session, like a decode failure.
            cropFailed.add(fk);
            warn('similarity crops: write failed', { key: st.key, message: errorMessage(error) });
            return;
        }
        stats.cropped++;
    }

    function cropProgress() {
        if (!cropsEnabled()) return { enabled: false, ready: 0, total: 0 };
        const states = analysedStates();
        let ready = 0;
        for (const st of states) if (hasCrops(st)) ready++;
        return { enabled: true, ready, total: states.length };
    }

    function sharingKeys(fk) {
        return [...(byFk.get(fk) || [])];
    }

    // --- row writes -------------------------------------------------------------------------------------------

    function noteWriteFailure(error) {
        if (writeErrorMessage !== null) return; // logged once until the writes recover
        writeErrorMessage = `similarity feature row write failed: ${errorMessage(error)}`;
        lastError = writeErrorMessage;
        report('error', 'similarity feature row write failed', { message: errorMessage(error), code: (error && error.code) || '' });
        bumpRevision(); // the snapshot's error changed
    }

    function writesRecovered() {
        if (writeErrorMessage === null || unsaved.size) return;
        if (lastError === writeErrorMessage) lastError = null;
        writeErrorMessage = null;
        report('info', 'similarity feature row writes recovered');
        bumpRevision();
    }

    // → true once the row is on disk; false when a disk error kept it in memory. A TypeError is a
    // malformed row (a bug, not the disk) and is rethrown, so the caller records a row failure.
    async function persistRow(fk, row, info) {
        try {
            await store.writeRow(fk, row, info);
        } catch (error) {
            if (closed || error instanceof TypeError) throw error;
            unsaved.set(fk, { row, info });
            noteWriteFailure(error);
            return false;
        }
        unsaved.delete(fk); // this row supersedes any older copy kept in memory
        if (unsaved.size) retryUnsaved(); // the disk may be back: try the rest now
        else writesRecovered();
        return true;
    }

    // Retries the rows kept in memory, oldest first; stops at the first error (the disk is still full).
    function retryUnsaved() {
        if (unsavedRetry || !unsaved.size || !store) return unsavedRetry;
        unsavedRetry = (async () => {
            for (const [fk, entry] of [...unsaved]) {
                try {
                    await store.writeRow(fk, entry.row, entry.info);
                } catch {
                    return;
                }
                if (unsaved.get(fk) === entry) unsaved.delete(fk);
            }
            writesRecovered();
        })()
            .catch(error => warn('similarity row write retry failed', { message: errorMessage(error) }))
            .finally(() => { unsavedRetry = null; });
        return unsavedRetry;
    }

    function recordFailure(st, kind, error) {
        const fk = st.fk;
        try {
            store.markFail(fk, { mtimeMs: st.mtimeMs, lastPath: st.path });
        } catch (markError) {
            warn('similarity markFail failed', { message: errorMessage(markError) });
        }
        rowCache.delete(fk);
        sessionFailed.add(fk);
        if (kind === 'embed') embedFailed.add(fk);
        else embedFailed.delete(fk);
        warn(`similarity ${kind} failed`, { key: st.key, message: errorMessage(error) });
        for (const other of sharingKeys(fk)) {
            if (other.status === 'pending' || other === st) setStatus(other, 'failed');
        }
    }

    function touchEmbedder() {
        lastEmbedAt = now();
        if (mode !== 'hd' || !embedder) return;
        releaseTimer = clearTimer(releaseTimer);
        releaseTimer = setTimer(() => {
            releaseTimer = null;
            if (closed || now() - lastEmbedAt < o.sessionIdleMs) return;
            if (embedder.loaded === false) return;
            return Promise.resolve(embedder.release()).catch(error => warn('similarity session release failed', { message: errorMessage(error) }));
        }, o.sessionIdleMs);
    }

    async function extract(st) {
        if (!usableForWork(st)) return;
        const gen = st.gen;
        const fk = st.fk;
        st.extracting = true;
        activity();
        lastWorkAt = now();
        try {
            const current = verdict(st);
            if (current !== 'pending') {
                applyVerdict(st, current);
                return;
            }
            let decoded;
            try {
                decoded = await decoder.decode({ originalPath: st.path, jpegPath: st.jpegPath, hasAlpha: st.hasAlpha });
            } catch (error) {
                if (stale(st, gen)) return;
                recordFailure(st, 'decode', error);
                return;
            }
            stats.decoded++;
            if (decoded.source === 'jpeg360') stats.reused++;
            if (stale(st, gen)) return;
            const colour = F.colourFeatures(decoded.rgb64);
            const phash = F.phash256(decoded.rgb64);
            let flags = F.FLAGS.OK;
            if (decoded.source === 'jpeg360') flags |= F.FLAGS.SRC_JPEG360;
            if (decoded.originalHasAlpha) flags |= F.FLAGS.ORIG_ALPHA;
            let q = null;
            let inv = 0;
            if (mode === 'hd' && embedder) {
                lastEmbedAt = now();
                let embedding;
                try {
                    embedding = await embedder.embed(decoded.rgb224);
                } catch (error) {
                    touchEmbedder();
                    if (stale(st, gen)) return;
                    runErrors++;
                    recordFailure(st, 'embed', error);
                    if (runErrors >= o.runErrorLimit) switchToH('run-failed', error);
                    return;
                }
                runErrors = 0;
                stats.embedded++;
                touchEmbedder();
                ({ q, inv } = F.quantizeEmbedding(embedding));
                flags |= F.FLAGS.DINO_OK;
            }
            if (stale(st, gen)) return;
            const row = F.packRow({
                hsv: colour.hsv,
                lab: colour.lab,
                layout: colour.layout,
                logR: decoded.logR,
                whiteFrac: colour.whiteFrac,
                phash,
                q,
                inv
            }, flags);
            await persistRow(fk, row, { mtimeMs: st.mtimeMs, lastPath: st.path }); // false: kept in memory
            rowCache.delete(fk);
            sessionFailed.delete(fk);
            embedFailed.delete(fk);
            lastWorkAt = now();
            for (const other of sharingKeys(fk)) {
                if (other.status === 'pending' || other === st) {
                    const value = verdict(other);
                    if (value === 'analysed') markAnalysed(other);
                }
            }
        } catch (error) {
            if (!closed) fail('similarity row extraction failed', error);
            if (!closed && keys.get(st.key) === st && st.status === 'pending') recordFailure(st, 'decode', error);
        } finally {
            st.extracting = false;
            if (st.requeue) {
                st.requeue = false;
                // Asked for while this ran (an upsert re-validated the key, or a neighbours query):
                // a stale run returned without a row, so the key goes back in its queue.
                if (!closed && keys.get(st.key) === st && st.status === 'pending') enqueueExtraction(st);
            }
        }
    }

    function usableForWork(st) {
        return keys.get(st.key) === st && st.status === 'pending' && !st.extracting && !closed;
    }

    function stale(st, gen) {
        return closed || keys.get(st.key) !== st || st.gen !== gen;
    }

    // --- mode -------------------------------------------------------------------------------------------------

    function modeInfo() {
        return { mode, reason: modeReason, ortVersion, featureVersion };
    }

    function emitMode() {
        if (typeof onMode !== 'function') return;
        try { onMode(modeInfo()); } catch { /* the host relays it; never fatal here */ }
    }

    function switchToH(reason, error) {
        if (mode === 'h') return;
        mode = 'h';
        modeReason = reason;
        featureVersion = F.H_VERSION;
        report('warn', 'similarity switched to method H', { reason, message: error ? errorMessage(error) : '' });
        releaseTimer = clearTimer(releaseTimer);
        if (embedder) Promise.resolve(embedder.release()).catch(() => {});
        emitMode();
        // Rows that failed only in the embedding are extractable for h this session.
        for (const fk of embedFailed) sessionFailed.delete(fk);
        embedFailed.clear();
        liveCache = null;
        forceFullEdges = true;
        analysedVersion++;
        for (const st of [...keys.values()]) {
            if (st.status !== 'analysed' && st.status !== 'pending' && st.status !== 'failed') continue;
            const value = verdict(st);
            if (value === 'pending' && st.status !== 'pending') {
                setStatus(st, 'pending');
                void classify(st).then(() => {
                    if (keys.get(st.key) === st && st.status === 'pending') enqueueExtraction(st);
                }).catch(error => warn('similarity re-queue failed', { key: st.key, message: errorMessage(error) }));
            } else if (value !== 'pending') {
                applyVerdict(st, value);
            }
        }
        scheduleRecluster();
        bumpRevision();
    }

    // --- clustering ---------------------------------------------------------------------------------------------

    function cannotLinkPairsForKeys(states) {
        const pairs = overrides.cannotLink;
        if (!pairs.length) return [];
        const keysByFk = new Map();
        for (const st of states) {
            if (!keysByFk.has(st.fk)) keysByFk.set(st.fk, []);
            keysByFk.get(st.fk).push(st.key);
        }
        const out = [];
        for (const [a, b] of pairs) {
            const left = keysByFk.get(a);
            const right = keysByFk.get(b);
            if (!left || !right) continue;
            for (const x of left) for (const y of right) if (x !== y) out.push([x, y]);
        }
        return out;
    }

    function analysedStates() {
        const list = [];
        for (const st of keys.values()) if (st.status === 'analysed') list.push(st);
        return list;
    }

    function digestFor(states, runMode) {
        const entries = [...states].sort(compareCanonical)
            .map(st => ({ key: st.key, createdAt: st.createdAt, fk: st.fk, np: st.np, crc: st.crc }));
        return snapshotDigest({ mode: runMode, embVersion, entries, cannotLink: overrides.cannotLink });
    }

    function setBase(next) {
        base = next;
        baseCuts = new Map();
        liveCache = null;
    }

    function confirmSavedBase() {
        const states = analysedStates();
        const digest = digestFor(states, mode);
        if (digest === base.digest && states.length === base.keys.length) {
            base.confirmed = true;
            base.identities = new Map(states.map(st => [st.key, st.ident]));
            base.analysedVersion = analysedVersion;
            base.cannotVersion = cannotVersion;
            stats.cacheHits++;
            reclusterWanted = false;
        } else {
            reclusterWanted = true;
        }
    }

    function scheduleRecluster() {
        if (closed) return;
        reclusterWanted = true;
        if (!initialised || validating()) return; // deferred to the end of the validation round
        armDebounce();
    }

    function armDebounce() {
        if (closed) return;
        const t = now();
        if (!burstStartedAt) burstStartedAt = t;
        const due = Math.min(t + o.debounceMs, burstStartedAt + o.maxWaitMs);
        debounceTimer = clearTimer(debounceTimer);
        debounceTimer = setTimer(fireRecluster, due - t);
    }

    function fireRecluster() {
        debounceTimer = null;
        burstStartedAt = 0;
        retryUnsaved();
        return runRecluster();
    }

    async function runRecluster() {
        if (closed) return;
        if (reclusterRunning) {
            reclusterAgain = true;
            return reclusterRunning;
        }
        reclusterWanted = false;
        reclusterRunning = recluster()
            .catch(error => {
                if (!closed) fail('similarity recluster failed', error);
            })
            .finally(() => {
                reclusterRunning = null;
                if (closed) return;
                try {
                    if (reclusterAgain) {
                        reclusterAgain = false;
                        scheduleRecluster();
                    }
                    bumpRevision();
                    scheduleIdleEdges();
                } catch (error) {
                    fail('similarity recluster bookkeeping failed', error);
                }
            });
        return reclusterRunning;
    }

    // Runs now, after any run in progress (overrides need their result before they answer).
    async function reclusterNow() {
        debounceTimer = clearTimer(debounceTimer);
        burstStartedAt = 0;
        while (reclusterRunning) {
            reclusterAgain = false;
            await reclusterRunning;
        }
        await runRecluster();
    }

    // An override's recluster, awaited at most o.overrideWaitMs. It is normally 70–150 ms, but it
    // queues behind a running (cold) build, and a full H edge build at 20k takes ≈ 18 s: past main's
    // 10 s request timeout, which would restart the host for a change that is already saved. When
    // the bound expires the caller answers anyway; the recluster's notice brings the new grouping.
    async function reclusterBounded() {
        const run = reclusterNow().catch(error => {
            if (!closed) fail('similarity recluster failed', error);
        });
        let timer = null;
        const bound = new Promise(resolve => { timer = clock.setTimeout(resolve, o.overrideWaitMs); });
        try {
            await Promise.race([run, bound]);
        } finally {
            clearTimer(timer);
        }
    }

    async function edgesForChanges(items, prev, changed) {
        let edges = C.remapEdges(prev.edges, prev.items, items, { dropKeys: changed });
        const ei = [];
        const ej = [];
        const ed = [];
        let sliceStart = performance.now();
        for (const key of changed) {
            const idx = items.indexOf.get(key);
            if (idx === undefined) continue;
            const add = C.edgesFor(items, idx, { mode: items.mode });
            for (let k = 0; k < add.ei.length; k++) {
                ei.push(add.ei[k]);
                ej.push(add.ej[k]);
                ed.push(add.ed[k]);
            }
            if (performance.now() - sliceStart >= o.sliceMs) {
                await yieldEvery();
                sliceStart = performance.now();
            }
        }
        if (ei.length) {
            edges = C.mergeEdges(edges, { ei: Int32Array.from(ei), ej: Int32Array.from(ej), ed: Float64Array.from(ed) });
        }
        return edges;
    }

    async function fullEdges(items) {
        const built = await C.buildEdges(items, { mode: items.mode, prefilter: 'auto', basis: pcaBasis, yieldEvery, sliceMs: o.sliceMs });
        if (built.stats && built.stats.basisSource === 'built' && built.basis) {
            pcaBasis = built.basis;
            store.savePca(built.basis).catch(error => warn('similarity PCA basis save failed', { message: errorMessage(error) }));
        }
        return built;
    }

    async function recluster() {
        const started = performance.now();
        const runMode = mode;
        const runAnalysed = analysedVersion;
        const runCannot = cannotVersion;
        const states = analysedStates();
        const rows = [];
        const used = [];
        for (const st of states) {
            const row = rowFor(st);
            if (!row) continue;
            rows.push(row);
            used.push(st);
        }
        const items = C.buildItems(rows, { mode: runMode, cannotLink: cannotLinkPairsForKeys(used) });
        const identities = new Map(used.map(st => [st.key, st.ident]));
        let edges = null;
        const prev = base;
        if (!forceFullEdges && prev && prev.mode === runMode && prev.edges && prev.items && prev.identities) {
            const changed = [];
            for (const key of items.keys) if (prev.identities.get(key) !== identities.get(key)) changed.push(key);
            // One attach costs about n pair checks (~1 ms at 20k, predictable); a full build costs
            // 2 s (real library) to 13 s (isotropic data the PCA prefilter cannot prune) at 20k.
            if (changed.length <= Math.max(INCREMENTAL_MIN, items.n >> 3)) edges = await edgesForChanges(items, prev, changed);
        }
        if (!edges) {
            forceFullEdges = false;
            edges = await fullEdges(items);
        }
        const K = modeConstants(runMode);
        const link = await C.sparseAverage(items.n, edges, { T: K.T_EDGE, dist: items.dist, yieldEvery, sliceMs: o.sliceMs });
        if (closed || mode !== runMode) return;
        setBase({
            mode: runMode,
            keys: items.keys,
            index: items.indexOf,
            merges: link.merges,
            items,
            edges,
            identities,
            digest: digestFor(used, runMode),
            fromSaved: false,
            confirmed: true,
            analysedVersion: runAnalysed,
            cannotVersion: runCannot
        });
        stats.groupRuns++;
        stats.lastClusterMs = Math.round((performance.now() - started) * 10) / 10;
        stats.capHits = link.capHits;
        stats.edgeCount = edges.ei.length;
        groupsDirty = true;
        scheduleGroupsSave();
    }

    function scheduleGroupsSave() {
        if (!groupsDirty || closed || groupsSaveTimer) return;
        const wait = Math.max(0, lastGroupsSaveAt + o.groupsSaveMs - now());
        const final = !hasPendingKeys();
        groupsSaveTimer = setTimer(() => {
            groupsSaveTimer = null;
            return saveGroups();
        }, final ? 0 : wait);
    }

    async function saveGroups() {
        if (!groupsDirty || !base || base.fromSaved || !store) return;
        groupsDirty = false;
        lastGroupsSaveAt = now();
        const target = base;
        try {
            await store.saveGroups({
                mode: target.mode,
                revision,
                digest: target.digest,
                // The base's own mode: after an in-place hd → h switch an hd base is never saved as h.
                featureVersion: target.mode === 'hd' ? `${F.H_VERSION}+${embVersion}` : F.H_VERSION,
                savedAt: now(),
                items: target.keys,
                merges: target.merges
            });
        } catch (error) {
            groupsDirty = true;
            warn('similarity groups save failed', { message: errorMessage(error) });
        }
    }

    function adoptSaved(saved) {
        if (!saved || saved.mode !== mode || saved.featureVersion !== featureVersion) return;
        const items = Array.isArray(saved.items) ? saved.items.map(String) : null;
        if (!items || new Set(items).size !== items.length || !validSavedMerges(saved.merges, items.length)) return;
        setBase({
            mode,
            keys: items,
            index: new Map(items.map((key, i) => [key, i])),
            merges: saved.merges.map(([a, b, h]) => [a, b, h]),
            items: null,
            edges: null,
            identities: null,
            digest: typeof saved.digest === 'string' ? saved.digest : '',
            fromSaved: true,
            confirmed: false,
            analysedVersion: -1,
            cannotVersion
        });
    }

    // Items (for neighbours and edges) over the base keys, when they are exactly the analysed set.
    function baseItems(target) {
        if (target.items) return target.items;
        const states = target.keys.map(key => keys.get(key));
        if (states.some(st => !st || st.status !== 'analysed')) return null;
        const rows = states.map(rowFor);
        if (rows.some(row => !row)) return null;
        const items = C.buildItems(rows, { mode: target.mode, cannotLink: cannotLinkPairsForKeys(states) });
        if (items.keys.some((key, i) => key !== target.keys[i])) return null;
        target.items = items;
        return items;
    }

    function scheduleIdleEdges() {
        if (closed || idleEdgeTimer || idleEdgeRunning || !base || base.edges || !base.confirmed) return;
        const wait = Math.max(0, lastActivityAt + o.idleEdgeMs - now());
        idleEdgeTimer = setTimer(() => {
            idleEdgeTimer = null;
            return idleEdges();
        }, wait);
    }

    async function idleEdges() {
        const target = base;
        if (closed || !target || target.edges || !target.confirmed) return;
        if (now() - lastActivityAt < o.idleEdgeMs || hasPendingKeys() || reclusterBusy() || validating()) {
            scheduleIdleEdges();
            return;
        }
        const items = baseItems(target);
        if (!items) return;
        idleEdgeRunning = true;
        try {
            const edges = await fullEdges(items);
            if (base === target && !closed) {
                target.edges = edges;
                stats.edgeCount = edges.ei.length;
            }
        } catch (error) {
            if (!closed) warn('similarity idle edge build failed', { message: errorMessage(error) });
        } finally {
            idleEdgeRunning = false;
        }
    }

    function scheduleCompaction() {
        if (closed || compactTimer || !store) return;
        compactTimer = setTimer(async () => {
            compactTimer = null;
            const idle = now() - lastWorkAt;
            if (closed) return;
            if (idle < o.compactIdleMs || hasPendingKeys() || lanesRunning > 0) {
                scheduleCompaction();
                return;
            }
            try {
                await store.compact({ now: now(), idle });
            } catch (error) {
                warn('similarity store compaction failed', { message: errorMessage(error) });
            }
        }, o.compactIdleMs);
    }

    // --- snapshot ---------------------------------------------------------------------------------------------------

    function eligible(st) {
        if (!base || !base.index.has(st.key)) return false;
        if (base.identities) return st.status === 'analysed' && base.identities.get(st.key) === st.ident;
        return st.status === 'analysed' || st.status === 'unvalidated';
    }

    function batchesFor(present) {
        if (batchesCache && batchesCache.version === recordsVersion) return batchesCache.batches;
        const batches = provisionalBatches(present, {
            keyOf: st => st.key,
            npOf: st => st.np,
            timeOf: st => st.createdAt
        });
        batchesCache = { version: recordsVersion, batches };
        return batches;
    }

    function cutsAt(t) {
        let groups = baseCuts.get(t);
        if (!groups) {
            groups = C.cutGroups(base.merges, base.keys.length, t);
            baseCuts.set(t, groups);
        }
        return groups;
    }

    function shapeGroup(group, preset, K, eligibleSet) {
        const members = group.members.map(key => keys.get(key)).filter(Boolean).sort(newestFirst);
        const anchor = members[members.length - 1];
        const covers = overrides.covers;
        let pinned = null;
        let pinnedAt = -Infinity;
        let latestAt = 0;
        const prompts = new Set();
        const ratios = [];
        for (const st of members) {
            const at = covers[st.fk];
            if (at !== undefined && at > pinnedAt) {
                pinned = st.key;
                pinnedAt = at;
            }
            latestAt = Math.max(latestAt, timeOrZero(st.createdAt));
            if (st.np) prompts.add(st.np);
            if (st.ratio && !ratios.includes(st.ratio)) ratios.push(st.ratio);
        }
        let parts = null;
        let rest = [];
        if (group.base >= 0 && base) {
            const baseMembers = members.filter(st => eligibleSet.has(st.key));
            const sub = C.subgroups(baseMembers.map(st => base.index.get(st.key)), base.merges, base.keys.length, K.NEXT_CUT[preset]);
            if (sub) {
                parts = sub.parts.map(part => part.map(i => base.keys[i]));
                const restSet = new Set(sub.rest.map(i => base.keys[i]));
                for (const st of members) if (!eligibleSet.has(st.key)) restSet.add(st.key);
                rest = members.filter(st => restSet.has(st.key)).map(st => st.key);
            }
        }
        const failedSet = new Set(group.failed);
        return {
            id: anchorIdOf(anchor.key),
            members: members.map(st => st.key),
            pinned,
            latestAt,
            promptVariants: prompts.size,
            ratios,
            provisional: Boolean(group.provisional),
            parts,
            rest,
            failed: members.filter(st => failedSet.has(st.key)).map(st => st.key)
        };
    }

    // Counts and key classes for the current revision (no grouping work; status() uses it alone).
    let tallyCache = null;
    function tally() {
        if (tallyCache && tallyCache.revision === revision) return tallyCache;
        const present = [];
        const pendingSet = new Set();
        const failedSet = new Set();
        const eligibleSet = new Set();
        let total = 0;
        let missing = 0;
        let pending = 0;
        let failed = 0;
        let analysed = 0;
        let unclustered = 0;
        for (const st of keys.values()) {
            total += st.recs.length;
            if (st.status === 'missing') {
                missing += st.recs.length;
                continue;
            }
            missing += st.recs.length - 1;
            present.push(st);
            if (st.status === 'failed') {
                failed++;
                failedSet.add(st.key);
                continue;
            }
            if (st.status === 'analysed') analysed++;
            else pending++;
            if (eligible(st)) eligibleSet.add(st.key);
            else {
                pendingSet.add(st.key);
                if (st.status === 'analysed') unclustered++;
            }
        }
        let stage;
        if (pending === 0 && unclustered === 0 && !reclusterBusy()) stage = 'final';
        else if (eligibleSet.size === 0) stage = 'provisional';
        else stage = 'partial';
        tallyCache = { revision, present, pendingSet, failedSet, eligibleSet, total, missing, pending, failed, analysed, stage };
        return tallyCache;
    }

    function compose(preset) {
        const K = modeConstants(mode);
        const t = K.PRESETS[preset];
        const { present, pendingSet, failedSet, eligibleSet, total, missing, pending, failed, analysed, stage } = tally();
        const analysedGroups = [];
        if (base) {
            for (const indices of cutsAt(t)) {
                if (indices.length < 2) continue;
                const members = [];
                for (const i of indices) {
                    const key = base.keys[i];
                    if (eligibleSet.has(key)) members.push(key);
                }
                if (members.length >= 2) analysedGroups.push(members);
            }
        }
        const attached = C.attachProvisional(analysedGroups, batchesFor(present), pendingSet, { failed: failedSet });
        const groups = attached.map(group => shapeGroup(group, preset, K, eligibleSet))
            .sort((a, b) => b.latestAt - a.latestAt || compareStrings(a.id, b.id));
        const inGroup = new Set();
        for (const group of groups) for (const key of group.members) inGroup.add(key);
        const singles = present.filter(st => !inGroup.has(st.key)).sort(newestFirst).map(st => st.key);
        return {
            version: 3,
            revision,
            mode,
            modeReason: mode === 'hd' ? null : modeReason,
            featureVersion,
            preset,
            thresholds: { ...K.PRESETS },
            stage,
            groups,
            singles,
            missing,
            failed,
            pending,
            analyzed: analysed,
            total,
            stats: null,
            error: lastError
        };
    }

    function composeCached(preset) {
        let snapshot = composeCache.get(preset);
        if (!snapshot) {
            snapshot = compose(preset);
            composeCache.set(preset, snapshot);
        }
        return snapshot;
    }

    function normalisePreset(preset) {
        return PRESET_NAMES.includes(preset) ? preset : 'standard';
    }

    function assertReady() {
        if (!initialised) throw new Error('similarity engine not initialised');
        if (closed) throw new Error('similarity engine closed');
    }

    function get({ preset, foreground = false, since } = {}) {
        assertReady();
        const name = normalisePreset(preset);
        if (foreground) markForeground();
        if (since !== undefined && since !== null && Number(since) === revision) {
            stats.cacheHits++;
            return { notModified: true, revision };
        }
        const snapshot = composeCached(name);
        return { ...snapshot, stats: { ...stats } };
    }

    // --- notices ---------------------------------------------------------------------------------------------------

    function scheduleNotice() {
        if (closed || !initialised || typeof onNotice !== 'function' || noticeTimer !== null || noticeQueued) return;
        const wait = lastNoticeAt + o.pushIntervalMs - now();
        if (wait <= 0) {
            noticeQueued = true;
            Promise.resolve().then(emitNotice);
        } else {
            noticeTimer = setTimer(emitNotice, wait);
        }
    }

    function emitNotice() {
        noticeTimer = null;
        noticeQueued = false;
        if (closed) return;
        lastNoticeAt = now();
        try {
            const snapshot = composeCached('standard');
            onNotice({
                revision,
                stage: snapshot.stage,
                mode,
                pending: snapshot.pending,
                analyzed: snapshot.analyzed,
                total: snapshot.total,
                groupCount: snapshot.groups.length
            });
        } catch (error) {
            fail('similarity notice failed', error); // runs in a microtask: never let it reject
        }
    }

    // --- neighbours ----------------------------------------------------------------------------------------------

    function liveItems() {
        if (liveCache && liveCache.version === analysedVersion && liveCache.mode === mode && liveCache.cannot === cannotVersion) {
            return liveCache.items;
        }
        let items = null;
        if (base && base.mode === mode && base.analysedVersion === analysedVersion && base.cannotVersion === cannotVersion) {
            items = baseItems(base);
        }
        if (!items) {
            const states = analysedStates();
            const rows = [];
            const used = [];
            for (const st of states) {
                const row = rowFor(st);
                if (!row) continue;
                rows.push(row);
                used.push(st);
            }
            items = C.buildItems(rows, { mode, cannotLink: cannotLinkPairsForKeys(used) });
        }
        liveCache = { version: analysedVersion, mode, cannot: cannotVersion, items };
        return items;
    }

    function waitSettled(st, ms) {
        return new Promise(resolve => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearTimer(timer);
                const set = waiters.get(st.key);
                if (set) {
                    set.delete(finish);
                    if (!set.size) waiters.delete(st.key);
                }
                resolve();
            };
            const timer = clock.setTimeout(finish, ms);
            if (!waiters.has(st.key)) waiters.set(st.key, new Set());
            waiters.get(st.key).add(finish);
        });
    }

    function groupIndex(preset) {
        const snapshot = composeCached(preset);
        const index = new Map();
        snapshot.groups.forEach((group, i) => { for (const key of group.members) index.set(key, i); });
        return index;
    }

    async function neighbors({ key, preset, mode: kind = 'combined', limit = 60, samePromptOnly = false } = {}) {
        assertReady();
        activity();
        const name = normalisePreset(preset);
        const view = kind === 'visual' ? 'visual' : 'combined';
        const st = keys.get(String(key === undefined || key === null ? '' : key));
        if (!st || st.status === 'missing') return { items: [], analyzed: false, mode };
        if (st.status !== 'analysed') {
            if (st.status === 'pending' || st.status === 'unvalidated') {
                prioritise(st);
                await waitSettled(st, o.neighborWaitMs);
            }
            if (closed) return { items: [], analyzed: false, mode };
            if (st.status !== 'analysed') return samePromptFallback(st, name, limit);
        }
        const items = liveItems();
        const idx = items.indexOf.get(st.key);
        if (idx === undefined) return samePromptFallback(st, name, limit);
        const groups = groupIndex(name);
        const result = C.neighbors(items, idx, {
            mode: view,
            preset: name,
            limit,
            samePromptOnly: Boolean(samePromptOnly),
            groupOf: i => groups.get(items.keys[i])
        });
        return {
            items: result.map(entry => ({
                key: items.keys[entry.idx],
                similarity: entry.similarity,
                samePrompt: entry.samePrompt,
                nearPrompt: entry.nearPrompt,
                sameGroup: entry.sameGroup
            })),
            analyzed: true,
            mode
        };
    }

    // 以图搜图: neighbours of an image file that need not be in the library. Its row is computed the
    // way the backfill computes one and is never stored. Visual only (the query has no prompt):
    // hd ranks by DINOv2 cosine >= HD.VISUAL_COS_MIN, h by the colour/layout value <= H.VISUAL_V_MAX.
    // match: 'whole' (the picture as a whole) | 'element' (包含相同元素: the query's subject against the
    // whole image and each of its 9 crops, best of 10). Element needs hd and the crop store; without them
    // it answers as whole and says so (`element: false`).
    async function neighborsOfImage({ path: imagePath, limit = 60, match = 'whole' } = {}) {
        assertReady();
        activity();
        const file = String(imagePath || '');
        if (!file) throw new TypeError('neighborsOfImage needs a path');
        const cap = limit === null || limit === undefined || Number.isNaN(Number(limit)) ? 60 : Math.max(0, Math.floor(Number(limit)));
        const element = match === 'element' && cropsEnabled() && typeof decoder.decodeSubject === 'function';
        let timer = null;
        const deadline = new Promise((_, reject) => {
            timer = setTimer(() => reject(new Error('图片分析超时，请稍后再试')), o.imageQueryMs);
        });
        let query;
        try {
            query = await Promise.race([element ? subjectQuery(file) : imageQueryRow(file), deadline]);
        } finally {
            clearTimer(timer);
        }
        if (closed) return { items: [], analyzed: false, mode };
        if (element) return elementNeighbors(query, cap);
        const items = liveItems();
        // The mode can switch (hd → h) while the query image was being embedded.
        if (query.q ? !items.q : !items.h) return { items: [], analyzed: false, mode };
        const hits = [];
        if (query.q) {
            const dim = items.dim;
            for (let j = 0; j < items.n; j++) {
                const value = cosQ(query.q, query.inv, items.q.subarray(j * dim, (j + 1) * dim), items.inv[j]);
                if (value >= HD.VISUAL_COS_MIN) hits.push({ j, value });
            }
            hits.sort((x, y) => y.value - x.value || x.j - y.j);
        } else {
            for (let j = 0; j < items.n; j++) {
                const value = visualH(query.h, items.h[j]);
                if (value <= H.VISUAL_V_MAX) hits.push({ j, value });
            }
            hits.sort((x, y) => x.value - y.value || x.j - y.j);
        }
        return {
            items: hits.slice(0, cap).map(({ j, value }) => ({
                key: items.keys[j],
                similarity: query.q ? Math.round(100 * value) : Math.round(100 * (1 - value / 2)),
                samePrompt: false,
                nearPrompt: false,
                sameGroup: false
            })),
            analyzed: true,
            element: false,
            indexed: items.n,
            mode
        };
    }

    async function subjectQuery(file) {
        const subject = await decoder.decodeSubject({ originalPath: file });
        lastEmbedAt = now();
        try {
            return { vector: await embedder.embed(subject.rgb224, subject.mask), subjectPatches: subject.subjectPatches };
        } finally {
            touchEmbedder();
        }
    }

    function elementNeighbors({ vector, subjectPatches }, cap) {
        const items = liveItems();
        if (!items.q) return { items: [], analyzed: false, mode };
        const dim = items.dim;
        const scores = [];
        let cropped = 0;
        for (let j = 0; j < items.n; j++) {
            let dot = 0;
            const offset = j * dim;
            for (let d = 0; d < dim; d++) dot += vector[d] * items.q[offset + d];
            let best = dot * items.inv[j];
            const st = keys.get(items.keys[j]);
            const crops = st ? cropStore.get(st.fk, st.crc) : null;
            if (crops) {
                cropped++;
                for (let c = 0; c < crops.inv.length; c++) {
                    let cropDot = 0;
                    const at = c * dim;
                    for (let d = 0; d < dim; d++) cropDot += vector[d] * crops.q[at + d];
                    const value = cropDot * crops.inv[c];
                    if (value > best) best = value;
                }
            }
            scores.push({ j, value: best });
        }
        scores.sort((x, y) => y.value - x.value || x.j - y.j);
        const top = scores.length ? scores[0].value : 0;
        const cut = Math.max(o.elementMin, top - o.elementSpread);
        return {
            items: scores.filter(entry => entry.value >= cut).slice(0, cap).map(({ j, value }) => ({
                key: items.keys[j],
                similarity: Math.round(100 * value),
                samePrompt: false,
                nearPrompt: false,
                sameGroup: false
            })),
            analyzed: true,
            element: true,
            indexed: items.n,
            cropped,
            subjectPatches,
            mode
        };
    }

    async function imageQueryRow(file) {
        const decoded = await decoder.decode({ originalPath: file });
        const colour = F.colourFeatures(decoded.rgb64);
        const phash = F.phash256(decoded.rgb64);
        let q = null;
        let inv = 0;
        let flags = F.FLAGS.OK;
        if (mode === 'hd' && embedder) {
            lastEmbedAt = now();
            try {
                ({ q, inv } = F.quantizeEmbedding(await embedder.embed(decoded.rgb224)));
            } finally {
                touchEmbedder();
            }
            flags |= F.FLAGS.DINO_OK;
        }
        // Through pack/unpack so the query sees exactly the precision a stored row has.
        const unpacked = F.unpackRow(F.packRow({
            hsv: colour.hsv,
            lab: colour.lab,
            layout: colour.layout,
            logR: decoded.logR,
            whiteFrac: colour.whiteFrac,
            phash,
            q,
            inv
        }, flags));
        return mode === 'hd' && q
            ? { q: Int8Array.from(unpacked.q), inv: unpacked.inv, h: null }
            : { q: null, inv: 0, h: hPart(unpacked) };
    }

    function samePromptFallback(st, preset, limit) {
        const cap = limit === null || limit === undefined || Number.isNaN(Number(limit)) ? 60 : Math.max(0, Math.floor(Number(limit)));
        if (!st.np || cap === 0) return { items: [], analyzed: false, mode };
        const groups = groupIndex(preset);
        const own = groups.get(st.key);
        const matches = [];
        for (const other of keys.values()) {
            if (other === st || other.status === 'missing' || other.np !== st.np) continue;
            matches.push(other);
        }
        matches.sort(newestFirst);
        return {
            items: matches.slice(0, cap).map(other => ({
                key: other.key,
                similarity: null,
                samePrompt: true,
                nearPrompt: false,
                sameGroup: own !== undefined && groups.get(other.key) === own
            })),
            analyzed: false,
            mode
        };
    }

    // --- overrides -------------------------------------------------------------------------------------------------

    function findGroup(groupId, key, preset) {
        const snapshot = composeCached(normalisePreset(preset));
        return snapshot.groups.find(group => group.id === groupId && (!key || group.members.includes(key)))
            || (key ? snapshot.groups.find(group => group.members.includes(key)) : null)
            || null;
    }

    function fkOf(key) {
        const st = keys.get(key);
        return st ? st.fk : null;
    }

    function saveOverride(kind, value) {
        overrides = { ...overrides, [kind]: store.setOverride(kind, value)[kind] };
        if (kind === 'cannotLink') {
            cannotVersion++;
            liveCache = null;
        }
    }

    async function override({ op, key, groupId, preset } = {}) {
        assertReady();
        activity();
        const name = key === undefined || key === null ? '' : String(key);
        const st = name ? keys.get(name) : null;
        if (op === 'setCover') {
            if (!st || st.status === 'missing') return { revision };
            const group = findGroup(groupId, name, preset);
            const covers = { ...overrides.covers };
            for (const member of group ? group.members : []) {
                const fk = fkOf(member);
                if (fk && member !== name) delete covers[fk];
            }
            covers[st.fk] = now();
            saveOverride('covers', covers);
            bumpRevision();
            return { revision };
        }
        if (op === 'detach') {
            if (!st || st.status === 'missing') return { revision };
            const group = findGroup(groupId, name, preset);
            if (!group) return { revision };
            const pairs = overrides.cannotLink.map(pair => [...pair]);
            for (const member of group.members) {
                const fk = fkOf(member);
                if (member !== name && fk && fk !== st.fk) pairs.push([st.fk, fk]);
            }
            saveOverride('cannotLink', pairs);
            if (overrides.covers[st.fk] !== undefined) {
                const covers = { ...overrides.covers };
                delete covers[st.fk];
                saveOverride('covers', covers);
            }
            await reclusterBounded();
            bumpRevision();
            return { revision };
        }
        if (op === 'reset') {
            let targets = [];
            if (st) targets = [st.fk];
            else if (groupId) {
                const group = findGroup(groupId, '', preset);
                targets = group ? group.members.map(fkOf).filter(Boolean) : [];
            }
            if (!targets.length) return { revision };
            const drop = new Set(targets);
            const covers = { ...overrides.covers };
            let coverChanged = false;
            for (const fk of drop) {
                if (covers[fk] !== undefined) {
                    delete covers[fk];
                    coverChanged = true;
                }
            }
            const pairs = overrides.cannotLink.filter(([a, b]) => !drop.has(a) && !drop.has(b));
            const linkChanged = pairs.length !== overrides.cannotLink.length;
            if (coverChanged) saveOverride('covers', covers);
            if (linkChanged) {
                saveOverride('cannotLink', pairs);
                forceFullEdges = true; // a removed cannot-link pair needs its edge back
                await reclusterBounded();
            }
            if (coverChanged || linkChanged) bumpRevision();
            return { revision };
        }
        throw new TypeError(`unknown similarity override op ${op}`);
    }

    // --- load ---------------------------------------------------------------------------------------------------------

    function setLoad({ saving, onBattery: battery, foreground } = {}) {
        if (saving !== undefined && saving !== null) savingCount = Math.max(0, Number(saving) || 0);
        if (battery !== undefined && battery !== null) onBattery = Boolean(battery);
        if (foreground) markForeground();
        pumpLanes();
        if (savingCount === 0 && lanesRunning === 0) scheduleCrops();
    }

    // --- status -------------------------------------------------------------------------------------------------------

    function status() {
        const snapshot = initialised ? tally() : null;
        return {
            mode,
            modeReason: mode === 'hd' ? null : modeReason,
            ortVersion,
            featureVersion,
            embVersion,
            initialised,
            stage: snapshot ? snapshot.stage : 'provisional',
            revision,
            pending: snapshot ? snapshot.pending : 0,
            analyzed: snapshot ? snapshot.analysed : 0,
            failed: snapshot ? snapshot.failed : 0,
            missing: snapshot ? snapshot.missing : 0,
            total: snapshot ? snapshot.total : 0,
            lanes: lanesRunning,
            validating: validateActive + validateQueue.length,
            sessionLoaded: Boolean(embedder && embedder.loaded),
            crops: initialised ? cropProgress() : { enabled: false, ready: 0, total: 0 },
            stats: { ...stats },
            error: lastError
        };
    }

    // --- lifecycle ----------------------------------------------------------------------------------------------------

    async function decideMode() {
        if (!o.ort || !embedder) {
            mode = 'h';
            modeReason = o.ortReason || 'disabled';
            return;
        }
        let result;
        try {
            result = await embedder.load();
        } catch (error) {
            result = { ok: false, reason: 'session-failed', message: errorMessage(error) };
        }
        if (result && result.ok) {
            mode = 'hd';
            modeReason = null;
            ortVersion = result.ortVersion || null;
            embVersion = String(result.embVersion || '');
            featureVersion = `${F.H_VERSION}+${embVersion}`;
        } else {
            mode = 'h';
            modeReason = (result && result.reason) || 'session-failed';
            report('warn', 'similarity visual model unavailable', { reason: modeReason, message: result && result.message });
        }
    }

    async function openStoreWithRetry() {
        let lastFailure;
        for (let attempt = 1; attempt <= STORE_OPEN_ATTEMPTS; attempt++) {
            try {
                return await openStore({ dir: storeDir, fs, embVersion: mode === 'hd' ? embVersion : '', now, log });
            } catch (error) {
                lastFailure = error;
                if (attempt < STORE_OPEN_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, STORE_RETRY_MS * attempt));
            }
        }
        throw lastFailure;
    }

    function init() {
        if (initPromise) return initPromise;
        initPromise = (async () => {
            await decideMode();
            store = await openStoreWithRetry();
            overrides = store.overrides();
            pcaBasis = await store.loadPca();
            if (mode === 'hd' && o.crops && typeof decoder.decodeCrops === 'function') {
                try {
                    cropStore = await openCropStore({ dir: storeDir, fs, embVersion, log: (level, message, data) => report(level, message, data) });
                } catch (error) {
                    warn('similarity crop store unavailable', { message: errorMessage(error) });
                }
            }
            adoptSaved(await store.loadGroups());
            initialised = true;
            updatePriority();
            emitMode();
            if (mode === 'hd') touchEmbedder();
            // A foreground hint that arrived before init has opened the backfill already.
            if (o.backfillDelayMs > 0 && !backfillOpen) backfillTimer = setTimer(openBackfill, o.backfillDelayMs);
            else backfillOpen = true;
            pumpValidation();
            return { mode, modeReason: mode === 'hd' ? null : modeReason, ortVersion, featureVersion, embVersion };
        })();
        return initPromise;
    }

    function close() {
        if (closing) return closing;
        closed = true;
        for (const timer of [backfillTimer, foregroundTimer, releaseTimer, idleEdgeTimer, compactTimer, debounceTimer, noticeTimer, groupsSaveTimer, cropTimer]) clearTimer(timer);
        backfillTimer = foregroundTimer = releaseTimer = idleEdgeTimer = compactTimer = debounceTimer = noticeTimer = groupsSaveTimer = cropTimer = null;
        for (const set of waiters.values()) for (const resolve of set) resolve();
        waiters.clear();
        closing = (async () => {
            if (initPromise) await initPromise.catch(() => {});
            await Promise.allSettled([...inflight]);
            if (reclusterRunning) await reclusterRunning.catch(() => {});
            if (store) {
                await (unsavedRetry || retryUnsaved()); // a last try; rows still unwritten are re-extracted next launch
                if (groupsDirty && base && !base.fromSaved) {
                    groupsDirty = true;
                    await saveGroups();
                }
                await store.close().catch(error => warn('similarity store close failed', { message: errorMessage(error) }));
            }
            if (cropStore) await cropStore.close().catch(() => {});
            if (embedder && typeof embedder.release === 'function') await Promise.resolve(embedder.release()).catch(() => {});
        })();
        return closing;
    }

    return {
        init,
        syncRecords,
        get,
        neighbors,
        neighborsOfImage,
        override,
        setLoad,
        status,
        close
    };
}

module.exports = { createSimilarityEngine, snapshotDigest, ENGINE, PRESET_NAMES };
