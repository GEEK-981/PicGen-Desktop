const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createHistoryUsageStore } = require('../historyUsageStore');

async function temporaryDirectory() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'picgen-usage-'));
}

function record(name, size = 100, extra = {}) {
    return { id: `task_${name}`, filePath: path.join('D:\\library', name), fileName: name, fileSize: size, ...extra };
}

function clock(start = 1_000_000) {
    let value = start;
    const now = () => value;
    now.advance = ms => { value += ms; };
    return now;
}

test('record increments, persists and reloads', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const now = clock();
    const store = createHistoryUsageStore({ dir, now });
    await store.load();

    const image = record('a.png', 4238532);
    const first = await store.record(image, 'drag-out', 'native-drag');
    assert.equal(first.changed, true);
    assert.equal(first.coalesced, false);
    assert.equal(first.usageKey, 'a.png|4238532');
    assert.deepEqual(first.usage, { dragCount: 1, referenceCount: 0, lastUsedAt: now(), lastUsedKind: 'drag-out' });

    now.advance(1000);
    const second = await store.record(image, 'reference', 'drawer');
    assert.deepEqual(second.usage, { dragCount: 1, referenceCount: 1, lastUsedAt: now(), lastUsedKind: 'reference' });
    await store.flush();

    const saved = JSON.parse(await fs.readFile(path.join(dir, 'history-usage.json'), 'utf8'));
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.entries['a.png|4238532'], { dragCount: 1, referenceCount: 1, lastUsedAt: now(), lastUsedKind: 'reference' });

    const reloaded = createHistoryUsageStore({ dir, now });
    await reloaded.load();
    // the same file seen from a moved folder still matches
    assert.deepEqual(reloaded.get({ filePath: 'E:\\moved\\A.PNG', fileSize: 4238532 }),
        { dragCount: 1, referenceCount: 1, lastUsedAt: now(), lastUsedKind: 'reference' });
    assert.equal(reloaded.get(record('a.png', 1)), null);
});

test('50 concurrent record calls give an exact count', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const store = createHistoryUsageStore({ dir, coalesceMs: 0 });
    await store.load();
    const image = record('burst.png');
    const others = Array.from({ length: 50 }, (_, index) => record(`other-${index}.png`));
    await Promise.all([
        ...Array.from({ length: 50 }, () => store.record(image, 'reference', 'menu')),
        ...others.map(other => store.record(other, 'drag-out', 'native-drag'))
    ]);
    assert.equal(store.get(image).referenceCount, 50);
    await store.flush();

    const reloaded = createHistoryUsageStore({ dir });
    await reloaded.load();
    assert.equal(reloaded.get(image).referenceCount, 50);
    for (const other of others) assert.equal(reloaded.get(other).dragCount, 1);
});

test('an identical (usageKey, kind) within 750 ms is coalesced', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const now = clock();
    const store = createHistoryUsageStore({ dir, now });
    await store.load();
    const image = record('c.png');

    assert.equal((await store.record(image, 'drag-out', 'native-drag')).changed, true);
    now.advance(500);
    const repeat = await store.record(image, 'drag-out', 'native-drag');
    assert.equal(repeat.changed, false);
    assert.equal(repeat.coalesced, true);
    assert.equal(repeat.usage.dragCount, 1);

    // a different kind is not coalesced
    const other = await store.record(image, 'reference', 'drop');
    assert.equal(other.changed, true);
    assert.equal(other.usage.referenceCount, 1);

    now.advance(800);
    const later = await store.record(image, 'drag-out', 'native-drag');
    assert.equal(later.changed, true);
    assert.equal(later.usage.dragCount, 2);
});

test('copy and save-as are drag-outs: one counter, coalesced with a drag, no new field on disk', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const now = clock();
    const store = createHistoryUsageStore({ dir, now });
    await store.load();
    const image = record('d.png');

    assert.equal((await store.record(image, 'drag-out', 'copy')).usage.dragCount, 1);
    now.advance(300);
    // copied, then dragged straight out: one gesture, one count
    const dragged = await store.record(image, 'drag-out', 'native-drag');
    assert.deepEqual([dragged.changed, dragged.coalesced, dragged.usage.dragCount], [false, true, 1]);
    now.advance(800);
    const saved = await store.record(image, 'drag-out', 'save-as');
    assert.deepEqual(saved.usage, { dragCount: 2, referenceCount: 0, lastUsedAt: now(), lastUsedKind: 'drag-out' });
    await store.flush();

    // The source is not persisted: older builds read and rewrite exactly the same document.
    const document = JSON.parse(await fs.readFile(path.join(dir, 'history-usage.json'), 'utf8'));
    assert.equal(document.version, 1);
    assert.deepEqual(document.entries['d.png|100'], { dragCount: 2, referenceCount: 0, lastUsedAt: now(), lastUsedKind: 'drag-out' });
    await assert.rejects(store.record(image, 'copy', 'copy'), /Unknown history usage kind/);
});

