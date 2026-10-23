// Fetches bundled ML models into <root>/models (gitignored), pinned by revision + sha256 and cached
// per user so clones / `git clean` do not download again.
//   node scripts/fetch-models.js             ensure models are present (download if needed)
//   node scripts/fetch-models.js --check     verify only, never touch the network (exit 1 if missing)
//   node scripts/fetch-models.js --optional  like the default, but a failed download only warns
// Env: PICGEN_HF_ENDPOINTS (comma-separated mirrors, default hf-mirror.com,huggingface.co),
//      PICGEN_MODEL_CACHE (cache dir),
//      PICGEN_MODEL_FILE_<NAME> (use a local file instead of downloading; still sha256-checked).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MODELS = Object.freeze([Object.freeze({
    name: 'DINOV2_SMALL_Q8',
    file: 'dinov2-small-q8.onnx',
    repo: 'Xenova/dinov2-small',
    revision: 'c2bb04a51fab207c420665f1946016107bffc701',
    path: 'onnx/model_quantized.onnx',
    size: 24451943,
    sha256: '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917',
    license: 'Apache-2.0 (weights of facebook/dinov2-small, ONNX export by Xenova)'
})]);
const ENDPOINTS = Object.freeze((process.env.PICGEN_HF_ENDPOINTS || 'https://hf-mirror.com,https://huggingface.co')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean));
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

function cacheDir() {
    return process.env.PICGEN_MODEL_CACHE
        || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'PicGen-build-cache', 'models');
}

async function sha256File(file) {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex');
}

async function valid(file, model) {
    try {
        if (fs.statSync(file).size !== model.size) return false;
        return (await sha256File(file)) === model.sha256;
    } catch {
        return false;
    }
}

async function download(model, destination, { endpoints, log }) {
    // In-place progress only makes sense on a terminal; the summary line always goes to `log`.
    const tty = Boolean(process.stdout.isTTY);
    const errors = [];
    for (const endpoint of endpoints) {
        const url = `${endpoint}/${model.repo}/resolve/${model.revision}/${model.path}`;
        const partial = `${destination}.${process.pid}.part`;
        try {
            const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw new Error(`HTTP ${response.status}`);
            }
            const hash = crypto.createHash('sha256');
            let bytes = 0;
            let lastLog = 0;
            const started = Date.now();
            const body = Readable.fromWeb(response.body);
            body.on('data', chunk => {
                hash.update(chunk);
                bytes += chunk.length;
                if (tty && Date.now() - lastLog > 2000) {
                    lastLog = Date.now();
                    process.stdout.write(`\r  ${model.file}: ${(bytes / 1048576).toFixed(1)}/${(model.size / 1048576).toFixed(1)} MB`);
                }
            });
            await pipeline(body, fs.createWriteStream(partial));
            const digest = hash.digest('hex');
            if (tty) process.stdout.write('\r');
            log(`  ${model.file}: ${(bytes / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s from ${endpoint}`);
            if (bytes !== model.size || digest !== model.sha256) throw new Error(`integrity mismatch (size ${bytes}, sha256 ${digest})`);
            fs.renameSync(partial, destination);
            return;
        } catch (error) {
            fs.rmSync(partial, { force: true });
            errors.push(`${endpoint}: ${error.message}`);
        }
    }
    throw new Error(`Could not download ${model.file}:\n  ${errors.join('\n  ')}`);
}

async function ensureModels({
    root = path.resolve(__dirname, '..'),
    check = false,
    models = MODELS,
    endpoints = ENDPOINTS,
    cache = cacheDir(),
    log = console.log
} = {}) {
    const outDir = path.join(root, 'models');
    fs.mkdirSync(outDir, { recursive: true });
    const results = [];
    for (const model of models) {
        const target = path.join(outDir, model.file);
        if (await valid(target, model)) { results.push({ file: target, source: 'present' }); continue; }
        if (check) throw new Error(`${model.file} missing or corrupt; run: node scripts/fetch-models.js`);
        const cached = path.join(cache, `${model.sha256}.onnx`);
        const local = process.env[`PICGEN_MODEL_FILE_${model.name}`];
        if (local) {
            if (!(await valid(local, model))) throw new Error(`${local} does not match the pinned sha256 of ${model.file}`);
            fs.copyFileSync(local, target);
            results.push({ file: target, source: 'env' });
            continue;
        }
        if (!(await valid(cached, model))) {
            fs.mkdirSync(path.dirname(cached), { recursive: true });
            await download(model, cached, { endpoints, log });
        }
        fs.copyFileSync(cached, target);
        results.push({ file: target, source: 'cache' });
    }
    return results;
}

module.exports = { MODELS, ENDPOINTS, cacheDir, ensureModels };

if (require.main === module) {
    // --optional (dev start): warn and continue; the app must run without the model (visual term off).
    const optional = process.argv.includes('--optional');
    ensureModels({ check: process.argv.includes('--check') })
        .then(results => { for (const r of results) console.log(`model ok (${r.source}): ${r.file}`); })
        .catch(error => {
            console.error(`${optional ? 'warning' : 'error'}: ${error.message}`);
            if (!optional) process.exitCode = 1;
        });
}
