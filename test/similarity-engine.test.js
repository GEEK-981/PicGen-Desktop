const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { createSimilarityEngine, snapshotDigest } = require('../similarityEngine');
const F = require('../similarityFeatures');
const { HD, H } = require('../similarityDistance');
const { openStore, featureKey } = require('../similarityStore');
const { historyThumbnailKey } = require('../historyThumbnailKey');
const { anchorId } = require('../similarityCluster');

// Synthetic fixtures only: solid-colour "images" in a memory fs, a fake decoder that turns a
// per-file spec into pixel buffers, a fake embedder that maps a colour to a fixed unit vector,
// and a fake clock. No real prompts, files or models.

const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
const MIN = 60 * 1000;
const ROOT = path.resolve(path.sep, 'picgen-engine-fixture');
const LIB = path.join(ROOT, 'desktop-cache', 'images');
const MOVED = path.join(ROOT, 'old-portable', 'images');
const STORE = path.join(ROOT, 'desktop-cache', 'similarity');
const THUMBS = path.join(ROOT, 'desktop-cache', 'thumbnails');
const EMB = `${F.EMB_VERSION_BASE}+ort1.24`;

const COLOURS = Object.freeze({
    red: [220, 30, 30],
    green: [30, 190, 40],
    blue: [30, 50, 220],
    yellow: [235, 220, 40],
    purple: [140, 40, 170],
    teal: [20, 160, 160],
    pink: [245, 150, 200],
    grey: [128, 128, 128]
});

// --- memory fs (the node:fs/promises subset the engine and the store use) ------------------

function fsError(code, op, file) {
    return Object.assign(new Error(`${code}: ${op} '${file}'`), { code });
}

function memoryFs(now) {
    const files = new Map(); // lower-case resolved path -> {name, data, mtimeMs}
    const dirs = new Map();
    const id = file => path.resolve(String(file)).toLowerCase();
    const addDir = dir => {
        let current = path.resolve(String(dir));
        for (;;) {
            dirs.set(current.toLowerCase(), current);
            const up = path.dirname(current);
            if (up === current) return;
            current = up;
        }
    };
    const statOf = file => ({
        size: file.data.length,
        mtimeMs: file.mtimeMs,
        isFile: () => true,
        isDirectory: () => false
    });
    const api = {
        async mkdir(dir) { addDir(dir); },
        async stat(file) {
            const entry = files.get(id(file));
            if (entry) return statOf(entry);
            if (dirs.has(id(file))) return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true };
            throw fsError('ENOENT', 'stat', file);
        },
        async readFile(file, options) {
            const entry = files.get(id(file));
            if (!entry) throw fsError('ENOENT', 'open', file);
            const encoding = typeof options === 'string' ? options : options?.encoding;
            return encoding ? entry.data.toString(encoding) : Buffer.from(entry.data);
        },
        async writeFile(file, data, options) {
            const key = id(file);
            if (options?.flag === 'wx' && files.has(key)) throw fsError('EEXIST', 'open', file);
            if (!dirs.has(id(path.dirname(path.resolve(String(file)))))) throw fsError('ENOENT', 'open', file);
            files.set(key, { name: path.resolve(String(file)), data: Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data), mtimeMs: now() });
        },
        async rename(from, to) {
            const entry = files.get(id(from));
            if (!entry) throw fsError('ENOENT', 'rename', from);
            files.delete(id(from));
            files.set(id(to), { ...entry, name: path.resolve(String(to)) });
        },
        async unlink(file) {
            if (!files.delete(id(file))) throw fsError('ENOENT', 'unlink', file);
        },
        async readdir(dir) {
            const key = id(dir);
            if (!dirs.has(key)) throw fsError('ENOENT', 'scandir', dir);
            return [...files.values()].filter(entry => id(path.dirname(entry.name)) === key).map(entry => path.basename(entry.name));
        },
        async open(file) {
            const entry = files.get(id(file));
            if (!entry) throw fsError('ENOENT', 'open', file);
            return {
                async write(buffer, offset, length, position) {
                    const end = position + length;
                    if (entry.data.length < end) {
                        const grown = Buffer.alloc(end);
                        entry.data.copy(grown);
                        entry.data = grown;
                    }
                    buffer.copy(entry.data, position, offset, offset + length);
                    entry.mtimeMs = now();
                    return { bytesWritten: length, buffer };
                },
                async close() {}
            };
        }
    };
    return {
        api,
        put(file, data, mtimeMs = now()) {
            addDir(path.dirname(path.resolve(file)));
            files.set(id(file), { name: path.resolve(file), data: Buffer.from(data), mtimeMs });
        },
        remove(file) { files.delete(id(file)); },
        exists(file) { return files.has(id(file)); },
        statSync(file) { return statOf(files.get(id(file))); }
    };
}

// --- fake clock -----------------------------------------------------------------------------------

async function settle(rounds = 60) {
    for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

function fakeClock(start = T0) {
    let now = start;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout(fn, ms) {
            const handle = ++seq;
            timers.set(handle, { at: now + Math.max(0, Number(ms) || 0), fn });
            return handle;
        },
        clearTimeout(handle) { timers.delete(handle); },
        async advance(ms) {
            const target = now + ms;
            for (;;) {
                await settle();
                let next = null;
                for (const [handle, timer] of timers) {
                    if (timer.at <= target && (!next || timer.at < next.timer.at || (timer.at === next.timer.at && handle < next.handle))) {
                        next = { handle, timer };
                    }
                }
                if (!next) break;
                timers.delete(next.handle);
                now = Math.max(now, next.timer.at);
                next.timer.fn();
            }
            now = target;
            await settle();
        }
    };
}

// --- fake decoder and embedder --------------------------------------------------------------------

function solid(pixels, [r, g, b]) {
    const out = Buffer.alloc(pixels * 3);
    for (let i = 0; i < pixels; i++) {
        out[3 * i] = r;
        out[3 * i + 1] = g;
        out[3 * i + 2] = b;
    }
    return out;
}

function fakeDecoder(specs) {
    const decoder = {
        calls: [],
        probes: [],
        active: 0,
        maxActive: 0,
        gate: null,
        hold() {
            let release;
            decoder.gate = new Promise(resolve => { release = resolve; });
            return () => {
                decoder.gate = null;
                release();
            };
        },
        async probe(file) {
            decoder.probes.push(file);
            const spec = specs.get(path.resolve(file).toLowerCase());
            if (!spec) throw new Error(`no such file ${file}`);
            return { hasAlpha: Boolean(spec.alpha), width: 100, height: 100, format: 'png' };
        },
        async decode({ originalPath, jpegPath = null, hasAlpha } = {}) {
            decoder.calls.push({ originalPath, jpegPath, hasAlpha });
            decoder.active++;
            decoder.maxActive = Math.max(decoder.maxActive, decoder.active);
            try {
                while (decoder.gate) await decoder.gate;
                await new Promise(resolve => setImmediate(resolve));
                const spec = specs.get(path.resolve(originalPath).toLowerCase());
                if (!spec) throw new Error(`no such file ${originalPath}`);
                if (spec.fail) throw new Error('corrupt image');
                const rgb224 = solid(224 * 224, spec.colour);
                rgb224[3] = spec.tint || 0;
                return {
                    rgb64: solid(64 * 64, spec.colour),
                    rgb224,
                    logR: spec.logR || 0,
                    source: jpegPath ? 'jpeg360' : 'original',
                    originalHasAlpha: Boolean(spec.alpha)
                };
            } finally {
                decoder.active--;
            }
        },
        // Crops: `spec.crops` lists 9 colours (default: the image colour everywhere).
        cropCalls: [],
        async decodeCrops({ originalPath } = {}) {
            decoder.cropCalls.push(originalPath);
            await new Promise(resolve => setImmediate(resolve));
            const spec = specs.get(path.resolve(originalPath).toLowerCase());
            if (!spec) throw new Error(`no such file ${originalPath}`);
            if (spec.cropFail) throw new Error('crop decode failed');
            return Array.from({ length: 9 }, (_, i) => solid(224 * 224, (spec.crops && spec.crops[i]) || spec.colour));
        },
        async decodeSubject({ originalPath } = {}) {
            const spec = specs.get(path.resolve(originalPath).toLowerCase());
            if (!spec) throw new Error(`no such file ${originalPath}`);
            const mask = new Uint8Array(256).fill(1);
            return { rgb224: solid(224 * 224, spec.colour), mask, subjectPatches: 256 };
        }
    };
    return decoder;
}

// One unit vector per colour (and tint): identical pixels give cos 1, different colours give
// cos ≈ 0 (below the 0.40 veto).
function vectorFor(rgb224) {
    const [r, g, b] = rgb224;
    const tint = rgb224[3];
    const index = (r * 7 + g * 13 + b * 17) % 384;
    const v = new Float32Array(384);
    v[index] = 1;
    v[(index + 2) % 384] = tint / 255;
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
}

