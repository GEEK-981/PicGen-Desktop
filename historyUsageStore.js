// Usage counters for history images (taken out of PicGen, and in-app AI-input uses), kept in a
// sidecar next to recent-images.json and keyed by lower(fileName)|fileSize, so they survive
// index rebuilds, orphan re-discovery, folder moves and downgrades. The index itself never
// stores these fields; records are projected when they are handed to the renderer.
// dragCount ('drag-out') counts every way an image left PicGen: native drag-out, 复制图片 and 另存为
// (sources 'native-drag' / 'copy' / 'save-as', never persisted). The document stays version 1, so older
// builds keep reading and writing the same counters.
const path = require('node:path');
const crypto = require('node:crypto');

const { createSerialTaskQueue } = require('./historyPersistence');
const { usageKey } = require('./historyUsage');

const FILE_NAME = 'history-usage.json';
const PREV_FILE_NAME = 'history-usage.prev.json';
const KINDS = new Set(['drag-out', 'reference']);
const RECENT_PRUNE_SIZE = 256;

function timestampSuffix(time = Date.now()) {
    return new Date(Number(time) || Date.now()).toISOString().replace(/[:.]/g, '-');
}

// Same contract as historyPersistence.writeJsonAtomic, but through an injectable fs.
async function writeJsonFileAtomic(fsImpl, filePath, value) {
    const directory = path.dirname(filePath);
    const tempPath = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await fsImpl.mkdir(directory, { recursive: true });
    try {
        await fsImpl.writeFile(tempPath, text, { encoding: 'utf8', flag: 'wx' });
        await fsImpl.rename(tempPath, filePath);
    } catch (error) {
        await Promise.resolve().then(() => fsImpl.unlink(tempPath)).catch(() => {});
        throw error;
    }
}

