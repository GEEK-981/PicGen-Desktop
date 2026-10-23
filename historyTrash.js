// The in-app recycle bin (应用内回收站) for history images.
//
// Deleting from history only MARKS an image: its file stays where it is, its record leaves the index
// (and with it the similarity index) and a bin entry keeps the record. Restoring puts the record back
// with its prompt; purging (彻底删除 / 清空) hard-deletes the file with fs.unlink. Nothing here uses
// the Windows Recycle Bin.
//
// Order matters for crash safety: a mark saves the bin entries before it commits the index without
// the records, a restore commits the index before it drops the entries. Whatever point a crash hits,
// the next load converges: a history record whose path is in the bin is taken out of history, and
// orphan discovery never re-adds a binned file. A bin entry is dropped only once its file is provably
// gone (lstat ENOENT); entries are never pruned by age or count, since an evicted entry's file would be
// re-discovered into history.
const path = require('node:path');
const crypto = require('node:crypto');

const { createSerialTaskQueue } = require('./historyPersistence');
const { pathKey, isProtected, isTrashableImageName } = require('./historyUsage');
const { writeJsonFileAtomic, readJsonDocument, moveAside, reportTo, timestampSuffix } = require('./historyUsageStore');

const TOMBSTONE_FILE_NAME = 'history-trash.json';
const BIN_VERSION = 2;
const MAX_TRASH_ITEMS = 1000;
const MAX_BIN_PATHS = 100000;
const PURGE_CHUNK = 50;
const PROGRESS_EVERY = 10;
const PROGRESS_MIN_BATCH = 20;
const EXISTS_CONCURRENCY = 16;
const REMEMBERED_REQUESTS = 200;
const REASONS = new Set(['group-cleanup', 'selection', 'drag']);
const STAT_FAILED_MESSAGE = '无法读取文件状态，未移到回收站';
const RESTORE_STAT_FAILED_MESSAGE = '无法读取文件状态，未还原';
const RESTORE_NOT_A_FILE_MESSAGE = '该位置已不是图片文件，未还原';
const PURGE_FAILED_MESSAGE = '无法彻底删除（文件可能被占用或没有权限）';
const PURGE_NOT_A_FILE_MESSAGE = '不是普通图片文件，未删除';
const TRANSIENT_FIELDS = ['url', 'thumbnailUrl', 'dragCount', 'referenceCount', 'lastUsedAt', 'lastUsedKind'];

function serializeTombstoneRecord(record) {
    const stored = { ...(record || {}) };
    for (const field of TRANSIENT_FIELDS) delete stored[field];
    return stored;
}

function byCreatedAtDesc(left, right) {
    return Number(right.createdAt || 0) - Number(left.createdAt || 0);
}

function resolvedKey(filePath) {
    return pathKey(path.resolve(String(filePath || '')));
}

// lstat-based presence check. Only ENOENT proves the file is gone; any other error (EPERM,
// EACCES, EBUSY…) may hide a file that is still on disk, so it is reported as 'unknown' and
// callers must never treat it as gone.
// → {state:'present', stat} | {state:'gone'} | {state:'unknown', error}
async function statPresence(fsImpl, filePath) {
    try {
        const stat = await fsImpl.lstat(filePath);
        return { state: 'present', stat };
    } catch (error) {
        return error?.code === 'ENOENT' ? { state: 'gone' } : { state: 'unknown', error };
    }
}

// Existence of many paths with bounded concurrency → Map<pathKey, boolean>.
// probe(path) may return a boolean or a promise; a throwing probe counts as "absent".
async function probeExistence(paths, probe, concurrency = EXISTS_CONCURRENCY) {
    const unique = new Map();
    for (const filePath of paths || []) unique.set(pathKey(filePath), filePath);
    const pending = [...unique];
    const result = new Map();
    let next = 0;
    async function worker() {
        while (next < pending.length) {
            const [key, filePath] = pending[next++];
            let present = false;
            try { present = Boolean(await probe(filePath)); } catch { present = false; }
            result.set(key, present);
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), pending.length) }, worker));
    return result;
}

