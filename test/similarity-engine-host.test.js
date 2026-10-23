const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

// Runs the real host file under child_process.fork (the transport npm test uses; Electron uses
// utilityProcess with the same protocol). Synthetic PNGs only, in a temp directory.

const HOST = path.join(__dirname, '..', 'similarity-engine-host.js');
const MODEL = path.join(__dirname, '..', 'models', 'dinov2-small-q8.onnx');
const HAS_MODEL = fs.existsSync(MODEL);

function startHost(env = {}) {
    const inherited = { ...process.env };
    delete inherited.PICGEN_SIMILARITY_ORT;
    delete inherited.PICGEN_SIMILARITY_TEST_HOOKS;
    const child = fork(HOST, [], {
        serialization: 'advanced',
        env: { ...inherited, ...env },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', () => {});
    let nextId = 1;
    const pending = new Map();
    const events = [];
    child.on('message', message => {
        if (message && message.id !== undefined && pending.has(message.id)) {
            const request = pending.get(message.id);
            pending.delete(message.id);
            if (message.ok) request.resolve(message.result);
            else request.reject(new Error(message.error));
            return;
        }
        events.push(message);
    });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    return {
        child,
        events,
        exited,
        stderr: () => stderr,
        request(message, timeoutMs = 20000) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`host did not answer ${message.type} in ${timeoutMs} ms; stderr: ${stderr}`));
                }, timeoutMs);
                pending.set(id, {
                    resolve: value => { clearTimeout(timer); resolve(value); },
                    reject: error => { clearTimeout(timer); reject(error); }
                });
                child.send({ id, ...message });
            });
        },
        send(message) { child.send(message); },
        kill() { if (child.exitCode === null && child.signalCode === null) child.kill(); }
    };
}

async function fixtureLibrary(t) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'picgen-sim-host-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const images = path.join(root, 'images');
    const thumbnails = path.join(root, 'thumbnails');
    const storeDir = path.join(root, 'similarity');
    await fsp.mkdir(images, { recursive: true });
    await fsp.mkdir(thumbnails, { recursive: true });
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
        records.push({ key: `task_${name}`, filePath, fileName: name, fileSize: stat.size, createdAt: now - age, prompt });
    };
    // One request rendered four times (identical pixels), plus four unrelated images.
    for (let i = 0; i < 4; i++) {
        await add(`same-${i}.png`, 'synthetic lighthouse test prompt', picture({ r: 200, g: 60, b: 40 }, { r: 250, g: 240, b: 230 }), (8 - i) * 1000);
    }
    const others = [
        [{ r: 30, g: 60, b: 200 }, { r: 10, g: 10, b: 10 }],
        [{ r: 40, g: 180, b: 60 }, { r: 250, g: 250, b: 250 }],
        [{ r: 230, g: 210, b: 40 }, { r: 90, g: 20, b: 120 }],
        [{ r: 120, g: 40, b: 160 }, { r: 20, g: 200, b: 200 }]
    ];
    for (let i = 0; i < others.length; i++) {
        await add(`other-${i}.png`, `unrelated synthetic prompt ${i} ${'xyzw'[i].repeat(6)}`, picture(...others[i]), (4 - i) * 1000);
    }
    return { root, images, thumbnails, storeDir, records, sameKeys: records.slice(0, 4).map(record => record.key) };
}

