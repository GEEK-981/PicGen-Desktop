'use strict';

// Persistent feature store for similar-image grouping (v3.1 plan §2.9), used by the
// similarity host. Files in `desktop-cache/similarity/`:
//
//   features-v3.bin   'PGS3', u32 layout = 2, u32 rowBytes = 2164, u32 capacity, then fixed
//                     rows at 16 + r·2164. A row is written with a positional write before the
//                     manifest references it; the whole file is mirrored in memory so reads
//                     are synchronous.
//   manifest-v3.json  {version:3, layout:2, rowBytes:2164, hVersion, embVersion,
//                      rows:{featureKey:[row, status, failCount, mtimeMs, lastPath, crc, flags, orphanedAt]},
//                      free:[row…], overrides:{covers:{featureKey:pinnedAt}, cannotLink:[[fk,fk]…]}}
//                     Written atomically, at most once per 5 s window while dirty, and on close.
//   groups-v3.json    the last snapshot, for instant display at launch.
//   pca32-v1.bin      'PGP1', u32 dims = 32, u32 dim = 384, 64-byte NUL-padded embVersion,
//                     then f32[32·384].
//
// Validation on open:
// - a header magic/layout/rowBytes or hVersion mismatch discards every row (overrides are
//   user choices keyed by featureKey and survive);
// - an embVersion mismatch keeps the rows but clears DINO_OK in the manifest flags. The
//   manifest flags are authoritative for DINO_OK: while they lack it, readRow returns the
//   row with the embedding zeroed and DINO_OK cleared, so the host re-embeds it;
// - a row past the end of the file, or whose stored CRC does not match the manifest, is
//   looked up by CRC among the unclaimed rows (this repairs a crash between the bin and
//   manifest renames of a compaction) and otherwise dropped, i.e. re-extracted;
// - readRow verifies the full CRC-32 and drops a bad row the same way.
// v2 files (similarity-index.json, thumbnails/*.signature.json) are never touched.
//
// fs: a node:fs/promises-compatible object. Used: mkdir, readFile, writeFile, rename, unlink,
// open(path, 'r+') → {write(buffer, offset, length, position), close()}, and readdir
// (optional, only to remove stale temp files).

const path = require('node:path');
const crypto = require('node:crypto');

const { createSerialTaskQueue } = require('./historyPersistence');
const { usageKey } = require('./historyUsage');
const { crc32, ROW_BYTES, OFFSETS, FLAGS, H_VERSION } = require('./similarityFeatures');

const BIN_FILE = 'features-v3.bin';
const MANIFEST_FILE = 'manifest-v3.json';
const GROUPS_FILE = 'groups-v3.json';
const PCA_FILE = 'pca32-v1.bin';
const BIN_MAGIC = 'PGS3';
const PCA_MAGIC = 'PGP1';
const LAYOUT = 2;
const HEADER_BYTES = 16;
const MANIFEST_VERSION = 3;
const GROUPS_VERSION = 3;
const PCA_DIMS = 32;
const PCA_DIM = 384;
const PCA_NAME_BYTES = 64;
const PCA_HEADER_BYTES = 12 + PCA_NAME_BYTES;
const FLUSH_DELAY_MS = 5000;
const ORPHAN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const COMPACT_FREE_RATIO = 0.25;
const COMPACT_IDLE_MS = 60 * 1000;
const STATUSES = new Set(['ok', 'fail']);
const OVERRIDE_KINDS = new Set(['covers', 'cannotLink']);
const MAX_ROW_WARNINGS = 5;
const TEMP_PATTERN = /^\.(?:features-v3\.bin|manifest-v3\.json|groups-v3\.json|pca32-v1\.bin)\..+\.tmp$/;