// Bin entries whose file is provably gone (lstat ENOENT). Any other lstat error keeps the entry.
async function goneEntries(fsImpl, entries) {
    const gone = new Set();
    await probeExistence(entries.map(entry => entry.path), async filePath => {
        const { state } = await statPresence(fsImpl, filePath);
        if (state === 'gone') gone.add(pathKey(filePath));
        return state !== 'gone';
    });
    return entries.filter(entry => gone.has(pathKey(entry.path)));
}

// Load-time pass, pure apart from lstat: every history record whose path is in the bin leaves history,
// and every binned path is returned so orphan discovery skips it. Entries whose file is gone are
// reported in `gone` (the caller drops them once the index is written); the rest stay in the bin.
async function reconcileHistoryBin({ records, entries, fs: fsImpl = require('fs/promises') } = {}) {
    const list = Array.isArray(records) ? records : [];
    const bin = Array.isArray(entries) ? entries : [];
    if (!bin.length) return { records: list, changed: false, removed: [], binnedPaths: [], gone: [] };
    const binned = new Set(bin.map(entry => resolvedKey(entry.path)));
    const kept = [];
    const removed = [];
    for (const record of list) {
        if (binned.has(resolvedKey(record.filePath))) removed.push(record);
        else kept.push(record);
    }
    return {
        records: removed.length ? kept : list,
        changed: removed.length > 0,
        removed,
        binnedPaths: bin.map(entry => path.resolve(entry.path)),
        gone: await goneEntries(fsImpl, bin)
    };
}

// desktop-cache/history-trash.json: {version:2, entries:[{path, trashedAt, batchId, reason, groupId?, record}]}.
// Version 1 files (Recycle-Bin tombstones, never shipped) are read as bin entries. No pruning.
function createTombstoneStore({ dir, fs = require('fs/promises'), now = Date.now, log } = {}) {
    if (!dir) throw new TypeError('createTombstoneStore needs a dir');
    const file = path.join(dir, TOMBSTONE_FILE_NAME);
    const enqueue = createSerialTaskQueue();
    let entries = [];
    let loadPromise = null;
    let fileWritten = false;
    let dirty = false;

    function normalize(entry, time) {
        if (!entry || typeof entry !== 'object') return null;
        const filePath = String(entry.path || '');
        const record = entry.record && typeof entry.record === 'object' && !Array.isArray(entry.record) ? entry.record : null;
        if (!filePath || !record) return null;
        const normalized = {
            path: filePath,
            trashedAt: Number(entry.trashedAt) || time,
            batchId: String(entry.batchId || ''),
            reason: String(entry.reason || '')
        };
        if (entry.groupId) normalized.groupId = String(entry.groupId);
        normalized.record = record;
        return normalized;
    }

    async function readInitial() {
        const document = await readJsonDocument(fs, file);
        if (document.state === 'missing') return;
        if (document.state === 'ok' && Array.isArray(document.value?.entries)) {
            fileWritten = true;
            const time = Number(now());
            const byPath = new Map();
            for (const raw of document.value.entries) {
                const entry = normalize(raw, time);
                if (entry) byPath.set(pathKey(entry.path), entry);
            }
            entries = [...byPath.values()];
            if (Number(document.value.version) !== BIN_VERSION) dirty = true;
            return;
        }
        const corruptPath = path.join(dir, `history-trash.corrupt-${timestampSuffix(now())}.json`);
        const moved = await moveAside(fs, file, corruptPath);
        fileWritten = !moved;
        reportTo(log, {
            source: 'storage',
            title: '回收站记录损坏，已另存',
            message: `回收站记录不可解析${moved ? `（原文件已另存 ${path.basename(corruptPath)}）` : ''}，此前删除的图片会重新出现在历史中。`,
            operation: 'load-history-trash',
            details: { corruptFile: moved ? corruptPath : file }
        });
    }

    // Idempotent. Rejects (and can be retried) only on an unexpected I/O error.
    function load() {
        if (!loadPromise) {
            loadPromise = readInitial().catch(error => {
                loadPromise = null;
                throw error;
            });
        }
        return loadPromise;
    }

    function list() {
        return entries.slice();
    }

    function has(filePath) {
        const key = pathKey(filePath);
        return entries.some(entry => pathKey(entry.path) === key);
    }

    // Adds or replaces (by path) entries in memory; save() persists them.
    function add(list) {
        const time = Number(now());
        const byPath = new Map(entries.map(entry => [pathKey(entry.path), entry]));
        let added = 0;
        for (const raw of list || []) {
            const entry = normalize(raw, time);
            if (!entry) continue;
            const key = pathKey(entry.path);
            byPath.delete(key);
            byPath.set(key, entry);
            added += 1;
        }
        if (added) {
            entries = [...byPath.values()];
            dirty = true;
        }
        return added;
    }

    function remove(paths) {
        const keys = new Set([...(paths || [])].map(pathKey));
        const next = entries.filter(entry => !keys.has(pathKey(entry.path)));
        const removed = entries.length - next.length;
        if (removed) {
            entries = next;
            dirty = true;
        }
        return removed;
    }

    // Writes only when something changed; never creates the file just to store an empty list.
    function save() {
        return enqueue(async () => {
            if (!dirty) return false;
            if (!fileWritten && entries.length === 0) {
                dirty = false;
                return false;
            }
            const snapshot = { version: BIN_VERSION, entries: entries.slice() };
            dirty = false;
            try {
                await writeJsonFileAtomic(fs, file, snapshot);
                fileWritten = true;
                return true;
            } catch (error) {
                dirty = true;
                throw error;
            }
        });
    }

    return { load, list, has, add, remove, save };
}

