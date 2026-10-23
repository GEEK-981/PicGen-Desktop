// Hermetic tests for the sha256-pinned model delivery (scripts/fetch-models.js) and the
// electron-builder afterPack layout check (scripts/after-pack.js, scripts/vc-runtime.js).
// Network: only a node:http server on 127.0.0.1; everything else lives in temp directories.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { MODELS, ensureModels } = require('../scripts/fetch-models');
const { VC_RUNTIME_DLLS, findVcRuntime } = require('../scripts/vc-runtime');
const afterPack = require('../scripts/after-pack');

const ORT_BIN = ['resources', 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64'];
const PAYLOAD = crypto.createHash('sha512').update('picgen-fake-model').digest();
const GOOD = Buffer.concat(Array.from({ length: 64 }, (_, i) => Buffer.concat([Buffer.from([i]), PAYLOAD.subarray(1)])));
const BAD = Buffer.from(GOOD).fill(0x5a, 100, 200);
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const FAKE = Object.freeze({
    name: 'TEST_FAKE',
    file: 'fake-model.onnx',
    repo: 'picgen/fake',
    revision: '0123456789abcdef0123456789abcdef01234567',
    path: 'onnx/model.onnx',
    size: GOOD.length,
    sha256: sha256(GOOD)
});
const ENV_OVERRIDE = `PICGEN_MODEL_FILE_${FAKE.name}`;
const quiet = () => {};

function tempDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function listRecursive(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive: true }).map(name => String(name));
}

// Serves `routes[<url path>]` bytes; counts requests and TCP connections.
async function startServer(t, routes) {
    const stats = { requests: [], connections: 0 };
    const server = http.createServer((req, res) => {
        stats.requests.push(req.url);
        const body = routes[req.url];
        if (!body) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
        res.end(body);
    });
    server.on('connection', () => { stats.connections += 1; });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    return { endpoint: `http://127.0.0.1:${server.address().port}`, stats };
}

async function closedEndpoint() {
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return `http://127.0.0.1:${port}`;
}

const modelUrl = model => `/${model.repo}/resolve/${model.revision}/${model.path}`;

function setup(t) {
    const root = tempDir(t, 'picgen-models-root-');
    const cache = tempDir(t, 'picgen-models-cache-');
    const previous = process.env[ENV_OVERRIDE];
    delete process.env[ENV_OVERRIDE];
    t.after(() => {
        if (previous === undefined) delete process.env[ENV_OVERRIDE];
        else process.env[ENV_OVERRIDE] = previous;
    });
    return {
        root,
        cache,
        target: path.join(root, 'models', FAKE.file),
        cached: path.join(cache, `${FAKE.sha256}.onnx`)
    };
}

test('the pinned DINOv2 model matches the plan', () => {
    assert.equal(MODELS.length, 1);
    const [model] = MODELS;
    assert.equal(model.name, 'DINOV2_SMALL_Q8');
    assert.equal(model.file, 'dinov2-small-q8.onnx');
    assert.equal(model.repo, 'Xenova/dinov2-small');
    assert.equal(model.revision, 'c2bb04a51fab207c420665f1946016107bffc701');
    assert.equal(model.path, 'onnx/model_quantized.onnx');
    assert.equal(model.size, 24451943);
    assert.equal(model.sha256, '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917');
});

test('a cold download writes the model and the cache; the next runs make no HTTP request', async t => {
    const { root, cache, target, cached } = setup(t);
    const { endpoint, stats } = await startServer(t, { [modelUrl(FAKE)]: GOOD });
    const options = { root, models: [FAKE], endpoints: [endpoint], cache, log: quiet };

    assert.deepEqual(await ensureModels(options), [{ file: target, source: 'cache' }]);
    assert.deepEqual(stats.requests, [modelUrl(FAKE)]);
    assert.ok(fs.readFileSync(target).equals(GOOD));
    assert.ok(fs.readFileSync(cached).equals(GOOD));

    assert.deepEqual(await ensureModels(options), [{ file: target, source: 'present' }]);
    fs.rmSync(target);
    assert.deepEqual(await ensureModels(options), [{ file: target, source: 'cache' }]);
    assert.ok(fs.readFileSync(target).equals(GOOD));
    assert.equal(stats.requests.length, 1);
    assert.equal(listRecursive(cache).some(name => name.endsWith('.part')), false);
});

test('the first endpoint failing falls through to the next mirror', async t => {
    const { root, cache, target } = setup(t);
    const broken = await startServer(t, {});
    const mirror = await startServer(t, { [modelUrl(FAKE)]: GOOD });
    const result = await ensureModels({ root, models: [FAKE], endpoints: [broken.endpoint, mirror.endpoint], cache, log: quiet });
    assert.deepEqual(result, [{ file: target, source: 'cache' }]);
    assert.equal(broken.stats.requests.length, 1);
    assert.equal(mirror.stats.requests.length, 1);
    assert.ok(fs.readFileSync(target).equals(GOOD));
});