// Unlike historyPersistence.readJsonFile, a parse failure is reported instead of being
// silently replaced by a fallback: these files hold protection data.
// → {state:'missing'} | {state:'ok', value} | {state:'corrupt', error}. Other I/O errors throw.
async function readJsonDocument(fsImpl, filePath) {
    let raw;
    try {
        raw = String(await fsImpl.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return { state: 'missing' };
        throw error;
    }
    if (!raw.trim() || raw.includes('\u0000')) return { state: 'corrupt', error: new Error('empty or NUL-filled file') };
    try {
        return { state: 'ok', value: JSON.parse(raw.replace(/^﻿/, '')) };
    } catch (error) {
        return { state: 'corrupt', error };
    }
}

async function moveAside(fsImpl, filePath, targetPath) {
    try {
        await fsImpl.rename(filePath, targetPath);
        return true;
    } catch {
        try {
            await fsImpl.copyFile(filePath, targetPath);
            return true;
        } catch {
            return false;
        }
    }
}

function reportTo(log, entry) {
    if (typeof log !== 'function') return;
    try {
        Promise.resolve(log(entry)).catch(() => {});
    } catch { /* logging must never break the caller */ }
}

function isUsageDocument(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = value.entries;
    return entries === undefined || (Boolean(entries) && typeof entries === 'object' && !Array.isArray(entries));
}

function count(value) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeUsage(value) {
    if (!value || typeof value !== 'object') return null;
    const usage = {
        dragCount: count(value.dragCount),
        referenceCount: count(value.referenceCount),
        lastUsedAt: Math.max(0, Number(value.lastUsedAt) || 0),
        lastUsedKind: KINDS.has(value.lastUsedKind) ? value.lastUsedKind : ''
    };
    return usage.dragCount + usage.referenceCount > 0 ? usage : null;
}

function nameOfKey(key) {
    const bar = key.lastIndexOf('|');
    return bar < 0 ? key : key.slice(0, bar);
}

function createHistoryUsageStore({ dir, fs = require('fs/promises'), now = Date.now, log, coalesceMs = 750 } = {}) {
    if (!dir) throw new TypeError('createHistoryUsageStore needs a dir');
    const file = path.join(dir, FILE_NAME);
    const prevFile = path.join(dir, PREV_FILE_NAME);
    const entries = new Map(); // usageKey -> usage
    const byName = new Map(); // lower(fileName) -> Set<usageKey>, for records whose size is 0
    const recent = new Map(); // `${usageKey}\n${kind}` -> time of the last counted event
    const enqueue = createSerialTaskQueue();
    let loadPromise = null;
    let loaded = false;
    let primaryTrusted = false; // only a file we parsed or wrote ourselves is copied to .prev
    let dirty = false;
    let pendingWrite = null;
    let writeFailureReported = false;

    function setEntry(key, usage) {
        entries.set(key, usage);
        const name = nameOfKey(key);
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name).add(key);
    }

    function ingest(document) {
        for (const [key, value] of Object.entries(document.entries || {})) {
            const usage = normalizeUsage(value);
            if (key && usage) setEntry(key, usage);
        }
    }

    function resolveKey(record) {
        const key = usageKey(record);
        if (!key || entries.has(key)) return key;
        if (!(Number(record?.fileSize) > 0)) {
            const candidates = byName.get(nameOfKey(key));
            if (candidates?.size === 1) return candidates.values().next().value;
        }
        return key;
    }

    async function readInitial() {
        const primary = await readJsonDocument(fs, file);
        if (primary.state === 'ok' && isUsageDocument(primary.value)) {
            ingest(primary.value);
            primaryTrusted = true;
            return;
        }
        if (primary.state === 'missing') {
            // Normal on a fresh profile. A leftover .prev (primary deleted by hand) is still better than zero.
            const prev = await readJsonDocument(fs, prevFile).catch(() => ({ state: 'missing' }));
            if (prev.state === 'ok' && isUsageDocument(prev.value)) ingest(prev.value);
            return;
        }

        const corruptPath = path.join(dir, `history-usage.corrupt-${timestampSuffix(now())}.json`);
        const moved = await moveAside(fs, file, corruptPath);
        const prev = await readJsonDocument(fs, prevFile).catch(() => ({ state: 'missing' }));
        const restored = prev.state === 'ok' && isUsageDocument(prev.value);
        if (restored) ingest(prev.value);
        reportTo(log, {
            source: 'storage',
            title: restored ? '拖用记录损坏，已从备份恢复' : '拖用记录损坏，未找到可用备份',
            message: `拖用记录文件不可解析${moved ? `（原文件已另存 ${path.basename(corruptPath)}）` : ''}。`
                + (restored ? `已从 ${PREV_FILE_NAME} 恢复 ${entries.size} 条记录。` : '没有可用的备份，计数从零开始。'),
            operation: 'load-history-usage',
            details: {
                corruptFile: moved ? corruptPath : file,
                restoredFrom: restored ? prevFile : '',
                entries: entries.size
            }
        });
    }

    // Resolves once the counters are in memory. Rejects (and can be retried) only on an
    // unexpected I/O error, so an unreadable file is never overwritten and never treated as "no use".
    function load() {
        if (!loadPromise) {
            loadPromise = readInitial().then(() => { loaded = true; }, error => {
                loadPromise = null;
                throw error;
            });
        }
        return loadPromise;
    }

    async function persist() {
        if (!dirty) return true;
        dirty = false;
        const document = { version: 1, entries: Object.fromEntries(entries) };
        try {
            if (primaryTrusted) await fs.copyFile(file, prevFile).catch(() => {});
            await writeJsonFileAtomic(fs, file, document);
            primaryTrusted = true;
            return true;
        } catch (error) {
            dirty = true; // the next event or flush retries with the full map
            if (!writeFailureReported) {
                writeFailureReported = true;
                reportTo(log, {
                    source: 'storage',
                    title: '拖用记录保存失败',
                    message: error?.message || String(error),
                    operation: 'save-history-usage',
                    details: { file, code: error?.code || '' }
                });
            }
            return false;
        }
    }

    // One queued write covers every change made before it starts.
    function schedulePersist() {
        if (!pendingWrite) {
            pendingWrite = enqueue(() => {
                pendingWrite = null;
                return persist();
            });
        }
        return pendingWrite;
    }

    function pruneRecent(time) {
        if (recent.size <= RECENT_PRUNE_SIZE) return;
        for (const [id, at] of recent) {
            if (!(time - at < coalesceMs)) recent.delete(id);
        }
    }

    function get(record) {
        if (!loaded) return null;
        const usage = entries.get(resolveKey(record));
        return usage ? { ...usage } : null;
    }

    function project(record) {
        if (!record || typeof record !== 'object') return record;
        const { dragCount: _drag, referenceCount: _reference, lastUsedAt: _at, lastUsedKind: _kind, ...rest } = record;
        const usage = get(rest);
        return usage ? { ...rest, ...usage } : rest;
    }

    async function recordUse(record, kind, _source) {
        if (!KINDS.has(kind)) throw new TypeError(`Unknown history usage kind: ${kind}`);
        if (!usageKey(record)) throw new TypeError('History record has no file name');
        await load();
        const key = resolveKey(record);
        const time = Number(now());
        const coalesceId = `${key}\n${kind}`;
        const last = recent.get(coalesceId);
        const current = entries.get(key) || { dragCount: 0, referenceCount: 0, lastUsedAt: 0, lastUsedKind: '' };
        if (last !== undefined && time >= last && time - last < coalesceMs) {
            return { changed: false, coalesced: true, usageKey: key, usage: { ...current } };
        }
        recent.set(coalesceId, time);
        pruneRecent(time);
        const field = kind === 'drag-out' ? 'dragCount' : 'referenceCount';
        const next = { ...current, [field]: current[field] + 1, lastUsedAt: time, lastUsedKind: kind };
        setEntry(key, next);
        dirty = true;
        await schedulePersist();
        return { changed: true, coalesced: false, usageKey: key, usage: { ...next } };
    }

    // Waits for queued writes and retries a pending one. Never creates a file when nothing was recorded.
    function flush() {
        return enqueue(() => persist());
    }

    return { load, get, project, record: recordUse, flush };
}

module.exports = {
    createHistoryUsageStore,
    writeJsonFileAtomic,
    readJsonDocument,
    moveAside,
    reportTo,
    timestampSuffix,
    USAGE_FILE_NAME: FILE_NAME
};
