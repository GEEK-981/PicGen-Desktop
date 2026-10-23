const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fork } = require('node:child_process');

const { createSimilarityService, SERVICE } = require('../similarityService');
const { anchorId } = require('../similarityCluster');
const { HD, H } = require('../similarityDistance');

// Main-side similarity service (v3.1 plan WP8). Fake hosts and a fake clock for the policy cases;
// one integration case forks the real host through a child_process adapter in h mode.
// Synthetic fixtures only: no real prompts, files or models.

const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOST = path.join(__dirname, '..', 'similarity-engine-host.js');

function settle(turns = 6) {
    let chain = Promise.resolve();
    for (let i = 0; i < turns; i++) chain = chain.then(() => new Promise(resolve => setImmediate(resolve)));
    return chain;
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
        pending: () => timers.size,
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

// --- fake host ------------------------------------------------------------------------------------

function snapshotFor(host, preset, extra = {}) {
    const K = host.mode === 'hd' ? HD : H;
    return {
        version: 3,
        revision: host.revision,
        mode: host.mode,
        modeReason: host.mode === 'hd' ? null : host.modeReason,
        featureVersion: host.mode === 'hd' ? 'cc4w-64fill-v1+dinov2s-q8-pad-v1+ort1.24' : 'cc4w-64fill-v1',
        preset,
        thresholds: { ...K.PRESETS },
        stage: 'final',
        groups: host.groups,
        singles: [],
        missing: 0,
        failed: 0,
        pending: 0,
        analyzed: host.records.size,
        total: host.records.size,
        stats: { decoded: host.decoded, reused: 0, embedded: 0, validated: 0, cacheHits: 0, groupRuns: 1, lastClusterMs: 1, edgeCount: 0, capHits: 0 },
        error: null,
        ...extra
    };
}

// A host handle as spawnHost returns it: postMessage, on/off('message'|'exit'), kill, pid.
function fakeHosts(behaviour = {}) {
    const spawned = [];
    let pid = 4000;
    function spawnHost(args) {
        const emitter = new EventEmitter();
        const host = {
            args,
            pid: ++pid,
            posted: [],
            alive: true,
            killed: 0,
            mode: null,
            modeReason: null,
            revision: 1,
            records: new Map(),
            groups: [],
            decoded: 0,
            hang: new Set(behaviour.hang || []),
            auto: behaviour.auto !== false,
            stdout: behaviour.streams ? new EventEmitter() : undefined,
            stderr: behaviour.streams ? new EventEmitter() : undefined,
            postMessage(message) {
                if (!host.alive) throw new Error('fake host is gone');
                host.posted.push(message);
                if (host.auto) Promise.resolve().then(() => respond(host, message));
            },
            on(event, listener) { emitter.on(event, listener); return host; },
            off(event, listener) { emitter.off(event, listener); return host; },
            kill() {
                host.killed++;
                if (host.alive) {
                    host.alive = false;
                    if (behaviour.killExits !== false) Promise.resolve().then(() => emitter.emit('exit', 1));
                }
                return true;
            },
            listenerCount: () => emitter.listenerCount('message') + emitter.listenerCount('exit') + emitter.listenerCount('error')
                + (host.stdout ? host.stdout.listenerCount('data') : 0) + (host.stderr ? host.stderr.listenerCount('data') : 0),
            // Electron's UtilityProcess 'error' (type, location, report): an EventEmitter throws
            // ERR_UNHANDLED_ERROR when nobody listens, which in main would crash the app.
            raise(type, location, report) { emitter.emit('error', type, location, report); },
            // The exit event of a host that is already dead (after a kill with killExits:false).
            emitExit(code) { emitter.emit('exit', code); },
            emit(message) { if (host.alive) emitter.emit('message', message); },
            reply(message, result) { host.emit({ id: message.id, ok: true, result }); },
            fail(message, error) { host.emit({ id: message.id, ok: false, error }); },
            exit(code) {
                if (!host.alive) return;
                host.alive = false;
                emitter.emit('exit', code);
            },
            last(type) { return [...host.posted].reverse().find(message => message.type === type); },
            all(type) { return host.posted.filter(message => message.type === type); }
        };
        spawned.push(host);
        if (behaviour.onSpawn) behaviour.onSpawn(host);
        return host;
    }
    function respond(host, message) {
        if (!host.alive || host.hang.has(message.type)) return;
        if (behaviour.respond && behaviour.respond(host, message) === true) return;
        switch (message.type) {
            case 'init':
                if (behaviour.failInit) return host.fail(message, behaviour.failInit);
                host.mode = message.ort ? (behaviour.hdMode || 'hd') : 'h';
                host.modeReason = host.mode === 'hd' ? null : (message.ortReason || 'disabled');
                host.emit({ type: 'mode', mode: host.mode, reason: host.modeReason, ortVersion: host.mode === 'hd' ? '1.24.3' : null, featureVersion: 'x' });
                return host.reply(message, { mode: host.mode, modeReason: host.modeReason, ortVersion: host.mode === 'hd' ? '1.24.3' : null, featureVersion: 'x', embVersion: '' });
            case 'records': {
                if (message.full) {
                    host.records = new Map();
                    for (const rec of message.full) host.records.set(rec.key, rec);
                } else {
                    for (const key of message.removes || []) host.records.delete(key);
                    for (const rec of message.upserts || []) host.records.set(rec.key, rec);
                }
                host.revision++;
                return host.reply(message, { total: host.records.size, keys: host.records.size, changed: 1 });
            }
            case 'get':
                if (message.since !== undefined && message.since !== null && message.since === host.revision) {
                    return host.reply(message, { notModified: true, revision: host.revision });
                }
                return host.reply(message, snapshotFor(host, message.preset));
            case 'neighbors':
                return host.reply(message, { items: [{ key: 'n1', similarity: 91, samePrompt: false, nearPrompt: false, sameGroup: false }], analyzed: true, mode: host.mode });
            case 'neighbors-image':
                return host.reply(message, { items: [{ key: 'a1', similarity: 88, samePrompt: false, nearPrompt: false, sameGroup: false }], analyzed: true, indexed: 4, mode: host.mode });
            case 'override':
                host.revision++;
                return host.reply(message, { revision: host.revision });
            case 'status':
                return host.reply(message, { pid: host.pid, rssMb: 42, mode: host.mode });
            case 'close':
                host.reply(message, { closed: true });
                return Promise.resolve().then(() => host.exit(0));
            default:
        }
    }
    return { spawnHost, spawned, respond };
}

function record(id, prompt, createdAt, extra = {}) {
    const fileName = `${id}.png`;
    return { id, filePath: path.join('C:\\fixture\\images', fileName), fileName, fileSize: 1000 + id.length, createdAt, prompt, ratio: '1:1', ...extra };
}

function library() {
    return [
        record('a1', 'synthetic castle prompt', T0 - 10 * MIN),
        record('a2', 'synthetic castle prompt', T0 - 9 * MIN),
        record('a3', 'synthetic castle prompt', T0 - 8 * MIN, { ratio: '16:9' }),
        record('b1', 'synthetic river prompt', T0 - 5 * MIN),
        record('b2', 'synthetic river prompt', T0 - 4 * MIN),
        record('c1', 'synthetic lone prompt', T0 - 3 * MIN),
        record('p1', '', T0 - 2 * MIN)
    ];
}

function makeService(t, options = {}) {
    const clock = options.clock || fakeClock();
    const hosts = options.hosts || fakeHosts(options.behaviour);
    const pushes = [];
    const logs = [];
    const errors = [];
    const service = createSimilarityService({
        hostPath: HOST,
        spawnHost: hosts.spawnHost,
        storeDir: 'C:\\fixture\\similarity',
        thumbnailsDir: 'C:\\fixture\\thumbnails',
        scanDirs: ['C:\\fixture\\images'],
        modelPath: 'C:\\fixture\\models\\dinov2-small-q8.onnx',
        ortEnabled: options.ortEnabled !== false,
        onPush: push => pushes.push(push),
        log: entry => logs.push(entry),
        recordError: entry => errors.push(entry),
        console: options.console || { log() {}, warn() {}, error() {} },
        clock,
        backfillAt: options.backfillAt ?? clock.now() + 20 * SEC,
        timeouts: options.timeouts
    });
    if (t) t.after(() => service.close());
    return { service, clock, hosts, pushes, logs, errors };
}

async function ready(ctx, index = 0) {
    await settle();
    const host = ctx.hosts.spawned[index];
    assert.ok(host, `host ${index} was spawned`);
    assert.ok(host.last('init'), 'init was posted');
    assert.equal(ctx.service.status().state, 'ready');
    return host;
}

// --- provisional fallback -----------------------------------------------------------------------

test('get returns provisional groups at once while the host is starting', async t => {
    const ctx = makeService(t, { behaviour: { hang: ['init'] } });
    const records = library();
    records.push({ ...records[0] }); // a duplicate key: passed through, counted as missing here
    ctx.service.syncRecords(records);
    await settle();
    assert.equal(ctx.hosts.spawned.length, 1, 'the first sync starts the host');
    assert.equal(ctx.service.status().state, 'starting');

    const snapshot = await ctx.service.get({ preset: 'standard', foreground: true });
    assert.equal(snapshot.version, 3);
    assert.equal(snapshot.stage, 'provisional');
    assert.equal(snapshot.mode, 'hd');
    assert.equal(snapshot.preset, 'standard');
    assert.deepEqual(snapshot.thresholds, { ...HD.PRESETS });
    assert.equal(snapshot.total, 8);
    assert.equal(snapshot.missing, 1);
    assert.equal(snapshot.analyzed, 0);
    assert.equal(snapshot.pending, 7);
    assert.equal(snapshot.error, null);
    assert.deepEqual(snapshot.groups.map(group => group.members), [['b2', 'b1'], ['a3', 'a2', 'a1']]);
    for (const group of snapshot.groups) {
        assert.equal(group.provisional, true);
        assert.equal(group.id, anchorId(group.members[group.members.length - 1]));
        assert.equal(group.pinned, null);
        assert.equal(group.parts, null);
        assert.deepEqual(group.rest, []);
        assert.equal(group.promptVariants, 1);
    }
    assert.deepEqual(snapshot.groups[1].ratios, ['16:9', '1:1']);
    assert.equal(snapshot.groups[1].latestAt, T0 - 8 * MIN);
    assert.deepEqual(snapshot.singles, ['p1', 'c1']);
    assert.equal(snapshot.stats.decoded, 0);

    // The foreground hint reached the starting host (it buffers load until init).
    const host = ctx.hosts.spawned[0];
    assert.ok(host.all('load').some(message => message.foreground === true));

    const again = await ctx.service.get({ preset: 'strict', since: snapshot.revision });
    assert.deepEqual(again, { notModified: true, revision: snapshot.revision });
    const strict = await ctx.service.get({ preset: 'strict' });
    assert.equal(strict.revision, snapshot.revision, 'the revision is preset-independent');
    assert.equal(strict.preset, 'strict');
});

test('get without records or host returns an empty provisional snapshot', async t => {
    const ctx = makeService(t, { ortEnabled: false, behaviour: { hang: ['init'] } });
    const snapshot = await ctx.service.get({});
    assert.equal(snapshot.stage, 'provisional');
    assert.equal(snapshot.mode, 'h');
    assert.equal(snapshot.modeReason, 'disabled');
    assert.deepEqual(snapshot.thresholds, { ...H.PRESETS });
    assert.equal(snapshot.preset, 'standard');
    assert.deepEqual(snapshot.groups, []);
    assert.deepEqual(snapshot.singles, []);
    assert.equal(snapshot.total, 0);
    // IPC payloads can be null: nothing throws except an override without an op.
    assert.equal((await ctx.service.get(null)).version, 3);
    assert.deepEqual(await ctx.service.neighbors(null), { items: [], analyzed: false, mode: 'h' });
    await assert.rejects(ctx.service.override(null), /unknown similarity override op/);
    ctx.service.setLoad(null);
    assert.equal(ctx.service.syncRecords(null).total, 0);
});

// --- init, records, diff ----------------------------------------------------------------------------

test('init carries the paths, the mode request and the remaining backfill delay', async t => {
    const clock = fakeClock();
    const ctx = makeService(t, { clock, backfillAt: clock.now() + 20 * SEC });
    await clock.advance(5 * SEC);
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    const init = host.last('init');
    assert.equal(init.storeDir, 'C:\\fixture\\similarity');
    assert.equal(init.thumbnailsDir, 'C:\\fixture\\thumbnails');
    assert.deepEqual(init.scanDirs, ['C:\\fixture\\images']);
    assert.equal(init.modelPath, 'C:\\fixture\\models\\dinov2-small-q8.onnx');
    assert.equal(init.ort, true);
    assert.equal(init.threads, 2);
    assert.equal(init.backfillDelayMs, 15 * SEC);
    assert.equal(host.args.hostPath, HOST);
    const status = ctx.service.status();
    assert.equal(status.mode, 'hd');
    assert.equal(status.ortVersion, '1.24.3');
    assert.equal(status.hostPid, host.pid);
    assert.equal(ctx.pushes.length, 0, 'no push before anyone holds a revision (the mode event changed the overlay)');
});

test('scanDirs may be an async function, resolved at every start', async t => {
    let calls = 0;
    const hosts = fakeHosts();
    const clock = fakeClock();
    const service = createSimilarityService({
        hostPath: HOST,
        spawnHost: hosts.spawnHost,
        storeDir: 's',
        thumbnailsDir: 't',
        scanDirs: async () => [`dir-${++calls}`],
        modelPath: 'm',
        ortEnabled: false,
        clock,
        console: { log() {}, warn() {}, error() {} }
    });
    t.after(() => service.close());
    service.syncRecords(library());
    await settle();
    assert.deepEqual(hosts.spawned[0].last('init').scanDirs, ['dir-1']);
    hosts.spawned[0].exit(1);
    await clock.advance(1 * SEC);
    assert.deepEqual(hosts.spawned[1].last('init').scanDirs, ['dir-2']);
});

test('the first sync after init is full; later syncs send only the diff', async t => {
    const ctx = makeService(t);
    const records = library();
    // Before the host is ready nothing but init/load is posted.
    ctx.service.syncRecords(records);
    const host = await ready(ctx);
    const full = host.all('records');
    assert.equal(full.length, 1);
    assert.equal(full[0].full.length, 7);
    assert.deepEqual(Object.keys(full[0].full[0]).sort(), ['createdAt', 'fileName', 'filePath', 'fileSize', 'key', 'prompt', 'ratio']);
    assert.equal(full[0].full[0].key, 'a1');

    // Unchanged → nothing is sent.
    const same = ctx.service.syncRecords(records.map(entry => ({ ...entry })));
    assert.equal(same.changed, 0);
    await settle();
    assert.equal(host.all('records').length, 1);

    // One prompt edit, one removal, one addition.
    const next = records.filter(entry => entry.id !== 'c1').map(entry => (entry.id === 'b2' ? { ...entry, prompt: 'synthetic river prompt, edited' } : entry));
    next.push(record('d1', 'synthetic new prompt', T0 - MIN));
    const summary = ctx.service.syncRecords(next);
    assert.deepEqual({ upserts: summary.upserts, removes: summary.removes }, { upserts: 2, removes: 1 });
    await settle();
    const diff = host.last('records');
    assert.equal(diff.full, undefined);
    assert.deepEqual(diff.upserts.map(rec => rec.key).sort(), ['b2', 'd1']);
    assert.deepEqual(diff.removes, ['c1']);
    assert.equal(diff.upserts.find(rec => rec.key === 'b2').prompt, 'synthetic river prompt, edited');

    // A size change, a path change and a createdAt change are all changes.
    const moved = next.map(entry => {
        if (entry.id === 'a1') return { ...entry, fileSize: entry.fileSize + 1 };
        if (entry.id === 'a2') return { ...entry, filePath: 'D:\\elsewhere\\a2.png' };
        if (entry.id === 'a3') return { ...entry, createdAt: entry.createdAt + 1 };
        return entry;
    });
    ctx.service.syncRecords(moved);
    await settle();
    assert.deepEqual(host.last('records').upserts.map(rec => rec.key).sort(), ['a1', 'a2', 'a3']);
    assert.deepEqual(host.last('records').removes, []);
});

test('duplicate keys are passed through together for the host to resolve', async t => {
    const ctx = makeService(t);
    const first = record('dup', 'synthetic dup prompt', T0 - 2 * MIN);
    const second = { ...first, filePath: 'D:\\copy\\dup.png' };
    ctx.service.syncRecords([first, second, record('x1', 'synthetic x prompt', T0)]);
    const host = await ready(ctx);
    const full = host.last('records').full;
    assert.deepEqual(full.filter(rec => rec.key === 'dup').map(rec => rec.filePath), [first.filePath, second.filePath]);

    // Changing only the second copy re-sends both, in order.
    ctx.service.syncRecords([first, { ...second, fileSize: 7 }, record('x1', 'synthetic x prompt', T0)]);
    await settle();
    const diff = host.last('records');
    assert.deepEqual(diff.upserts.map(rec => [rec.key, rec.filePath]), [['dup', first.filePath], ['dup', second.filePath]]);
    // Dropping the second copy is an upsert of the key, not a removal.
    ctx.service.syncRecords([first, record('x1', 'synthetic x prompt', T0)]);
    await settle();
    assert.deepEqual(host.last('records').upserts.map(rec => rec.key), ['dup']);
    assert.deepEqual(host.last('records').removes, []);
});

// --- routing, revisions, pushes ------------------------------------------------------------------------

test('request ids route replies to their callers, in any order', async t => {
    const ctx = makeService(t, { behaviour: { hang: ['neighbors', 'status'] } });
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    const first = ctx.service.neighbors({ key: 'a1', preset: 'standard' });
    const second = ctx.service.neighbors({ key: 'b1', mode: 'visual', limit: 5, samePromptOnly: true });
    const status = ctx.service.hostStatus();
    await settle();
    const [q1, q2] = host.all('neighbors');
    assert.equal(q1.key, 'a1');
    assert.deepEqual({ key: q2.key, mode: q2.mode, limit: q2.limit, samePromptOnly: q2.samePromptOnly }, { key: 'b1', mode: 'visual', limit: 5, samePromptOnly: true });
    assert.equal(q1.mode, 'combined');
    assert.notEqual(q1.id, q2.id);
    host.reply(host.last('status'), { pid: host.pid, rssMb: 12 });
    host.reply(q2, { items: [{ key: 'b2' }], analyzed: true, mode: 'hd' });
    host.emit({ id: 987654, ok: true, result: { stray: true } }); // an unknown id is ignored
    host.reply(q1, { items: [{ key: 'a2' }], analyzed: true, mode: 'hd' });
    assert.deepEqual((await second).items, [{ key: 'b2' }]);
    assert.deepEqual((await first).items, [{ key: 'a2' }]);
    assert.equal((await status).rssMb, 12);
});

test('snapshots and notices carry one strictly increasing service revision across restarts', async t => {
    const ctx = makeService(t);
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    host.groups = [{ id: 'sg_x', members: ['a3', 'a2', 'a1'], pinned: null, latestAt: 1, promptVariants: 1, ratios: [], provisional: false, parts: null, rest: [], failed: [] }];
    const first = await ctx.service.get({ preset: 'standard' });
    assert.equal(first.stage, 'final');
    assert.deepEqual(first.groups.map(group => group.id), ['sg_x']);
    assert.equal(host.last('get').since, undefined);

    // The same host revision → the host says notModified and the cached snapshot is served.
    const cached = await ctx.service.get({ preset: 'standard' });
    assert.equal(host.last('get').since, host.revision);
    assert.equal(cached.revision, first.revision);
    assert.deepEqual(cached.groups, first.groups);
    assert.deepEqual(await ctx.service.get({ preset: 'standard', since: first.revision }), { notModified: true, revision: first.revision });

    // A notice relays with the translated revision, and a get at that host revision matches it.
    host.revision += 1;
    host.emit({ type: 'notice', revision: host.revision, stage: 'partial', mode: 'hd', pending: 3, analyzed: 4, total: 7, groupCount: 1 });
    const push = ctx.pushes.at(-1);
    assert.ok(push.revision > first.revision);
    assert.deepEqual({ ...push, revision: 0 }, { revision: 0, stage: 'partial', mode: 'hd', pending: 3, analyzed: 4, total: 7, groupCount: 1 });
    const second = await ctx.service.get({ preset: 'standard' });
    assert.equal(second.revision, push.revision);

    // A restarted host counts from 1 again; the service revision keeps growing.
    host.exit(1);
    await ctx.clock.advance(1 * SEC);
    const next = await ready(ctx, 1);
    assert.equal(next.last('records').full.length, 7, 'the new host gets the full list');
    next.revision = 1;
    const third = await ctx.service.get({ preset: 'standard' });
    assert.ok(third.revision > second.revision, `${third.revision} > ${second.revision}`);
    assert.equal(next.last('get').since, undefined, 'an old generation\'s revision is never sent as since');
});

test('a slow host: get answers from the cache within the soft deadline, and the late reply pushes', async t => {
    const ctx = makeService(t);
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    const first = await ctx.service.get({ preset: 'standard' });
    host.hang.add('get');
    host.revision += 1;
    let answered = null;
    const pending = ctx.service.get({ preset: 'standard' }).then(value => { answered = value; });
    await ctx.clock.advance(SERVICE.getMs - 1);
    assert.equal(answered, null);
    await ctx.clock.advance(1);
    await pending;
    assert.equal(answered.revision, first.revision, 'the cached snapshot');
    const pushesBefore = ctx.pushes.length;
    host.reply(host.last('get'), snapshotFor(host, 'standard'));
    await settle();
    assert.equal(ctx.pushes.length, pushesBefore + 1);
    assert.ok(ctx.pushes.at(-1).revision > first.revision);
    host.hang.delete('get');
    const fresh = await ctx.service.get({ preset: 'standard' });
    assert.equal(fresh.revision, ctx.pushes.at(-1).revision);
});

test('override relays to the host and returns a service revision', async t => {
    const ctx = makeService(t);
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    const before = await ctx.service.get({ preset: 'standard' });
    const result = await ctx.service.override({ op: 'setCover', key: 'a2', groupId: 'sg_x' });
    const sent = host.last('override');
    assert.deepEqual({ op: sent.op, key: sent.key, groupId: sent.groupId }, { op: 'setCover', key: 'a2', groupId: 'sg_x' });
    assert.ok(result.revision > before.revision);
    const after = await ctx.service.get({ preset: 'standard' });
    assert.equal(after.revision, result.revision);
    await assert.rejects(ctx.service.override({ op: 'explode', key: 'a1' }), /unknown similarity override op/);
});

// --- crash policy ---------------------------------------------------------------------------------------

test('a request timeout kills the host, rejects in-flight requests and restarts with backoff', async t => {
    const ctx = makeService(t, { behaviour: { hang: ['override'] } });
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    const first = ctx.service.override({ op: 'detach', key: 'a1', groupId: 'g' });
    const second = ctx.service.override({ op: 'reset', key: 'a2' });
    const firstDone = assert.rejects(first, /did not answer override within 10000 ms/);
    const secondDone = assert.rejects(second);
    await ctx.clock.advance(SERVICE.requestMs - 1);
    assert.equal(host.killed, 0);
    await ctx.clock.advance(1);
    await firstDone;
    await secondDone;
    assert.equal(host.killed, 1);
    assert.equal(ctx.service.status().state, 'restarting');
    assert.equal(ctx.hosts.spawned.length, 1);
    await ctx.clock.advance(999);
    assert.equal(ctx.hosts.spawned.length, 1);
    await ctx.clock.advance(1);
    assert.equal(ctx.hosts.spawned.length, 2, 'restarted after 1 s');
    await ready(ctx, 1);

    // Timeouts count as crashes: the next backoff is 5 s, then 30 s.
    ctx.hosts.spawned[1].hang.add('status');
    const probe = ctx.service.hostStatus();
    await ctx.clock.advance(SERVICE.requestMs);
    assert.equal(await probe, null, 'hostStatus resolves null when the host fails');
    await ctx.clock.advance(4999);
    assert.equal(ctx.hosts.spawned.length, 2);
    await ctx.clock.advance(1);
    assert.equal(ctx.hosts.spawned.length, 3, 'restarted after 5 s');
});

test('an exit rejects in-flight requests; neighbours fall back to same-prompt results', async t => {
    const ctx = makeService(t, { behaviour: { hang: ['override', 'neighbors'] } });
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    const snapshot = await ctx.service.get({ preset: 'standard' });
    const override = ctx.service.override({ op: 'setCover', key: 'a1', groupId: 'g' });
    const overrideDone = assert.rejects(override, /exited with code 7/);
    const neighbours = ctx.service.neighbors({ key: 'a1', preset: 'standard', limit: 1 });
    await settle();
    host.exit(7);
    await overrideDone;
    const fallback = await neighbours;
    assert.equal(fallback.analyzed, false);
    assert.equal(fallback.mode, 'hd');
    assert.deepEqual(fallback.items, [{ key: 'a3', similarity: null, samePrompt: true, nearPrompt: false, sameGroup: false }]);
    assert.ok(ctx.logs.some(entry => entry.level === 'warn' && /similarity host exited/.test(entry.message)));

    // While restarting the last snapshot is served, with the error overlay and a new revision.
    const served = await ctx.service.get({ preset: 'standard' });
    assert.equal(served.stage, snapshot.stage);
    assert.ok(served.revision > snapshot.revision);
    assert.match(served.error, /重启/);
    assert.ok(ctx.pushes.some(push => push.revision === served.revision), 'the overlay change was pushed');
    await assert.rejects(ctx.service.override({ op: 'reset', key: 'a1' }), /尚未就绪/);

    await ctx.clock.advance(1 * SEC);
    const next = await ready(ctx, 1);
    assert.equal(next.last('records').full.length, 7, 'the new host gets the full list');
    assert.equal(ctx.service.status().error, null, 'a ready host clears the restart error');
});

test('more than 3 restarts in 10 min degrade the service for the session', async t => {
    const ctx = makeService(t);
    ctx.service.syncRecords(library());
    let host = await ready(ctx);
    await ctx.service.get({ preset: 'standard' });
    const delays = [1000, 5000, 30000];
    for (let i = 0; i < 3; i++) {
        host.exit(1);
        await ctx.clock.advance(delays[i] - 1);
        assert.equal(ctx.hosts.spawned.length, i + 1);
        await ctx.clock.advance(1);
        host = await ready(ctx, i + 1);
    }
    host.exit(1);
    await ctx.clock.advance(15 * MIN);
    assert.equal(ctx.hosts.spawned.length, 4, 'no fifth host');
    const status = ctx.service.status();
    assert.equal(status.state, 'degraded');
    assert.equal(status.degraded, true);
    assert.match(status.error, /停用/);
    const served = await ctx.service.get({ preset: 'standard' });
    assert.match(served.error, /停用/);
    assert.equal(served.stage, 'final', 'the last snapshot');
    assert.equal(ctx.errors.filter(entry => entry.source === 'similarity' && /停用/.test(entry.title)).length, 1);
    // Degraded: new records are still reflected (as singles) without a host.
    ctx.service.syncRecords([...library(), record('z9', 'synthetic late prompt', T0 + MIN)]);
    const later = await ctx.service.get({ preset: 'standard' });
    assert.ok(later.singles.includes('z9'));
    assert.equal(later.total, 8);
    assert.equal(ctx.hosts.spawned.length, 4);
    const neighbours = await ctx.service.neighbors({ key: 'b1' });
    assert.deepEqual(neighbours.items.map(item => item.key), ['b2']);
});

test('crashes more than 10 min apart never degrade, and the backoff starts over', async t => {
    const ctx = makeService(t);
    ctx.service.syncRecords(library());
    let host = await ready(ctx);
    for (let i = 0; i < 5; i++) {
        host.exit(1);
        await ctx.clock.advance(1 * SEC);
        host = await ready(ctx, i + 1);
        await ctx.clock.advance(11 * MIN);
    }
    assert.equal(ctx.service.status().degraded, false);
    assert.equal(ctx.hosts.spawned.length, 6);
    // Spread-out hd crashes never add up to 'unstable' either.
    for (const spawned of ctx.hosts.spawned) assert.equal(spawned.last('init').ort, true);
    assert.equal(ctx.service.status().mode, 'hd');
});

test('get() and syncRecords() during a restart backoff never respawn before the timer fires', async t => {
    const ctx = makeService(t);
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    host.exit(1);
    await settle();
    assert.equal(ctx.service.status().state, 'restarting');
    for (let i = 0; i < 3; i++) {
        await ctx.service.get({ preset: 'standard', foreground: true });
        ctx.service.syncRecords([...library(), record(`late${i}`, 'synthetic late prompt', T0 + i * SEC)]);
        await ctx.service.neighbors({ key: 'a1' });
        await ctx.clock.advance(300);
        assert.equal(ctx.hosts.spawned.length, 1, `no respawn at call round ${i}`);
    }
    await ctx.clock.advance(99);
    assert.equal(ctx.hosts.spawned.length, 1);
    await ctx.clock.advance(1);
    assert.equal(ctx.hosts.spawned.length, 2, 'exactly one restart, when the 1 s timer fires');
    const next = await ready(ctx, 1);
    const full = next.last('records').full;
    assert.equal(full.length, 8, 'the last list synced during the backoff');
    assert.ok(full.some(rec => rec.key === 'late2'));
    assert.equal(ctx.hosts.spawned.length, 2);
});

test('2 crashes within 10 min in hd → the next init carries ort:false (unstable), and h is kept', async t => {
    const ctx = makeService(t);
    ctx.service.syncRecords(library());
    let host = await ready(ctx);
    assert.equal(host.last('init').ort, true);
    host.exit(1);
    await ctx.clock.advance(1 * SEC);
    host = await ready(ctx, 1);
    assert.equal(host.last('init').ort, true, 'one crash in hd keeps hd');
    host.exit(1);
    await ctx.clock.advance(5 * SEC);
    host = await ready(ctx, 2);
    const init = host.last('init');
    assert.equal(init.ort, false);
    assert.equal(init.ortReason, 'unstable');
    assert.equal(ctx.service.status().mode, 'h');
    assert.equal(ctx.service.status().modeReason, 'unstable');
    const logged = ctx.errors.filter(entry => entry.title === '视觉模型未加载，已改用基础相似度');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].source, 'similarity');

    // Much later, a crash in h restarts in h: a session never goes back to hd.
    await ctx.clock.advance(20 * MIN);
    host.exit(1);
    await ctx.clock.advance(1 * SEC);
    host = await ready(ctx, 3);
    assert.equal(host.last('init').ort, false);
    assert.equal(host.last('init').ortReason, 'unstable');
    assert.equal(ctx.errors.filter(entry => entry.title === '视觉模型未加载，已改用基础相似度').length, 1, 'one entry per session');
});

