const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    openStore,
    featureKey,
    BIN_FILE,
    MANIFEST_FILE,
    GROUPS_FILE,
    PCA_FILE,
    ORPHAN_RETENTION_MS,
    FLUSH_DELAY_MS
} = require('../similarityStore');
const { historyThumbnailKey } = require('../historyThumbnailKey');
const { usageKey } = require('../historyUsage');
const { packRow, unpackRow, crc32, ROW_BYTES, OFFSETS, FLAGS, H_VERSION, EMB_VERSION_BASE } = require('../similarityFeatures');

const EMB = `${EMB_VERSION_BASE}+ort1.24`;
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

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

// A valid layout-2 row with deterministic content.
function makeRow(seed, { dino = true } = {}) {
    const rnd = mulberry32(seed);
    const floats = length => Float32Array.from({ length }, () => rnd());
    const q = Int8Array.from({ length: 384 }, () => Math.round(rnd() * 254) - 127);
    let norm = 0;
    for (const value of q) norm += value * value;
    const flags = FLAGS.OK | (dino ? FLAGS.DINO_OK : 0);
    return packRow({
        hsv: floats(128),
        lab: floats(256),
        layout: floats(48),
        logR: rnd() - 0.5,
        whiteFrac: rnd(),
        phash: Uint32Array.from({ length: 8 }, () => Math.floor(rnd() * 0xffffffff)),
        q,
        inv: 1 / Math.sqrt(norm)
    }, flags);
}

function key(index, size = 1000 + index) {
    return featureKey(`D:\\library\\img-${index}.png`, size);
}

async function temporaryDirectory(t) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picgen-simstore-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    return path.join(dir, 'similarity');
}

function open(dir, options = {}) {
    return openStore({ dir, hVersion: H_VERSION, embVersion: EMB, ...options });
}

async function listTemps(dir) {
    const names = await fsp.readdir(dir).catch(() => []);
    return names.filter(name => name.endsWith('.tmp'));
}

async function readManifest(dir) {
    return JSON.parse(await fsp.readFile(path.join(dir, MANIFEST_FILE), 'utf8'));
}

// fs/promises wrapper that records renames (the atomic-write commit points) and positional writes.
function recordingFs() {
    const events = [];
    const wrapped = {
        ...fsp,
        async rename(from, to) {
            await fsp.rename(from, to);
            events.push({ op: 'rename', file: path.basename(to) });
        },
        async open(file, flags) {
            const handle = await fsp.open(file, flags);
            return {
                async write(buffer, offset, length, position) {
                    const result = await handle.write(buffer, offset, length, position);
                    events.push({ op: 'write', file: path.basename(file), position, length });
                    return result;
                },
                close: () => handle.close()
            };
        }
    };
    return { fs: wrapped, events };
}

async function settle(condition, turns = 500) {
    for (let i = 0; i < turns; i++) {
        if (condition()) return true;
        await new Promise(resolve => setImmediate(resolve));
        await fsp.stat(os.tmpdir()); // let real I/O callbacks run
    }
    return condition();
}

test('featureKey is the usage key: lower(fileName)|size, independent of the folder', () => {
    assert.equal(featureKey('D:\\PicGen\\images\\Foo Bar.PNG', 4238532), 'foo bar.png|4238532');
    assert.equal(featureKey('E:/moved/foo bar.png', 4238532), 'foo bar.png|4238532');
    assert.equal(featureKey('D:\\a\\x.webp', 12), usageKey({ fileName: 'x.webp', fileSize: 12 }));
    assert.equal(featureKey('D:\\a\\x.webp', 0), 'x.webp|0');
});

test('manifest and bin round-trip exactly, and no .tmp files are left behind', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir, { now: () => T0 });
    assert.deepEqual(store.keys(), []);
    const rows = [makeRow(1), makeRow(2, { dino: false }), makeRow(3)];
    for (let i = 0; i < rows.length; i++) {
        const meta = await store.writeRow(key(i), rows[i], { mtimeMs: T0 - i, lastPath: `D:\\library\\img-${i}.png` });
        assert.equal(meta.row, i);
    }
    store.setOverride('covers', { [key(0)]: T0 });
    await store.close();

    const bin = await fsp.readFile(path.join(dir, BIN_FILE));
    assert.equal(bin.toString('latin1', 0, 4), 'PGS3');
    assert.equal(bin.readUInt32LE(4), 2);
    assert.equal(bin.readUInt32LE(8), ROW_BYTES);
    assert.equal(bin.readUInt32LE(12), 3);
    assert.equal(bin.length, 16 + 3 * ROW_BYTES);
    for (let i = 0; i < rows.length; i++) assert.ok(bin.subarray(16 + i * ROW_BYTES, 16 + (i + 1) * ROW_BYTES).equals(rows[i]));

    const manifest = await readManifest(dir);
    assert.equal(manifest.version, 3);
    assert.equal(manifest.layout, 2);
    assert.equal(manifest.rowBytes, 2164);
    assert.equal(manifest.hVersion, H_VERSION);
    assert.equal(manifest.embVersion, EMB);
    assert.deepEqual(manifest.free, []);
    assert.deepEqual(manifest.overrides, { covers: { [key(0)]: T0 }, cannotLink: [] });
    const crc = rows[1].readUInt32LE(OFFSETS.crc);
    assert.deepEqual(manifest.rows[key(1)], [1, 'ok', 0, T0 - 1, 'D:\\library\\img-1.png', crc, FLAGS.OK, 0]);

    const reopened = await open(dir);
    assert.deepEqual(reopened.keys().sort(), [key(0), key(1), key(2)].sort());
    for (let i = 0; i < rows.length; i++) {
        const read = reopened.readRow(key(i));
        assert.ok(Buffer.isBuffer(read));
        assert.ok(read.equals(rows[i]), `row ${i} round-trips byte for byte`);
    }
    assert.deepEqual(reopened.meta(key(2)), {
        row: 2, status: 'ok', failCount: 0, mtimeMs: T0 - 2, lastPath: 'D:\\library\\img-2.png',
        crc: rows[2].readUInt32LE(OFFSETS.crc), flags: FLAGS.OK | FLAGS.DINO_OK, orphanedAt: 0
    });
    assert.equal(reopened.readRow('absent.png|1'), null);
    assert.equal(reopened.meta('absent.png|1'), null);
    await reopened.close();
    assert.deepEqual(await listTemps(dir), []);
});