test('a tampered cache file of the right size is replaced by a fresh download', async t => {
    const { root, cache, target, cached } = setup(t);
    fs.writeFileSync(cached, BAD);
    assert.equal(fs.statSync(cached).size, FAKE.size);
    const { endpoint, stats } = await startServer(t, { [modelUrl(FAKE)]: GOOD });
    assert.deepEqual(await ensureModels({ root, models: [FAKE], endpoints: [endpoint], cache, log: quiet }), [{ file: target, source: 'cache' }]);
    assert.equal(stats.requests.length, 1);
    assert.ok(fs.readFileSync(cached).equals(GOOD));
    assert.ok(fs.readFileSync(target).equals(GOOD));
});

test('a present but corrupt model file is replaced from the cache', async t => {
    const { root, cache, target, cached } = setup(t);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, BAD);
    fs.writeFileSync(cached, GOOD);
    const { endpoint, stats } = await startServer(t, {});
    assert.deepEqual(await ensureModels({ root, models: [FAKE], endpoints: [endpoint], cache, log: quiet }), [{ file: target, source: 'cache' }]);
    assert.equal(stats.connections, 0);
    assert.ok(fs.readFileSync(target).equals(GOOD));
});

test('a server returning wrong bytes fails with an integrity mismatch and leaves no partial file', async t => {
    const { root, cache, target, cached } = setup(t);
    const { endpoint, stats } = await startServer(t, { [modelUrl(FAKE)]: BAD });
    await assert.rejects(
        ensureModels({ root, models: [FAKE], endpoints: [endpoint], cache, log: quiet }),
        /integrity mismatch/
    );
    assert.equal(stats.requests.length, 1);
    assert.equal(fs.existsSync(cached), false);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(listRecursive(cache).filter(name => name.endsWith('.part')), []);
    assert.deepEqual(listRecursive(root).filter(name => name.endsWith('.part')), []);
});

test('a truncated download fails the integrity check too', async t => {
    const { root, cache, cached } = setup(t);
    const { endpoint } = await startServer(t, { [modelUrl(FAKE)]: GOOD.subarray(0, GOOD.length - 1) });
    await assert.rejects(ensureModels({ root, models: [FAKE], endpoints: [endpoint], cache, log: quiet }), /integrity mismatch/);
    assert.equal(fs.existsSync(cached), false);
    assert.deepEqual(listRecursive(cache).filter(name => name.endsWith('.part')), []);
});

test('all endpoints unreachable rejects and names every endpoint', async t => {
    const { root, cache, target } = setup(t);
    const first = await closedEndpoint();
    const missing = await startServer(t, {});
    await assert.rejects(
        ensureModels({ root, models: [FAKE], endpoints: [first, missing.endpoint], cache, log: quiet }),
        error => {
            assert.match(error.message, /Could not download fake-model\.onnx/);
            assert.ok(error.message.includes(first));
            assert.ok(error.message.includes(`${missing.endpoint}: HTTP 404`));
            return true;
        }
    );
    assert.equal(fs.existsSync(target), false);
});

test('check mode never opens a socket: rejects when missing, resolves when valid', async t => {
    const { root, cache, target, cached } = setup(t);
    fs.writeFileSync(cached, GOOD);
    const { endpoint, stats } = await startServer(t, { [modelUrl(FAKE)]: GOOD });
    const options = { root, check: true, models: [FAKE], endpoints: [endpoint], cache, log: quiet };
    await assert.rejects(ensureModels(options), /fake-model\.onnx missing or corrupt/);
    assert.equal(fs.existsSync(target), false, 'check mode must not copy from the cache');

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, BAD);
    await assert.rejects(ensureModels(options), /missing or corrupt/);

    fs.writeFileSync(target, GOOD);
    assert.deepEqual(await ensureModels(options), [{ file: target, source: 'present' }]);
    assert.equal(stats.connections, 0);
    assert.deepEqual(stats.requests, []);
});

test('PICGEN_MODEL_FILE_<NAME> is sha256-checked before it is used', async t => {
    const { root, cache, target, cached } = setup(t);
    const local = path.join(tempDir(t, 'picgen-models-local-'), 'model.onnx');
    const { endpoint, stats } = await startServer(t, { [modelUrl(FAKE)]: GOOD });
    const options = { root, models: [FAKE], endpoints: [endpoint], cache, log: quiet };

    fs.writeFileSync(local, BAD);
    process.env[ENV_OVERRIDE] = local;
    await assert.rejects(ensureModels(options), /does not match the pinned sha256/);
    assert.equal(fs.existsSync(target), false);

    process.env[ENV_OVERRIDE] = path.join(path.dirname(local), 'absent.onnx');
    await assert.rejects(ensureModels(options), /does not match the pinned sha256/);

    fs.writeFileSync(local, GOOD);
    process.env[ENV_OVERRIDE] = local;
    assert.deepEqual(await ensureModels(options), [{ file: target, source: 'env' }]);
    assert.ok(fs.readFileSync(target).equals(GOOD));
    assert.equal(fs.existsSync(cached), false);
    assert.equal(stats.connections, 0);
});