test('a crash during init with ORT requested counts as an hd crash', async t => {
    const ctx = makeService(t, { behaviour: { hang: ['init'] } });
    ctx.service.syncRecords(library());
    await settle();
    ctx.hosts.spawned[0].exit(3221225477);
    await ctx.clock.advance(1 * SEC);
    ctx.hosts.spawned[1].exit(3221225477);
    await ctx.clock.advance(5 * SEC);
    const init = ctx.hosts.spawned[2].last('init');
    assert.equal(init.ort, false);
    assert.equal(init.ortReason, 'unstable');
});

test('a host that reports h at start keeps later starts in h with the same reason', async t => {
    const ctx = makeService(t, {
        behaviour: {
            respond(host, message) {
                if (message.type !== 'init' || !message.ort) return false;
                host.mode = 'h';
                host.modeReason = 'model-missing';
                host.emit({ type: 'mode', mode: 'h', reason: 'model-missing', ortVersion: null, featureVersion: 'cc4w-64fill-v1' });
                host.reply(message, { mode: 'h', modeReason: 'model-missing', ortVersion: null, featureVersion: 'cc4w-64fill-v1', embVersion: '' });
                return true;
            }
        }
    });
    ctx.service.syncRecords(library());
    let host = await ready(ctx);
    assert.equal(ctx.service.status().modeReason, 'model-missing');
    const snapshot = await ctx.service.get({});
    assert.equal(snapshot.mode, 'h');
    host.exit(1);
    await ctx.clock.advance(1 * SEC);
    host = await ready(ctx, 1);
    assert.deepEqual({ ort: host.last('init').ort, ortReason: host.last('init').ortReason }, { ort: false, ortReason: 'model-missing' });
    assert.equal(ctx.errors.filter(entry => entry.title === '视觉模型未加载，已改用基础相似度').length, 1);
});