test('readRow returns a copy that callers may mutate', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    const row = makeRow(9);
    await store.writeRow(key(9), row, {});
    const first = store.readRow(key(9));
    first.fill(0);
    assert.ok(store.readRow(key(9)).equals(row));
    await store.close();
});

test('the same file name and size under a new folder and mtime reuses the row', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    const row = makeRow(5);
    const oldKey = featureKey('D:\\PicGen\\PicGenData\\desktop-cache\\images\\2026_cat_task1.png', 777);
    await store.writeRow(oldKey, row, { mtimeMs: 1000, lastPath: 'D:\\PicGen\\PicGenData\\desktop-cache\\images\\2026_cat_task1.png' });
    await store.close();

    const reopened = await open(dir);
    const movedKey = featureKey('E:\\Moved\\PicGenData\\desktop-cache\\images\\2026_cat_task1.png', 777);
    assert.equal(movedKey, oldKey);
    assert.equal(reopened.meta(movedKey).status, 'ok');
    assert.ok(reopened.readRow(movedKey).equals(row));
    await reopened.close();
});

test('rows are written before the manifest that references them', async t => {
    const dir = await temporaryDirectory(t);
    const { fs, events } = recordingFs();
    const store = await open(dir, { fs });
    await store.writeRow(key(1), makeRow(1), {});
    await store.writeRow(key(2), makeRow(2), {});
    await store.flush();
    const manifestAt = events.findIndex(event => event.op === 'rename' && event.file === MANIFEST_FILE);
    const rowWrites = events.map((event, index) => ({ ...event, index }))
        .filter(event => event.op === 'write' && event.file === BIN_FILE && event.length === ROW_BYTES);
    assert.equal(rowWrites.length, 2);
    assert.ok(manifestAt > rowWrites[1].index);
    await store.close();
});

test('a row written after the last manifest flush is not referenced after a crash, and its slot is reused', async t => {
    const dir = await temporaryDirectory(t);
    const crashed = await open(dir);
    await crashed.writeRow(key(1), makeRow(1), {});
    await crashed.writeRow(key(2), makeRow(2), {});
    await crashed.flush();
    await crashed.writeRow(key(3), makeRow(3), {}); // row 2 on disk, manifest not yet flushed

    const next = await open(dir); // the "next launch" while the crashed instance never flushed
    assert.deepEqual(next.keys().sort(), [key(1), key(2)].sort());
    assert.equal(next.meta(key(3)), null);
    const reused = await next.writeRow(key(4), makeRow(4), {});
    assert.equal(reused.row, 2);
    assert.ok(next.readRow(key(4)).equals(makeRow(4)));
    await next.close();
    await crashed.close().catch(() => {});
});

test('concurrent writes get distinct rows', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    const metas = await Promise.all(Array.from({ length: 20 }, (_, i) => store.writeRow(key(i), makeRow(100 + i), {})));
    assert.deepEqual(metas.map(meta => meta.row).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
    for (let i = 0; i < 20; i++) assert.ok(store.readRow(key(i)).equals(makeRow(100 + i)));
    await store.close();
});

test('re-extracting an existing key overwrites its row in place', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    await store.writeRow(key(1), makeRow(1), {});
    await store.writeRow(key(2), makeRow(2), {});
    const again = await store.writeRow(key(1), makeRow(11), { mtimeMs: 5 });
    assert.equal(again.row, 0);
    assert.equal(again.mtimeMs, 5);
    assert.ok(store.readRow(key(1)).equals(makeRow(11)));
    await store.close();
    assert.equal((await fsp.stat(path.join(dir, BIN_FILE))).size, 16 + 2 * ROW_BYTES);
});