function fakeEmbedder({ embVersion = EMB, failWhen = () => false } = {}) {
    let loaded = false;
    const embedder = {
        creates: 0,
        releases: 0,
        embeds: 0,
        attempts: 0,
        async load() {
            if (!loaded) {
                embedder.creates++;
                loaded = true;
            }
            return { ok: true, ortVersion: '1.24.3', embVersion };
        },
        async embed(rgb224, mask = null) {
            embedder.masks = (embedder.masks || 0) + (mask ? 1 : 0);
            if (!loaded) {
                embedder.creates++;
                loaded = true;
            }
            embedder.attempts++;
            if (failWhen(rgb224)) throw new Error('session.run failed');
            embedder.embeds++;
            return vectorFor(rgb224);
        },
        async release() {
            if (loaded) embedder.releases++;
            loaded = false;
        },
        get loaded() { return loaded; }
    };
    return embedder;
}

// --- fixtures ---------------------------------------------------------------------------------------

function makeContext({ start = T0 } = {}) {
    const clock = fakeClock(start);
    const mem = memoryFs(() => clock.now());
    const specs = new Map();
    return { clock, mem, fs: mem.api, specs, decoder: fakeDecoder(specs), embedder: fakeEmbedder() };
}

let sizeSeed = 0;
function addImage(ctx, {
    name,
    prompt = '',
    colour = 'red',
    tint = 0,
    createdAt = T0 - 60 * MIN,
    alpha = false,
    thumb = false,
    fail = false,
    size = 2000 + (++sizeSeed),
    dir = LIB,
    recordDir = dir,
    write = true
}) {
    const filePath = path.join(dir, name);
    if (write) ctx.mem.put(filePath, Buffer.alloc(size, 7), createdAt);
    ctx.specs.set(path.resolve(filePath).toLowerCase(), { colour: COLOURS[colour] || colour, tint, alpha, fail });
    if (thumb) {
        const stat = ctx.mem.statSync(filePath);
        ctx.mem.put(path.join(THUMBS, historyThumbnailKey(path.resolve(filePath), stat)), Buffer.alloc(64, 1), createdAt);
    }
    return { key: `task_${name}`, filePath: path.join(recordDir, name), fileName: name, fileSize: size, createdAt, prompt };
}

async function startEngine(ctx, { ort = true, embedder = ctx.embedder, opts = {}, scanDirs = [LIB], yieldEvery } = {}) {
    const events = { notices: [], modes: [], logs: [], priorities: [] };
    const engine = createSimilarityEngine({
        storeDir: STORE,
        thumbnailsDir: THUMBS,
        scanDirs,
        decoder: ctx.decoder,
        embedder: ort ? embedder : null,
        fs: ctx.fs,
        clock: ctx.clock,
        log: entry => events.logs.push(entry),
        onNotice: notice => events.notices.push({ ...notice, at: ctx.clock.now() }),
        onMode: info => events.modes.push(info),
        setPriority: level => events.priorities.push(level),
        ...(yieldEvery ? { yieldEvery } : {}),
        // The crop pass is off unless a test turns it on: it embeds while idle, which other tests time.
        opts: { ort, gaps: { background: 0, foreground: 0, battery: 0 }, crops: false, ...opts }
    });
    const info = await engine.init();
    return { engine, info, ...events };
}

async function drain(ctx, engine, { step = 1000, max = 400 } = {}) {
    for (let i = 0; i < max; i++) {
        await ctx.clock.advance(step);
        const status = engine.status();
        if (status.stage === 'final') return status;
    }
    throw new Error(`the engine never reached stage final: ${JSON.stringify(engine.status())}`);
}

const sortKeys = keys => [...keys].sort();
const groupSets = snapshot => snapshot.groups.map(group => sortKeys(group.members).join(',')).sort();
const groupOf = (snapshot, key) => snapshot.groups.find(group => group.members.includes(key)) || null;
const grouped = snapshot => snapshot.groups.reduce((sum, group) => sum + group.members.length, 0);

// A library with two prompted families, a promptless pair and two singles.
//   A: prompt 'pa', red ×3      → one group
//   B: prompt 'pb', blue ×2     → one group
//   C: no prompt, green ×2      → one group (visual only)
//   D: no prompt, yellow        → single
//   E: prompt 'pa', purple      → single (same prompt, different look)
function standardLibrary(ctx) {
    const at = minutes => T0 - minutes * MIN;
    return [
        addImage(ctx, { name: 'a1.png', prompt: 'pa', colour: 'red', createdAt: at(300) }),
        addImage(ctx, { name: 'a2.png', prompt: 'pa', colour: 'red', createdAt: at(299) }),
        addImage(ctx, { name: 'a3.png', prompt: 'pa', colour: 'red', createdAt: at(298) }),
        addImage(ctx, { name: 'b1.png', prompt: 'pb', colour: 'blue', createdAt: at(200) }),
        addImage(ctx, { name: 'b2.png', prompt: 'pb', colour: 'blue', createdAt: at(199) }),
        addImage(ctx, { name: 'c1.png', colour: 'green', createdAt: at(150) }),
        addImage(ctx, { name: 'c2.png', colour: 'green', createdAt: at(100) }),
        addImage(ctx, { name: 'd1.png', colour: 'yellow', createdAt: at(90) }),
        addImage(ctx, { name: 'e1.png', prompt: 'pa', colour: 'purple', createdAt: at(80) })
    ];
}

const EXPECTED_STANDARD_GROUPS = [
    'task_a1.png,task_a2.png,task_a3.png',
    'task_b1.png,task_b2.png',
    'task_c1.png,task_c2.png'
];

// --- tests --------------------------------------------------------------------------------------------

test('get answers immediately with provisional groups while nothing is analysed yet', async () => {
    const ctx = makeContext();
    const recs = [
        addImage(ctx, { name: 'p1.png', prompt: 'one prompt', colour: 'red', createdAt: T0 - 3 * MIN }),
        addImage(ctx, { name: 'p2.png', prompt: 'one prompt', colour: 'red', createdAt: T0 - 2 * MIN }),
        addImage(ctx, { name: 'p3.png', prompt: 'one prompt', colour: 'red', createdAt: T0 - 1 * MIN }),
        addImage(ctx, { name: 'q1.png', prompt: 'other prompt', colour: 'blue', createdAt: T0 - 50 * MIN }),
        addImage(ctx, { name: 'q2.png', prompt: 'other prompt', colour: 'blue', createdAt: T0 - 49 * MIN }),
        addImage(ctx, { name: 'z1.png', colour: 'green', createdAt: T0 - 40 * MIN })
    ];
    const release = ctx.decoder.hold();
    const { engine } = await startEngine(ctx);
    engine.syncRecords({ full: recs });
    await settle();

    const snapshot = engine.get({ preset: 'standard' });
    assert.equal(typeof snapshot.then, 'undefined', 'get never returns a promise');
    assert.equal(snapshot.stage, 'provisional');
    assert.equal(snapshot.analyzed, 0);
    assert.equal(snapshot.pending, 6);
    assert.deepEqual(groupSets(snapshot), ['task_p1.png,task_p2.png,task_p3.png', 'task_q1.png,task_q2.png']);
    assert.ok(snapshot.groups.every(group => group.provisional === true));
    assert.deepEqual(snapshot.singles, ['task_z1.png']);
    const p = groupOf(snapshot, 'task_p1.png');
    assert.equal(p.id, anchorId('task_p1.png'), 'the id comes from the oldest member');
    assert.deepEqual(p.members, ['task_p3.png', 'task_p2.png', 'task_p1.png'], 'members newest first');

    release();
    await drain(ctx, engine);
    const done = engine.get({ preset: 'standard' });
    assert.equal(done.stage, 'final');
    assert.ok(done.groups.every(group => group.provisional === false));
    assert.equal(groupOf(done, 'task_p1.png').id, p.id, 'the id survives the switch to analysed groups');
    await engine.close();
});

test('after the queue drains the snapshot is final, complete and stable (hd)', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const { engine, info } = await startEngine(ctx);
    assert.equal(info.mode, 'hd');
    assert.equal(info.featureVersion, `${F.H_VERSION}+${EMB}`);
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);

    const one = engine.get({ preset: 'standard' });
    const two = engine.get({ preset: 'standard' });
    assert.equal(one.version, 3);
    assert.equal(one.mode, 'hd');
    assert.equal(one.modeReason, null);
    assert.equal(one.featureVersion, `${F.H_VERSION}+${EMB}`);
    assert.equal(one.preset, 'standard');
    assert.deepEqual(one.thresholds, { ...HD.PRESETS });
    assert.equal(one.stage, 'final');
    assert.deepEqual(groupSets(one), EXPECTED_STANDARD_GROUPS);
    assert.deepEqual(sortKeys(one.singles), ['task_d1.png', 'task_e1.png']);
    assert.equal(one.total, 9);
    assert.equal(one.analyzed, 9);
    assert.equal(one.pending, 0);
    assert.equal(one.failed, 0);
    assert.equal(one.missing, 0);
    assert.equal(grouped(one) + one.singles.length + one.missing, one.total);
    assert.equal(one.stats.decoded, 9);
    assert.equal(one.stats.embedded, 9);
    assert.equal(one.stats.decoded, two.stats.decoded);
    assert.equal(one.stats.groupRuns, two.stats.groupRuns);
    assert.equal(one.revision, two.revision);
    assert.ok(one.stats.edgeCount >= 5);
    assert.equal(one.error, null);

    const a = groupOf(one, 'task_a1.png');
    assert.equal(a.id, anchorId('task_a1.png'));
    assert.deepEqual(a.members, ['task_a3.png', 'task_a2.png', 'task_a1.png']);
    assert.equal(a.latestAt, T0 - 298 * MIN);
    assert.equal(a.promptVariants, 1);
    assert.equal(a.pinned, null);
    assert.equal(a.provisional, false);
    assert.equal(a.parts, null);
    assert.deepEqual(a.rest, []);
    assert.deepEqual(a.failed, []);
    assert.equal(groupOf(one, 'task_c1.png').promptVariants, 0);
    assert.deepEqual(one.groups.map(group => group.latestAt), [...one.groups.map(group => group.latestAt)].sort((x, y) => y - x), 'groups newest first');

    assert.deepEqual(engine.get({ preset: 'standard', since: one.revision }), { notModified: true, revision: one.revision });
    assert.equal(engine.get({ preset: 'strict' }).preset, 'strict');
    assert.equal(engine.get({ preset: 'bogus' }).preset, 'standard');
    const status = engine.status();
    assert.equal(status.mode, 'hd');
    assert.equal(status.ortVersion, '1.24.3');
    assert.equal(status.stage, 'final');
    await engine.close();
});

