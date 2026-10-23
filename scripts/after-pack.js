// electron-builder afterPack hook: runs on the unpacked app dir before the portable target
// compresses it. Places the VC++ runtime next to onnxruntime_binding.node and fails the build
// if the ORT binaries, the DirectML exclusions or the bundled model are not as expected.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { VC_RUNTIME_DLLS, findVcRuntime } = require('./vc-runtime');
const { MODELS } = require('./fetch-models');

const ORT_BIN = Object.freeze(['node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64']);

async function sha256File(file) {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex');
}

async function verifyPackedLayout({ appOutDir, models, vcRuntime, log = console.log }) {
    const resources = path.join(appOutDir, 'resources');
    const bin = path.join(resources, 'app.asar.unpacked', ...ORT_BIN);
    for (const name of ['onnxruntime.dll', 'onnxruntime_binding.node']) {
        if (!fs.existsSync(path.join(bin, name))) throw new Error(`afterPack: ${name} was not unpacked to ${bin}`);
    }
    const unexpected = fs.readdirSync(bin).filter(name => /^(DirectML|dxcompiler|dxil)\.dll$/i.test(name));
    if (unexpected.length) throw new Error(`afterPack: GPU-only DLLs leaked into the build: ${unexpected.join(', ')}`);

    for (const name of VC_RUNTIME_DLLS) fs.copyFileSync(path.join(vcRuntime.dir, name), path.join(bin, name));
    log(`  • VC++ runtime ${vcRuntime.version ? vcRuntime.version.join('.') : '(env)'} copied app-local from ${vcRuntime.dir}`);

    for (const model of models) {
        const file = path.join(resources, 'models', model.file);
        if (!fs.existsSync(file)) throw new Error(`afterPack: ${model.file} is missing from ${path.dirname(file)}`);
        const hash = await sha256File(file);
        if (hash !== model.sha256) throw new Error(`afterPack: ${model.file} sha256 ${hash} != pinned ${model.sha256}`);
    }
}

async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') return;
    await verifyPackedLayout({ appOutDir: context.appOutDir, models: MODELS, vcRuntime: findVcRuntime() });
}

exports.default = afterPack;
exports.verifyPackedLayout = verifyPackedLayout;