test('writeRow rejects malformed rows', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    await assert.rejects(() => store.writeRow(key(1), Buffer.alloc(100), {}), /2164/);
    const bad = Buffer.from(makeRow(1));
    bad[10] ^= 0xff;
    await assert.rejects(() => store.writeRow(key(1), bad, {}), /CRC/i);
    await assert.rejects(() => store.writeRow(key(1), makeRow(1), { flags: FLAGS.OK }), /flags/);
    await assert.rejects(() => store.writeRow('', makeRow(1), {}), /key/);
    assert.deepEqual(store.keys(), []);
    const ok = await store.writeRow(key(1), makeRow(1), { flags: FLAGS.OK | FLAGS.DINO_OK });
    assert.equal(ok.flags, FLAGS.OK | FLAGS.DINO_OK);
    await store.close();
    await assert.rejects(() => store.writeRow(key(2), makeRow(2), {}), /closed/);
    assert.throws(() => store.readRow(key(1)), /closed/);
});

test('a CRC-bad row is dropped and re-extracted', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    for (let i = 0; i < 3; i++) await store.writeRow(key(i), makeRow(i), {});
    await store.close();

    const binPath = path.join(dir, BIN_FILE);
    const bin = await fsp.readFile(binPath);
    bin[16 + ROW_BYTES + 700] ^= 0x5a; // inside row 1, stored CRC untouched
    await fsp.writeFile(binPath, bin);

    const reopened = await open(dir);
    assert.ok(reopened.readRow(key(0)).equals(makeRow(0)));
    assert.equal(reopened.meta(key(1)).status, 'ok'); // not yet read
    assert.equal(reopened.readRow(key(1)), null);
    assert.equal(reopened.meta(key(1)), null, 'the key becomes pending');
    const rewritten = await reopened.writeRow(key(1), makeRow(1), {});
    assert.equal(rewritten.row, 1, 'the freed slot is reused');
    assert.ok(reopened.readRow(key(1)).equals(makeRow(1)));
    await reopened.close();

    const third = await open(dir);
    assert.ok(third.readRow(key(1)).equals(makeRow(1)));
    await third.close();
});

test('a row dropped by readRow while its in-place rewrite is in flight is not handed out twice', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    for (let i = 0; i < 3; i++) await store.writeRow(key(i), makeRow(i), {});
    await store.close();
    const binPath = path.join(dir, BIN_FILE);
    const bin = await fsp.readFile(binPath);
    bin[16 + ROW_BYTES + 50] ^= 0x01;
    await fsp.writeFile(binPath, bin);

    // Hold the positional write open, so readRow runs while the in-place rewrite is in flight.
    let release;
    let started = false;
    const gate = new Promise(resolve => { release = resolve; });
    const gatedFs = {
        ...fsp,
        async open(file, flags) {
            const handle = await fsp.open(file, flags);
            return {
                async write(...args) {
                    started = true;
                    await gate;
                    return handle.write(...args);
                },
                close: () => handle.close()
            };
        }
    };
    const reopened = await open(dir, { fs: gatedFs });
    const pending = reopened.writeRow(key(1), makeRow(11), {}); // in place: key 1 still owns row 1
    assert.ok(await settle(() => started));
    assert.equal(reopened.readRow(key(1)), null); // drops the bad row and frees slot 1
    release();
    assert.equal((await pending).row, 1);
    const other = await reopened.writeRow(key(5), makeRow(5), {});
    assert.equal(other.row, 3, 'slot 1 belongs to key 1 again');
    assert.ok(reopened.readRow(key(1)).equals(makeRow(11)));
    assert.ok(reopened.readRow(key(5)).equals(makeRow(5)));
    await reopened.close();
});

test('a torn row past the end of the file is dropped and re-extracted', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    for (let i = 0; i < 3; i++) await store.writeRow(key(i), makeRow(i), {});
    await store.close();
    const binPath = path.join(dir, BIN_FILE);
    const bin = await fsp.readFile(binPath);
    await fsp.writeFile(binPath, bin.subarray(0, 16 + 2 * ROW_BYTES + 1000)); // row 2 torn

    const reopened = await open(dir);
    assert.equal(reopened.meta(key(2)), null);
    assert.equal(reopened.readRow(key(2)), null);
    assert.ok(reopened.readRow(key(1)).equals(makeRow(1)));
    const rewritten = await reopened.writeRow(key(2), makeRow(2), {});
    assert.equal(rewritten.row, 2);
    await reopened.close();
    assert.equal((await fsp.stat(binPath)).size, 16 + 3 * ROW_BYTES);
});

test('a manifest pointing at a different valid row re-finds its row by CRC', async t => {
    // This is the state after a crash between the bin rename and the manifest write of a compaction.
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    for (let i = 0; i < 4; i++) await store.writeRow(key(i), makeRow(i), {});
    await store.close();
    const manifest = await readManifest(dir);
    // Rotate the row indices: every entry now points at another key's row.
    for (let i = 0; i < 4; i++) manifest.rows[key(i)][0] = (i + 1) % 4;
    await fsp.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest));

    const reopened = await open(dir);
    for (let i = 0; i < 4; i++) {
        assert.equal(reopened.meta(key(i)).row, i);
        assert.ok(reopened.readRow(key(i)).equals(makeRow(i)));
    }
    await reopened.close();
});

