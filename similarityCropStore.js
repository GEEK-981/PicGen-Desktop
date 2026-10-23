'use strict';

// Crop embeddings for 包含相同元素 (element search), used by the similarity host next to the
// feature store. One append-only file in `desktop-cache/similarity/`:
//
//   crops-v1.bin   'PGC1', u32 version = 1, u32 crops = 9, u32 dim = 384, 64-byte NUL-padded
//                  embVersion, then records:
//                  u16 keyBytes, key (UTF-8 feature key), u32 rowCrc, crops x i8[dim], crops x f32 inv
//
// A key written again supersedes its earlier record (the last one wins on load). `rowCrc` is the CRC of
// the key's feature row when the crops were made: a different CRC means the image changed, so the
// crops are stale. A header mismatch (another embVersion or layout) starts the file over. A torn tail
// (a crash mid-append) is dropped on load. When superseded and dropped records outweigh the live
// ones, the file is rewritten once (compact()).
//
// fs: a node:fs/promises-compatible object. Used: mkdir, readFile, writeFile, rename,
// open(path, 'r+') → {write(buffer, offset, length, position), close()}.

const path = require('node:path');

const FILE = 'crops-v1.bin';
const MAGIC = 'PGC1';
const VERSION = 1;
const NAME_BYTES = 64;
const HEADER_BYTES = 16 + NAME_BYTES;
const COMPACT_DEAD_RATIO = 0.5;

function headerFor({ crops, dim, embVersion }) {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write(MAGIC, 0, 'latin1');
    header.writeUInt32LE(VERSION, 4);
    header.writeUInt32LE(crops, 8);
    header.writeUInt32LE(dim, 12);
    header.write(String(embVersion).slice(0, NAME_BYTES), 16, 'utf8');
    return header;
}

async function openCropStore({ dir, fs = require('node:fs/promises'), embVersion, crops = 9, dim = 384, log = () => {} } = {}) {
    if (!dir) throw new TypeError('openCropStore needs a dir');
    if (!embVersion) throw new TypeError('openCropStore needs an embVersion');
    const file = path.join(dir, FILE);
    const header = headerFor({ crops, dim, embVersion });
    const vectorBytes = crops * dim + crops * 4;
    const entries = new Map(); // key -> { crc, q: Int8Array(crops*dim), inv: Float32Array(crops) }
    let records = 0;
    let size = 0;
    let queue = Promise.resolve();
    let closed = false;

    await fs.mkdir(dir, { recursive: true });
    let image = null;
    try {
        image = await fs.readFile(file);
    } catch (error) {
        if (error?.code !== 'ENOENT') log('warn', 'crop store unreadable, starting over', { message: error?.message });
    }
    if (image && image.length >= HEADER_BYTES && image.subarray(0, HEADER_BYTES).equals(header)) {
        let offset = HEADER_BYTES;
        while (offset + 2 <= image.length) {
            const keyBytes = image.readUInt16LE(offset);
            const end = offset + 2 + keyBytes + 4 + vectorBytes;
            if (!keyBytes || end > image.length) break; // a torn tail
            const key = image.toString('utf8', offset + 2, offset + 2 + keyBytes);
            const at = offset + 2 + keyBytes;
            const crc = image.readUInt32LE(at);
            const q = new Int8Array(crops * dim);
            q.set(new Int8Array(image.buffer, image.byteOffset + at + 4, crops * dim));
            const inv = new Float32Array(crops);
            for (let c = 0; c < crops; c++) inv[c] = image.readFloatLE(at + 4 + crops * dim + c * 4);
            entries.set(key, { crc, q, inv });
            records++;
            offset = end;
        }
        size = offset;
        if (offset < image.length) {
            // Cut the torn bytes off now: a shorter record appended later would leave some of them behind.
            log('warn', 'crop store had a torn tail', { dropped: image.length - offset });
            await fs.writeFile(file, image.subarray(0, offset));
        }
    } else {
        if (image) log('info', 'crop store reset (layout or embVersion changed)');
        await fs.writeFile(file, header);
        size = HEADER_BYTES;
    }

    function serial(task) {
        const run = queue.then(task, task);
        queue = run.catch(() => {});
        return run;
    }

    function encode(key, { crc, q, inv }) {
        const name = Buffer.from(String(key), 'utf8');
        const out = Buffer.alloc(2 + name.length + 4 + vectorBytes);
        out.writeUInt16LE(name.length, 0);
        name.copy(out, 2);
        let at = 2 + name.length;
        out.writeUInt32LE(crc >>> 0, at);
        Buffer.from(q.buffer, q.byteOffset, q.byteLength).copy(out, at + 4);
        for (let c = 0; c < crops; c++) out.writeFloatLE(inv[c], at + 4 + crops * dim + c * 4);
        return out;
    }

    function check(value) {
        if (!(value?.q instanceof Int8Array) || value.q.length !== crops * dim) throw new TypeError(`crop store: q must be Int8Array(${crops * dim})`);
        if (!(value.inv instanceof Float32Array) || value.inv.length !== crops) throw new TypeError(`crop store: inv must be Float32Array(${crops})`);
    }

    // The crops of `key` made from a row with this CRC, or null.
    function get(key, crc) {
        const entry = entries.get(key);
        return entry && (crc === undefined || entry.crc === (crc >>> 0)) ? entry : null;
    }

    function put(key, value) {
        check(value);
        const entry = { crc: value.crc >>> 0, q: Int8Array.from(value.q), inv: Float32Array.from(value.inv) };
        return serial(async () => {
            if (closed) return;
            const bytes = encode(key, entry);
            const handle = await fs.open(file, 'r+');
            try {
                await handle.write(bytes, 0, bytes.length, size);
            } finally {
                await handle.close();
            }
            size += bytes.length;
            records++;
            entries.set(key, entry);
        });
    }

    function deadRatio() {
        return records ? (records - entries.size) / records : 0;
    }

    // Rewrites the file with the latest record of each key in `keep` (all keys when omitted).
    function compact(keep = null) {
        return serial(async () => {
            if (closed) return;
            if (keep) for (const key of [...entries.keys()]) if (!keep.has(key)) entries.delete(key);
            const parts = [header];
            for (const [key, entry] of entries) parts.push(encode(key, entry));
            const next = Buffer.concat(parts);
            const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
            await fs.writeFile(temp, next);
            await fs.rename(temp, file);
            size = next.length;
            records = entries.size;
        });
    }

    function maybeCompact(keep) {
        return deadRatio() > COMPACT_DEAD_RATIO || (keep && [...entries.keys()].some(key => !keep.has(key))) ? compact(keep) : Promise.resolve();
    }

    async function close() {
        await serial(async () => { closed = true; });
    }

    return {
        get,
        put,
        compact,
        maybeCompact,
        close,
        get size() { return entries.size; },
        get crops() { return crops; },
        get dim() { return dim; },
        keys: () => entries.keys()
    };
}

module.exports = { openCropStore, CROP_FILE: FILE };