test('h mode with ort:false: method H presets and modeReason disabled', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const { engine, info, modes } = await startEngine(ctx, { ort: false });
    assert.equal(info.mode, 'h');
    assert.equal(info.modeReason, 'disabled');
    assert.equal(info.featureVersion, F.H_VERSION);
    assert.deepEqual(modes.map(m => [m.mode, m.reason]), [['h', 'disabled']]);
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);
    const snapshot = engine.get({});
    assert.equal(snapshot.mode, 'h');
    assert.equal(snapshot.modeReason, 'disabled');
    assert.deepEqual(snapshot.thresholds, { ...H.PRESETS });
    assert.deepEqual(groupSets(snapshot), EXPECTED_STANDARD_GROUPS);
    assert.equal(snapshot.stats.embedded, 0);
    assert.equal(ctx.embedder.attempts, 0);
    await engine.close();
});

test('an unusable embedder puts the session in h with the load reason', async () => {
    const ctx = makeContext();
    const embedder = { ...fakeEmbedder(), load: async () => ({ ok: false, reason: 'model-size', message: 'wrong size' }) };
    const { engine, info, modes } = await startEngine(ctx, { embedder });
    assert.equal(info.mode, 'h');
    assert.equal(info.modeReason, 'model-size');
    assert.equal(modes[0].reason, 'model-size');
    await engine.close();
});

test('a restart reuses every row and the saved groups: no decode, no embedding, no recluster', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const first = await startEngine(ctx);
    first.engine.syncRecords({ full: recs });
    await drain(ctx, first.engine);
    const before = first.engine.get({});
    await first.engine.close();

    ctx.embedder = fakeEmbedder();
    const second = await startEngine(ctx);
    second.engine.syncRecords({ full: recs });
    const early = second.engine.get({});
    assert.deepEqual(groupSets(early), groupSets(before), 'the saved groups show before stat validation finishes');
    assert.deepEqual(early.groups.map(group => group.id).sort(), before.groups.map(group => group.id).sort());

    await drain(ctx, second.engine);
    const after = second.engine.get({});
    assert.equal(after.stage, 'final');
    assert.deepEqual(groupSets(after), groupSets(before));
    assert.deepEqual(after.groups.map(group => group.id).sort(), before.groups.map(group => group.id).sort());
    assert.equal(after.stats.decoded, 0);
    assert.equal(after.stats.embedded, 0);
    assert.equal(after.stats.groupRuns, 0, 'digest hit');
    assert.equal(after.stats.validated, recs.length);
    assert.equal(ctx.embedder.attempts, 0);

    // Edges are built later, once the host has been idle for 10 s; groups do not change.
    await ctx.clock.advance(11000);
    await settle();
    const idle = second.engine.get({});
    assert.ok(idle.stats.edgeCount > 0, 'idle edge build');
    assert.equal(idle.stats.groupRuns, 0);
    await second.engine.close();
});

test('a host killed right after the backfill loses no rows (the manifest is flushed when the queue drains)', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const first = await startEngine(ctx);
    first.engine.syncRecords({ full: recs });
    await drain(ctx, first.engine);
    await ctx.clock.advance(1000);
    // No close(): the process is gone. A new engine reads what reached the disk.
    ctx.embedder = fakeEmbedder();
    const second = await startEngine(ctx);
    second.engine.syncRecords({ full: recs });
    await drain(ctx, second.engine);
    const snapshot = second.engine.get({});
    assert.equal(snapshot.stats.decoded, 0);
    assert.equal(snapshot.stats.groupRuns, 0);
    assert.deepEqual(groupSets(snapshot), EXPECTED_STANDARD_GROUPS);
    await second.engine.close();
    await first.engine.close();
});

test('one size change causes exactly one re-decode', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const { engine } = await startEngine(ctx);
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);
    assert.equal(engine.status().stats.decoded, 9);

    const changed = { ...recs[1], fileSize: 4321 };
    ctx.mem.put(changed.filePath, Buffer.alloc(4321, 3), T0 + MIN);
    engine.syncRecords({ upserts: [changed] });
    await drain(ctx, engine);
    const snapshot = engine.get({});
    assert.equal(snapshot.stats.decoded, 10);
    assert.deepEqual(groupSets(snapshot), EXPECTED_STANDARD_GROUPS);
    await engine.close();
});

test('removed records are dropped and missing files are excluded but counted', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const ghost = addImage(ctx, { name: 'ghost.png', prompt: 'pa', write: false });
    const { engine } = await startEngine(ctx);
    engine.syncRecords({ full: [...recs, ghost] });
    await drain(ctx, engine);
    let snapshot = engine.get({});
    assert.equal(snapshot.total, 10);
    assert.equal(snapshot.missing, 1);
    assert.ok(!snapshot.singles.includes(ghost.key));
    assert.ok(!groupOf(snapshot, ghost.key));
    assert.equal(grouped(snapshot) + snapshot.singles.length + snapshot.missing, snapshot.total);

    engine.syncRecords({ removes: ['task_a3.png', 'task_d1.png'] });
    await drain(ctx, engine);
    snapshot = engine.get({});
    assert.equal(snapshot.total, 8);
    assert.deepEqual(sortKeys(groupOf(snapshot, 'task_a1.png').members), ['task_a1.png', 'task_a2.png']);
    assert.ok(!snapshot.singles.includes('task_d1.png'));
    assert.equal(grouped(snapshot) + snapshot.singles.length + snapshot.missing, snapshot.total);
    await engine.close();
});

test('records sharing a history key collapse to the first whose stat succeeds; stale paths use the name index', async () => {
    const ctx = makeContext();
    const real = addImage(ctx, { name: 'dup.png', prompt: 'dp', colour: 'red', createdAt: T0 - 10 * MIN });
    const gone = { ...real, filePath: path.join(ROOT, 'nowhere', 'dup.png') };
    const moved = addImage(ctx, { name: 'moved.png', prompt: 'dp', colour: 'red', createdAt: T0 - 9 * MIN, recordDir: MOVED });
    assert.ok(!ctx.mem.exists(moved.filePath), 'the record points at the old folder');
    const { engine } = await startEngine(ctx);
    engine.syncRecords({ full: [gone, real, moved] });
    await drain(ctx, engine);
    const snapshot = engine.get({});
    assert.equal(snapshot.total, 3);
    assert.equal(snapshot.missing, 1, 'the extra record of the shared key counts as missing');
    assert.equal(snapshot.analyzed, 2);
    assert.deepEqual(groupSets(snapshot), ['task_dup.png,task_moved.png']);
    assert.ok(ctx.decoder.calls.some(call => path.resolve(call.originalPath) === path.join(LIB, 'moved.png')), 'decoded from the folder the name index found');
    await engine.close();
});

test('a failed decode is retried at most 3 times across launches, and its group stays final', async () => {
    const ctx = makeContext();
    const recs = [
        addImage(ctx, { name: 'f1.png', prompt: 'fam', colour: 'red', createdAt: T0 - 3 * MIN }),
        addImage(ctx, { name: 'f2.png', prompt: 'fam', colour: 'red', createdAt: T0 - 2 * MIN }),
        addImage(ctx, { name: 'bad.png', prompt: 'fam', colour: 'red', createdAt: T0 - 1 * MIN, fail: true })
    ];
    const badCalls = () => ctx.decoder.calls.filter(call => call.originalPath.endsWith('bad.png')).length;
    for (let launch = 1; launch <= 4; launch++) {
        const { engine } = await startEngine(ctx);
        engine.syncRecords({ full: recs });
        await drain(ctx, engine);
        const snapshot = engine.get({});
        assert.equal(snapshot.failed, 1);
        assert.equal(snapshot.stage, 'final');
        const group = groupOf(snapshot, 'task_f1.png');
        assert.deepEqual(sortKeys(group.members), ['task_bad.png', 'task_f1.png', 'task_f2.png'], 'the failed image attaches through its batch');
        assert.deepEqual(group.failed, ['task_bad.png']);
        assert.equal(group.provisional, false, 'a failed member never makes a group provisional');
        assert.equal(badCalls(), Math.min(launch, 3));
        await engine.close();
    }
    const store = await openStore({ dir: STORE, fs: ctx.fs, embVersion: EMB });
    assert.equal(store.meta(featureKey(recs[2].filePath, recs[2].fileSize)).failCount, 3);
    await store.close();
});