async function waitFinal(host, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const snapshot = await host.request({ type: 'get', preset: 'standard', foreground: true });
        if (snapshot.stage === 'final') return snapshot;
        if (Date.now() > deadline) throw new Error(`stage stayed ${snapshot.stage}: ${JSON.stringify({ pending: snapshot.pending, analyzed: snapshot.analyzed })}`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

function initMessage(lib, extra = {}) {
    return {
        type: 'init',
        storeDir: lib.storeDir,
        thumbnailsDir: lib.thumbnails,
        scanDirs: [lib.images],
        modelPath: MODEL,
        ort: true,
        threads: 2,
        ...extra
    };
}

test('host (h mode): init → records → final groups → close exits 0', { timeout: 90000 }, async t => {
    const lib = await fixtureLibrary(t);
    const host = startHost({ PICGEN_SIMILARITY_ORT: 'off', PICGEN_SIMILARITY_TEST_HOOKS: '1' });
    t.after(() => host.kill());

    await assert.rejects(host.request({ type: 'get', preset: 'standard' }), /not initiali[sz]ed/);
    const info = await host.request(initMessage(lib));
    assert.equal(info.mode, 'h');
    assert.equal(info.modeReason, 'disabled');
    assert.ok(host.events.some(event => event.type === 'mode' && event.mode === 'h' && event.reason === 'disabled'));

    const synced = await host.request({ type: 'records', full: lib.records });
    assert.equal(synced.total, 8);
    const snapshot = await waitFinal(host);
    assert.equal(snapshot.mode, 'h');
    assert.equal(snapshot.total, 8);
    assert.equal(snapshot.analyzed, 8);
    assert.equal(snapshot.groups.length, 1);
    assert.deepEqual([...snapshot.groups[0].members].sort(), [...lib.sameKeys].sort());
    assert.equal(snapshot.singles.length, 4);
    assert.ok(host.events.some(event => event.type === 'notice' && typeof event.revision === 'number'));

    const neighbours = await host.request({ type: 'neighbors', key: lib.sameKeys[0], preset: 'standard', mode: 'combined', limit: 10 });
    assert.equal(neighbours.analyzed, true);
    assert.deepEqual(neighbours.items.map(item => item.key).sort(), lib.sameKeys.slice(1).sort());

    host.send({ type: 'load', saving: 0, onBattery: false });
    const status = await host.request({ type: 'status' });
    assert.equal(status.mode, 'h');
    assert.equal(status.pid, host.child.pid);
    assert.ok(status.rssMb > 0);
    // SIMD 关闭：libvips 的 SIMD 横向缩小在 Electron utility 进程里会 0xC0000005 崩溃
    assert.equal(status.simd, false);

    await host.request({ type: 'close' });
    const { code } = await host.exited;
    assert.equal(code, 0, host.stderr());
    assert.ok(fs.existsSync(path.join(lib.storeDir, 'manifest-v3.json')));
    assert.ok(fs.existsSync(path.join(lib.storeDir, 'groups-v3.json')));
});

test('host: the __crash test hook exits with code 3', { timeout: 30000 }, async t => {
    const host = startHost({ PICGEN_SIMILARITY_ORT: 'off', PICGEN_SIMILARITY_TEST_HOOKS: '1' });
    t.after(() => host.kill());
    host.send({ type: '__crash' });
    const { code } = await host.exited;
    assert.equal(code, 3);
});

test('host: test hooks are ignored unless PICGEN_SIMILARITY_TEST_HOOKS=1', { timeout: 30000 }, async t => {
    const host = startHost({ PICGEN_SIMILARITY_ORT: 'off' });
    t.after(() => host.kill());
    host.send({ type: '__crash' });
    const status = await host.request({ type: 'status' });
    assert.equal(status.pid, host.child.pid, 'still alive');
    await host.request({ type: 'close' });
    assert.equal((await host.exited).code, 0);
});

test('host (hd mode): DINOv2 session, featureVersion ends in +ort1.24', {
    timeout: 120000,
    skip: HAS_MODEL ? false : 'models/dinov2-small-q8.onnx is absent (run `npm run fetch:models`)'
}, async t => {
    const lib = await fixtureLibrary(t);
    const host = startHost({ PICGEN_SIMILARITY_TEST_HOOKS: '1' });
    t.after(() => host.kill());
    const info = await host.request(initMessage(lib), 60000);
    assert.equal(info.mode, 'hd', JSON.stringify(info));
    assert.equal(info.modeReason, null);
    assert.match(info.ortVersion, /^1\.24\./);
    await host.request({ type: 'records', full: lib.records });
    const snapshot = await waitFinal(host, 90000);
    assert.equal(snapshot.mode, 'hd');
    assert.ok(snapshot.featureVersion.endsWith('+ort1.24'), snapshot.featureVersion);
    assert.equal(snapshot.stats.embedded, 8);
    const group = snapshot.groups.find(entry => entry.members.length === 4);
    assert.ok(group, JSON.stringify(snapshot.groups));
    assert.deepEqual([...group.members].sort(), [...lib.sameKeys].sort());
    await host.request({ type: 'close' }, 30000);
    assert.equal((await host.exited).code, 0, host.stderr());
});
