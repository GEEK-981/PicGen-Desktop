const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createSerialTaskQueue } = require('../historyPersistence');
const { createTombstoneStore, createHistoryTrash, reconcileHistoryBin } = require('../historyTrash');
const { createHistoryUsageStore } = require('../historyUsageStore');

const DAY = 24 * 60 * 60 * 1000;

async function temporaryDirectory() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'picgen-trash-'));
}

async function exists(filePath) {
    try { await fs.lstat(filePath); return true; } catch { return false; }
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fsError(code, syscall, filePath) {
    return Object.assign(new Error(`${code}: operation not permitted, ${syscall} '${filePath}'`), { code, syscall, path: filePath });
}

// fs/promises whose lstat and access fail with `code` for every basename in the live set `denied`.
function deniedFs(denied, code = 'EACCES') {
    const refuse = (syscall, filePath) => {
        if (denied.has(path.basename(String(filePath)))) throw fsError(code, syscall, filePath);
    };
    return {
        ...fs,
        lstat: async (filePath, ...rest) => { refuse('lstat', filePath); return fs.lstat(filePath, ...rest); },
        access: async (filePath, ...rest) => { refuse('access', filePath); return fs.access(filePath, ...rest); }
    };
}

// fs/promises whose readFile fails with EACCES while `gate.deny` is true.
function unreadableFs(gate) {
    return {
        ...fs,
        readFile: async (filePath, ...rest) => {
            if (gate.deny) throw fsError('EACCES', 'open', filePath);
            return fs.readFile(filePath, ...rest);
        }
    };
}

// Builds a history of real files in <root>/images plus a fake index, bin store and usage store.
async function createHarness(t, specs, options = {}) {
    const root = await temporaryDirectory();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const images = path.join(root, 'images');
    const cache = path.join(root, 'desktop-cache');
    await fs.mkdir(images, { recursive: true });

    const records = [];
    for (const spec of specs) {
        const filePath = path.join(images, spec.name);
        if (spec.directory) await fs.mkdir(filePath, { recursive: true });
        else if (!spec.missing) await fs.writeFile(filePath, Buffer.from(`image ${spec.id}`));
        records.push({
            id: spec.id,
            filePath,
            fileName: spec.name,
            fileSize: 10,
            prompt: spec.prompt || `prompt ${spec.id}`,
            createdAt: spec.createdAt,
            url: `file:///${spec.name}`
        });
    }

    const state = {
        index: records,
        commits: [],
        unlinkCalls: [],
        logs: [],
        progress: [],
        changes: [],
        binChanges: [],
        purged: [],
        failCommit: false,
        failUnlink: new Map(Object.entries(options.failUnlink || {}))
    };
    const usage = new Map(Object.entries(options.usage || {}));
    const bin = createTombstoneStore({ dir: cache, fs, now: options.now || Date.now });
    await bin.load();
    const enqueue = createSerialTaskQueue();
    const loadIndex = async () => state.index;
    const commit = async next => {
        if (state.failCommit) throw new Error('index write failed');
        state.commits.push(next.map(record => record.id));
        state.index = next.map(record => ({ ...record }));
        if (state.failAfterWrite) throw new Error('similarity notify failed');
        return state.index;
    };

    const trash = createHistoryTrash({
        loadIndex,
        commit,
        enqueue,
        usageStore: options.usageStore || { get: record => usage.get(record.id) || null },
        tombstones: bin,
        fs: options.fs || fs,
        unlink: async filePath => {
            state.unlinkCalls.push(filePath);
            const code = state.failUnlink.get(path.basename(filePath));
            if (code) throw fsError(code, 'unlink', filePath);
            return fs.unlink(filePath);
        },
        hydrate: options.hydrate,
        log: entry => { state.logs.push(entry); },
        now: options.now || Date.now,
        onProgress: event => { state.progress.push(event); },
        onChanged: event => { state.changes.push(event); },
        onBinChanged: event => { state.binChanges.push(event); },
        onPurged: event => { state.purged.push(event); }
    });

    const byId = Object.fromEntries(records.map(record => [record.id, record]));
    const item = id => ({ id, filePath: byId[id].filePath });
    const payload = (ids, extra = {}) => ({
        requestId: `req_${Math.random().toString(16).slice(2)}`,
        items: ids.map(item),
        includeProtected: false,
        confirmProtected: [],
        reason: 'group-cleanup',
        groupId: 'sg_test',
        ...extra
    });
    const binIds = () => bin.list().map(entry => entry.record.id).sort();
    return { root, images, cache, state, trash, bin, binIds, byId, item, payload, usage, enqueue, loadIndex, commit };
}

// ----- mark -----

test('marking keeps the file in place, takes the record out of history and puts it in the bin', async t => {
    const h = await createHarness(t, [
        { id: 'a', name: 'a.png', createdAt: 3, prompt: 'a lighthouse at dusk' },
        { id: 'b', name: 'b.png', createdAt: 2 }
    ]);
    const result = await h.trash.trash(h.payload(['a']));
    assert.deepEqual(result.trashed, [h.item('a')]);
    assert.deepEqual({ missing: result.missing, failed: result.failed, skipped: result.skipped, total: result.total },
        { missing: [], failed: [], skipped: [], total: 1 });
    assert.match(result.batchId, /^trash_/);
    assert.equal(await exists(h.byId.a.filePath), true, 'the file never moves');
    assert.deepEqual(h.state.index.map(record => record.id), ['b']);
    assert.deepEqual(h.state.unlinkCalls, []);

    const [entry] = h.bin.list();
    assert.equal(entry.path, path.resolve(h.byId.a.filePath));
    assert.equal(entry.reason, 'group-cleanup');
    assert.equal(entry.groupId, 'sg_test');
    assert.equal(entry.batchId, result.batchId);
    assert.equal(entry.record.prompt, 'a lighthouse at dusk');
    const saved = JSON.parse(await fs.readFile(path.join(h.cache, 'history-trash.json'), 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(saved.entries[0].record.url, undefined, 'bin entries hold the serialized record');

    assert.deepEqual(h.state.changes, [{ reason: 'trashed', removedIds: ['a'], addedIds: [] }]);
    assert.deepEqual(h.state.binChanges, [{ total: 1 }]);
});

test('only records matching both id and path are marked', async t => {
    const h = await createHarness(t, [
        { id: 'a', name: 'a.png', createdAt: 3 },
        { id: 'b', name: 'b.png', createdAt: 2 }
    ]);
    const result = await h.trash.trash(h.payload([], {
        items: [
            { id: 'a', filePath: h.byId.a.filePath.toUpperCase() },
            { id: 'b', filePath: h.byId.a.filePath },
            { id: 'zzz', filePath: h.byId.b.filePath }
        ]
    }));
    assert.deepEqual(result.trashed.map(entry => entry.id), ['a']);
    assert.deepEqual(result.skipped.map(entry => [entry.id, entry.reason]), [['b', 'not-found'], ['zzz', 'not-found']]);
    assert.deepEqual(h.state.index.map(record => record.id), ['b']);
    assert.equal(result.total, 1);
});

test('protected images are skipped unless included and confirmed', async t => {
    const h = await createHarness(t, [
        { id: 'p', name: 'p.png', createdAt: 3 },
        { id: 'q', name: 'q.png', createdAt: 2 },
        { id: 'r', name: 'r.png', createdAt: 1 }
    ], { usage: { p: { dragCount: 1, referenceCount: 0 }, q: { dragCount: 0, referenceCount: 2 } } });

    let result = await h.trash.trash(h.payload(['p', 'q', 'r']));
    assert.deepEqual(result.trashed.map(entry => entry.id), ['r']);
    assert.deepEqual(result.skipped.map(entry => [entry.id, entry.reason]), [['p', 'protected'], ['q', 'protected']]);

    // the switch alone is not enough: the id must be in confirmProtected (main's count is authoritative)
    result = await h.trash.trash(h.payload(['p', 'q'], { includeProtected: true, confirmProtected: ['p'] }));
    assert.deepEqual(result.trashed.map(entry => entry.id), ['p']);
    assert.deepEqual(result.skipped.map(entry => [entry.id, entry.reason]), [['q', 'protected']]);

    result = await h.trash.trash(h.payload(['q'], { includeProtected: false, confirmProtected: ['q'] }));
    assert.deepEqual(result.skipped.map(entry => entry.reason), ['protected']);
    assert.deepEqual(h.state.index.map(record => record.id), ['q']);
});

test('drag-to-trash marks protected images directly when every id is confirmed', async t => {
    const h = await createHarness(t, [
        { id: 'used', name: 'used.png', createdAt: 2 },
        { id: 'fresh', name: 'fresh.png', createdAt: 1 }
    ], { usage: { used: { dragCount: 3, referenceCount: 1 } } });
    const result = await h.trash.trash(h.payload(['used', 'fresh'], { reason: 'drag', groupId: undefined, includeProtected: true, confirmProtected: ['used', 'fresh'] }));
    assert.deepEqual(result.trashed.map(entry => entry.id), ['used', 'fresh']);
    assert.deepEqual(h.state.index, []);
    assert.deepEqual(h.bin.list().map(entry => entry.reason), ['drag', 'drag']);
    assert.equal(h.bin.list()[0].groupId, undefined);
    assert.equal(await exists(h.byId.used.filePath), true);
});

test('a missing file leaves history without a bin entry', async t => {
    const h = await createHarness(t, [
        { id: 'gone', name: 'gone.png', createdAt: 2, missing: true },
        { id: 'live', name: 'live.png', createdAt: 1 }
    ]);
    const result = await h.trash.trash(h.payload(['gone']));
    assert.deepEqual(result.missing, [{ id: 'gone', filePath: h.byId.gone.filePath }]);
    assert.deepEqual(result.trashed, []);
    assert.deepEqual(h.state.index.map(record => record.id), ['live']);
    assert.deepEqual(h.bin.list(), []);
    assert.deepEqual(h.state.changes, [{ reason: 'trashed', removedIds: ['gone'], addedIds: [] }]);
    assert.deepEqual(h.state.binChanges, [], 'the bin did not change');
});

test('a directory, a link or a non-image file is never marked', async t => {
    const h = await createHarness(t, [
        { id: 'dir', name: 'folder.png', createdAt: 4, directory: true },
        { id: 'txt', name: 'notes.txt', createdAt: 3 },
        { id: 'img', name: 'fine.jpeg', createdAt: 2 }
    ]);
    const specs = ['dir', 'txt', 'img'];
    const link = path.join(h.images, 'link.png');
    let linked = true;
    try { await fs.symlink(h.byId.img.filePath, link, 'file'); } catch { linked = false; }
    if (linked) h.state.index.push({ id: 'lnk', filePath: link, fileName: 'link.png', createdAt: 1 });
    const result = await h.trash.trash(h.payload([], {
        items: [...specs.map(h.item), ...(linked ? [{ id: 'lnk', filePath: link }] : [])]
    }));
    assert.deepEqual(result.skipped.map(entry => [entry.id, entry.reason]),
        [['dir', 'not-a-file'], ['txt', 'not-a-file'], ...(linked ? [['lnk', 'not-a-file']] : [])]);
    assert.deepEqual(result.trashed.map(entry => entry.id), ['img']);
    assert.deepEqual(h.binIds(), ['img']);
    assert.deepEqual(h.state.index.map(record => record.id), ['dir', 'txt', ...(linked ? ['lnk'] : [])]);
});

test('an lstat error other than ENOENT fails the item and keeps its record', async t => {
    const denied = new Set(['locked.png']);
    const h = await createHarness(t, [
        { id: 'locked', name: 'locked.png', createdAt: 2 },
        { id: 'fine', name: 'fine.png', createdAt: 1 }
    ], { fs: deniedFs(denied, 'EACCES') });

    // on its own: nothing is committed, but the failure is still reported and logged once
    let result = await h.trash.trash(h.payload(['locked']));
    assert.deepEqual(result.failed, [{ id: 'locked', filePath: h.byId.locked.filePath, message: '无法读取文件状态，未移到回收站' }]);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.trashed, []);
    assert.equal(result.total, 2);
    assert.deepEqual(h.state.commits, []);
    assert.deepEqual(h.bin.list(), []);
    assert.equal(h.state.logs.length, 1);
    assert.match(h.state.logs[0].details.messages[0], /EACCES/);
    assert.deepEqual(h.state.changes, []);

    // next to a readable image: that one is marked, the unreadable one stays in history
    result = await h.trash.trash(h.payload(['locked', 'fine']));
    assert.deepEqual(result.failed.map(entry => entry.id), ['locked']);
    assert.deepEqual(result.trashed.map(entry => entry.id), ['fine']);
    assert.deepEqual(h.state.index.map(record => record.id), ['locked']);
    assert.deepEqual(h.binIds(), ['fine']);
    assert.equal(h.state.logs.length, 2);
});

test('protection holds when the usage store has not been loaded before the mark', async t => {
    const usageDir = await temporaryDirectory();
    t.after(() => fs.rm(usageDir, { recursive: true, force: true }));
    // written by an earlier session: dragged.png (fileSize 10, as in the harness) was dragged out once
    await fs.writeFile(path.join(usageDir, 'history-usage.json'), JSON.stringify({
        version: 1,
        entries: { 'dragged.png|10': { dragCount: 1, referenceCount: 0, lastUsedAt: 5, lastUsedKind: 'drag-out' } }
    }));
    const usageStore = createHistoryUsageStore({ dir: usageDir });
    assert.equal(usageStore.get({ fileName: 'dragged.png', fileSize: 10 }), null, 'an unloaded store knows nothing yet');
    const h = await createHarness(t, [
        { id: 'dragged', name: 'dragged.png', createdAt: 2 },
        { id: 'plain', name: 'plain.png', createdAt: 1 }
    ], { usageStore });

    const result = await h.trash.trash(h.payload(['dragged', 'plain']));
    assert.deepEqual(result.trashed.map(entry => entry.id), ['plain']);
    assert.deepEqual(result.skipped.map(entry => [entry.id, entry.reason]), [['dragged', 'protected']]);
    assert.deepEqual(h.state.index.map(record => record.id), ['dragged']);
});

test('an unreadable usage file makes the mark fail before anything changes, and a retry uses its counts', async t => {
    const usageDir = await temporaryDirectory();
    t.after(() => fs.rm(usageDir, { recursive: true, force: true }));
    const usageFile = path.join(usageDir, 'history-usage.json');
    const original = JSON.stringify({
        version: 1,
        entries: { 'a.png|10': { dragCount: 0, referenceCount: 2, lastUsedAt: 5, lastUsedKind: 'reference' } }
    });
    await fs.writeFile(usageFile, original);
    const gate = { deny: true };
    const usageStore = createHistoryUsageStore({ dir: usageDir, fs: unreadableFs(gate) });
    const h = await createHarness(t, [
        { id: 'a', name: 'a.png', createdAt: 2 },
        { id: 'b', name: 'b.png', createdAt: 1 }
    ], { usageStore });

    await assert.rejects(h.trash.trash(h.payload(['a', 'b'])), { code: 'EACCES' });
    assert.deepEqual(h.state.commits, []);
    assert.deepEqual(h.state.index.map(record => record.id), ['a', 'b']);
    assert.deepEqual(h.bin.list(), []);
    assert.equal(await fs.readFile(usageFile, 'utf8'), original);
    assert.deepEqual(await fs.readdir(usageDir), ['history-usage.json']);

    gate.deny = false;
    const retry = await h.trash.trash(h.payload(['a', 'b']));
    assert.deepEqual(retry.skipped.map(entry => [entry.id, entry.reason]), [['a', 'protected']]);
    assert.deepEqual(retry.trashed.map(entry => entry.id), ['b']);
});

test('a commit failure marks nothing and removes its bin entries', async t => {
    const h = await createHarness(t, [{ id: 'a', name: 'a.png', createdAt: 1 }]);
    h.state.failCommit = true;
    await assert.rejects(h.trash.trash(h.payload(['a'])), /index write failed/);
    assert.deepEqual(h.state.index.map(record => record.id), ['a']);
    assert.deepEqual(h.bin.list(), []);
    const saved = JSON.parse(await fs.readFile(path.join(h.cache, 'history-trash.json'), 'utf8'));
    assert.deepEqual(saved.entries, []);
    assert.deepEqual(h.state.binChanges, []);

    // the same request can be retried once the index is writable again
    h.state.failCommit = false;
    const retry = await h.trash.trash(h.payload(['a']));
    assert.deepEqual(retry.trashed.map(entry => entry.id), ['a']);
});

test('a commit that rejects after the index write landed keeps the records in the bin', async t => {
    const h = await createHarness(t, [
        { id: 'a', name: 'a.png', createdAt: 2 },
        { id: 'b', name: 'b.png', createdAt: 1 }
    ]);
    h.state.failAfterWrite = true;
    await assert.rejects(h.trash.trash(h.payload(['a'])), /similarity notify failed/);
    assert.deepEqual(h.state.index.map(record => record.id), ['b']);
    assert.deepEqual(h.binIds(), ['a']);

    h.state.failAfterWrite = false;
    const restored = await h.trash.restore({ paths: [h.byId.a.filePath] });
    assert.deepEqual(restored.restored, ['a']);
    assert.deepEqual(h.state.index.map(record => record.id), ['a', 'b']);
});

test('a repeated requestId returns the first result without marking again', async t => {
    const h = await createHarness(t, [{ id: 'a', name: 'a.png', createdAt: 1 }]);
    const payload = h.payload(['a']);
    const [first, concurrent] = await Promise.all([h.trash.trash(payload), h.trash.trash({ ...payload })]);
    const again = await h.trash.trash({ ...payload });
    assert.equal(h.state.commits.length, 1);
    assert.deepEqual(concurrent, first);
    assert.deepEqual(again, first);
    assert.deepEqual(first.trashed.map(entry => entry.id), ['a']);
});

test('the index commit (which notifies similarity) receives the post-removal list', async t => {
    const h = await createHarness(t, [
        { id: 'a', name: 'a.png', createdAt: 3 },
        { id: 'b', name: 'b.png', createdAt: 2 },
        { id: 'c', name: 'c.png', createdAt: 1 }
    ]);
    await h.trash.trash(h.payload(['a', 'c']));
    assert.deepEqual(h.state.commits, [['b']]);
});

test('invalid payloads throw before touching anything', async t => {
    const h = await createHarness(t, [{ id: 'a', name: 'a.png', createdAt: 1 }]);
    const tooMany = Array.from({ length: 1001 }, () => h.item('a'));
    for (const bad of [
        null,
        h.payload([], { items: [] }),
        h.payload([], { items: tooMany }),
        h.payload(['a'], { reason: 'everything' }),
        h.payload(['a'], { requestId: '' }),
        h.payload([], { items: [{ id: 'a' }] }),
        h.payload(['a'], { confirmProtected: 'a' })
    ]) {
        await assert.rejects(h.trash.trash(bad), TypeError);
    }
    for (const bad of ['all', { paths: 'x' }, { paths: [''] }, { paths: [1] }]) {
        await assert.rejects(h.trash.restore(bad), TypeError);
        await assert.rejects(h.trash.purge(bad), TypeError);
    }
    assert.deepEqual(h.state.index.map(record => record.id), ['a']);
    assert.deepEqual(h.bin.list(), []);
});

// ----- restore -----

test('restore brings records back with their prompt in createdAt order and empties their entries', async t => {
    const h = await createHarness(t, [
        { id: 'k', name: 'k.png', createdAt: 60 },
        { id: 'a', name: 'a.png', createdAt: 50, prompt: 'a lighthouse at dusk' },
        { id: 'm', name: 'm.png', createdAt: 35 },
        { id: 'c', name: 'c.png', createdAt: 30 }
    ]);
    await h.trash.trash(h.payload(['a', 'c']));
    assert.deepEqual(h.state.index.map(record => record.id), ['k', 'm']);
    h.state.binChanges.length = 0;

    const one = await h.trash.restore({ paths: [h.byId.a.filePath.toUpperCase()] });
    assert.deepEqual(one, { restored: ['a'], missing: [], failed: [] });
    assert.deepEqual(h.state.index.map(record => record.id), ['k', 'a', 'm']);
    const back = h.state.index.find(record => record.id === 'a');
    assert.equal(back.prompt, 'a lighthouse at dusk');
    assert.equal(back.filePath, path.resolve(h.byId.a.filePath));
    assert.deepEqual(h.binIds(), ['c']);
    assert.deepEqual(h.state.changes.at(-1), { reason: 'restored', removedIds: [], addedIds: ['a'] });
    assert.deepEqual(h.state.binChanges, [{ total: 1 }]);

    // paths omitted = everything
    const all = await h.trash.restore();
    assert.deepEqual(all.restored, ['c']);
    assert.deepEqual(h.state.index.map(record => record.id), ['k', 'a', 'm', 'c']);
    assert.deepEqual(h.bin.list(), []);
    const saved = JSON.parse(await fs.readFile(path.join(h.cache, 'history-trash.json'), 'utf8'));
    assert.deepEqual(saved.entries, []);

    // nothing left: no commit, no event
    const commits = h.state.commits.length;
    const changes = h.state.changes.length;
    assert.deepEqual(await h.trash.restore({ paths: null }), { restored: [], missing: [], failed: [] });
    assert.equal(h.state.commits.length, commits);
    assert.equal(h.state.changes.length, changes);
});

test('restore never duplicates a path already in history, drops gone entries and keeps unreadable ones', async t => {
    const denied = new Set();
    const h = await createHarness(t, [
        { id: 'a', name: 'a.png', createdAt: 30 },
        { id: 'b', name: 'b.png', createdAt: 20 },
        { id: 'c', name: 'c.png', createdAt: 10 }
    ], { fs: deniedFs(denied, 'EPERM') });
    await h.trash.trash(h.payload(['a', 'b', 'c']));
    // a is back in history by other means (other casing), b's file was deleted outside PicGen, c is unreadable
    h.state.index = [{ ...h.byId.a, filePath: h.byId.a.filePath.toUpperCase() }];
    await fs.rm(h.byId.b.filePath);
    denied.add('c.png');

    const result = await h.trash.restore();
    assert.deepEqual(result.restored, ['a']);
    assert.deepEqual(result.missing, [path.resolve(h.byId.b.filePath)]);
    assert.deepEqual(result.failed, [{ filePath: path.resolve(h.byId.c.filePath), message: '无法读取文件状态，未还原' }]);
    assert.deepEqual(h.state.index.map(record => record.id), ['a'], 'not added twice');
    assert.deepEqual(h.binIds(), ['c'], 'the unreadable entry stays in the bin');

    denied.clear();
    assert.deepEqual((await h.trash.restore()).restored, ['c']);
    assert.deepEqual(h.state.index.map(record => record.id), ['a', 'c']);
});

test('a restore whose commit fails leaves every entry in the bin', async t => {
    const h = await createHarness(t, [{ id: 'a', name: 'a.png', createdAt: 1 }]);
    await h.trash.trash(h.payload(['a']));
    h.state.failCommit = true;
    await assert.rejects(h.trash.restore(), /index write failed/);
    assert.deepEqual(h.binIds(), ['a']);
    assert.deepEqual(h.state.index, []);
});

test('restore and purge wait for the history queue', async t => {
    const h = await createHarness(t, [
        { id: 'a', name: 'a.png', createdAt: 2 },
        { id: 'b', name: 'b.png', createdAt: 1 }
    ]);
    await h.trash.trash(h.payload(['a', 'b']));
    const gate = deferred();
    const blocker = h.enqueue(() => gate.promise);
    const restoring = h.trash.restore({ paths: [h.byId.a.filePath] });
    const purging = h.trash.purge({ paths: [h.byId.b.filePath] });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(h.state.index, [], 'nothing restored while the queue is busy');
    assert.equal(await exists(h.byId.b.filePath), true, 'nothing deleted while the queue is busy');
    gate.resolve();
    await blocker;
    assert.deepEqual((await restoring).restored, ['a']);
    assert.deepEqual((await purging).deleted, [path.resolve(h.byId.b.filePath)]);
});

// ----- purge -----

test('purge hard-deletes the files, counts an already-gone file as deleted and drops their entries', async t => {
    const h = await createHarness(t, [
        { id: 'a', name: 'a.png', createdAt: 3 },
        { id: 'b', name: 'b.png', createdAt: 2 },
        { id: 'c', name: 'c.png', createdAt: 1 }
    ]);
    await h.trash.trash(h.payload(['a', 'b', 'c']));
    await fs.rm(h.byId.b.filePath); // deleted outside PicGen meanwhile
    h.state.binChanges.length = 0;

    const result = await h.trash.purge({ paths: [h.byId.a.filePath, h.byId.b.filePath] });
    assert.deepEqual(result.deleted, [path.resolve(h.byId.a.filePath), path.resolve(h.byId.b.filePath)]);
    assert.deepEqual(result.failed, []);
    assert.equal(await exists(h.byId.a.filePath), false);
    assert.equal(await exists(h.byId.c.filePath), true);
    assert.deepEqual(h.state.unlinkCalls, [path.resolve(h.byId.a.filePath)]);
    assert.deepEqual(h.binIds(), ['c']);
    assert.deepEqual(h.state.binChanges, [{ total: 1 }]);
    assert.equal(h.state.purged.length, 1);
    assert.equal(h.state.purged[0].filePath, path.resolve(h.byId.a.filePath));
    assert.equal(typeof h.state.purged[0].stat.mtimeMs, 'number', 'the cache hook receives the stat taken before the unlink');
    assert.deepEqual(h.state.index, [], 'purge never touches history');

    // paths omitted = empty the whole bin
    const rest = await h.trash.purge();
    assert.deepEqual(rest.deleted, [path.resolve(h.byId.c.filePath)]);
    assert.deepEqual(h.bin.list(), []);
    assert.equal(await exists(h.byId.c.filePath), false);
    const saved = JSON.parse(await fs.readFile(path.join(h.cache, 'history-trash.json'), 'utf8'));
    assert.deepEqual(saved.entries, []);
    assert.equal(h.state.logs.length, 0);
});

test('a refused unlink fails the item, keeps its entry and file, and is logged', async t => {
    const h = await createHarness(t, [
        { id: 'locked', name: 'locked.png', createdAt: 2 },
        { id: 'fine', name: 'fine.png', createdAt: 1 }
    ], { failUnlink: { 'locked.png': 'EPERM' } });
    await h.trash.trash(h.payload(['locked', 'fine']));
    const result = await h.trash.purge();
    assert.deepEqual(result.deleted, [path.resolve(h.byId.fine.filePath)]);
    assert.deepEqual(result.failed, [{ filePath: path.resolve(h.byId.locked.filePath), message: '无法彻底删除（文件可能被占用或没有权限）' }]);
    assert.equal(await exists(h.byId.locked.filePath), true);
    assert.deepEqual(h.binIds(), ['locked']);
    assert.equal(h.state.logs.length, 1);
    assert.equal(h.state.logs[0].operation, 'purge-history-bin');
    assert.match(h.state.logs[0].details.messages[0], /EPERM/);
});

test('purge never unlinks a directory, a link or a non-image file, and leaves an unreadable one alone', async t => {
    const denied = new Set();
    const h = await createHarness(t, [
        { id: 'img', name: 'img.png', createdAt: 3 },
        { id: 'dir', name: 'dir.png', createdAt: 2 },
        { id: 'lnk', name: 'lnk.png', createdAt: 1 },
        { id: 'odd', name: 'odd.png', createdAt: 0 }
    ], { fs: deniedFs(denied, 'EACCES') });
    const target = path.join(h.root, 'outside.png');
    await fs.writeFile(target, 'keep me');
    await h.trash.trash(h.payload(['img', 'dir', 'lnk', 'odd']));
    // after the mark, the paths change under the bin's feet
    await fs.rm(h.byId.dir.filePath);
    await fs.mkdir(h.byId.dir.filePath);
    await fs.rm(h.byId.lnk.filePath);
    let linked = true;
    try { await fs.symlink(target, h.byId.lnk.filePath, 'file'); } catch { linked = false; }
    denied.add('odd.png');
    // a v1-era entry for a non-image file
    const notes = path.join(h.images, 'notes.txt');
    await fs.writeFile(notes, 'text');
    h.bin.add([{ path: notes, trashedAt: 1, reason: 'selection', record: { id: 'txt' } }]);

    const result = await h.trash.purge();
    assert.deepEqual(result.deleted, [path.resolve(h.byId.img.filePath)]);
    const failed = Object.fromEntries(result.failed.map(entry => [path.basename(entry.filePath), entry.message]));
    assert.equal(failed['dir.png'], '不是普通图片文件，未删除');
    assert.equal(failed['notes.txt'], '不是普通图片文件，未删除');
    assert.equal(failed['odd.png'], '无法彻底删除（文件可能被占用或没有权限）');
    if (linked) assert.equal(failed['lnk.png'], '不是普通图片文件，未删除');
    assert.deepEqual(h.state.unlinkCalls, [path.resolve(h.byId.img.filePath)]);
    assert.equal((await fs.stat(h.byId.dir.filePath)).isDirectory(), true);
    assert.equal(await fs.readFile(target, 'utf8'), 'keep me', 'a link target is never touched');
    assert.equal(await exists(notes), true);
    assert.deepEqual(h.binIds(), ['dir', 'odd', 'txt', ...(linked ? ['lnk'] : [])].sort());
});

test('purge reports progress for batches over 20', async t => {
    const specs = Array.from({ length: 25 }, (_, index) => ({ id: `i${index}`, name: `i${index}.png`, createdAt: 100 - index }));
    const h = await createHarness(t, specs);
    await h.trash.trash(h.payload(specs.map(spec => spec.id)));
    const result = await h.trash.purge();
    assert.equal(result.deleted.length, 25);
    assert.deepEqual(h.state.progress.map(event => [event.kind, event.done, event.total]), [['purge', 25, 25]]);
    assert.match(h.state.progress[0].batchId, /^purge_/);
});

// ----- list, count, sweep -----

test('list returns hydrated items newest-trashed first and drops entries whose file is gone', async t => {
    let clock = 1000;
    const h = await createHarness(t, [
        { id: 'a', name: 'a.png', createdAt: 3, prompt: 'first' },
        { id: 'b', name: 'b.png', createdAt: 2 },
        { id: 'c', name: 'c.png', createdAt: 1 }
    ], { now: () => clock, hydrate: record => ({ ...record, url: `file:///${record.fileName}`, hydrated: true }) });
    await h.trash.trash(h.payload(['a'], { reason: 'selection', groupId: undefined }));
    clock = 2000;
    await h.trash.trash(h.payload(['b', 'c']));
    await fs.rm(h.byId.c.filePath);
    h.state.binChanges.length = 0;

    assert.deepEqual(await h.trash.count(), { total: 3 });
    const listed = await h.trash.list();
    assert.equal(listed.total, 2);
    assert.deepEqual(listed.items.map(item => item.id), ['b', 'a']);
    const [b, a] = listed.items;
    assert.equal(a.prompt, 'first');
    assert.equal(a.filePath, path.resolve(h.byId.a.filePath));
    assert.equal(a.url, 'file:///a.png');
    assert.equal(a.hydrated, true);
    assert.deepEqual({ binnedAt: a.binnedAt, binReason: a.binReason, binGroupId: a.binGroupId }, { binnedAt: 1000, binReason: 'selection', binGroupId: undefined });
    assert.deepEqual({ binnedAt: b.binnedAt, binReason: b.binReason, binGroupId: b.binGroupId }, { binnedAt: 2000, binReason: 'group-cleanup', binGroupId: 'sg_test' });
    assert.deepEqual(h.binIds(), ['a', 'b'], 'the gone entry was dropped');
    assert.deepEqual(h.state.binChanges, [{ total: 2 }]);
    assert.deepEqual(await h.trash.count(), { total: 2 });
});

test('list order is deterministic within one millisecond: later batch first, newest image first within a batch', async t => {
    const h = await createHarness(t, [
        { id: 'old', name: 'old.png', createdAt: 1 },
        { id: 'new', name: 'new.png', createdAt: 9 },
        { id: 'later', name: 'later.png', createdAt: 0 }
    ], { now: () => 5000 });
    await h.trash.trash(h.payload(['old', 'new']));
    await h.trash.trash(h.payload(['later']));
    assert.deepEqual((await h.trash.list()).items.map(item => item.id), ['later', 'new', 'old']);
});

test('sweep drops only entries whose file is provably gone', async t => {
    const denied = new Set();
    const h = await createHarness(t, [
        { id: 'a', name: 'a.png', createdAt: 3 },
        { id: 'b', name: 'b.png', createdAt: 2 },
        { id: 'c', name: 'c.png', createdAt: 1 }
    ], { fs: deniedFs(denied, 'EACCES') });
    await h.trash.trash(h.payload(['a', 'b', 'c']));
    h.state.binChanges.length = 0;
    assert.deepEqual(await h.trash.sweep(), { dropped: [], total: 3 });
    assert.deepEqual(h.state.binChanges, [], 'nothing dropped, nothing pushed');

    await fs.rm(h.byId.a.filePath);
    await fs.rm(h.byId.b.filePath);
    denied.add('b.png'); // gone, but its status cannot be read: not provably gone
    const swept = await h.trash.sweep();
    assert.deepEqual(swept, { dropped: [path.resolve(h.byId.a.filePath)], total: 2 });
    assert.deepEqual(h.binIds(), ['b', 'c']);
    assert.deepEqual(h.state.binChanges, [{ total: 2 }]);
    assert.deepEqual(h.state.index, [], 'a sweep never touches history');
});

// ----- load-time pass -----

test('reconcileHistoryBin takes binned records out of history and reports gone entries (ENOENT only)', async t => {
    const root = await temporaryDirectory();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = name => path.join(root, name);
    for (const name of ['kept.png', 'binned.png', 'locked.png']) await fs.writeFile(file(name), 'x');
    const records = [
        { id: 'kept', filePath: file('kept.png') },
        { id: 'binned', filePath: file('BINNED.png') },
        { id: 'ghost', filePath: file('ghost.png') }
    ];
    const entries = ['binned.png', 'ghost.png', 'locked.png'].map(name => ({ path: file(name), record: { id: name } }));
    const outcome = await reconcileHistoryBin({ records, entries, fs: deniedFs(new Set(['locked.png']), 'EACCES') });
    assert.deepEqual(outcome.records.map(record => record.id), ['kept']);
    assert.equal(outcome.changed, true);
    assert.deepEqual(outcome.removed.map(record => record.id), ['binned', 'ghost']);
    assert.deepEqual(outcome.binnedPaths, entries.map(entry => path.resolve(entry.path)));
    assert.deepEqual(outcome.gone.map(entry => entry.record.id), ['ghost.png'], 'an unreadable path is not gone');

    const empty = await reconcileHistoryBin({ records, entries: [] });
    assert.equal(empty.records, records);
    assert.equal(empty.changed, false);
    const untouched = await reconcileHistoryBin({ records: records.slice(0, 1), entries });
    assert.equal(untouched.changed, false);
});

// ----- the store -----

test('the bin store is lazy, replaces by path and removes case-insensitively', async t => {
    const root = await temporaryDirectory();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = path.join(root, 'desktop-cache');
    const store = createTombstoneStore({ dir, fs, now: () => 1000 });
    await store.load();
    await store.save();
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });

    store.add([
        { path: 'D:\\h\\x.png', batchId: 'trash_1', reason: 'selection', record: { id: 'x', prompt: 'old' } },
        { path: 'D:\\h\\y.png', batchId: 'trash_1', reason: 'selection', record: { id: 'y' } }
    ]);
    store.add([{ path: 'd:/H/X.png', trashedAt: 2000, batchId: 'trash_2', reason: 'group-cleanup', groupId: 'sg_1', record: { id: 'x', prompt: 'new' } }]);
    assert.deepEqual(store.list().map(entry => [entry.record.id, entry.record.prompt || '']).sort(), [['x', 'new'], ['y', '']]);
    assert.equal(store.list().find(entry => entry.record.id === 'y').trashedAt, 1000);
    assert.equal(store.has('d:/h/Y.PNG'), true);
    assert.equal(store.has('D:\\h\\z.png'), false);
    await store.save();

    const reloaded = createTombstoneStore({ dir, fs, now: () => 3000 });
    await reloaded.load();
    assert.equal(reloaded.list().length, 2);
    const x = reloaded.list().find(entry => entry.record.id === 'x');
    assert.deepEqual({ batchId: x.batchId, reason: x.reason, groupId: x.groupId, trashedAt: x.trashedAt }, { batchId: 'trash_2', reason: 'group-cleanup', groupId: 'sg_1', trashedAt: 2000 });
    assert.equal(reloaded.remove(['D:\\H\\Y.PNG']), 1);
    await reloaded.save();
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'history-trash.json'), 'utf8'));
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.entries.map(entry => entry.record.id), ['x']);
});