function validateTrashPayload(payload) {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid trash payload');
    const { requestId, items, includeProtected, confirmProtected, reason, groupId } = payload;
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) {
        throw new TypeError('Trash payload needs a requestId');
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_TRASH_ITEMS) {
        throw new TypeError(`Trash payload needs 1..${MAX_TRASH_ITEMS} items`);
    }
    const cleanItems = items.map(item => {
        if (!item || typeof item.id !== 'string' || !item.id || typeof item.filePath !== 'string' || !item.filePath) {
            throw new TypeError('Each trash item needs an id and a filePath');
        }
        return { id: item.id, filePath: item.filePath };
    });
    const confirmed = confirmProtected ?? [];
    if (!Array.isArray(confirmed) || confirmed.some(id => typeof id !== 'string')) {
        throw new TypeError('confirmProtected must be an array of ids');
    }
    if (includeProtected != null && typeof includeProtected !== 'boolean') throw new TypeError('includeProtected must be a boolean');
    if (!REASONS.has(reason)) throw new TypeError(`Invalid trash reason: ${reason}`);
    if (groupId != null && typeof groupId !== 'string') throw new TypeError('groupId must be a string');
    return {
        requestId,
        items: cleanItems,
        includeProtected: includeProtected === true,
        confirmProtected: new Set(confirmed),
        reason,
        groupId: groupId || ''
    };
}

// {paths} for restore/purge: omitted or null = the whole bin, else 1..MAX_BIN_PATHS non-empty strings.
// → null (everything) | string[]
function validateBinPaths(payload) {
    const paths = payload == null ? null : payload.paths;
    if (payload != null && typeof payload !== 'object') throw new TypeError('Invalid bin payload');
    if (paths == null) return null;
    if (!Array.isArray(paths) || paths.length > MAX_BIN_PATHS || paths.some(entry => typeof entry !== 'string' || !entry)) {
        throw new TypeError(`paths must be an array of up to ${MAX_BIN_PATHS} file paths`);
    }
    return paths;
}