test('an in-place switch to h (run-failed) is relayed and kept across restarts; disabled logs nothing', async t => {
    const ctx = makeService(t);
    ctx.service.syncRecords(library());
    let host = await ready(ctx);
    host.emit({ type: 'mode', mode: 'h', reason: 'run-failed', ortVersion: '1.24.3', featureVersion: 'cc4w-64fill-v1' });
    assert.equal(ctx.service.status().mode, 'h');
    assert.equal(ctx.service.status().modeReason, 'run-failed');
    assert.equal(ctx.errors.length, 1);
    host.exit(1);
    await ctx.clock.advance(1 * SEC);
    host = await ready(ctx, 1);
    assert.equal(host.last('init').ortReason, 'run-failed');

    const off = makeService(t, { ortEnabled: false });
    off.service.syncRecords(library());
    const offHost = await ready(off);
    assert.deepEqual({ ort: offHost.last('init').ort, ortReason: offHost.last('init').ortReason }, { ort: false, ortReason: 'disabled' });
    assert.equal(off.service.status().modeReason, 'disabled');
    assert.equal(off.errors.length, 0, 'disabled is not an error');
});

test('a mode change alone gives the served snapshot a new revision and a push', async t => {
    const ctx = makeService(t, { behaviour: { hang: ['init'] } });
    ctx.service.syncRecords(library());
    await settle();
    const before = await ctx.service.get({ preset: 'standard' });
    assert.equal(before.mode, 'hd');
    const host = ctx.hosts.spawned[0];
    host.emit({ type: 'mode', mode: 'h', reason: 'model-size', ortVersion: null, featureVersion: 'cc4w-64fill-v1' });
    const push = ctx.pushes.at(-1);
    assert.ok(push && push.revision > before.revision);
    assert.equal(push.mode, 'h');
    const after = await ctx.service.get({ preset: 'standard', since: before.revision });
    assert.equal(after.revision, push.revision);
    assert.equal(after.mode, 'h');
    assert.equal(after.modeReason, 'model-size');
    assert.equal(after.featureVersion, 'cc4w-64fill-v1');
    assert.deepEqual(after.thresholds, { ...H.PRESETS });
    assert.deepEqual(after.groups, before.groups, 'the same provisional groups');
});