test('an upsert or a neighbours query while the key is being extracted re-queues it, and the stage reaches final', async () => {
    const family = ['task_u1.png,task_u2.png,task_u3.png'];
    const library = ctx => [
        addImage(ctx, { name: 'u1.png', prompt: 'up', colour: 'red', createdAt: T0 - 3 * MIN }),
        addImage(ctx, { name: 'u2.png', prompt: 'up', colour: 'red', createdAt: T0 - 2 * MIN }),
        addImage(ctx, { name: 'u3.png', prompt: 'up', colour: 'red', createdAt: T0 - 1 * MIN })
    ];
    const settled = async (name, ctx, engine, query) => {
        const status = await drain(ctx, engine, { max: 60 });
        assert.equal(status.stage, 'final', name);
        assert.equal(status.pending, 0, name);
        assert.equal(status.analyzed, 3, name);
        assert.deepEqual(groupSets(engine.get({})), family, `${name}: the re-queued key joins its group`);
        if (query) assert.equal((await query).analyzed, true, `${name}: the query waited for the re-queued extraction`);
        await engine.close();
    };

    // One lane: the in-flight key is upserted (an edited prompt, a ratio), optionally with a
    // neighbours query right after the upsert, before the key is validated again.
    for (const variant of [
        { name: 'prompt', edit: rec => ({ ...rec, prompt: 'Up  ' }) },
        { name: 'ratio', edit: rec => ({ ...rec, ratio: '1:1' }) },
        { name: 'query', edit: rec => ({ ...rec, ratio: '1:1' }), query: true }
    ]) {
        const ctx = makeContext();
        const recs = library(ctx);
        const release = ctx.decoder.hold();
        const { engine } = await startEngine(ctx);
        engine.syncRecords({ full: recs });
        await ctx.clock.advance(100);
        assert.equal(ctx.decoder.active, 1, `${variant.name}: one extraction is in flight`);
        const inFlight = recs.find(rec => rec.fileName === path.basename(ctx.decoder.calls[0].originalPath));
        engine.syncRecords({ upserts: [variant.edit(inFlight)] });
        const query = variant.query ? engine.neighbors({ key: inFlight.key }) : null;
        await ctx.clock.advance(100); // the re-validation finishes while the stale decode is held
        release();
        await settled(variant.name, ctx, engine, query);
    }

    // Two lanes, only u2's decode held: the other lane goes idle, then the query arrives after the
    // re-validation. A queue entry pushed for the still-extracting key would be dropped by a lane
    // started for it, leaving the key marked queued for good.
    const ctx = makeContext();
    const recs = library(ctx);
    let releaseU2;
    let u2Gate = new Promise(resolve => { releaseU2 = resolve; });
    let u2Started = false;
    const decode = ctx.decoder.decode;
    ctx.decoder.decode = async args => {
        if (u2Gate && path.basename(args.originalPath) === 'u2.png') {
            u2Started = true;
            await u2Gate;
        }
        return decode(args);
    };
    const { engine } = await startEngine(ctx);
    engine.get({ foreground: true });
    engine.syncRecords({ full: recs });
    await ctx.clock.advance(100);
    assert.ok(u2Started, 'u2 is being extracted');
    assert.equal(engine.status().analyzed, 2, 'the other lane finished u3 and u1');
    engine.syncRecords({ upserts: [{ ...recs[1], ratio: '1:1' }] });
    await ctx.clock.advance(100);
    const query = engine.neighbors({ key: 'task_u2.png' });
    u2Gate = null;
    releaseU2();
    await settled('query-busy', ctx, engine, query);
});

test('a queued key failed through a shared feature key is queued again when switchToH revives it', async () => {
    // k1 and k2 share a feature key (same name and size in two folders). k2 fails first, which
    // fails k1 while its queue entry is still there; a lane later drops that entry. When the
    // session switches to h, k1 is pending again and must be enqueued, not skipped as "queued".
    const ctx = makeContext();
    const other = path.join(ROOT, 'copy');
    const embedder = fakeEmbedder({ failWhen: () => true });
    const recs = [
        addImage(ctx, { name: 'f2.png', prompt: 'a', colour: 'blue', createdAt: T0 - 9 * MIN }),
        addImage(ctx, { name: 'f1.png', prompt: 'b', colour: 'green', createdAt: T0 - 8 * MIN }),
        { ...addImage(ctx, { name: 'x.png', prompt: 'c', colour: 'red', createdAt: T0 - 7 * MIN, size: 5555 }), key: 'k1' },
        { ...addImage(ctx, { name: 'x.png', prompt: 'c', colour: 'red', createdAt: T0 - 6 * MIN, size: 5555, dir: other }), key: 'k2' }
    ];
    let releaseF1;
    let f1Gate = new Promise(resolve => { releaseF1 = resolve; });
    const decode = ctx.decoder.decode;
    ctx.decoder.decode = async args => {
        if (f1Gate && path.basename(args.originalPath) === 'f1.png') await f1Gate;
        return decode(args);
    };
    const { engine } = await startEngine(ctx, { embedder, scanDirs: [LIB, other] });
    engine.syncRecords({ full: recs });
    await ctx.clock.advance(100);
    assert.ok(engine.status().failed >= 2, 'k2 failed and took k1 with it');
    assert.equal(engine.status().mode, 'hd', 'f1 (the third run error) is still held');
    engine.syncRecords({ removes: ['k2'] });
    f1Gate = null;
    releaseF1();
    const status = await drain(ctx, engine, { max: 40 });
    assert.equal(status.mode, 'h');
    assert.equal(status.pending, 0);
    assert.equal(status.failed, 0, 'k1 is extracted for h');
    assert.equal(status.analyzed, 3);
    await engine.close();
});

test('a failed row write keeps the row in memory: no failCount, logged once, written on the next debounce', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx).slice(0, 3); // the red 'pa' family
    const open = ctx.fs.open;
    let full = true;
    ctx.fs.open = async (file, flags) => {
        const handle = await open(file, flags);
        return {
            async write(...args) {
                if (full && String(file).endsWith('features-v3.bin')) {
                    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
                }
                return handle.write(...args);
            },
            close: () => handle.close()
        };
    };
    const family = ['task_a1.png,task_a2.png,task_a3.png'];
    const rowWriteErrors = logs => logs.filter(entry => entry.level === 'error' && /row write failed/.test(entry.message)).length;
    for (let launch = 1; launch <= 4; launch++) {
        const { engine, logs } = await startEngine(ctx);
        engine.syncRecords({ full: recs });
        await drain(ctx, engine);
        const snapshot = engine.get({});
        assert.equal(snapshot.failed, 0, `launch ${launch}: a disk error is not a row failure`);
        assert.equal(snapshot.analyzed, 3, `launch ${launch}: the rows are kept in memory`);
        assert.deepEqual(groupSets(snapshot), family);
        assert.equal(snapshot.stats.decoded, 3, `launch ${launch}: nothing reached the disk, so the rows are extracted again`);
        assert.match(snapshot.error || '', /ENOSPC/);
        assert.equal(rowWriteErrors(logs), 1, `launch ${launch}: logged once`);
        await engine.close();
    }
    let store = await openStore({ dir: STORE, fs: ctx.fs, embVersion: EMB });
    for (const rec of recs) {
        const meta = store.meta(featureKey(rec.filePath, rec.fileSize));
        assert.ok(!meta || (meta.status !== 'fail' && meta.failCount === 0), `${rec.key}: no failCount for a disk error`);
    }
    await store.close();

    // Space comes back mid-session: the next debounce (here from a removal, with no extraction
    // running) writes the rows kept in memory.
    const { engine, logs } = await startEngine(ctx);
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);
    assert.match(engine.get({}).error || '', /ENOSPC/);
    full = false;
    engine.syncRecords({ removes: ['task_a3.png'] });
    await drain(ctx, engine);
    await ctx.clock.advance(1000);
    assert.equal(engine.get({}).error, null, 'the error clears once the rows are written');
    const decoded = engine.status().stats.decoded;
    engine.syncRecords({ upserts: [recs[2]] });
    await drain(ctx, engine);
    assert.equal(engine.status().stats.decoded, decoded, 'the restored record reuses its row');
    assert.deepEqual(groupSets(engine.get({})), family);
    assert.equal(rowWriteErrors(logs), 1);
    await engine.close();
    store = await openStore({ dir: STORE, fs: ctx.fs, embVersion: EMB });
    for (const rec of recs) assert.equal(store.meta(featureKey(rec.filePath, rec.fileSize)).status, 'ok', rec.key);
    await store.close();

    const next = await startEngine(ctx);
    next.engine.syncRecords({ full: recs });
    await drain(ctx, next.engine);
    assert.equal(next.engine.get({}).stats.decoded, 0, 'the next launch reuses every row');
    await next.engine.close();
});