function withVcRuntimeEnv(t, value) {
    const previous = process.env.PICGEN_VCRUNTIME_DIR;
    process.env.PICGEN_VCRUNTIME_DIR = value;
    t.after(() => {
        if (previous === undefined) delete process.env.PICGEN_VCRUNTIME_DIR;
        else process.env.PICGEN_VCRUNTIME_DIR = previous;
    });
}

function fakeVcRuntime(t, names = VC_RUNTIME_DLLS) {
    const dir = tempDir(t, 'picgen-vcrt-');
    for (const name of names) fs.writeFileSync(path.join(dir, name), `fake ${name}`);
    return dir;
}

test('findVcRuntime honours PICGEN_VCRUNTIME_DIR with all four DLLs', t => {
    assert.deepEqual([...VC_RUNTIME_DLLS].sort(), ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']);
    const dir = fakeVcRuntime(t);
    withVcRuntimeEnv(t, dir);
    assert.deepEqual(findVcRuntime(), { dir, version: null, source: 'env' });
});

test('findVcRuntime throws when PICGEN_VCRUNTIME_DIR lacks a DLL', t => {
    const dir = fakeVcRuntime(t, VC_RUNTIME_DLLS.filter(name => name !== 'vcruntime140_1.dll'));
    withVcRuntimeEnv(t, dir);
    assert.throws(() => findVcRuntime(), /PICGEN_VCRUNTIME_DIR is missing one of/);
});

// A fake electron-builder appOutDir with the unpacked ORT binding and a bundled fake model.
function fakeAppOutDir(t, { binding = true, extra = [], model = GOOD } = {}) {
    const appOutDir = tempDir(t, 'picgen-afterpack-');
    const bin = path.join(appOutDir, ...ORT_BIN);
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'onnxruntime.dll'), 'fake ort');
    if (binding) fs.writeFileSync(path.join(bin, 'onnxruntime_binding.node'), 'fake binding');
    for (const name of extra) fs.writeFileSync(path.join(bin, name), 'gpu only');
    if (model) {
        fs.mkdirSync(path.join(appOutDir, 'resources', 'models'), { recursive: true });
        fs.writeFileSync(path.join(appOutDir, 'resources', 'models', FAKE.file), model);
    }
    return { appOutDir, bin };
}

test('verifyPackedLayout passes and copies the VC++ runtime next to the binding', async t => {
    const vcDir = fakeVcRuntime(t);
    const { appOutDir, bin } = fakeAppOutDir(t);
    await afterPack.verifyPackedLayout({ appOutDir, models: [FAKE], vcRuntime: { dir: vcDir, version: null, source: 'env' }, log: quiet });
    for (const name of VC_RUNTIME_DLLS) assert.equal(fs.readFileSync(path.join(bin, name), 'utf8'), `fake ${name}`);
});

test('verifyPackedLayout rejects a missing binding, leaked GPU DLLs and a wrong model', async t => {
    const vcRuntime = { dir: fakeVcRuntime(t), version: [14, 50, 35710], source: 'vswhere' };
    const run = options => afterPack.verifyPackedLayout({ models: [FAKE], vcRuntime, log: quiet, ...options });

    await assert.rejects(run({ appOutDir: fakeAppOutDir(t, { binding: false }).appOutDir }), /onnxruntime_binding\.node was not unpacked/);
    await assert.rejects(run({ appOutDir: fakeAppOutDir(t, { extra: ['DirectML.dll'] }).appOutDir }), /GPU-only DLLs leaked into the build: DirectML\.dll/);
    await assert.rejects(run({ appOutDir: fakeAppOutDir(t, { extra: ['dxil.dll'] }).appOutDir }), /dxil\.dll/);
    await assert.rejects(run({ appOutDir: fakeAppOutDir(t, { model: BAD }).appOutDir }), /fake-model\.onnx sha256 [0-9a-f]{64} != pinned/);
    await assert.rejects(run({ appOutDir: fakeAppOutDir(t, { model: null }).appOutDir }), /fake-model\.onnx is missing/);
});

test('the afterPack default export skips non-Windows targets and checks Windows ones', async t => {
    assert.equal(typeof afterPack.default, 'function');
    await afterPack.default({ electronPlatformName: 'linux', appOutDir: path.join(os.tmpdir(), 'picgen-never-created') });
    const { appOutDir } = fakeAppOutDir(t, { binding: false });
    withVcRuntimeEnv(t, fakeVcRuntime(t));
    await assert.rejects(afterPack.default({ electronPlatformName: 'win32', appOutDir }), /onnxruntime_binding\.node was not unpacked/);
});