test('an init failure is a crash: the host is killed and restarted', async t => {
    const ctx = makeService(t, { behaviour: { failInit: 'EACCES: similarity store' } });
    ctx.service.syncRecords(library());
    await settle();
    assert.equal(ctx.hosts.spawned[0].killed, 1);
    assert.equal(ctx.service.status().state, 'restarting');
    await ctx.clock.advance(1 * SEC);
    assert.equal(ctx.hosts.spawned.length, 2);
    assert.ok(ctx.logs.some(entry => /EACCES/.test(JSON.stringify(entry))));
});

test('a spawn that throws counts as a crash', async t => {
    let calls = 0;
    const hosts = fakeHosts();
    const ctx = makeService(t, {
        hosts: {
            spawned: hosts.spawned,
            spawnHost(args) {
                calls++;
                if (calls === 1) throw new Error('fork failed');
                return hosts.spawnHost(args);
            }
        }
    });
    ctx.service.syncRecords(library());
    await settle();
    assert.equal(ctx.service.status().state, 'restarting');
    await ctx.clock.advance(1 * SEC);
    await ready(ctx, 0);
});

test('a failed spawn counts as a restart but never toward unstable', async t => {
    let calls = 0;
    const hosts = fakeHosts();
    const ctx = makeService(t, {
        hosts: {
            spawned: hosts.spawned,
            spawnHost(args) {
                calls++;
                if (calls === 1) throw new Error('fork failed');
                return hosts.spawnHost(args);
            }
        }
    });
    ctx.service.syncRecords(library());
    await settle();
    assert.equal(ctx.service.status().restarts, 1);
    await ctx.clock.advance(1 * SEC);
    let host = await ready(ctx, 0);
    assert.equal(host.last('init').ort, true);
    // One real hd crash on top of the failed fork: still one short of the hd crash limit.
    host.exit(1);
    await ctx.clock.advance(5 * SEC);
    host = await ready(ctx, 1);
    assert.equal(host.last('init').ort, true, 'the failed fork is not an hd crash');
    assert.equal(host.last('init').ortReason, undefined);
    assert.equal(ctx.service.status().mode, 'hd');
    assert.equal(ctx.service.status().restarts, 2);
});