test('the history JPEG is used only when the original has no alpha, and JPEG rows go first', async () => {
    const ctx = makeContext();
    const recs = [
        addImage(ctx, { name: 'j-old.png', colour: 'red', thumb: true, createdAt: T0 - 5 * MIN }),
        addImage(ctx, { name: 'j-new.png', colour: 'blue', thumb: true, createdAt: T0 - 1 * MIN }),
        addImage(ctx, { name: 'alpha.png', colour: 'green', thumb: true, alpha: true, createdAt: T0 - 2 * MIN }),
        addImage(ctx, { name: 'o-old.png', colour: 'yellow', createdAt: T0 - 9 * MIN }),
        addImage(ctx, { name: 'o-new.png', colour: 'teal', createdAt: T0 - 3 * MIN })
    ];
    const { engine } = await startEngine(ctx, { opts: { backfillDelayMs: 2000 } });
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);
    const order = ctx.decoder.calls.map(call => path.basename(call.originalPath));
    assert.deepEqual(order, ['j-new.png', 'j-old.png', 'alpha.png', 'o-new.png', 'o-old.png']);
    const byName = Object.fromEntries(ctx.decoder.calls.map(call => [path.basename(call.originalPath), call]));
    assert.ok(byName['j-new.png'].jpegPath && byName['j-new.png'].jpegPath.startsWith(THUMBS));
    assert.equal(byName['j-new.png'].hasAlpha, false);
    assert.equal(byName['alpha.png'].jpegPath, null, 'never the JPEG of a transparent original');
    assert.equal(byName['o-new.png'].jpegPath, null);
    assert.equal(engine.get({}).stats.reused, 2);
    await engine.close();
});

test('saving pauses originals but not JPEG rows', async () => {
    const ctx = makeContext();
    const recs = [
        addImage(ctx, { name: 'jpg.png', colour: 'red', thumb: true }),
        addImage(ctx, { name: 'orig1.png', colour: 'blue' }),
        addImage(ctx, { name: 'orig2.png', colour: 'green' })
    ];
    const { engine } = await startEngine(ctx);
    engine.setLoad({ saving: 1 });
    engine.syncRecords({ full: recs });
    await ctx.clock.advance(5000);
    assert.deepEqual(ctx.decoder.calls.map(call => path.basename(call.originalPath)), ['jpg.png']);
    assert.notEqual(engine.status().stage, 'final');
    engine.setLoad({ saving: 0 });
    await drain(ctx, engine);
    assert.equal(ctx.decoder.calls.length, 3);
    await engine.close();
});

test('the backfill waits for its start delay unless a foreground get arrives', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const { engine } = await startEngine(ctx, { opts: { backfillDelayMs: 20000 } });
    engine.syncRecords({ full: recs });
    await ctx.clock.advance(5000);
    assert.equal(ctx.decoder.calls.length, 0);
    assert.equal(engine.get({}).stats.validated, recs.length, 'stat validation does not wait');
    engine.get({ foreground: true });
    await ctx.clock.advance(1000);
    assert.ok(ctx.decoder.calls.length > 0);
    await drain(ctx, engine);
    await engine.close();
});

test('one lane in the background, two after a foreground get; host priority follows', async () => {
    const ctx = makeContext();
    const recs = Array.from({ length: 6 }, (_, i) => addImage(ctx, { name: `l${i}.png`, colour: 'grey', createdAt: T0 - i * MIN }));
    const release = ctx.decoder.hold();
    const { engine, priorities } = await startEngine(ctx);
    assert.deepEqual(priorities, ['background']);
    engine.syncRecords({ full: recs });
    await ctx.clock.advance(1000);
    assert.equal(ctx.decoder.maxActive, 1);
    engine.get({ foreground: true });
    await settle();
    assert.equal(ctx.decoder.maxActive, 2);
    assert.deepEqual(priorities, ['background', 'foreground']);
    release();
    await ctx.clock.advance(61000);
    assert.deepEqual(priorities, ['background', 'foreground', 'background']);
    await drain(ctx, engine);
    await engine.close();
});

test('pushes are throttled to at most 2 per second and the last one is current', async () => {
    const ctx = makeContext();
    const recs = Array.from({ length: 40 }, (_, i) => addImage(ctx, { name: `n${i}.png`, prompt: `prompt ${i % 5}`, colour: 'red', createdAt: T0 - i * MIN }));
    const { engine, notices } = await startEngine(ctx);
    engine.syncRecords({ full: recs });
    for (let i = 0; i < 60; i++) await ctx.clock.advance(100);
    await drain(ctx, engine);
    await ctx.clock.advance(2000);
    assert.ok(notices.length >= 2);
    for (let i = 1; i < notices.length; i++) {
        assert.ok(notices[i].at - notices[i - 1].at >= 500, `pushes ${i - 1} and ${i} are ${notices[i].at - notices[i - 1].at} ms apart`);
    }
    const last = notices[notices.length - 1];
    const snapshot = engine.get({});
    assert.equal(last.revision, snapshot.revision);
    assert.equal(last.stage, 'final');
    assert.equal(last.mode, 'hd');
    assert.equal(last.total, 40);
    assert.equal(last.analyzed, 40);
    assert.equal(last.pending, 0);
    assert.equal(last.groupCount, snapshot.groups.length);
    await engine.close();
});

test('get takes under 50 ms during a 200-item backfill', async () => {
    const ctx = makeContext();
    const colours = Object.keys(COLOURS);
    const recs = Array.from({ length: 200 }, (_, i) => addImage(ctx, {
        name: `b${i}.png`,
        prompt: i % 7 === 0 ? '' : `family ${i % 23}`,
        colour: colours[i % 23 % colours.length],
        createdAt: T0 - i * 3 * MIN
    }));
    // A 60 ms lane gap spreads the backfill over about 6 s of clock time (past the 5 s max wait).
    const { engine } = await startEngine(ctx, { opts: { gaps: { background: 60, foreground: 60, battery: 60 } } });
    engine.syncRecords({ full: recs });
    let worst = 0;
    let during = 0;
    const stages = new Set();
    for (let i = 0; i < 1000 && engine.status().stage !== 'final'; i++) {
        await ctx.clock.advance(20);
        const t0 = performance.now();
        const snapshot = engine.get({ preset: ['strict', 'standard', 'loose'][i % 3], foreground: true });
        worst = Math.max(worst, performance.now() - t0);
        if (snapshot.stage !== 'final') {
            during++;
            stages.add(snapshot.stage);
        }
    }
    assert.ok(during >= 10, `gets ran during the backfill (${during})`);
    assert.ok(stages.has('partial'), `stages seen: ${[...stages]}`);
    assert.ok(worst < 50, `worst get took ${worst.toFixed(1)} ms`);
    await drain(ctx, engine);
    await engine.close();
});

test('hd re-extracts rows without DINO_OK, and an embVersion change re-embeds', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const run = async (options, embedder) => {
        ctx.embedder = embedder;
        const { engine } = await startEngine(ctx, options);
        engine.syncRecords({ full: recs });
        await drain(ctx, engine);
        const snapshot = engine.get({});
        await engine.close();
        return snapshot;
    };
    const h = await run({ ort: false }, fakeEmbedder());
    assert.equal(h.stats.decoded, 9);
    const hd = await run({}, fakeEmbedder());
    assert.equal(hd.stats.decoded, 9, 'H-only rows are pending in hd');
    assert.equal(hd.stats.embedded, 9);
    const again = await run({}, fakeEmbedder());
    assert.equal(again.stats.embedded, 0);
    const upgraded = await run({}, fakeEmbedder({ embVersion: `${F.EMB_VERSION_BASE}+ort1.26` }));
    assert.equal(upgraded.stats.embedded, 9, 'an ORT upgrade re-embeds every row');
    assert.equal(upgraded.featureVersion, `${F.H_VERSION}+${F.EMB_VERSION_BASE}+ort1.26`);
    assert.deepEqual(groupSets(upgraded), EXPECTED_STANDARD_GROUPS);
});

test('an embedding failure fails only that row and is retried at most 3 times', async () => {
    const ctx = makeContext();
    const recs = [
        addImage(ctx, { name: 'm1.png', prompt: 'mf', colour: 'red', createdAt: T0 - 4 * MIN }),
        addImage(ctx, { name: 'm2.png', prompt: 'mf', colour: 'red', createdAt: T0 - 3 * MIN }),
        addImage(ctx, { name: 'mx.png', prompt: 'mf', colour: 'red', tint: 99, createdAt: T0 - 2 * MIN }),
        addImage(ctx, { name: 'm3.png', prompt: 'mf', colour: 'red', createdAt: T0 - 1 * MIN })
    ];
    const failing = rgb224 => rgb224[3] === 99;
    let badAttempts = 0;
    for (let launch = 1; launch <= 4; launch++) {
        const embedder = fakeEmbedder({ failWhen: rgb => { const bad = failing(rgb); if (bad) badAttempts++; return bad; } });
        const { engine } = await startEngine(ctx, { embedder });
        engine.syncRecords({ full: recs });
        await drain(ctx, engine);
        const snapshot = engine.get({});
        assert.equal(snapshot.mode, 'hd', 'one bad image never switches the mode');
        assert.equal(snapshot.failed, 1);
        assert.deepEqual(groupOf(snapshot, 'task_m1.png').failed, ['task_mx.png']);
        assert.equal(badAttempts, Math.min(launch, 3));
        await engine.close();
    }
});