test('two manifest entries claiming one row keep it for only one key', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    await store.writeRow(key(1), makeRow(1), {});
    await store.writeRow(key(2), makeRow(2), {});
    await store.close();
    const manifest = await readManifest(dir);
    manifest.rows[key(3)] = [...manifest.rows[key(1)]];
    await fsp.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest));

    const reopened = await open(dir);
    const holders = [key(1), key(3)].filter(fk => reopened.meta(fk));
    assert.equal(holders.length, 1);
    assert.ok(reopened.readRow(holders[0]).equals(makeRow(1)));
    assert.ok(reopened.readRow(key(2)).equals(makeRow(2)));
    await reopened.close();
});

test('an hVersion change discards all rows but keeps the overrides', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    for (let i = 0; i < 3; i++) await store.writeRow(key(i), makeRow(i), {});
    store.setOverride('cannotLink', [[key(1), key(0)]]);
    await store.close();

    const reopened = await open(dir, { hVersion: 'cc4w-64fill-v2' });
    assert.deepEqual(reopened.keys(), []);
    assert.equal(reopened.readRow(key(0)), null);
    assert.equal(reopened.stats().reset, 'h-version');
    assert.deepEqual(reopened.overrides(), { covers: {}, cannotLink: [[key(0), key(1)]] });
    assert.equal((await fsp.stat(path.join(dir, BIN_FILE))).size, 16);
    const fresh = await reopened.writeRow(key(5), makeRow(5), {});
    assert.equal(fresh.row, 0);
    await reopened.close();
    const manifest = await readManifest(dir);
    assert.equal(manifest.hVersion, 'cc4w-64fill-v2');
    assert.deepEqual(Object.keys(manifest.rows), [key(5)]);
});

test('a header magic, layout or rowBytes mismatch discards all rows', async t => {
    for (const [offset, value, reason] of [[0, 0x58, 'bin-header'], [4, 1, 'bin-header'], [8, 1776, 'bin-header']]) {
        const dir = await temporaryDirectory(t);
        const store = await open(dir);
        await store.writeRow(key(1), makeRow(1), {});
        await store.close();
        const binPath = path.join(dir, BIN_FILE);
        const bin = await fsp.readFile(binPath);
        if (offset === 0) bin[0] = value;
        else bin.writeUInt32LE(value, offset);
        await fsp.writeFile(binPath, bin);

        const reopened = await open(dir);
        assert.deepEqual(reopened.keys(), [], `offset ${offset}`);
        assert.equal(reopened.stats().reset, reason);
        await reopened.close();
        const header = await fsp.readFile(binPath);
        assert.equal(header.toString('latin1', 0, 4), 'PGS3');
        assert.equal(header.length, 16);
    }
});

test('a manifest layout, rowBytes or version mismatch discards all rows', async t => {
    for (const patch of [{ layout: 1 }, { rowBytes: 1776 }, { version: 2 }]) {
        const dir = await temporaryDirectory(t);
        const store = await open(dir);
        await store.writeRow(key(1), makeRow(1), {});
        await store.close();
        const manifest = { ...(await readManifest(dir)), ...patch };
        await fsp.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest));
        const reopened = await open(dir);
        assert.deepEqual(reopened.keys(), [], JSON.stringify(patch));
        await reopened.close();
    }
});

test('a corrupt manifest discards the rows without throwing', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    await store.writeRow(key(1), makeRow(1), {});
    await store.close();
    await fsp.writeFile(path.join(dir, MANIFEST_FILE), '{"version":3, "rows": {');
    const reopened = await open(dir);
    assert.deepEqual(reopened.keys(), []);
    assert.equal(reopened.stats().reset, 'manifest-corrupt');
    await reopened.writeRow(key(2), makeRow(2), {});
    await reopened.close();
    assert.deepEqual(Object.keys((await readManifest(dir)).rows), [key(2)]);
});