test('an init gets its own longer timeout for the cold model load', async t => {
    const ctx = makeService(t, { behaviour: { hang: ['init'] } });
    ctx.service.syncRecords(library());
    await settle();
    const host = ctx.hosts.spawned[0];
    assert.ok(host.last('init'));
    assert.ok(SERVICE.initMs >= 60000, `initMs ${SERVICE.initMs}`);
    await ctx.clock.advance(SERVICE.requestMs * 2);
    assert.equal(host.killed, 0, 'a slow cold start outlives the ordinary request timeout');
    assert.equal(ctx.service.status().state, 'starting');
    await ctx.clock.advance(SERVICE.initMs - SERVICE.requestMs * 2 - 1);
    assert.equal(host.killed, 0);
    await ctx.clock.advance(1);
    assert.equal(host.killed, 1);
    assert.equal(ctx.service.status().state, 'restarting');
    assert.ok(ctx.logs.some(entry => /did not answer init within 60000 ms/.test(JSON.stringify(entry))));

    // The option is overridable; ordinary requests keep requestMs.
    const quick = makeService(t, { timeouts: { initMs: 3000 }, behaviour: { hang: ['init'] } });
    quick.service.syncRecords(library());
    await settle();
    await quick.clock.advance(2999);
    assert.equal(quick.hosts.spawned[0].killed, 0);
    await quick.clock.advance(1);
    assert.equal(quick.hosts.spawned[0].killed, 1);
});