test('3 consecutive run errors switch the session to h in place and recluster once', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const embedder = fakeEmbedder({ failWhen: () => true });
    const { engine, modes } = await startEngine(ctx, { embedder });
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);
    const snapshot = engine.get({});
    assert.equal(snapshot.mode, 'h');
    assert.equal(snapshot.modeReason, 'run-failed');
    assert.deepEqual(modes.map(m => m.mode), ['hd', 'h']);
    assert.equal(modes[1].reason, 'run-failed');
    assert.equal(embedder.attempts, 3);
    assert.ok(embedder.releases >= 1, 'the session is released');
    assert.equal(snapshot.failed, 0, 'rows that failed only in the embedding are re-extracted for h');
    assert.deepEqual(snapshot.thresholds, { ...H.PRESETS });
    assert.deepEqual(groupSets(snapshot), EXPECTED_STANDARD_GROUPS);
    assert.equal(snapshot.stats.groupRuns, 1);
    await engine.close();
});

test('the ORT session is released after 120 s idle and re-created for the next new row', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx).slice(0, 2);
    const { engine } = await startEngine(ctx);
    assert.equal(ctx.embedder.creates, 1, 'created at start for the self-test');
    engine.syncRecords({ full: recs });
    for (let i = 0; i < 200 && ctx.embedder.embeds < 2; i++) await ctx.clock.advance(100);
    assert.equal(ctx.embedder.embeds, 2);
    await ctx.clock.advance(119000);
    assert.equal(ctx.embedder.releases, 0);
    await ctx.clock.advance(1000);
    assert.equal(ctx.embedder.releases, 1);
    assert.equal(ctx.embedder.loaded, false);

    const next = addImage(ctx, { name: 'late.png', prompt: 'pa', colour: 'red', createdAt: T0 });
    engine.syncRecords({ upserts: [next] });
    await drain(ctx, engine);
    assert.equal(ctx.embedder.embeds, 3);
    assert.equal(ctx.embedder.creates, 2, 're-created on demand');
    await engine.close();
});

test('reclusters are debounced 1 s after the last change, at most 5 s after the first', async () => {
    const ctx = makeContext();
    const first = addImage(ctx, { name: 'd0.png', prompt: 'deb', colour: 'red', createdAt: T0 - 100 * MIN });
    const { engine } = await startEngine(ctx);
    engine.syncRecords({ full: [first] });
    await drain(ctx, engine);
    const runs = () => engine.status().stats.groupRuns;

    const base = runs();
    engine.syncRecords({ upserts: [addImage(ctx, { name: 'd1.png', prompt: 'deb', colour: 'red', createdAt: T0 - 99 * MIN })] });
    await ctx.clock.advance(900);
    assert.equal(runs(), base, 'not before 1 s');
    await ctx.clock.advance(200);
    assert.equal(runs(), base + 1, 'one run 1 s after the change');

    const start = ctx.clock.now();
    const times = [];
    let seen = runs();
    for (let i = 0; i < 16; i++) {
        engine.syncRecords({ upserts: [addImage(ctx, { name: `burst${i}.png`, prompt: 'deb', colour: 'red', createdAt: T0 - 90 * MIN + i })] });
        for (let k = 0; k < 5; k++) {
            await ctx.clock.advance(100);
            if (runs() !== seen) {
                seen = runs();
                times.push(ctx.clock.now() - start);
            }
        }
    }
    for (let k = 0; k < 30; k++) {
        await ctx.clock.advance(100);
        if (runs() !== seen) {
            seen = runs();
            times.push(ctx.clock.now() - start);
        }
    }
    assert.ok(times.length >= 2, `runs at ${times}`);
    assert.ok(times[0] >= 4800 && times[0] <= 5200, `the first burst run waits at most 5 s (${times[0]} ms)`);
    const lastChange = 15 * 500;
    assert.ok(times[times.length - 1] >= lastChange + 900 && times[times.length - 1] <= lastChange + 1300, `the last run follows the last change by 1 s (${times})`);
    assert.equal(engine.status().stage, 'final');
    await engine.close();
});

test('incremental reclusters give exactly the groups of one full build, in both modes', async () => {
    const prompts = ['alpha scene', 'alpha scene!', 'beta product', 'gamma room', '', ''];
    const colours = ['red', 'red', 'blue', 'green', 'red', 'teal'];
    const spec = i => ({
        name: `inc${i}.png`,
        prompt: prompts[i % prompts.length],
        colour: colours[(i * 7) % colours.length],
        tint: (i * 37) % 140,
        createdAt: T0 - (200 - i) * 2 * MIN
    });
    for (const ort of [true, false]) {
        const incremental = makeContext();
        const recs = Array.from({ length: 72 }, (_, i) => addImage(incremental, spec(i)));
        const one = await startEngine(incremental, { ort });
        for (let batch = 0; batch < 6; batch++) {
            one.engine.syncRecords({ upserts: recs.slice(batch * 12, batch * 12 + 12) });
            await drain(incremental, one.engine);
        }
        one.engine.syncRecords({ removes: [recs[5].key, recs[40].key] });
        await drain(incremental, one.engine);
        assert.ok(one.engine.status().stats.groupRuns >= 7);

        const full = makeContext();
        const kept = Array.from({ length: 72 }, (_, i) => addImage(full, spec(i))).filter((_, i) => i !== 5 && i !== 40);
        const two = await startEngine(full, { ort });
        two.engine.syncRecords({ full: kept });
        await drain(full, two.engine);
        assert.equal(two.engine.status().stats.groupRuns, 1);
        for (const preset of ['strict', 'standard', 'loose']) {
            const a = one.engine.get({ preset });
            const b = two.engine.get({ preset });
            assert.deepEqual(a.groups.map(group => [group.id, group.members]), b.groups.map(group => [group.id, group.members]), `${ort ? 'hd' : 'h'} ${preset}`);
            assert.deepEqual(a.singles, b.singles);
        }
        assert.ok(one.engine.get({}).groups.length >= 3, 'the fixture forms groups');
        await one.engine.close();
        await two.engine.close();
    }
});

test('the warm-start digest includes the mode', async () => {
    const entries = [{ key: 'k1', createdAt: 1, fk: 'a.png|1', np: 'x', crc: 5 }];
    const hd = snapshotDigest({ mode: 'hd', embVersion: EMB, entries, cannotLink: [] });
    const h = snapshotDigest({ mode: 'h', embVersion: EMB, entries, cannotLink: [] });
    assert.notEqual(hd, h);
    assert.notEqual(hd, snapshotDigest({ mode: 'hd', embVersion: `${F.EMB_VERSION_BASE}+ort1.26`, entries, cannotLink: [] }));
    assert.notEqual(hd, snapshotDigest({ mode: 'hd', embVersion: EMB, entries, cannotLink: [['a.png|1', 'b.png|2']] }));
    assert.notEqual(hd, snapshotDigest({ mode: 'hd', embVersion: EMB, entries: [{ ...entries[0], crc: 6 }], cannotLink: [] }));

    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const first = await startEngine(ctx);
    first.engine.syncRecords({ full: recs });
    await drain(ctx, first.engine);
    await first.engine.close();
    const second = await startEngine(ctx, { ort: false });
    second.engine.syncRecords({ full: recs });
    await drain(ctx, second.engine);
    const snapshot = second.engine.get({});
    assert.equal(snapshot.stats.decoded, 0, 'hd rows carry the H part');
    assert.equal(snapshot.stats.groupRuns, 1, 'saved hd groups are never served in h');
    assert.deepEqual(groupSets(snapshot), EXPECTED_STANDARD_GROUPS);
    await second.engine.close();
});

test('a trashed record keeps its row, the restore reuses it with 0 decodes, and orphans are marked', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const { engine } = await startEngine(ctx);
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);
    const decoded = engine.status().stats.decoded;

    engine.syncRecords({ removes: ['task_b2.png'] });
    await drain(ctx, engine);
    assert.ok(!engine.get({}).singles.includes('task_b2.png'));
    assert.ok(!groupOf(engine.get({}), 'task_b1.png'), 'the pair is gone');
    await engine.close();
    let store = await openStore({ dir: STORE, fs: ctx.fs, embVersion: EMB });
    const fk = featureKey(recs[4].filePath, recs[4].fileSize);
    assert.ok(store.meta(fk).orphanedAt > 0, 'the row is kept and marked orphaned');
    await store.close();

    // An in-session restore (main sends it as an upsert) reuses the row and clears orphanedAt.
    const revived = await startEngine(ctx);
    revived.engine.syncRecords({ full: recs.filter(rec => rec.key !== 'task_b2.png') });
    await drain(ctx, revived.engine);
    const before = revived.engine.status().stats.decoded;
    revived.engine.syncRecords({ upserts: [recs[4]] });
    await drain(ctx, revived.engine);
    assert.equal(revived.engine.status().stats.decoded, before, 'no re-decode for the restored record');
    assert.deepEqual(sortKeys(groupOf(revived.engine.get({}), 'task_b1.png').members), ['task_b1.png', 'task_b2.png']);
    await revived.engine.close();
    store = await openStore({ dir: STORE, fs: ctx.fs, embVersion: EMB });
    assert.equal(store.meta(fk).orphanedAt, 0, 'present again after the in-session restore');
    await store.close();

    const again = await startEngine(ctx);
    again.engine.syncRecords({ full: recs });
    await drain(ctx, again.engine);
    const snapshot = again.engine.get({});
    assert.equal(snapshot.stats.decoded, 0, 'restored from the kept row');
    assert.ok(decoded > 0);
    assert.deepEqual(sortKeys(groupOf(snapshot, 'task_b1.png').members), ['task_b1.png', 'task_b2.png']);
    await again.engine.close();
    store = await openStore({ dir: STORE, fs: ctx.fs, embVersion: EMB });
    assert.equal(store.meta(fk).orphanedAt, 0, 'present again');
    await store.close();
});