test('an embVersion change keeps the H parts but clears DINO_OK, until the row is re-embedded', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir, { embVersion: `${EMB_VERSION_BASE}+ort1.23` });
    const embedded = makeRow(1);
    const plain = makeRow(2, { dino: false });
    await store.writeRow(key(1), embedded, {});
    await store.writeRow(key(2), plain, {});
    await store.close();

    const upgraded = await open(dir, { embVersion: EMB });
    assert.equal(upgraded.stats().embVersion, EMB);
    assert.equal(upgraded.stats().staleEmbeddings, 1);
    assert.deepEqual(upgraded.keys().sort(), [key(1), key(2)].sort());
    const meta = upgraded.meta(key(1));
    assert.equal(meta.status, 'ok');
    assert.equal(meta.flags & FLAGS.DINO_OK, 0);
    assert.equal(meta.flags & FLAGS.OK, FLAGS.OK);

    const stale = upgraded.readRow(key(1));
    const unpacked = unpackRow(stale);
    assert.equal(unpacked.crcOk, true);
    assert.equal(unpacked.flags & FLAGS.DINO_OK, 0);
    assert.equal(unpacked.flags & FLAGS.OK, FLAGS.OK);
    assert.ok(unpacked.q.every(value => value === 0));
    assert.equal(unpacked.inv, 0);
    assert.ok(stale.subarray(0, OFFSETS.q).equals(embedded.subarray(0, OFFSETS.q)), 'H part (bytes 0..1767) kept');
    assert.ok(upgraded.readRow(key(2)).equals(plain), 'rows without an embedding are untouched');
    await upgraded.close();

    // Still stale on the next launch with the same (new) version: the manifest persisted the cleared flag.
    const again = await open(dir, { embVersion: EMB });
    assert.equal((await readManifest(dir)).embVersion, EMB);
    assert.equal(again.meta(key(1)).flags & FLAGS.DINO_OK, 0);
    assert.equal(unpackRow(again.readRow(key(1))).flags & FLAGS.DINO_OK, 0);
    const reembedded = makeRow(11);
    await again.writeRow(key(1), reembedded, {});
    assert.equal(again.meta(key(1)).flags & FLAGS.DINO_OK, FLAGS.DINO_OK);
    await again.close();

    const final = await open(dir, { embVersion: EMB });
    assert.ok(final.readRow(key(1)).equals(reembedded));
    assert.equal(final.stats().staleEmbeddings, 0);
    await final.close();
});

test('an unknown embVersion adopts the stored one and invalidates nothing', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    await store.writeRow(key(1), makeRow(1), {});
    await store.close();
    const reopened = await open(dir, { embVersion: '' });
    assert.equal(reopened.stats().embVersion, EMB);
    assert.equal(reopened.meta(key(1)).flags & FLAGS.DINO_OK, FLAGS.DINO_OK);
    assert.ok(reopened.readRow(key(1)).equals(makeRow(1)));
    await reopened.close();
    assert.equal((await readManifest(dir)).embVersion, EMB);
});

test('markFail counts failures, keeps an existing row and is reset by a successful write', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    const first = store.markFail(key(1), { mtimeMs: 7, lastPath: 'D:\\a\\img-1.png' });
    assert.deepEqual(first, { row: -1, status: 'fail', failCount: 1, mtimeMs: 7, lastPath: 'D:\\a\\img-1.png', crc: 0, flags: 0, orphanedAt: 0 });
    assert.equal(store.markFail(key(1), {}).failCount, 2);
    assert.equal(store.readRow(key(1)), null);

    await store.writeRow(key(2), makeRow(2, { dino: false }), {});
    const failed = store.markFail(key(2), { mtimeMs: 9 });
    assert.equal(failed.status, 'fail');
    assert.equal(failed.row, 0);
    assert.ok(store.readRow(key(2)).equals(makeRow(2, { dino: false })), 'the H part stays readable');
    await store.close();

    const reopened = await open(dir);
    assert.equal(reopened.meta(key(1)).failCount, 2);
    assert.equal(reopened.meta(key(1)).status, 'fail');
    assert.equal(reopened.meta(key(2)).status, 'fail');
    const ok = await reopened.writeRow(key(1), makeRow(1), {});
    assert.equal(ok.status, 'ok');
    assert.equal(ok.failCount, 0);
    await reopened.close();
});

test('overrides are normalised, persisted and validated', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    assert.deepEqual(store.overrides(), { covers: {}, cannotLink: [] });
    store.setOverride('covers', { [key(2)]: 200, [key(1)]: 100, bad: 'x', '': 5 });
    store.setOverride('cannotLink', [[key(2), key(1)], [key(1), key(2)], [key(3), key(3)], ['only-one'], [key(0), key(4)]]);
    const expected = { covers: { [key(1)]: 100, [key(2)]: 200 }, cannotLink: [[key(0), key(4)], [key(1), key(2)]] };
    assert.deepEqual(store.overrides(), expected);
    const copy = store.overrides();
    copy.covers.x = 1;
    copy.cannotLink.push(['a', 'b']);
    assert.deepEqual(store.overrides(), expected, 'overrides() returns a copy');
    assert.throws(() => store.setOverride('anchors', {}), /kind/);
    await store.close();
    const reopened = await open(dir);
    assert.deepEqual(reopened.overrides(), expected);
    await reopened.close();
});