// --- UtilityProcess 'error' -----------------------------------------------------------------------------

test('a host error event is recorded without throwing, and the following exit restarts it', async t => {
    const ctx = makeService(t);
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    assert.doesNotThrow(() => host.raise('FatalError', 'v8::ToLocalChecked', 'synthetic report'));
    const logged = ctx.logs.find(entry => entry.level === 'error' && /fatal/.test(entry.message));
    assert.ok(logged, 'the error event is reported');
    assert.match(JSON.stringify(logged.data), /FatalError/);
    assert.equal(ctx.service.status().state, 'ready', 'the exit, not the error, ends the host');
    host.exit(5);
    await settle();
    assert.ok(ctx.logs.some(entry => entry.level === 'warn' && /exited with code 5: FatalError/.test(JSON.stringify(entry.data))));
    assert.equal(host.listenerCount(), 0, 'every listener, error included, is removed');
    assert.equal(ctx.service.status().state, 'restarting');
    await ctx.clock.advance(1 * SEC);
    await ready(ctx, 1);
});

test('an error event after the service killed the host (before its exit) never throws', async t => {
    const ctx = makeService(t, { behaviour: { hang: ['status'], killExits: false } });
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    const probe = ctx.service.hostStatus();
    await ctx.clock.advance(SERVICE.requestMs);
    assert.equal(await probe, null);
    assert.equal(host.killed, 1);
    assert.doesNotThrow(() => host.raise('OOMError', '', ''));
    host.emitExit(1);
    assert.equal(host.listenerCount(), 0, 'the error guard goes with the exit');
    assert.equal(ctx.hosts.spawned.length, 1);
    await ctx.clock.advance(1 * SEC);
    assert.equal(ctx.hosts.spawned.length, 2, 'one restart only');
});

test('degraded: removed records leave their cached groups; totals still add up', async t => {
    const extra = [
        record('d1', 'synthetic desert prompt', T0 - 7 * MIN),
        record('d2', 'synthetic desert prompt', T0 - 6.5 * MIN),
        record('d3', 'synthetic desert prompt', T0 - 6 * MIN)
    ];
    const groupA = { id: 'sg_a', members: ['a3', 'a2', 'a1'], pinned: 'a2', latestAt: T0 - 8 * MIN, promptVariants: 1, ratios: ['16:9', '1:1'], provisional: false, parts: [['a3'], ['a2', 'a1']], rest: ['a1'], failed: ['a1', 'a3'] };
    const groupB = { id: 'sg_b', members: ['b2', 'b1'], pinned: null, latestAt: T0 - 4 * MIN, promptVariants: 1, ratios: ['1:1'], provisional: false, parts: null, rest: [], failed: [] };
    const groupD = { id: 'sg_d', members: ['d3', 'd2', 'd1'], pinned: 'd1', latestAt: T0 - 6 * MIN, promptVariants: 1, ratios: ['1:1'], provisional: false, parts: null, rest: [], failed: [] };
    const ctx = makeService(t, {
        behaviour: {
            respond(host, message) {
                if (message.type !== 'get') return false;
                host.groups = [groupB, groupD, groupA];
                host.reply(message, snapshotFor(host, message.preset, { singles: ['p1', 'c1'] }));
                return true;
            }
        }
    });
    ctx.service.syncRecords([...library(), ...extra]);
    let host = await ready(ctx);
    const first = await ctx.service.get({ preset: 'standard' });
    assert.equal(first.total, 10);
    const delays = [1000, 5000, 30000];
    for (let i = 0; i < 3; i++) {
        host.exit(1);
        await ctx.clock.advance(delays[i]);
        host = await ready(ctx, i + 1);
    }
    host.exit(1);
    await settle();
    assert.equal(ctx.service.status().state, 'degraded');

    // a1: a plain member of a 3-group; d1: the pinned member of a 3-group; b1: one of a 2-group.
    const remaining = [...library(), ...extra].filter(entry => !['a1', 'd1', 'b1'].includes(entry.id));
    remaining.push(record('z9', 'synthetic late prompt', T0 + MIN));
    ctx.service.syncRecords(remaining);
    const served = await ctx.service.get({ preset: 'standard' });
    assert.equal(served.stage, 'final');
    assert.match(served.error, /停用/);
    assert.deepEqual(served.groups.map(group => [group.id, group.members, group.pinned]), [
        ['sg_d', ['d3', 'd2'], null],
        ['sg_a', ['a3', 'a2'], 'a2']
    ]);
    const a = served.groups.find(group => group.id === 'sg_a');
    assert.deepEqual({ parts: a.parts, rest: a.rest, failed: a.failed }, { parts: null, rest: [], failed: ['a3'] });
    assert.deepEqual(served.singles, ['z9', 'p1', 'c1', 'b2'], 'the released b2 and the new z9, newest first');
    assert.equal(served.total, 8);
    const grouped = served.groups.reduce((sum, group) => sum + group.members.length, 0);
    assert.equal(grouped + served.singles.length + served.missing, served.total);
    assert.equal(served.missing, 0);
    assert.ok(served.revision > first.revision);
    assert.equal(ctx.hosts.spawned.length, 4, 'no host while degraded');

    // Removing the rest of a group releases its last member too.
    ctx.service.syncRecords(remaining.filter(entry => entry.id !== 'd2'));
    const later = await ctx.service.get({ preset: 'standard' });
    assert.deepEqual(later.groups.map(group => group.id), ['sg_a']);
    assert.ok(later.singles.includes('d3'));
    assert.equal(later.groups[0].members.length + later.singles.length + later.missing, later.total);
    assert.equal(later.total, 7);
});