test('overrides: setCover pins, detach splits, reset restores; absent keys are ignored', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const { engine } = await startEngine(ctx);
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);
    const group = groupOf(engine.get({}), 'task_a1.png');

    let result = await engine.override({ op: 'setCover', key: 'task_a2.png', groupId: group.id });
    assert.equal(result.revision, engine.get({}).revision);
    assert.equal(groupOf(engine.get({}), 'task_a1.png').pinned, 'task_a2.png');
    await engine.override({ op: 'setCover', key: 'task_a3.png', groupId: group.id });
    assert.equal(groupOf(engine.get({}), 'task_a1.png').pinned, 'task_a3.png', 'one pinned member per group');

    await engine.override({ op: 'detach', key: 'task_a1.png', groupId: group.id });
    let snapshot = engine.get({});
    assert.deepEqual(sortKeys(groupOf(snapshot, 'task_a2.png').members), ['task_a2.png', 'task_a3.png']);
    assert.ok(snapshot.singles.includes('task_a1.png'));
    assert.ok(!groupOf(engine.get({ preset: 'loose' }), 'task_a1.png'), 'cannot-link holds at every preset');

    const before = engine.get({}).revision;
    result = await engine.override({ op: 'detach', key: 'task_nobody', groupId: 'sg_000000000000' });
    assert.equal(result.revision, before, 'an absent key changes nothing');

    await engine.override({ op: 'reset', key: 'task_a1.png' });
    snapshot = engine.get({});
    assert.deepEqual(sortKeys(groupOf(snapshot, 'task_a1.png').members), ['task_a1.png', 'task_a2.png', 'task_a3.png']);
    await engine.close();

    const restarted = await startEngine(ctx);
    restarted.engine.syncRecords({ full: recs });
    await drain(ctx, restarted.engine);
    assert.equal(groupOf(restarted.engine.get({}), 'task_a1.png').pinned, 'task_a3.png', 'the pin persists');
    await restarted.engine.close();
});

test('detach and reset answer within a bounded wait while a slow recluster runs; the grouping lands later', { timeout: 30000 }, async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const slow = { gate: null };
    const hold = () => {
        let release;
        slow.gate = new Promise(resolve => { release = resolve; });
        return () => {
            slow.gate = null;
            release();
        };
    };
    // sliceMs 0: the recluster yields after every step, so a held gate stalls it (a cold or H-mode
    // full edge build at 20k takes longer than main's 10 s request timeout).
    const { engine } = await startEngine(ctx, {
        opts: { sliceMs: 0 },
        yieldEvery: () => slow.gate || new Promise(resolve => setImmediate(resolve))
    });
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);
    const group = groupOf(engine.get({}), 'task_a1.png');

    let release = hold();
    let answer = null;
    const detach = engine.override({ op: 'detach', key: 'task_a1.png', groupId: group.id }).then(result => { answer = result; });
    await ctx.clock.advance(4000);
    assert.equal(answer, null, 'waits for the recluster while it may still land quickly');
    await ctx.clock.advance(1000);
    await detach;
    assert.equal(typeof answer.revision, 'number', 'answers once the bounded wait expires');
    assert.ok(groupOf(engine.get({}), 'task_a1.png'), 'the held recluster has not landed yet');
    release();
    await drain(ctx, engine);
    assert.ok(engine.get({}).singles.includes('task_a1.png'), 'the detach lands with the recluster');
    assert.ok(engine.get({}).revision > answer.revision, 'the landing is a new revision (pushed as a notice)');

    release = hold();
    answer = null;
    const reset = engine.override({ op: 'reset', key: 'task_a1.png' }).then(result => { answer = result; });
    await ctx.clock.advance(5000);
    await reset;
    assert.equal(typeof answer.revision, 'number');
    release();
    await drain(ctx, engine);
    assert.deepEqual(sortKeys(groupOf(engine.get({}), 'task_a1.png').members), ['task_a1.png', 'task_a2.png', 'task_a3.png']);
    await engine.close();
});

test('neighbours rank group-mates first; an unanalysed query jumps the queue and falls back after 3 s', async () => {
    const ctx = makeContext();
    const recs = [
        addImage(ctx, { name: 'n1.png', prompt: 'same', colour: 'red', createdAt: T0 - 10 * MIN }),
        addImage(ctx, { name: 'n2.png', prompt: 'same', colour: 'red', createdAt: T0 - 9 * MIN }),
        addImage(ctx, { name: 'n3.png', prompt: 'same', colour: 'red', tint: 60, createdAt: T0 - 8 * MIN }),
        addImage(ctx, { name: 'n4.png', prompt: 'unrelated words', colour: 'red', createdAt: T0 - 7 * MIN }),
        addImage(ctx, { name: 'n5.png', prompt: 'same', colour: 'blue', createdAt: T0 - 6 * MIN })
    ];
    const { engine } = await startEngine(ctx);
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);

    const combined = await engine.neighbors({ key: 'task_n1.png', preset: 'standard', mode: 'combined', limit: 60 });
    assert.equal(combined.analyzed, true);
    assert.equal(combined.mode, 'hd');
    assert.deepEqual(combined.items.map(item => item.key), ['task_n2.png', 'task_n3.png']);
    assert.deepEqual(combined.items[0], { key: 'task_n2.png', similarity: 100, samePrompt: true, nearPrompt: false, sameGroup: true });
    const visual = await engine.neighbors({ key: 'task_n1.png', mode: 'visual' });
    assert.deepEqual(visual.items.map(item => item.key), ['task_n2.png', 'task_n4.png', 'task_n3.png']);
    assert.equal((await engine.neighbors({ key: 'task_n1.png', mode: 'visual', limit: 1 })).items.length, 1);
    assert.deepEqual((await engine.neighbors({ key: 'task_n1.png', mode: 'visual', samePromptOnly: true })).items.map(item => item.key), ['task_n2.png', 'task_n3.png']);
    assert.deepEqual(await engine.neighbors({ key: 'task_missing' }), { items: [], analyzed: false, mode: 'hd' });

    // A new batch, queued behind newer images: the query jumps ahead of them.
    const release = ctx.decoder.hold();
    const late = [
        addImage(ctx, { name: 'w2.png', colour: 'green', createdAt: T0 - 1 * MIN }),
        addImage(ctx, { name: 'w3.png', colour: 'grey', createdAt: T0 - 2 * MIN }),
        addImage(ctx, { name: 'w4.png', colour: 'teal', createdAt: T0 - 3 * MIN }),
        addImage(ctx, { name: 'w1.png', prompt: 'same', colour: 'red', createdAt: T0 - 20 * MIN })
    ];
    engine.syncRecords({ upserts: late });
    await settle();
    const pending = engine.neighbors({ key: 'task_w1.png', mode: 'combined' });
    await ctx.clock.advance(3000);
    const fallback = await pending;
    assert.equal(fallback.analyzed, false);
    assert.deepEqual(fallback.items.map(item => item.key), ['task_n5.png', 'task_n3.png', 'task_n2.png', 'task_n1.png'], 'same-prompt results, newest first');
    assert.ok(fallback.items.every(item => item.samePrompt === true && item.similarity === null));
    release();
    await settle();
    const order = ctx.decoder.calls.slice(-4).map(call => path.basename(call.originalPath));
    assert.deepEqual([...order].sort(), ['w1.png', 'w2.png', 'w3.png', 'w4.png']);
    assert.ok(order.indexOf('w1.png') <= 1, `decoded right after the one already in flight (${order})`);
    assert.ok(order.indexOf('w1.png') < order.indexOf('w3.png') && order.indexOf('w1.png') < order.indexOf('w4.png'), `the oldest image went ahead of newer ones (${order})`);
    await drain(ctx, engine);
    assert.equal((await engine.neighbors({ key: 'task_w1.png' })).analyzed, true);
    await engine.close();
});

test('close flushes the manifest and saves the groups for the next launch', async () => {
    const ctx = makeContext();
    const recs = standardLibrary(ctx);
    const { engine } = await startEngine(ctx);
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);
    await engine.close();
    assert.ok(ctx.mem.exists(path.join(STORE, 'manifest-v3.json')));
    const saved = JSON.parse(await ctx.fs.readFile(path.join(STORE, 'groups-v3.json'), 'utf8'));
    assert.equal(saved.version, 3);
    assert.equal(saved.mode, 'hd');
    assert.equal(saved.items.length, 9);
    assert.ok(Array.isArray(saved.merges) && saved.merges.length >= 4);
    assert.equal(typeof saved.digest, 'string');
});