// Queue contract (electron-main.js wiring):
// - `enqueue` is the history mutation queue (enqueueHistoryMutation). trash(), restore() and purge()
//   put their own steps on it, so they must NEVER be called from inside a task running on that queue:
//   the outer task would wait for a step queued behind itself, and every later history save would hang
//   (deadlock). Call them directly from the IPC handler.
// - `loadIndex` and `commit` run inside those queued steps, so they must be the raw, un-queued
//   functions (loadHistoryIndex, commitHistoryImages), never wrappers that enqueue.
// - list(), count() and sweep() never touch the index and never enqueue.
function createHistoryTrash({
    loadIndex,
    commit,
    enqueue,
    usageStore,
    tombstones,
    fs = require('fs/promises'),
    unlink,
    hydrate,
    log,
    now = Date.now,
    onProgress,
    onChanged,
    onBinChanged,
    onPurged
} = {}) {
    for (const [name, value] of Object.entries({ loadIndex, commit, enqueue })) {
        if (typeof value !== 'function') throw new TypeError(`createHistoryTrash needs ${name}()`);
    }
    if (typeof usageStore?.get !== 'function') throw new TypeError('createHistoryTrash needs a usageStore');
    if (!tombstones || typeof tombstones.add !== 'function') throw new TypeError('createHistoryTrash needs a bin store');
    const unlinkFile = typeof unlink === 'function' ? unlink : filePath => fs.unlink(filePath);

    const requests = new Map(); // requestId -> Promise<result>

    function emit(callback, event) {
        if (typeof callback !== 'function') return;
        try { callback(event); } catch { /* a closed window must not break the bin */ }
    }

    function emitBinChanged() {
        emit(onBinChanged, { total: tombstones.list().length });
    }

    function remember(requestId, promise) {
        requests.set(requestId, promise);
        if (requests.size > REMEMBERED_REQUESTS) requests.delete(requests.keys().next().value);
        promise.catch(() => {
            if (requests.get(requestId) === promise) requests.delete(requestId);
        });
    }

    // Entries for `paths` (null = all), in bin order; unknown paths are ignored.
    function selectEntries(paths) {
        const entries = tombstones.list();
        if (paths == null) return entries;
        const wanted = new Set(paths.map(resolvedKey));
        return entries.filter(entry => wanted.has(resolvedKey(entry.path)));
    }

    // Inside the history queue: match, filter, save bin entries, commit without the records. No file is touched.
    async function mark(request, batchId, result, failures) {
        if (typeof usageStore.load === 'function') await usageStore.load();
        await tombstones.load();
        const current = await loadIndex();
        const records = Array.isArray(current) ? current : [];
        const byId = new Map();
        for (const record of records) {
            if (!byId.has(record.id)) byId.set(record.id, []);
            byId.get(record.id).push(record);
        }

        const seen = new Set();
        const toBin = [];
        const missing = [];
        for (const item of request.items) {
            const key = resolvedKey(item.filePath);
            const dedupe = `${item.id}\n${key}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            // id AND path: after a folder move a stale record and a re-discovered one can share a task id.
            const record = (byId.get(item.id) || []).find(candidate => resolvedKey(candidate.filePath) === key);
            if (!record) {
                result.skipped.push({ id: item.id, filePath: item.filePath, reason: 'not-found' });
                continue;
            }
            // Main's counter is authoritative: an image used after the dialog opened stays.
            if (isProtected(usageStore.get(record)) && !(request.includeProtected && request.confirmProtected.has(item.id))) {
                result.skipped.push({ id: record.id, filePath: record.filePath, reason: 'protected' });
                continue;
            }
            const resolved = path.resolve(record.filePath);
            let stat;
            try {
                stat = await fs.lstat(resolved);
            } catch (error) {
                if (error?.code === 'ENOENT') {
                    missing.push({ record, resolved, key });
                } else {
                    result.failed.push({ id: record.id, filePath: record.filePath, message: STAT_FAILED_MESSAGE });
                    failures.push({ filePath: resolved, message: error?.message || String(error) });
                }
                continue;
            }
            // The bin only ever holds regular image files: never a directory, a link or another file type.
            if (!stat.isFile() || !isTrashableImageName(resolved)) {
                result.skipped.push({ id: record.id, filePath: record.filePath, reason: 'not-a-file' });
                continue;
            }
            toBin.push({ record, resolved, key });
        }

        const removed = [...toBin, ...missing];
        if (!removed.length) return { committed: false, total: records.length };

        const trashedAt = Number(now());
        tombstones.add(toBin.map(entry => ({
            path: entry.resolved,
            trashedAt,
            batchId,
            reason: request.reason,
            ...(request.groupId ? { groupId: request.groupId } : {}),
            record: serializeTombstoneRecord(entry.record)
        })));
        const removedRecords = new Set(removed.map(entry => entry.record));
        const remaining = records.filter(record => !removedRecords.has(record));
        try {
            await tombstones.save();
            await commit(remaining);
        } catch (error) {
            // Roll the entries back, unless the index write itself landed (only a later step of
            // commit failed): then the records are already out of history and belong in the bin.
            const removedKeys = new Set(removed.map(entry => entry.key));
            const landed = await Promise.resolve()
                .then(loadIndex)
                .then(after => Array.isArray(after) && !after.some(record => removedKeys.has(resolvedKey(record.filePath))))
                .catch(() => false);
            if (!landed) {
                tombstones.remove(toBin.map(entry => entry.resolved));
                await tombstones.save().catch(() => {});
            }
            throw error;
        }
        for (const entry of toBin) result.trashed.push({ id: entry.record.id, filePath: entry.record.filePath });
        for (const entry of missing) result.missing.push({ id: entry.record.id, filePath: entry.record.filePath });
        return { committed: true, total: remaining.length };
    }

    async function runTrash(request) {
        const batchId = `trash_${Number(now())}_${crypto.randomBytes(4).toString('hex')}`;
        const result = { batchId, trashed: [], missing: [], failed: [], skipped: [], total: 0 };
        const failures = [];
        const outcome = await enqueue(() => mark(request, batchId, result, failures));
        result.total = outcome.total;
        if (failures.length) {
            reportTo(log, {
                source: 'storage',
                title: '部分图片未能移到回收站',
                message: `${result.failed.length} 张图片未能移到回收站，历史记录已保留。`,
                operation: 'trash-history-images',
                details: { batchId, failed: failures.map(entry => entry.filePath), messages: failures.map(entry => entry.message) }
            });
        }
        if (outcome.committed) {
            const removedIds = [...result.trashed, ...result.missing].map(entry => entry.id);
            emit(onChanged, { reason: 'trashed', removedIds, addedIds: [] });
            if (result.trashed.length) emitBinChanged();
        }
        return result;
    }

    // → {batchId, trashed, missing, failed, skipped, total}; trashed = moved into the bin, missing = file
    // already gone (left history without a bin entry). Idempotent per requestId. Throws only on an
    // invalid payload or when the stores cannot be read or written (then nothing changed).
    // Queues itself on `enqueue`: never call it from inside `enqueue` (deadlock).
    function trash(payload) {
        let request;
        try {
            request = validateTrashPayload(payload);
        } catch (error) {
            return Promise.reject(error);
        }
        const known = requests.get(request.requestId);
        if (known) return known;
        const running = runTrash(request);
        remember(request.requestId, running);
        return running;
    }

    // Drops entries whose file is gone (ENOENT only) → the dropped entries. Never enqueues.
    async function dropGone(entries) {
        const gone = await goneEntries(fs, entries);
        if (!gone.length) return [];
        tombstones.remove(gone.map(entry => entry.path));
        await tombstones.save().catch(error => reportTo(log, {
            source: 'storage',
            title: '回收站记录保存失败',
            message: error?.message || String(error),
            operation: 'sweep-history-bin'
        }));
        emitBinChanged();
        return gone;
    }

    function toItem(entry) {
        const record = { ...(entry.record || {}), filePath: entry.path };
        const hydrated = typeof hydrate === 'function' ? hydrate(record) : record;
        if (!hydrated) return null;
        const item = { ...hydrated, binnedAt: entry.trashedAt, binReason: entry.reason, binBatchId: entry.batchId };
        if (entry.groupId) item.binGroupId = entry.groupId;
        return item;
    }

    // → {items, total}: newest-trashed first; entries whose file is gone are dropped, not listed.
    async function list() {
        await tombstones.load();
        const entries = tombstones.list();
        const gone = new Set((await dropGone(entries)).map(entry => pathKey(entry.path)));
        // Newest-trashed first; within one millisecond the later batch first, within a batch newest image first.
        const items = entries
            .map((entry, index) => ({ entry, index }))
            .filter(({ entry }) => !gone.has(pathKey(entry.path)))
            .sort((left, right) => right.entry.trashedAt - left.entry.trashedAt
                || (left.entry.batchId !== right.entry.batchId ? right.index - left.index : byCreatedAtDesc(left.entry.record, right.entry.record)))
            .map(({ entry }) => toItem(entry))
            .filter(Boolean);
        return { items, total: items.length };
    }

    async function count() {
        await tombstones.load();
        return { total: tombstones.list().length };
    }

    // Focus-time pass → {dropped: [paths], total}. Never touches history.
    async function sweep() {
        await tombstones.load();
        const dropped = await dropGone(tombstones.list());
        return { dropped: dropped.map(entry => entry.path), total: tombstones.list().length };
    }

    // Inside the history queue: re-add the records (createdAt order, no duplicate path), commit, then
    // drop their entries. Entries whose file is gone are dropped and reported in `missing`.
    async function runRestore(paths) {
        await tombstones.load();
        const result = { restored: [], missing: [], failed: [] };
        const back = [];
        const gone = [];
        for (const entry of selectEntries(paths)) {
            const presence = await statPresence(fs, entry.path);
            if (presence.state === 'gone') {
                gone.push(entry);
                result.missing.push(entry.path);
            } else if (presence.state === 'unknown') {
                result.failed.push({ filePath: entry.path, message: RESTORE_STAT_FAILED_MESSAGE });
            } else if (!presence.stat.isFile()) {
                result.failed.push({ filePath: entry.path, message: RESTORE_NOT_A_FILE_MESSAGE });
            } else {
                back.push(entry);
            }
        }
        if (back.length) {
            const current = await loadIndex();
            const records = Array.isArray(current) ? current : [];
            const present = new Set(records.map(record => resolvedKey(record.filePath)));
            const added = [];
            for (const entry of back) {
                const key = resolvedKey(entry.path);
                if (present.has(key)) continue;
                present.add(key);
                added.push({ ...(entry.record || {}), filePath: entry.path });
            }
            // Before the entries go: if this throws, everything is still in the bin.
            if (added.length) await commit([...records, ...added].sort(byCreatedAtDesc));
            result.restored = back.map(entry => entry.record?.id).filter(Boolean);
        }
        const done = [...back, ...gone];
        if (done.length) {
            tombstones.remove(done.map(entry => entry.path));
            // The records are back already; a failed save stays dirty and is retried by the next save.
            await tombstones.save().catch(error => reportTo(log, {
                source: 'storage',
                title: '回收站记录保存失败',
                message: error?.message || String(error),
                operation: 'restore-history-bin'
            }));
        }
        if (back.length) emit(onChanged, { reason: 'restored', removedIds: [], addedIds: result.restored });
        if (done.length) emitBinChanged();
        return result;
    }

    // → {restored: [ids], missing: [paths], failed: [{filePath, message}]}. {paths} omitted/null = all.
    // Queues itself on `enqueue`: never call it from inside `enqueue` (deadlock).
    function restore(payload) {
        let paths;
        try {
            paths = validateBinPaths(payload);
        } catch (error) {
            return Promise.reject(error);
        }
        return enqueue(() => runRestore(paths));
    }

    // One file: lstat guard (a regular image file, never a link or a directory), then fs.unlink.
    // → 'deleted' | {message, detail}
    async function purgeFile(entry) {
        const resolved = path.resolve(entry.path);
        let stat;
        try {
            stat = await fs.lstat(resolved);
        } catch (error) {
            if (error?.code === 'ENOENT') return 'deleted';
            return { message: PURGE_FAILED_MESSAGE, detail: error?.message || String(error) };
        }
        if (!stat.isFile() || !isTrashableImageName(resolved)) {
            return { message: PURGE_NOT_A_FILE_MESSAGE, detail: stat.isSymbolicLink() ? 'symbolic link' : 'not a regular image file' };
        }
        try {
            await unlinkFile(resolved);
        } catch (error) {
            if (error?.code !== 'ENOENT') return { message: PURGE_FAILED_MESSAGE, detail: error?.message || String(error) };
        }
        emit(onPurged, { filePath: resolved, stat });
        return 'deleted';
    }

    async function runPurge(paths) {
        await tombstones.load();
        const batchId = `purge_${Number(now())}_${crypto.randomBytes(4).toString('hex')}`;
        const targets = selectEntries(paths).map(entry => entry.path);
        const result = { deleted: [], failed: [] };
        const failures = [];
        const total = targets.length;
        let done = 0;
        // In chunks on the history queue: serialized with restore and mark, without holding saves up.
        for (let start = 0; start < targets.length; start += PURGE_CHUNK) {
            const chunk = targets.slice(start, start + PURGE_CHUNK);
            await enqueue(async () => {
                const deleted = [];
                const current = new Map(tombstones.list().map(entry => [resolvedKey(entry.path), entry]));
                for (const target of chunk) {
                    const entry = current.get(resolvedKey(target));
                    done += 1;
                    if (!entry) continue; // restored or purged meanwhile
                    const outcome = await purgeFile(entry);
                    if (outcome === 'deleted') {
                        deleted.push(entry.path);
                    } else {
                        result.failed.push({ filePath: entry.path, message: outcome.message });
                        failures.push({ filePath: entry.path, message: outcome.detail });
                    }
                }
                if (deleted.length) {
                    result.deleted.push(...deleted);
                    tombstones.remove(deleted);
                    // The files are gone already; a failed save stays dirty, and a later sweep drops them anyway.
                    await tombstones.save().catch(error => failures.push({ filePath: '', message: `save: ${error?.message || error}` }));
                }
            });
            if (total > PROGRESS_MIN_BATCH) emit(onProgress, { batchId, kind: 'purge', done, total });
        }
        if (failures.length) {
            reportTo(log, {
                source: 'storage',
                title: '部分图片未能彻底删除',
                message: `${result.failed.length} 张图片未能彻底删除，仍留在回收站中。`,
                operation: 'purge-history-bin',
                details: { batchId, failed: failures.map(entry => entry.filePath), messages: failures.map(entry => entry.message) }
            });
        }
        if (result.deleted.length) emitBinChanged();
        return result;
    }

    // → {deleted: [paths], failed: [{filePath, message}]}. {paths} omitted/null = empty the whole bin.
    // A file already gone counts as deleted; a failed one keeps its entry.
    // Queues its chunks on `enqueue`: never call it from inside `enqueue` (deadlock).
    function purge(payload) {
        let paths;
        try {
            paths = validateBinPaths(payload);
        } catch (error) {
            return Promise.reject(error);
        }
        return runPurge(paths);
    }

    return { trash, restore, purge, list, count, sweep };
}

module.exports = {
    createTombstoneStore,
    createHistoryBinStore: createTombstoneStore,
    createHistoryTrash,
    reconcileHistoryBin,
    probeExistence,
    statPresence,
    validateTrashPayload,
    validateBinPaths,
    TOMBSTONE_FILE_NAME,
    STAT_FAILED_MESSAGE,
    PURGE_FAILED_MESSAGE,
    PURGE_NOT_A_FILE_MESSAGE
};