test('the bin is never pruned, and a version 1 file is read as bin entries and rewritten as version 2', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const now = 4000 * DAY;
    const old = Array.from({ length: 30 }, (_, index) => ({ path: `D:\\h\\old${index}.png`, trashedAt: now - (1000 + index) * DAY, reason: 'selection', record: { id: `old${index}` } }));
    await fs.writeFile(path.join(dir, 'history-trash.json'), JSON.stringify({ version: 1, entries: old }));
    const store = createTombstoneStore({ dir, fs, now: () => now, retentionDays: 1, maxEntries: 3 });
    await store.load();
    assert.equal(store.list().length, 30, 'no retention and no max-entries eviction');
    store.add([{ path: 'D:\\h\\new.png', reason: 'drag', record: { id: 'new' } }]);
    assert.equal(store.list().length, 31);
    await store.save();
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'history-trash.json'), 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(saved.entries.length, 31);

    // an untouched v1 file is upgraded by the next save
    const legacy = await temporaryDirectory();
    t.after(() => fs.rm(legacy, { recursive: true, force: true }));
    await fs.writeFile(path.join(legacy, 'history-trash.json'), JSON.stringify({ version: 1, entries: old.slice(0, 1) }));
    const upgraded = createTombstoneStore({ dir: legacy, fs });
    await upgraded.load();
    assert.equal(await upgraded.save(), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(legacy, 'history-trash.json'), 'utf8')).version, 2);
});