test('orphans get a timestamp, are revived when present again, and survive compaction until 30 days old', async t => {
    const dir = await temporaryDirectory(t);
    let clock = T0;
    const store = await open(dir, { now: () => clock });
    for (let i = 0; i < 8; i++) await store.writeRow(key(i), makeRow(i), {});
    const present = new Set([key(0), key(1), key(2), key(3), key(4)]);
    assert.deepEqual(store.markOrphans(present, T0), { orphaned: 3, revived: 0 });
    assert.equal(store.meta(key(5)).orphanedAt, T0);
    assert.equal(store.meta(key(0)).orphanedAt, 0);
    // A second pass does not move the timestamp.
    assert.deepEqual(store.markOrphans(present, T0 + DAY), { orphaned: 0, revived: 0 });
    assert.equal(store.meta(key(5)).orphanedAt, T0);
    // Trash followed by a restore: key 7 is back.
    present.add(key(7));
    assert.deepEqual(store.markOrphans([...present], T0 + DAY), { orphaned: 0, revived: 1 });
    assert.equal(store.meta(key(7)).orphanedAt, 0);
    await store.flush();
    assert.equal((await readManifest(dir)).rows[key(5)][7], T0);

    // 29 days later: nothing expires, even though the host is idle.
    const early = await store.compact({ now: T0 + 29 * DAY, idle: 120000 });
    assert.equal(early.expired, 0);
    assert.ok(store.readRow(key(5)).equals(makeRow(5)));

    // 30 days: keys 5 and 6 expire (2 of 8 free = 25%, not more), so no physical compaction yet.
    const expired = await store.compact({ now: T0 + ORPHAN_RETENTION_MS, idle: 120000 });
    assert.equal(expired.expired, 2);
    assert.equal(expired.compacted, false);
    assert.equal(store.meta(key(5)), null);
    assert.equal(store.readRow(key(6)), null);
    assert.ok(store.readRow(key(7)).equals(makeRow(7)));
    assert.equal(ORPHAN_RETENTION_MS, 30 * DAY);
    await store.close();
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest.free, [5, 6]);
});

test('compaction remaps rows, shrinks the file and persists, only when idle and more than 25% is free', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir, { now: () => T0 });
    for (let i = 0; i < 12; i++) await store.writeRow(key(i), makeRow(i), { mtimeMs: i, lastPath: `p${i}` });
    const keep = [0, 2, 4, 6, 7, 8, 9, 11];
    store.markOrphans(keep.map(i => key(i)), T0);
    const later = T0 + ORPHAN_RETENTION_MS;

    const busy = await store.compact({ now: later, idle: 59999 });
    assert.equal(busy.expired, 4);
    assert.equal(busy.compacted, false, 'not idle for 60 s yet');
    assert.equal((await fsp.stat(path.join(dir, BIN_FILE))).size, 16 + 12 * ROW_BYTES);

    const done = await store.compact({ now: later, idle: 60000 });
    assert.equal(done.compacted, true);
    assert.equal(done.capacity, 8);
    assert.equal((await fsp.stat(path.join(dir, BIN_FILE))).size, 16 + 8 * ROW_BYTES);
    keep.forEach((index, row) => {
        assert.equal(store.meta(key(index)).row, row, 'rows keep their relative order');
        assert.equal(store.meta(key(index)).lastPath, `p${index}`);
        assert.ok(store.readRow(key(index)).equals(makeRow(index)));
    });
    // The manifest was written as part of the compaction.
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest.free, []);
    assert.equal(manifest.rows[key(11)][0], 7);
    const appended = await store.writeRow(key(20), makeRow(20), {});
    assert.equal(appended.row, 8);
    await store.close();

    const reopened = await open(dir);
    for (const index of [...keep, 20]) assert.ok(reopened.readRow(key(index)).equals(makeRow(index)));
    assert.equal((await reopened.compact({ now: later, idle: true })).compacted, false, 'nothing free');
    await reopened.close();
    assert.deepEqual(await listTemps(dir), []);
});

test('calls made while a compaction is renaming the bin stay consistent', async t => {
    const dir = await temporaryDirectory(t);
    let release;
    let armed = false;
    let renaming = false;
    const gate = new Promise(resolve => { release = resolve; });
    const gatedFs = {
        ...fsp,
        async rename(from, to) {
            if (armed && path.basename(to) === BIN_FILE) {
                renaming = true;
                await gate;
            }
            return fsp.rename(from, to);
        }
    };
    const store = await open(dir, { fs: gatedFs, now: () => T0 });
    for (let i = 0; i < 6; i++) await store.writeRow(key(i), makeRow(i), {});
    store.markOrphans([key(3), key(5)], T0);
    armed = true; // only the compaction's rename waits
    const running = store.compact({ now: T0 + ORPHAN_RETENTION_MS, idle: true });
    assert.ok(await settle(() => renaming));
    // Reads still see the old layout, and markFail keeps the entry the compaction will remap.
    assert.ok(store.readRow(key(5)).equals(makeRow(5)));
    store.markFail(key(5), { mtimeMs: 1 });
    release();
    const result = await running;
    assert.equal(result.compacted, true);
    assert.equal(store.meta(key(3)).row, 0);
    assert.equal(store.meta(key(5)).row, 1);
    assert.equal(store.meta(key(5)).status, 'fail');
    assert.ok(store.readRow(key(5)).equals(makeRow(5)));
    await store.close();
    const reopened = await open(dir);
    assert.ok(reopened.readRow(key(3)).equals(makeRow(3)));
    assert.ok(reopened.readRow(key(5)).equals(makeRow(5)));
    await reopened.close();
});