// --- load ------------------------------------------------------------------------------------------

test('setLoad forwards saving and battery, and a new host starts with the current load', async t => {
    const ctx = makeService(t);
    ctx.service.setLoad({ saving: 2 });
    assert.equal(ctx.hosts.spawned.length, 0, 'setLoad alone does not start the host');
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    const initial = host.posted[0];
    assert.deepEqual({ type: initial.type, saving: initial.saving, onBattery: initial.onBattery }, { type: 'load', saving: 2, onBattery: false });
    ctx.service.setLoad({ onBattery: true });
    ctx.service.setLoad({ saving: 0 });
    assert.deepEqual(host.all('load').slice(-2).map(({ type, ...rest }) => rest), [{ onBattery: true }, { saving: 0 }]);
    await ctx.service.get({ foreground: true });
    assert.equal(host.last('get').foreground, true);
    host.exit(1);
    await ctx.clock.advance(1 * SEC);
    const next = await ready(ctx, 1);
    const load = next.posted[0];
    assert.deepEqual({ type: load.type, saving: load.saving, onBattery: load.onBattery, foreground: load.foreground }, { type: 'load', saving: 0, onBattery: true, foreground: true });
});

// --- output forwarding -----------------------------------------------------------------------------

test('host stdout and stderr lines are forwarded with a [similarity] prefix, at most 200 per minute', async t => {
    const lines = [];
    const sink = { log: line => lines.push(['log', line]), warn: line => lines.push(['warn', line]), error: line => lines.push(['error', line]) };
    const ctx = makeService(t, { behaviour: { streams: true }, console: sink });
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    host.stdout.emit('data', Buffer.from('first line\r\nsecond '));
    host.stdout.emit('data', Buffer.from('half\n'));
    host.stderr.emit('data', 'oops\n');
    assert.deepEqual(lines, [['log', '[similarity] first line'], ['log', '[similarity] second half'], ['warn', '[similarity] oops']]);
    lines.length = 0;
    host.stdout.emit('data', Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n') + '\n');
    assert.equal(lines.length, 197, '200 per minute in total');
    await ctx.clock.advance(MIN);
    host.stdout.emit('data', 'after\n');
    assert.deepEqual(lines.slice(-2), [['warn', '[similarity] 53 lines suppressed'], ['log', '[similarity] after']]);
});

// --- close ------------------------------------------------------------------------------------------

test('close() closes the host, removes every listener and leaves no timers', async t => {
    const ctx = makeService(t, { behaviour: { streams: true } });
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    await ctx.service.get({ preset: 'standard' });
    assert.ok(host.listenerCount() > 0);
    await ctx.service.close();
    assert.ok(host.last('close'));
    assert.equal(host.alive, false);
    assert.equal(host.killed, 0, 'it exited by itself');
    assert.equal(host.listenerCount(), 0);
    assert.equal(ctx.clock.pending(), 0);
    assert.equal(ctx.service.status().state, 'closed');
    // Later calls are safe and never start a host.
    assert.equal(ctx.service.syncRecords(library()).changed, 0);
    const snapshot = await ctx.service.get({ preset: 'standard' });
    assert.equal(snapshot.version, 3);
    await assert.rejects(ctx.service.override({ op: 'reset', key: 'a1' }), /closed/);
    ctx.service.setLoad({ saving: 1 });
    assert.equal(ctx.hosts.spawned.length, 1);
    assert.equal(ctx.service.close(), ctx.service.close(), 'idempotent');
});

test('close() is capped at 2 s: a host that never exits is killed', async t => {
    const ctx = makeService(t, { behaviour: { hang: ['close'] } });
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    let done = false;
    const closing = ctx.service.close().then(() => { done = true; });
    await ctx.clock.advance(SERVICE.closeMs - 1);
    assert.equal(done, false);
    await ctx.clock.advance(1);
    await closing;
    assert.equal(host.killed, 1);
    assert.equal(host.listenerCount(), 0);
    assert.equal(ctx.clock.pending(), 0);
});

test('close() during a restart backoff cancels the restart', async t => {
    const ctx = makeService(t);
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    host.exit(1);
    await settle();
    assert.equal(ctx.clock.pending(), 1, 'the backoff timer');
    await ctx.service.close();
    assert.equal(ctx.clock.pending(), 0);
    await ctx.clock.advance(MIN);
    assert.equal(ctx.hosts.spawned.length, 1);
});

// --- performance ------------------------------------------------------------------------------------

test('syncRecords and the provisional fallback stay cheap on main at 20k records', async t => {
    const ctx = makeService(t, { behaviour: { hang: ['init'] } });
    const records = [];
    for (let i = 0; i < 20000; i++) {
        records.push(record(`r${i}`, i % 7 === 0 ? '' : `synthetic prompt family ${Math.floor(i / 3)}`, T0 - i * SEC));
    }
    ctx.service.syncRecords(records);
    const copy = records.map(entry => ({ ...entry }));
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
        const started = process.hrtime.bigint();
        ctx.service.syncRecords(copy);
        best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }
    assert.ok(best < 60, `unchanged 20k sync took ${best.toFixed(1)} ms`);
    await ctx.service.get({});
    const started = process.hrtime.bigint();
    const snapshot = await ctx.service.get({ preset: 'loose' });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 30, `cached fallback get took ${ms.toFixed(1)} ms`);
    assert.equal(snapshot.total, 20000);
    assert.ok(snapshot.groups.length > 5000);
});

// --- integration: the real host through a child_process adapter (h mode) ------------------------------