test('a corrupt bin file is moved aside and the store starts empty', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'history-trash.json'), '{"version":2,"entries":[');
    const logs = [];
    const store = createTombstoneStore({ dir, fs, log: entry => { logs.push(entry); } });
    await store.load();
    assert.deepEqual(store.list(), []);
    const names = await fs.readdir(dir);
    assert.equal(names.filter(name => /^history-trash\.corrupt-.+\.json$/.test(name)).length, 1);
    assert.equal(names.includes('history-trash.json'), false);
    assert.equal(logs.length, 1);
});

test('an unreadable bin file makes load() reject without touching it, and a retry loads it', async t => {
    const dir = await temporaryDirectory();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'history-trash.json');
    const original = JSON.stringify({ version: 2, entries: [{ path: 'D:\\h\\x.png', trashedAt: 5, record: { id: 'x' } }] });
    await fs.writeFile(file, original);
    const gate = { deny: true };
    const logs = [];
    const store = createTombstoneStore({ dir, fs: unreadableFs(gate), now: () => 10, log: entry => { logs.push(entry); } });

    await assert.rejects(store.load(), { code: 'EACCES' });
    assert.deepEqual(store.list(), []);
    await store.save();
    assert.equal(await fs.readFile(file, 'utf8'), original);
    assert.deepEqual(await fs.readdir(dir), ['history-trash.json'], 'nothing is moved aside as corrupt');
    assert.deepEqual(logs, []);

    gate.deny = false;
    await store.load();
    assert.deepEqual(store.list().map(entry => entry.record.id), ['x']);
});