test('the previous file is copied to .prev before each replace', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const now = clock();
    const store = createHistoryUsageStore({ dir, now });
    await store.load();
    await store.record(record('p.png'), 'drag-out', 'native-drag');
    await store.flush();
    now.advance(1000);
    await store.record(record('p.png'), 'drag-out', 'native-drag');
    await store.flush();

    const prev = JSON.parse(await fs.readFile(path.join(dir, 'history-usage.prev.json'), 'utf8'));
    const current = JSON.parse(await fs.readFile(path.join(dir, 'history-usage.json'), 'utf8'));
    assert.equal(prev.entries['p.png|100'].dragCount, 1);
    assert.equal(current.entries['p.png|100'].dragCount, 2);
});

test('a corrupt primary is moved aside and .prev is loaded, with one error-log entry', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'history-usage.prev.json'), JSON.stringify({
        version: 1,
        entries: { 'kept.png|100': { dragCount: 2, referenceCount: 0, lastUsedAt: 5, lastUsedKind: 'drag-out' } }
    }));
    await fs.writeFile(path.join(dir, 'history-usage.json'), '\u0000'.repeat(64));
    const logs = [];
    const store = createHistoryUsageStore({ dir, log: entry => { logs.push(entry); } });
    await store.load();
    await store.load();

    assert.equal(store.get(record('kept.png')).dragCount, 2);
    const names = await fs.readdir(dir);
    assert.equal(names.filter(name => /^history-usage\.corrupt-.+\.json$/.test(name)).length, 1);
    assert.equal(names.includes('history-usage.json'), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].source, 'storage');
    assert.equal(logs[0].title, '拖用记录损坏，已从备份恢复');

    // the next write keeps the good .prev instead of copying the corrupt primary over it
    await store.record(record('new.png'), 'reference', 'drop');
    await store.flush();
    const prev = JSON.parse(await fs.readFile(path.join(dir, 'history-usage.prev.json'), 'utf8'));
    assert.equal(prev.entries['kept.png|100'].dragCount, 2);
    const current = JSON.parse(await fs.readFile(path.join(dir, 'history-usage.json'), 'utf8'));
    assert.equal(current.entries['kept.png|100'].dragCount, 2);
    assert.equal(current.entries['new.png|100'].referenceCount, 1);
});

test('unparsable JSON without a backup starts empty and says so', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'history-usage.json'), '{"version":1,"entries":{');
    const logs = [];
    const store = createHistoryUsageStore({ dir, log: entry => { logs.push(entry); } });
    await store.load();
    assert.equal(store.get(record('any.png')), null);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].title, '拖用记录损坏，未找到可用备份');
    assert.equal((await fs.readdir(dir)).filter(name => name.startsWith('history-usage.corrupt-')).length, 1);
});

test('an unreadable usage file makes load() reject, is never overwritten, and a retry loads it', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'history-usage.json');
    const original = JSON.stringify({
        version: 1,
        entries: { 'kept.png|100': { dragCount: 3, referenceCount: 1, lastUsedAt: 5, lastUsedKind: 'reference' } }
    });
    await fs.writeFile(file, original);
    const realFs = require('node:fs/promises');
    let deny = true;
    const lockedFs = {
        ...realFs,
        readFile: async (filePath, ...rest) => {
            if (deny) throw Object.assign(new Error(`EACCES: permission denied, open '${filePath}'`), { code: 'EACCES' });
            return realFs.readFile(filePath, ...rest);
        }
    };
    const logs = [];
    const store = createHistoryUsageStore({ dir, fs: lockedFs, coalesceMs: 0, log: entry => { logs.push(entry); } });

    await assert.rejects(store.load(), { code: 'EACCES' });
    assert.equal(store.get(record('kept.png')), null);
    // a use recorded meanwhile is refused instead of being written over the unreadable counters
    await assert.rejects(store.record(record('new.png'), 'drag-out', 'native-drag'), { code: 'EACCES' });
    await store.flush();
    assert.equal(await fs.readFile(file, 'utf8'), original);
    assert.deepEqual(await fs.readdir(dir), ['history-usage.json'], 'no .corrupt or .prev file is created');
    assert.deepEqual(logs, []);

    deny = false;
    await store.load();
    assert.equal(store.get(record('kept.png')).dragCount, 3);
    const next = await store.record(record('kept.png'), 'drag-out', 'native-drag');
    assert.equal(next.usage.dragCount, 4);
    assert.equal(store.get(record('new.png')), null, 'the refused use was not counted');
});