function childProcessSpawner(env, children) {
    return ({ hostPath }) => {
        const inherited = { ...process.env };
        delete inherited.PICGEN_SIMILARITY_ORT;
        delete inherited.PICGEN_SIMILARITY_TEST_HOOKS;
        const child = fork(hostPath, [], {
            serialization: 'advanced',
            env: { ...inherited, ...env },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        });
        children.push(child);
        return {
            get pid() { return child.pid; },
            stdout: child.stdout,
            stderr: child.stderr,
            postMessage(message) { child.send(message); },
            on(event, listener) { child.on(event, listener); return this; },
            off(event, listener) { child.off(event, listener); return this; },
            kill() { return child.kill(); }
        };
    };
}

async function fixtureLibrary(t) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'picgen-sim-service-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const images = path.join(root, 'images');
    await fsp.mkdir(images, { recursive: true });
    await fsp.mkdir(path.join(root, 'thumbnails'), { recursive: true });
    const sharp = require('sharp');
    const picture = (background, accent) => sharp({ create: { width: 96, height: 64, channels: 3, background } })
        .composite([{ input: { create: { width: 30, height: 20, channels: 3, background: accent } }, top: 22, left: 33 }])
        .png();
    const now = Date.now();
    const records = [];
    const add = async (name, prompt, image, age) => {
        const filePath = path.join(images, name);
        await image.toFile(filePath);
        const stat = await fsp.stat(filePath);
        records.push({ id: `task_${name}`, filePath, fileName: name, fileSize: stat.size, createdAt: now - age, prompt, ratio: '3:2' });
    };
    for (let i = 0; i < 4; i++) {
        await add(`same-${i}.png`, 'synthetic lighthouse service prompt', picture({ r: 200, g: 60, b: 40 }, { r: 250, g: 240, b: 230 }), (8 - i) * 1000);
    }
    const others = [
        [{ r: 30, g: 60, b: 200 }, { r: 10, g: 10, b: 10 }],
        [{ r: 40, g: 180, b: 60 }, { r: 250, g: 250, b: 250 }],
        [{ r: 230, g: 210, b: 40 }, { r: 90, g: 20, b: 120 }],
        [{ r: 120, g: 40, b: 160 }, { r: 20, g: 200, b: 200 }]
    ];
    for (let i = 0; i < others.length; i++) {
        await add(`other-${i}.png`, `unrelated synthetic service prompt ${i} ${'xyzw'[i].repeat(6)}`, picture(...others[i]), (4 - i) * 1000);
    }
    return { root, images, records, sameKeys: records.slice(0, 4).map(entry => entry.id) };
}

async function waitFor(fn, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

test('integration: the real host in h mode, a crash restart, and a clean close', { timeout: 120000 }, async t => {
    const lib = await fixtureLibrary(t);
    const children = [];
    t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const pushes = [];
    const service = createSimilarityService({
        hostPath: HOST,
        spawnHost: childProcessSpawner({ PICGEN_SIMILARITY_ORT: 'off', PICGEN_SIMILARITY_TEST_HOOKS: '1' }, children),
        storeDir: path.join(lib.root, 'similarity'),
        thumbnailsDir: path.join(lib.root, 'thumbnails'),
        scanDirs: [lib.images],
        modelPath: path.join(lib.root, 'no-model.onnx'),
        ortEnabled: false,
        onPush: push => pushes.push(push),
        log: () => {},
        console: { log() {}, warn() {}, error() {} },
        backfillAt: 0
    });
    t.after(() => service.close());

    service.syncRecords(lib.records);
    const provisional = await service.get({ preset: 'standard', foreground: true });
    assert.equal(provisional.stage, 'provisional');
    assert.equal(provisional.groups.length, 1);
    assert.equal(provisional.groups[0].provisional, true);
    assert.equal(provisional.groups[0].id, anchorId(lib.sameKeys[0]));

    const final = await waitFor(async () => {
        const snapshot = await service.get({ preset: 'standard', foreground: true });
        return snapshot.stage === 'final' ? snapshot : null;
    }, 60000, 'stage final');
    assert.equal(final.mode, 'h');
    assert.equal(final.modeReason, 'disabled');
    assert.equal(final.total, 8);
    assert.equal(final.groups.length, 1);
    assert.deepEqual([...final.groups[0].members].sort(), [...lib.sameKeys].sort());
    assert.ok(final.revision > provisional.revision);
    assert.ok(pushes.length > 0, 'notices were relayed');

    const neighbours = await service.neighbors({ key: lib.sameKeys[0], preset: 'standard', limit: 10 });
    assert.equal(neighbours.analyzed, true);
    assert.deepEqual(neighbours.items.map(item => item.key).sort(), lib.sameKeys.slice(1).sort());
    const hostStatus = await service.hostStatus();
    assert.equal(hostStatus.pid, children[0].pid);

    // A crash of the real host: the last snapshot is served meanwhile and a new host takes over.
    const firstChild = children[0];
    const firstExit = new Promise(resolve => firstChild.once('exit', code => resolve(code)));
    firstChild.send({ type: '__crash' });
    assert.equal(await firstExit, 3);
    const meanwhile = await service.get({ preset: 'standard' });
    assert.equal(meanwhile.groups.length, 1);
    assert.ok(meanwhile.error);
    const recovered = await waitFor(async () => {
        const snapshot = await service.get({ preset: 'standard', foreground: true });
        return children.length === 2 && snapshot.stage === 'final' && !snapshot.error ? snapshot : null;
    }, 60000, 'the restarted host');
    assert.deepEqual([...recovered.groups[0].members].sort(), [...lib.sameKeys].sort());
    assert.ok(recovered.revision > meanwhile.revision);

    const secondChild = children[1];
    const secondExit = new Promise(resolve => secondChild.once('exit', code => resolve(code)));
    await service.close();
    assert.equal(await secondExit, 0);
    assert.equal(secondChild.listenerCount('message'), 0);
    assert.ok(fs.existsSync(path.join(lib.root, 'similarity', 'manifest-v3.json')));
});

test('以图搜图 forwards the path to the host, and has no fallback while the host is not ready', async t => {
    const ctx = makeService(t);
    ctx.service.syncRecords(library());
    const host = await ready(ctx);
    const result = await ctx.service.neighborsOfImage({ path: 'C:\Downloads\query.png', limit: 5 });
    assert.deepEqual(result.items.map(item => item.key), ['a1']);
    const sent = host.last('neighbors-image');
    assert.deepEqual({ path: sent.path, limit: sent.limit }, { path: 'C:\Downloads\query.png', limit: 5 });
    assert.equal((await ctx.service.neighborsOfImage({ path: 'C:\q.png' }), host.last('neighbors-image').limit), 60, 'default limit');
    await assert.rejects(ctx.service.neighborsOfImage({}), /needs a path/);
    await assert.rejects(ctx.service.neighborsOfImage(null), /needs a path/);

    const cold = makeService(t, { behaviour: { hang: ['init'] } });
    cold.service.syncRecords(library());
    const early = await cold.service.neighborsOfImage({ path: 'C:\q.png' });
    assert.equal(early.analyzed, false);
    assert.deepEqual(early.items, []);
    assert.match(early.error, /尚未就绪/);
});