test('protection is read from the real usage store at mark time, and marking keeps the counters', async t => {
    const usageDir = await temporaryDirectory();
    t.after(() => fs.rm(usageDir, { recursive: true, force: true }));
    const usageStore = createHistoryUsageStore({ dir: usageDir });
    const h = await createHarness(t, [
        { id: 'dragged', name: 'dragged.png', createdAt: 2 },
        { id: 'plain', name: 'plain.png', createdAt: 1 }
    ], { usageStore });
    // the drag-out lands after the renderer built its plan: main still keeps the image
    await usageStore.record(h.byId.dragged, 'drag-out', 'native-drag');
    const result = await h.trash.trash(h.payload(['dragged', 'plain']));
    assert.deepEqual(result.trashed.map(entry => entry.id), ['plain']);
    assert.deepEqual(result.skipped.map(entry => [entry.id, entry.reason]), [['dragged', 'protected']]);
    const confirmed = await h.trash.trash(h.payload(['dragged'], { includeProtected: true, confirmProtected: ['dragged'] }));
    assert.deepEqual(confirmed.trashed.map(entry => entry.id), ['dragged']);
    await h.trash.restore();
    // the usage entry survives mark and restore, so a restored image keeps its protection
    assert.equal(usageStore.get(h.byId.dragged).dragCount, 1);
});