test('the manifest flush is debounced to one write per 5 s window', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dir = await temporaryDirectory(t);
    const { fs, events } = recordingFs();
    const store = await open(dir, { fs });
    const manifestWrites = () => events.filter(event => event.op === 'rename' && event.file === MANIFEST_FILE).length;
    assert.equal(FLUSH_DELAY_MS, 5000);

    await store.writeRow(key(1), makeRow(1), {});
    t.mock.timers.tick(3000);
    await store.writeRow(key(2), makeRow(2), {});
    store.markFail(key(3), {});
    await settle(() => false, 20);
    assert.equal(manifestWrites(), 0, 'nothing written before the window ends');

    t.mock.timers.tick(1999);
    await settle(() => false, 20);
    assert.equal(manifestWrites(), 0);
    t.mock.timers.tick(1);
    assert.ok(await settle(() => manifestWrites() === 1), 'one write at 5 s');
    assert.deepEqual(Object.keys((await readManifest(dir)).rows).sort(), [key(1), key(2), key(3)].sort());

    await settle(() => false, 20);
    t.mock.timers.tick(10000);
    await settle(() => false, 20);
    assert.equal(manifestWrites(), 1, 'no write without a change');

    await store.writeRow(key(4), makeRow(4), {});
    t.mock.timers.tick(5000);
    assert.ok(await settle(() => manifestWrites() === 2));
    await store.close();
    assert.equal(manifestWrites(), 2, 'close has nothing left to write');
});

test('a failed manifest flush is logged once and retried 5 s later', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dir = await temporaryDirectory(t);
    let failures = 1;
    let committed = 0;
    const flakyFs = {
        ...fsp,
        async rename(from, to) {
            if (path.basename(to) === MANIFEST_FILE && failures > 0) {
                failures--;
                throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
            }
            await fsp.rename(from, to);
            if (path.basename(to) === MANIFEST_FILE) committed++;
        }
    };
    const logs = [];
    const store = await open(dir, { fs: flakyFs, log: entry => logs.push(entry) });
    await store.writeRow(key(1), makeRow(1), {});
    t.mock.timers.tick(5000);
    assert.ok(await settle(() => logs.length === 1));
    assert.equal(logs[0].level, 'error');
    assert.match(logs[0].data.code, /EPERM/);
    assert.equal(committed, 0);
    t.mock.timers.tick(5000);
    assert.ok(await settle(() => committed === 1), 'retried');
    assert.deepEqual(Object.keys((await readManifest(dir)).rows), [key(1)]);
    assert.deepEqual(await listTemps(dir), [], 'the failed temp file was removed');
    await store.close();
    assert.equal(logs.length, 1);
});

test('groups-v3.json round-trips; a missing, corrupt or foreign file loads as null', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    assert.equal(await store.loadGroups(), null);
    const groups = { version: 3, mode: 'hd', revision: 7, digest: 'abc', items: ['k1', 'k2', 'k3'], merges: [[0, 1, 0.05]], anchors: { 0: 'sg_000000000000' } };
    await store.saveGroups(groups);
    assert.deepEqual(await store.loadGroups(), groups);
    await store.close();

    const reopened = await open(dir);
    assert.deepEqual(await reopened.loadGroups(), groups);
    await fsp.writeFile(path.join(dir, GROUPS_FILE), '{"version":3,');
    assert.equal(await reopened.loadGroups(), null);
    await fsp.writeFile(path.join(dir, GROUPS_FILE), JSON.stringify({ ...groups, version: 2 }));
    assert.equal(await reopened.loadGroups(), null);
    await reopened.close();
    assert.deepEqual(await listTemps(dir), []);
});

test('the PCA basis round-trips with its embVersion check', async t => {
    const dir = await temporaryDirectory(t);
    const store = await open(dir);
    assert.equal(await store.loadPca(), null);
    const rnd = mulberry32(42);
    const basis = Float32Array.from({ length: 32 * 384 }, () => rnd() - 0.5);
    await store.savePca(basis);
    const loaded = await store.loadPca();
    assert.ok(loaded instanceof Float32Array);
    assert.deepEqual(Array.from(loaded), Array.from(basis));
    await assert.rejects(() => store.savePca(new Float32Array(10)), /32/);
    await store.close();

    const file = await fsp.readFile(path.join(dir, PCA_FILE));
    assert.equal(file.toString('latin1', 0, 4), 'PGP1');
    assert.equal(file.readUInt32LE(4), 32);
    assert.equal(file.readUInt32LE(8), 384);
    assert.equal(file.subarray(12, 76).toString('utf8').replace(/\0+$/, ''), EMB);
    assert.ok(file.subarray(12 + Buffer.byteLength(EMB), 76).every(byte => byte === 0), 'NUL-padded');
    assert.equal(file.length, 76 + 32 * 384 * 4);

    const other = await open(dir, { embVersion: `${EMB_VERSION_BASE}+ort1.25` });
    assert.equal(await other.loadPca(), null, 'a basis from another embedding version is not used');
    await other.close();

    const truncated = await open(dir);
    await fsp.writeFile(path.join(dir, PCA_FILE), file.subarray(0, 1000));
    assert.equal(await truncated.loadPca(), null);
    const badMagic = Buffer.from(file);
    badMagic[0] = 0x51;
    await fsp.writeFile(path.join(dir, PCA_FILE), badMagic);
    assert.equal(await truncated.loadPca(), null);
    await truncated.close();
});