// The usage sidecar's key: lower(fileName)|size. It carries no directory, so a row survives
// folder moves, portable-profile copies and a trash followed by a restore.
function featureKey(filePath, size) {
    return usageKey({ fileName: path.win32.basename(String(filePath || '')), fileSize: size });
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isU32(value) {
    return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function nonNegative(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function tempPathFor(filePath) {
    return path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );
}

// historyPersistence.writeJsonAtomic's contract (temp file + rename) through an injectable fs.
async function writeFileAtomic(fsImpl, filePath, data) {
    const tempPath = tempPathFor(filePath);
    try {
        await fsImpl.writeFile(tempPath, data, { flag: 'wx' });
        await fsImpl.rename(tempPath, filePath);
    } catch (error) {
        await Promise.resolve().then(() => fsImpl.unlink(tempPath)).catch(() => {});
        throw error;
    }
}

// → {state:'missing'} | {state:'ok', value} | {state:'corrupt'}. Other I/O errors throw, so an
// unreadable (locked) manifest never makes the store discard its rows.
async function readJson(fsImpl, filePath) {
    let raw;
    try {
        raw = await fsImpl.readFile(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return { state: 'missing' };
        throw error;
    }
    try {
        return { state: 'ok', value: JSON.parse(String(raw).replace(/^﻿/, '')) };
    } catch {
        return { state: 'corrupt' };
    }
}

async function readBuffer(fsImpl, filePath) {
    try {
        const data = await fsImpl.readFile(filePath);
        return Buffer.isBuffer(data) ? data : Buffer.from(data);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function removeStaleTemps(fsImpl, dir) {
    if (typeof fsImpl.readdir !== 'function') return;
    let names;
    try {
        names = await fsImpl.readdir(dir);
    } catch {
        return;
    }
    await Promise.all(names.filter(name => TEMP_PATTERN.test(String(name))).map(name =>
        Promise.resolve().then(() => fsImpl.unlink(path.join(dir, String(name)))).catch(() => {})));
}

function binHeader(capacity) {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write(BIN_MAGIC, 0, 'latin1');
    header.writeUInt32LE(LAYOUT, 4);
    header.writeUInt32LE(ROW_BYTES, 8);
    header.writeUInt32LE(capacity >>> 0, 12);
    return header;
}

function binHeaderValid(buffer) {
    return Boolean(buffer) && buffer.length >= HEADER_BYTES
        && buffer.toString('latin1', 0, 4) === BIN_MAGIC
        && buffer.readUInt32LE(4) === LAYOUT
        && buffer.readUInt32LE(8) === ROW_BYTES;
}

function rowStart(row) {
    return HEADER_BYTES + row * ROW_BYTES;
}

function parseEntry(tuple) {
    if (!Array.isArray(tuple) || tuple.length < 7) return null;
    const [row, status, failCount, mtimeMs, lastPath, crc, flags, orphanedAt = 0] = tuple;
    if (!Number.isInteger(row) || row < -1 || !STATUSES.has(status) || (status === 'ok' && row < 0)) return null;
    if (!Number.isInteger(failCount) || failCount < 0 || !isU32(crc) || !isU32(flags)) return null;
    return {
        row,
        status,
        failCount,
        mtimeMs: nonNegative(mtimeMs),
        lastPath: typeof lastPath === 'string' ? lastPath : '',
        crc,
        flags,
        orphanedAt: nonNegative(orphanedAt)
    };
}

function entryTuple(entry) {
    return [entry.row, entry.status, entry.failCount, entry.mtimeMs, entry.lastPath, entry.crc, entry.flags, entry.orphanedAt];
}

function normalizeCovers(value) {
    const covers = {};
    if (!isPlainObject(value)) return covers;
    for (const fk of Object.keys(value).sort()) {
        const pinnedAt = value[fk];
        if (fk && typeof pinnedAt === 'number' && Number.isFinite(pinnedAt)) covers[fk] = pinnedAt;
    }
    return covers;
}

function comparePairs(a, b) {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
}

// Sorted, de-duplicated [a, b] pairs with a < b, so the list is canonical for the warm-start digest.
function normalizeCannotLink(value) {
    const seen = new Set();
    const pairs = [];
    for (const pair of Array.isArray(value) ? value : []) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [a, b] = pair;
        if (typeof a !== 'string' || typeof b !== 'string' || !a || !b || a === b) continue;
        const sorted = a < b ? [a, b] : [b, a];
        const id = `${sorted[0]}\n${sorted[1]}`;
        if (seen.has(id)) continue;
        seen.add(id);
        pairs.push(sorted);
    }
    return pairs.sort(comparePairs);
}

// Without DINO_OK the embedding and inv must be zero (layout 2); the CRC is recomputed.
function stripEmbedding(row) {
    row.fill(0, OFFSETS.q, OFFSETS.flags);
    row.writeUInt32LE((row.readUInt32LE(OFFSETS.flags) & ~FLAGS.DINO_OK) >>> 0, OFFSETS.flags);
    row.writeUInt32LE(crc32(row, 0, OFFSETS.crc), OFFSETS.crc);
    return row;
}

async function openStore({
    dir,
    fs = require('node:fs/promises'),
    rowBytes = ROW_BYTES,
    layout = LAYOUT,
    hVersion = H_VERSION,
    embVersion = '',
    now = Date.now,
    log,
    flushDelayMs = FLUSH_DELAY_MS
} = {}) {
    if (!dir) throw new TypeError('openStore needs a dir');
    if (rowBytes !== ROW_BYTES) throw new TypeError(`openStore: rowBytes must be ${ROW_BYTES}`);
    if (layout !== LAYOUT) throw new TypeError(`openStore: layout must be ${LAYOUT}`);
    if (!hVersion || typeof hVersion !== 'string') throw new TypeError('openStore needs an hVersion');

    const files = {
        bin: path.join(dir, BIN_FILE),
        manifest: path.join(dir, MANIFEST_FILE),
        groups: path.join(dir, GROUPS_FILE),
        pca: path.join(dir, PCA_FILE)
    };

    function report(level, message, data) {
        if (typeof log !== 'function') return;
        try {
            Promise.resolve(log({ level, message, data })).catch(() => {});
        } catch { /* logging never breaks the store */ }
    }

    await fs.mkdir(dir, { recursive: true });
    await removeStaleTemps(fs, dir);
    const manifest = await readJson(fs, files.manifest);
    const bin = await readBuffer(fs, files.bin);

    const doc = manifest.state === 'ok' && isPlainObject(manifest.value) ? manifest.value : null;
    const knownFormat = Boolean(doc) && doc.version === MANIFEST_VERSION;
    const storedEmb = knownFormat && typeof doc.embVersion === 'string' ? doc.embVersion : '';
    // An unknown embVersion (ORT not even installed) adopts the stored one: nothing is invalidated.
    const effectiveEmb = String(embVersion || storedEmb || '');
    const embChanged = Boolean(embVersion) && knownFormat && storedEmb !== embVersion;

    let reset = null;
    if (manifest.state === 'missing') reset = bin ? 'manifest-missing' : null;
    else if (!doc) reset = 'manifest-corrupt';
    else if (doc.version !== MANIFEST_VERSION) reset = 'manifest-version';
    else if (doc.layout !== LAYOUT || doc.rowBytes !== ROW_BYTES) reset = 'manifest-layout';
    else if (doc.hVersion !== hVersion) reset = 'h-version';
    else if (!bin) reset = 'bin-missing';
    else if (!binHeaderValid(bin)) reset = 'bin-header';

    const entries = new Map(); // featureKey -> {row, status, failCount, mtimeMs, lastPath, crc, flags, orphanedAt}
    let free = []; // sorted row indices < capacity that no entry references
    let capacity = 0; // complete row slots in the file
    let image; // in-memory mirror of the bin (at least rowStart(capacity) bytes)
    let overrides = { covers: {}, cannotLink: [] };
    let dirty = false;
    let headerDirty = false;

    if (knownFormat) {
        overrides = {
            covers: normalizeCovers(doc.overrides?.covers),
            cannotLink: normalizeCannotLink(doc.overrides?.cannotLink)
        };
    }

    if (reset !== null || !bin) {
        await writeFileAtomic(fs, files.bin, binHeader(0));
        image = binHeader(0);
        dirty = manifest.state !== 'missing';
        if (reset) report('warn', `similarity feature store reset (${reset})`, { dir, reason: reset });
    } else {
        image = bin;
        const fileRows = Math.floor((bin.length - HEADER_BYTES) / ROW_BYTES);
        const storedCrcAt = row => bin.readUInt32LE(rowStart(row) + OFFSETS.crc);
        const claimed = new Map(); // row -> featureKey
        const lost = [];
        const rawRows = isPlainObject(doc.rows) ? doc.rows : {};
        if (!isPlainObject(doc.rows)) dirty = true;
        for (const fk of Object.keys(rawRows)) {
            const entry = parseEntry(rawRows[fk]);
            if (!fk || !entry) {
                dirty = true;
                continue;
            }
            if (embChanged && (entry.flags & FLAGS.DINO_OK)) {
                entry.flags = (entry.flags & ~FLAGS.DINO_OK) >>> 0;
                dirty = true;
            }
            entries.set(fk, entry);
            if (entry.row < 0) continue;
            if (entry.row < fileRows && !claimed.has(entry.row) && storedCrcAt(entry.row) === entry.crc) claimed.set(entry.row, fk);
            else lost.push(fk);
        }
        if (lost.length) {
            const byCrc = new Map();
            for (let row = 0; row < fileRows; row++) {
                if (claimed.has(row)) continue;
                const crc = storedCrcAt(row);
                if (!byCrc.has(crc)) byCrc.set(crc, []);
                byCrc.get(crc).push(row);
            }
            for (const fk of lost) {
                const entry = entries.get(fk);
                const found = (byCrc.get(entry.crc) || []).find(row => !claimed.has(row)
                    && crc32(bin, rowStart(row), rowStart(row) + OFFSETS.crc) === entry.crc);
                if (found !== undefined) {
                    entry.row = found;
                    claimed.set(found, fk);
                } else if (entry.status === 'fail') {
                    Object.assign(entry, { row: -1, crc: 0, flags: 0 });
                } else {
                    entries.delete(fk);
                }
            }
            dirty = true;
            report('warn', 'similarity feature rows re-validated', { dir, rows: lost.length });
        }
        capacity = fileRows;
        for (let row = 0; row < capacity; row++) if (!claimed.has(row)) free.push(row);
        const storedFree = Array.isArray(doc.free) ? doc.free : [];
        if (storedFree.length !== free.length || storedFree.some((row, index) => row !== free[index])) dirty = true;
        headerDirty = bin.readUInt32LE(12) !== capacity;
    }

    const enqueue = createSerialTaskQueue();
    let handle = null;
    let timer = null;
    let closed = false;
    let closing = null;
    let flushFailureReported = false;

    function assertOpen() {
        if (closed) throw new Error('similarity store is closed');
    }

    function assertKey(fk) {
        if (typeof fk !== 'string' || !fk) throw new TypeError('similarity store: a feature key is required');
    }

    async function openHandle() {
        if (!handle) handle = await fs.open(files.bin, 'r+');
        return handle;
    }

    async function closeHandle() {
        if (!handle) return;
        const current = handle;
        handle = null;
        await current.close();
    }

    function clearTimer() {
        if (timer) clearTimeout(timer);
        timer = null;
    }

    function scheduleFlush() {
        if (timer || closed) return;
        timer = setTimeout(() => {
            timer = null;
            enqueue(() => persist()).then(() => {
                flushFailureReported = false;
            }, error => {
                if (flushFailureReported) return;
                flushFailureReported = true;
                report('error', 'similarity manifest flush failed', { dir, message: error?.message || String(error), code: error?.code || '' });
            });
        }, flushDelayMs);
        timer?.unref?.();
    }

    function markDirty() {
        dirty = true;
        scheduleFlush();
    }

    function takeFreeRow() {
        return free.length ? free.shift() : capacity;
    }

    function freeIndexOf(row) {
        let low = 0;
        let high = free.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (free[mid] < row) low = mid + 1;
            else high = mid;
        }
        return low;
    }

    function releaseRow(row) {
        if (!(row >= 0 && row < capacity)) return;
        const index = freeIndexOf(row);
        if (free[index] !== row) free.splice(index, 0, row);
    }

    function claimRow(row) {
        const index = freeIndexOf(row);
        if (free[index] === row) free.splice(index, 1);
    }

    function rebuildFree() {
        const used = new Set();
        for (const entry of entries.values()) if (entry.row >= 0) used.add(entry.row);
        free = [];
        for (let row = 0; row < capacity; row++) if (!used.has(row)) free.push(row);
    }

    // Grows the mirror in steps of 1/8 (at least 256 rows) so appends stay amortised O(1)
    // without holding much slack at 20k rows.
    function ensureImageRows(rows) {
        const needed = rowStart(rows);
        if (image.length >= needed) return;
        const next = Buffer.alloc(rowStart(Math.max(rows, capacity + Math.max(256, capacity >> 3))));
        image.copy(next, 0, 0, Math.min(image.length, rowStart(capacity)));
        image = next;
    }

    let rowWarnings = 0;
    function invalidate(fk, entry) {
        entries.delete(fk);
        releaseRow(entry.row);
        markDirty();
        if (rowWarnings++ < MAX_ROW_WARNINGS) report('warn', 'similarity feature row failed validation', { key: fk, row: entry.row });
    }

    function manifestDocument() {
        const rows = {};
        for (const [fk, entry] of entries) rows[fk] = entryTuple(entry);
        return {
            version: MANIFEST_VERSION,
            layout: LAYOUT,
            rowBytes: ROW_BYTES,
            hVersion,
            embVersion: effectiveEmb,
            rows,
            free: [...free],
            overrides: copyOverrides()
        };
    }

    // Runs inside the queue, so every row write queued before it has completed. The header's
    // capacity is written before the manifest. A failure keeps the state dirty and retries in 5 s.
    async function persist() {
        clearTimer();
        const wasDirty = dirty;
        try {
            if (headerDirty) {
                const fh = await openHandle();
                await fh.write(binHeader(capacity), 0, HEADER_BYTES, 0);
                headerDirty = false;
            }
            if (!wasDirty) return false;
            dirty = false;
            await writeFileAtomic(fs, files.manifest, JSON.stringify(manifestDocument()));
            return true;
        } catch (error) {
            if (wasDirty) dirty = true;
            scheduleFlush();
            throw error;
        }
    }

    function copyOverrides() {
        return {
            covers: { ...overrides.covers },
            cannotLink: overrides.cannotLink.map(pair => [...pair])
        };
    }

    function meta(fk) {
        assertOpen();
        const entry = entries.get(fk);
        return entry ? { ...entry } : null;
    }

    function keys() {
        assertOpen();
        return [...entries.keys()];
    }

    // → a CRC-checked copy of the row (whatever the status), or null when there is no valid row.
    // A bad row is dropped, so meta() then reports the key as unknown (pending).
    function readRow(fk) {
        assertOpen();
        const entry = entries.get(fk);
        if (!entry || entry.row < 0) return null;
        const start = rowStart(entry.row);
        if (entry.row >= capacity || image.length < start + ROW_BYTES) {
            invalidate(fk, entry);
            return null;
        }
        const row = Buffer.from(image.subarray(start, start + ROW_BYTES));
        const stored = row.readUInt32LE(OFFSETS.crc);
        if (stored !== entry.crc || crc32(row, 0, OFFSETS.crc) !== stored) {
            invalidate(fk, entry);
            return null;
        }
        if ((row.readUInt32LE(OFFSETS.flags) & FLAGS.DINO_OK) && !(entry.flags & FLAGS.DINO_OK)) stripEmbedding(row);
        return row;
    }

    // Writes a packed row (similarityFeatures.packRow) for fk, in place when fk already owns a
    // row, and marks it ok. Resolves with the new meta once the bytes are on disk.
    async function writeRow(fk, buf, { mtimeMs, lastPath, flags } = {}) {
        assertOpen();
        assertKey(fk);
        if (!ArrayBuffer.isView(buf) || buf.byteLength !== ROW_BYTES) throw new TypeError(`writeRow expects a ${ROW_BYTES}-byte row`);
        const row = Buffer.from(buf.buffer.slice(buf.byteOffset, buf.byteOffset + ROW_BYTES));
        const crc = row.readUInt32LE(OFFSETS.crc);
        if (crc32(row, 0, OFFSETS.crc) !== crc) throw new TypeError('writeRow: row CRC mismatch');
        const rowFlags = row.readUInt32LE(OFFSETS.flags);
        if (flags !== undefined && flags !== null && (Number(flags) >>> 0) !== rowFlags) {
            throw new TypeError('writeRow: flags differ from the flags inside the row');
        }
        return enqueue(async () => {
            const existing = entries.get(fk);
            const inPlace = Boolean(existing && existing.row >= 0);
            const index = inPlace ? existing.row : takeFreeRow();
            try {
                const fh = await openHandle();
                await fh.write(row, 0, ROW_BYTES, rowStart(index));
            } catch (error) {
                if (!inPlace) releaseRow(index);
                throw error;
            }
            ensureImageRows(index + 1);
            row.copy(image, rowStart(index));
            if (index >= capacity) {
                capacity = index + 1;
                headerDirty = true;
            }
            claimRow(index); // in case a readRow dropped the old entry while this write was in flight
            const entry = {
                row: index,
                status: 'ok',
                failCount: 0,
                mtimeMs: nonNegative(mtimeMs, existing?.mtimeMs ?? 0),
                lastPath: typeof lastPath === 'string' ? lastPath : (existing?.lastPath || ''),
                crc,
                flags: rowFlags,
                orphanedAt: 0
            };
            entries.set(fk, entry);
            markDirty();
            return { ...entry };
        });
    }

    // Records a failed extraction. An existing row (e.g. valid H features whose embedding failed)
    // stays readable; a later successful writeRow resets the count.
    function markFail(fk, { mtimeMs, lastPath } = {}) {
        assertOpen();
        assertKey(fk);
        let entry = entries.get(fk);
        if (!entry) {
            entry = { row: -1, status: 'fail', failCount: 0, mtimeMs: 0, lastPath: '', crc: 0, flags: 0, orphanedAt: 0 };
            entries.set(fk, entry);
        }
        // Mutated in place: a compaction in flight remaps rows through these same objects.
        entry.status = 'fail';
        entry.failCount += 1;
        entry.mtimeMs = nonNegative(mtimeMs, entry.mtimeMs);
        if (typeof lastPath === 'string') entry.lastPath = lastPath;
        entry.orphanedAt = 0;
        markDirty();
        return { ...entry };
    }

    // Keys absent from presentKeys get orphanedAt (kept once set); present keys lose it.
    function markOrphans(presentKeys, time = now()) {
        assertOpen();
        const present = presentKeys instanceof Set ? presentKeys : new Set(presentKeys || []);
        const at = Math.max(1, Number(time) || 0);
        let orphaned = 0;
        let revived = 0;
        for (const [fk, entry] of entries) {
            if (present.has(fk)) {
                if (entry.orphanedAt) {
                    entry.orphanedAt = 0;
                    revived++;
                }
            } else if (!entry.orphanedAt) {
                entry.orphanedAt = at;
                orphaned++;
            }
        }
        if (orphaned || revived) markDirty();
        return { orphaned, revived };
    }

    // kind 'covers' → {featureKey: pinnedAt}; kind 'cannotLink' → [[fk, fk]…]. Replaces that section.
    function setOverride(kind, value) {
        assertOpen();
        if (!OVERRIDE_KINDS.has(kind)) throw new TypeError(`setOverride: unknown kind ${kind}`);
        overrides = {
            ...overrides,
            [kind]: kind === 'covers' ? normalizeCovers(value) : normalizeCannotLink(value)
        };
        markDirty();
        return copyOverrides();
    }

    function getOverrides() {
        assertOpen();
        return copyOverrides();
    }

    async function saveGroups(obj) {
        assertOpen();
        if (!isPlainObject(obj)) throw new TypeError('saveGroups expects an object');
        const text = JSON.stringify({ ...obj, version: GROUPS_VERSION });
        return enqueue(() => writeFileAtomic(fs, files.groups, text));
    }

    // → the saved snapshot, or null when it is missing, unreadable or of another version.
    async function loadGroups() {
        assertOpen();
        return enqueue(async () => {
            try {
                const result = await readJson(fs, files.groups);
                if (result.state !== 'ok') return null;
                return isPlainObject(result.value) && result.value.version === GROUPS_VERSION ? result.value : null;
            } catch (error) {
                report('warn', 'similarity groups snapshot unreadable', { message: error?.message || String(error) });
                return null;
            }
        });
    }

    async function savePca(basis) {
        assertOpen();
        if (!basis || basis.length !== PCA_DIMS * PCA_DIM) throw new TypeError(`savePca expects ${PCA_DIMS}x${PCA_DIM} values`);
        const name = Buffer.from(effectiveEmb, 'utf8');
        if (name.length > PCA_NAME_BYTES) throw new TypeError('savePca: embVersion is longer than 64 bytes');
        const out = Buffer.alloc(PCA_HEADER_BYTES + basis.length * 4);
        out.write(PCA_MAGIC, 0, 'latin1');
        out.writeUInt32LE(PCA_DIMS, 4);
        out.writeUInt32LE(PCA_DIM, 8);
        name.copy(out, 12);
        for (let i = 0; i < basis.length; i++) {
            const value = Number(basis[i]);
            if (!Number.isFinite(value)) throw new TypeError('savePca: the basis must be finite');
            out.writeFloatLE(value, PCA_HEADER_BYTES + 4 * i);
        }
        return enqueue(() => writeFileAtomic(fs, files.pca, out));
    }

    // → Float32Array(32·384) saved under the current embVersion, or null.
    async function loadPca() {
        assertOpen();
        return enqueue(async () => {
            let buffer;
            try {
                buffer = await readBuffer(fs, files.pca);
            } catch (error) {
                report('warn', 'similarity PCA basis unreadable', { message: error?.message || String(error) });
                return null;
            }
            if (!buffer || buffer.length !== PCA_HEADER_BYTES + PCA_DIMS * PCA_DIM * 4) return null;
            if (buffer.toString('latin1', 0, 4) !== PCA_MAGIC || buffer.readUInt32LE(4) !== PCA_DIMS || buffer.readUInt32LE(8) !== PCA_DIM) return null;
            const name = buffer.subarray(12, PCA_HEADER_BYTES);
            const end = name.indexOf(0);
            if (name.subarray(0, end < 0 ? name.length : end).toString('utf8') !== effectiveEmb) return null;
            const basis = new Float32Array(PCA_DIMS * PCA_DIM);
            for (let i = 0; i < basis.length; i++) {
                const value = buffer.readFloatLE(PCA_HEADER_BYTES + 4 * i);
                if (!Number.isFinite(value)) return null;
                basis[i] = value;
            }
            return basis;
        });
    }

    async function rewriteBin() {
        const live = [...entries].filter(([, entry]) => entry.row >= 0)
            .sort((a, b) => a[1].row - b[1].row)
            .map(([fk, entry]) => [fk, entry.row]);
        const next = Buffer.alloc(rowStart(live.length));
        binHeader(live.length).copy(next, 0);
        live.forEach(([, row], index) => image.copy(next, rowStart(index), rowStart(row), rowStart(row) + ROW_BYTES));
        await closeHandle(); // never rename over a file this process holds open
        await writeFileAtomic(fs, files.bin, next);
        live.forEach(([fk, row], index) => {
            const entry = entries.get(fk);
            if (entry && entry.row === row) entry.row = index;
        });
        image = next;
        capacity = live.length;
        rebuildFree(); // empty unless a readRow dropped an entry during the rename
        headerDirty = false;
        dirty = true;
        // A crash before this manifest lands is repaired on open by the CRC lookup.
        await persist();
    }

    // Frees rows orphaned for 30 days, then rewrites the bin densely when more than 25% of the
    // slots are free and the host has been idle for 60 s (idle: ms since the last activity, or true).
    async function compact({ now: time = now(), idle = 0 } = {}) {
        assertOpen();
        return enqueue(async () => {
            const at = Number(time);
            let expired = 0;
            for (const [fk, entry] of [...entries]) {
                if (entry.orphanedAt > 0 && at - entry.orphanedAt >= ORPHAN_RETENTION_MS) {
                    entries.delete(fk);
                    releaseRow(entry.row);
                    expired++;
                }
            }
            if (expired) markDirty();
            const idleEnough = idle === true || Number(idle) >= COMPACT_IDLE_MS;
            if (!idleEnough || !(capacity > 0 && free.length / capacity > COMPACT_FREE_RATIO)) {
                return { expired, compacted: false, capacity, free: free.length };
            }
            await rewriteBin();
            return { expired, compacted: true, capacity, free: free.length };
        });
    }

    function flush() {
        if (closed) return closing || Promise.resolve(false);
        return enqueue(() => persist());
    }

    function close() {
        if (closing) return closing;
        closed = true;
        clearTimer();
        closing = enqueue(async () => {
            try {
                await persist();
            } finally {
                await closeHandle();
            }
        });
        return closing;
    }

    function stats() {
        let staleEmbeddings = 0;
        for (const entry of entries.values()) {
            if (entry.row < 0 || entry.row >= capacity || (entry.flags & FLAGS.DINO_OK)) continue;
            if (image.readUInt32LE(rowStart(entry.row) + OFFSETS.flags) & FLAGS.DINO_OK) staleEmbeddings++;
        }
        return { entries: entries.size, capacity, free: free.length, hVersion, embVersion: effectiveEmb, staleEmbeddings, reset };
    }

    if (dirty) scheduleFlush();

    return {
        meta,
        keys,
        readRow,
        writeRow,
        markFail,
        markOrphans,
        setOverride,
        overrides: getOverrides,
        saveGroups,
        loadGroups,
        savePca,
        loadPca,
        compact,
        flush,
        close,
        stats
    };
}

module.exports = {
    openStore,
    featureKey,
    BIN_FILE,
    MANIFEST_FILE,
    GROUPS_FILE,
    PCA_FILE,
    LAYOUT,
    HEADER_BYTES,
    FLUSH_DELAY_MS,
    ORPHAN_RETENTION_MS,
    COMPACT_FREE_RATIO,
    COMPACT_IDLE_MS
};