test('writes leave no .tmp files behind', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const store = createHistoryUsageStore({ dir, coalesceMs: 0 });
    await store.load();
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.record(record(`t${index % 4}.png`), 'drag-out', 'native-drag')));
    await store.flush();
    const leftovers = (await fs.readdir(dir)).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
});

test('project never mutates its input and strips stale usage fields', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const now = clock();
    const store = createHistoryUsageStore({ dir, now });
    await store.load();
    const used = record('used.png');
    await store.record(used, 'drag-out', 'native-drag');

    const frozen = Object.freeze({ ...used });
    const projected = store.project(frozen);
    assert.notEqual(projected, frozen);
    assert.equal(projected.dragCount, 1);
    assert.equal(projected.referenceCount, 0);
    assert.equal(projected.lastUsedKind, 'drag-out');
    assert.equal(frozen.dragCount, undefined);

    const stale = { ...record('never.png'), dragCount: 9, referenceCount: 9, lastUsedAt: 1, lastUsedKind: 'drag-out' };
    const clean = store.project(stale);
    assert.equal(stale.dragCount, 9);
    assert.equal('dragCount' in clean, false);
    assert.equal('lastUsedKind' in clean, false);
    assert.equal(clean.filePath, stale.filePath);
});

test('a plain load with no events creates no file', async t => {
    const parent = await temporaryDirectory();
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const dir = path.join(parent, 'desktop-cache');
    const store = createHistoryUsageStore({ dir });
    await store.load();
    assert.equal(store.project(record('x.png')).dragCount, undefined);
    await store.flush();
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
});

test('a record with size 0 falls back to a unique match on the name', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const store = createHistoryUsageStore({ dir, coalesceMs: 0 });
    await store.load();
    await store.record(record('unique.png', 500), 'drag-out', 'native-drag');
    await store.record(record('twin.png', 1), 'drag-out', 'native-drag');
    await store.record(record('twin.png', 2), 'drag-out', 'native-drag');

    assert.equal(store.get(record('unique.png', 0)).dragCount, 1);
    assert.equal(store.get(record('twin.png', 0)), null);
    // an increment through the size-0 record lands on the matched entry
    const result = await store.record(record('unique.png', 0), 'reference', 'drawer');
    assert.equal(result.usageKey, 'unique.png|500');
    assert.equal(store.get(record('unique.png', 500)).referenceCount, 1);
});

test('record rejects an unknown kind or a record without a name', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const store = createHistoryUsageStore({ dir });
    await assert.rejects(store.record(record('k.png'), 'export', 'menu'), TypeError);
    await assert.rejects(store.record({}, 'reference', 'menu'), TypeError);
    await store.flush();
    assert.deepEqual(await fs.readdir(dir), []);
});

test('a failed write keeps the count in memory, logs once and is retried by the next write', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const realFs = require('node:fs/promises');
    let failWrites = true;
    const flakyFs = {
        ...realFs,
        writeFile: async (...args) => {
            if (failWrites) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            return realFs.writeFile(...args);
        }
    };
    const logs = [];
    const store = createHistoryUsageStore({ dir, fs: flakyFs, coalesceMs: 0, log: entry => { logs.push(entry); } });
    await store.load();
    const image = record('flaky.png');
    const first = await store.record(image, 'drag-out', 'native-drag');
    assert.equal(first.changed, true);
    await store.record(image, 'drag-out', 'native-drag');
    assert.equal(store.get(image).dragCount, 2);
    assert.equal(logs.length, 1);
    assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')).length, 0);

    failWrites = false;
    await store.record(record('ok.png'), 'reference', 'drop');
    await store.flush();
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'history-usage.json'), 'utf8'));
    assert.equal(saved.entries['flaky.png|100'].dragCount, 2);
    assert.equal(saved.entries['ok.png|100'].referenceCount, 1);
});
