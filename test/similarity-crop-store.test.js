const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

const { openCropStore, CROP_FILE } = require('../similarityCropStore');

const CROPS = 9;
const DIM = 384;
function crops(seed, crc = 7) {
    const q = new Int8Array(CROPS * DIM);
    for (let i = 0; i < q.length; i++) q[i] = ((i * 31 + seed * 17) % 255) - 127;
    const inv = new Float32Array(CROPS).map((_, c) => 0.001 * (c + 1) + seed);
    return { crc, q, inv };
}

async function tempDir(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-crops-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
}

test('crops round-trip through the file; the last record of a key wins; a CRC mismatch is stale', async t => {
    const dir = await tempDir(t);
    let store = await openCropStore({ dir, embVersion: 'dinov2s-q8-pad-v1+ort1.24' });
    assert.equal(store.size, 0);
    await store.put('a.png|10', crops(1));
    await store.put('b.png|20', crops(2, 9));
    await store.put('a.png|10', crops(3, 8));
    await store.close();

    store = await openCropStore({ dir, embVersion: 'dinov2s-q8-pad-v1+ort1.24' });
    assert.equal(store.size, 2);
    assert.deepEqual(Array.from(store.get('a.png|10', 8).q.slice(0, 4)), Array.from(crops(3).q.slice(0, 4)));
    assert.equal(store.get('a.png|10', 7), null, 'the old CRC is stale');
    assert.ok(Math.abs(store.get('b.png|20').inv[8] - crops(2).inv[8]) < 1e-6);
    assert.equal(store.get('missing|1'), null);
    await store.close();
});

test('another embVersion starts the file over; a torn tail is dropped', async t => {
    const dir = await tempDir(t);
    let store = await openCropStore({ dir, embVersion: 'v1' });
    await store.put('a.png|10', crops(1));
    await store.put('b.png|20', crops(2));
    await store.close();
    const file = path.join(dir, CROP_FILE);
    const full = await fs.readFile(file);
    await fs.writeFile(file, full.subarray(0, full.length - 100));
    const logs = [];
    store = await openCropStore({ dir, embVersion: 'v1', log: (level, message) => logs.push(message) });
    assert.equal(store.size, 1, 'b was torn');
    assert.ok(store.get('a.png|10'));
    assert.ok(logs.some(message => /torn/.test(message)));
    await store.put('c.png|30', crops(3));
    await store.close();
    store = await openCropStore({ dir, embVersion: 'v1' });
    assert.deepEqual([...store.keys()].sort(), ['a.png|10', 'c.png|30'], 'an append after a torn tail overwrites it cleanly');
    await store.close();

    store = await openCropStore({ dir, embVersion: 'v2' });
    assert.equal(store.size, 0);
    await store.close();
});

test('compact keeps only the live keys and shrinks the file', async t => {
    const dir = await tempDir(t);
    const store = await openCropStore({ dir, embVersion: 'v1' });
    for (let i = 0; i < 4; i++) await store.put('a.png|10', crops(i));
    await store.put('b.png|20', crops(5));
    const before = (await fs.stat(path.join(dir, CROP_FILE))).size;
    await store.maybeCompact(new Set(['a.png|10']));
    const after = (await fs.stat(path.join(dir, CROP_FILE))).size;
    assert.ok(after < before / 4, `${after} < ${before}/4`);
    assert.deepEqual([...store.keys()], ['a.png|10']);
    await store.close();
    const reopened = await openCropStore({ dir, embVersion: 'v1' });
    assert.equal(reopened.size, 1);
    await reopened.close();
});

test('put validates the vector shapes', async t => {
    const dir = await tempDir(t);
    const store = await openCropStore({ dir, embVersion: 'v1' });
    assert.throws(() => store.put('a|1', { crc: 1, q: new Int8Array(3), inv: new Float32Array(CROPS) }), /Int8Array/);
    assert.throws(() => store.put('a|1', { crc: 1, q: new Int8Array(CROPS * DIM), inv: new Float32Array(2) }), /Float32Array/);
    await store.close();
});