test('以图搜图: an outside image ranks the library by DINOv2 cosine and is never stored', async () => {
    const ctx = makeContext();
    const recs = [
        addImage(ctx, { name: 'q1.png', prompt: 'one', colour: 'red', createdAt: T0 - 10 * MIN }),
        addImage(ctx, { name: 'q2.png', prompt: 'two', colour: 'red', tint: 60, createdAt: T0 - 9 * MIN }),
        addImage(ctx, { name: 'q3.png', prompt: 'three', colour: 'blue', createdAt: T0 - 8 * MIN })
    ];
    const outside = path.join(ROOT, 'Downloads', 'query.png');
    ctx.specs.set(path.resolve(outside).toLowerCase(), { colour: COLOURS.red, tint: 0 });
    const { engine } = await startEngine(ctx);
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);
    const before = engine.status();

    const result = await engine.neighborsOfImage({ path: outside });
    assert.equal(result.analyzed, true);
    assert.equal(result.mode, 'hd');
    assert.equal(result.indexed, 3);
    assert.deepEqual(result.items.map(item => item.key), ['task_q1.png', 'task_q2.png'], 'blue is below the visual cut');
    assert.deepEqual(result.items[0], { key: 'task_q1.png', similarity: 100, samePrompt: false, nearPrompt: false, sameGroup: false });
    assert.ok(result.items[1].similarity < 100 && result.items[1].similarity >= 70);
    assert.equal((await engine.neighborsOfImage({ path: outside, limit: 1 })).items.length, 1);
    assert.ok(ctx.decoder.calls.some(call => call.originalPath === outside));

    const after = engine.status();
    assert.equal(after.total, before.total, 'the query image did not join the library');
    assert.equal(after.analyzed, before.analyzed);
    await assert.rejects(engine.neighborsOfImage({}), /needs a path/);
    await assert.rejects(engine.neighborsOfImage({ path: path.join(ROOT, 'missing.png') }), /no such file/);
    await engine.close();
});

test('以图搜图 works in basic mode (colour/layout) and gives up after 7 s without killing anything', async () => {
    const ctx = makeContext();
    const recs = [
        addImage(ctx, { name: 'h1.png', prompt: 'one', colour: 'red', createdAt: T0 - 10 * MIN }),
        addImage(ctx, { name: 'h2.png', prompt: 'two', colour: 'blue', createdAt: T0 - 9 * MIN })
    ];
    const outside = path.join(ROOT, 'Downloads', 'basic.png');
    ctx.specs.set(path.resolve(outside).toLowerCase(), { colour: COLOURS.red, tint: 0 });
    const { engine } = await startEngine(ctx, { ort: false });
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);

    const result = await engine.neighborsOfImage({ path: outside });
    assert.equal(result.mode, 'h');
    assert.equal(result.items[0].key, 'task_h1.png');
    assert.equal(result.items[0].similarity, 100);
    assert.ok(!result.items.some(item => item.key === 'task_h2.png'), 'a different colour is not similar');

    const release = ctx.decoder.hold();
    const slow = engine.neighborsOfImage({ path: outside });
    const outcome = slow.then(() => 'resolved', error => error.message);
    await ctx.clock.advance(7000);
    assert.equal(await outcome, '图片分析超时，请稍后再试');
    release();
    await settle();
    assert.equal((await engine.neighborsOfImage({ path: outside })).items[0].key, 'task_h1.png', 'the engine still answers');
    await engine.close();
});

test('包含相同元素: an idle crop pass stores 9 crops per image; element search finds the subject inside a scene', async () => {
    const ctx = makeContext();
    const recs = [
        addImage(ctx, { name: 'scene.png', prompt: 'a family room', colour: 'green', createdAt: T0 - 10 * MIN }),
        addImage(ctx, { name: 'plain.png', prompt: 'something else', colour: 'blue', createdAt: T0 - 9 * MIN })
    ];
    // The red product sits in one crop of the green scene.
    ctx.specs.get(path.resolve(path.join(LIB, 'scene.png')).toLowerCase()).crops = [null, null, null, null, COLOURS.red];
    const product = path.join(ROOT, 'Downloads', 'product.png');
    ctx.specs.set(path.resolve(product).toLowerCase(), { colour: COLOURS.red, tint: 0 });
    const { engine } = await startEngine(ctx, { opts: { crops: true, cropDelayMs: 600000, cropGapMs: 10 } });
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);

    // Before the crop pass: element search falls back to whole vectors and says how far the crops are.
    const early = await engine.neighborsOfImage({ path: product, match: 'element' });
    assert.equal(early.element, true);
    assert.equal(early.cropped, 0);
    assert.deepEqual(early.items, []);
    assert.deepEqual(engine.status().crops, { enabled: true, ready: 0, total: 2 });

    await ctx.clock.advance(600000);
    for (let i = 0; i < 20 && engine.status().crops.ready < 2; i++) await ctx.clock.advance(50);
    assert.deepEqual(engine.status().crops, { enabled: true, ready: 2, total: 2 });
    assert.equal(ctx.decoder.cropCalls.length, 2, 'one crop decode per image');
    assert.ok(ctx.mem.exists(path.join(STORE, 'crops-v1.bin')));

    const element = await engine.neighborsOfImage({ path: product, match: 'element' });
    assert.equal(element.cropped, 2);
    assert.deepEqual(element.items.map(item => item.key), ['task_scene.png']);
    assert.equal(element.items[0].similarity, 100);
    assert.ok(ctx.embedder.masks >= 1, 'the subject is embedded with its patch mask');
    const whole = await engine.neighborsOfImage({ path: product, match: 'whole' });
    assert.equal(whole.element, false);
    assert.deepEqual(whole.items, [], 'as a whole the green scene is not like the red product');
    await engine.close();

    // A restart reuses the stored crops: no image is decoded for crops again.
    const again = makeContext();
    again.mem = ctx.mem; again.fs = ctx.mem.api; again.specs = ctx.specs; again.decoder = fakeDecoder(ctx.specs);
    const second = await startEngine(again, { opts: { crops: true, cropDelayMs: 1000, cropGapMs: 10 } });
    second.engine.syncRecords({ full: recs });
    await drain(again, second.engine);
    await again.clock.advance(2000);
    assert.equal(again.decoder.cropCalls.length, 0);
    assert.deepEqual((await second.engine.neighborsOfImage({ path: product, match: 'element' })).items.map(item => item.key), ['task_scene.png']);
    await second.engine.close();
});

test('the crop pass yields to pending rows and saving, skips a failing image, and is off in basic mode', async () => {
    const ctx = makeContext();
    const recs = [
        addImage(ctx, { name: 'c1.png', prompt: 'one', colour: 'red', createdAt: T0 - 10 * MIN }),
        addImage(ctx, { name: 'c2.png', prompt: 'two', colour: 'blue', createdAt: T0 - 9 * MIN })
    ];
    ctx.specs.get(path.resolve(path.join(LIB, 'c2.png')).toLowerCase()).cropFail = true;
    const { engine } = await startEngine(ctx, { opts: { crops: true, cropDelayMs: 600000, cropGapMs: 10 } });
    engine.syncRecords({ full: recs });
    await drain(ctx, engine);
    engine.setLoad({ saving: 1 });
    await ctx.clock.advance(600000);
    assert.equal(ctx.decoder.cropCalls.length, 0, 'nothing while an image is being saved');
    engine.setLoad({ saving: 0 });
    await ctx.clock.advance(600000);
    for (let i = 0; i < 40 && ctx.decoder.cropCalls.length < 2; i++) await ctx.clock.advance(100);
    assert.deepEqual(engine.status().crops, { enabled: true, ready: 1, total: 2 }, 'c2 failed and is skipped');
    await ctx.clock.advance(5000);
    assert.equal(ctx.decoder.cropCalls.filter(file => /c2\.png$/.test(file)).length, 1, 'a failed image is not retried this session');
    await engine.close();

    const basic = makeContext();
    const plain = [addImage(basic, { name: 'b1.png', prompt: 'one', colour: 'red' })];
    const outside = path.join(ROOT, 'Downloads', 'b.png');
    basic.specs.set(path.resolve(outside).toLowerCase(), { colour: COLOURS.red, tint: 0 });
    const h = await startEngine(basic, { ort: false, opts: { crops: true, cropDelayMs: 1000 } });
    h.engine.syncRecords({ full: plain });
    await drain(basic, h.engine);
    await basic.clock.advance(3000);
    assert.equal(basic.decoder.cropCalls.length, 0);
    assert.equal(h.engine.status().crops.enabled, false);
    const answer = await h.engine.neighborsOfImage({ path: outside, match: 'element' });
    assert.equal(answer.element, false, 'basic mode answers as whole and says so');
    assert.equal(answer.items[0].key, 'task_b1.png');
    await h.engine.close();
});

test('a library restored whole from the store (no lane runs) still gets its crop pass after validation', async () => {
    const ctx = makeContext();
    const recs = [
        addImage(ctx, { name: 'r1.png', prompt: 'one', colour: 'red', createdAt: T0 - 10 * MIN }),
        addImage(ctx, { name: 'r2.png', prompt: 'two', colour: 'blue', createdAt: T0 - 9 * MIN })
    ];
    const first = await startEngine(ctx); // crops off: rows only
    first.engine.syncRecords({ full: recs });
    await drain(ctx, first.engine);
    await first.engine.close();

    const again = makeContext();
    again.mem = ctx.mem; again.fs = ctx.mem.api; again.specs = ctx.specs; again.decoder = fakeDecoder(ctx.specs);
    const second = await startEngine(again, { opts: { crops: true, cropDelayMs: 1000, cropGapMs: 10 } });
    second.engine.syncRecords({ full: recs });
    await drain(again, second.engine);
    assert.equal(again.decoder.calls.length, 0, 'every row came from the store');
    for (let i = 0; i < 40 && second.engine.status().crops.ready < 2; i++) await again.clock.advance(500);
    assert.deepEqual(second.engine.status().crops, { enabled: true, ready: 2, total: 2 });
    await second.engine.close();
});