test('v2 similarity files are never read, written or deleted', async t => {
    const dir = await temporaryDirectory(t);
    const cacheRoot = path.dirname(dir);
    const thumbnails = path.join(cacheRoot, 'thumbnails');
    await fsp.mkdir(thumbnails, { recursive: true });
    await fsp.mkdir(dir, { recursive: true });
    const v2Files = {
        [path.join(cacheRoot, 'similarity-index.json')]: '{"version":2,"entries":{"a":1}}\n',
        [path.join(dir, 'similarity-index.json')]: '{"version":2}\n',
        [path.join(thumbnails, 'abc.signature.json')]: '{"hash":"ff00"}',
        [path.join(thumbnails, 'abc.jpg')]: 'jpeg bytes'
    };
    for (const [file, text] of Object.entries(v2Files)) await fsp.writeFile(file, text);
    const before = await Promise.all(Object.keys(v2Files).map(file => fsp.stat(file)));

    let clock = T0;
    const store = await open(dir, { now: () => clock });
    for (let i = 0; i < 6; i++) await store.writeRow(key(i), makeRow(i), {});
    store.markOrphans([key(0)], T0);
    clock = T0 + ORPHAN_RETENTION_MS;
    await store.compact({ idle: true });
    await store.saveGroups({ version: 3, items: [] });
    await store.savePca(new Float32Array(32 * 384));
    await store.close();
    const again = await open(dir, { hVersion: 'other' }); // a discard must not touch them either
    await again.close();

    const names = Object.keys(v2Files);
    for (let i = 0; i < names.length; i++) {
        assert.equal(await fsp.readFile(names[i], 'utf8'), v2Files[names[i]]);
        assert.equal((await fsp.stat(names[i])).mtimeMs, before[i].mtimeMs);
    }
});

test('stale temp files from a crashed write are removed at open', async t => {
    const dir = await temporaryDirectory(t);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `.${MANIFEST_FILE}.123.456.abcd1234.tmp`), '{');
    await fsp.writeFile(path.join(dir, `.${BIN_FILE}.123.456.abcd1234.tmp`), 'x');
    await fsp.writeFile(path.join(dir, 'unrelated.tmp'), 'keep');
    const store = await open(dir);
    await store.close();
    assert.deepEqual(await listTemps(dir), ['unrelated.tmp']);
});

test('openStore validates its options', async t => {
    const dir = await temporaryDirectory(t);
    await assert.rejects(() => openStore({ hVersion: H_VERSION }), /dir/);
    await assert.rejects(() => open(dir, { rowBytes: 1776 }), /2164/);
    await assert.rejects(() => open(dir, { layout: 1 }), /layout/);
});

test('historyThumbnailKey equals the inline formula from electron-main.js', async () => {
    const inline = (sourcePath, stat) => `${crypto.createHash('sha1').update(`${sourcePath.toLowerCase()}:${stat.size}:${stat.mtimeMs}`).digest('hex')}.jpg`;
    const samples = [
        ['D:\\PicGen-Desktop\\dist\\release\\PicGenData\\desktop-cache\\images\\2026-09-24T12-00-00-000Z_Cat_task_1.PNG', { size: 4238532, mtimeMs: 1727179200123.4567 }],
        ['C:\\Users\\GEEK_GUO\\AppData\\Roaming\\PicGen\\desktop-cache\\images\\猫咪 ÄÖ.webp', { size: 12, mtimeMs: 1700000000000 }],
        ['\\\\NAS\\Share\\Pictures\\IMG_0001.JPG', { size: 0, mtimeMs: 0.5 }]
    ];
    for (const [resolvedPath, stat] of samples) {
        const name = historyThumbnailKey(resolvedPath, stat);
        assert.equal(name, inline(resolvedPath, stat));
        assert.match(name, /^[0-9a-f]{40}\.jpg$/);
    }
    // Guard against drift: main either still has the exact inline formula or uses this module.
    const main = await fsp.readFile(path.join(__dirname, '..', 'electron-main.js'), 'utf8');
    const inlineInMain = main.includes("crypto.createHash('sha1').update(`${sourcePath.toLowerCase()}:${stat.size}:${stat.mtimeMs}`).digest('hex')");
    assert.ok(inlineInMain || /historyThumbnailKey\(/.test(main));
});

test('checksum helper agrees with the row format', () => {
    const row = makeRow(3);
    assert.equal(crc32(row, 0, OFFSETS.crc), row.readUInt32LE(OFFSETS.crc));
});
