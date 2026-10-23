// Usage: node scripts/performance-benchmark.js [module-directory] [report-label]
// Synthetic only: two loopback HTTP providers and JSON payload serialization.
// Never loads server.js, .env, saved providers, or a live provider.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TASKS = 20;
const CAPACITY = 2;
const DELAYS = [20, 25, 30, 35, 40];
const HARD_TIMEOUT_MS = 10000;
const WORKER_TIMEOUT_MS = 9000;
const ROUNDS = 3;
const MODEL = 'benchmark-image';
const round = value => Math.round(value * 1000) / 1000;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function sourceEvidence(moduleDir) {
    const evidence = { moduleDirectory: moduleDir, node: process.version, platform: process.platform, architecture: process.arch };
    evidence.version = JSON.parse(fs.readFileSync(path.join(moduleDir, 'package.json'), 'utf8')).version;
    const files = ['providerManager.js', 'taskQueue.js', 'apiService.js', 'protocolRouter.js', 'package.json', 'package-lock.json'];
    evidence.sha256 = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(moduleDir, file))).digest('hex')]));
    evidence.harnessSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
    try {
        evidence.gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: moduleDir, encoding: 'utf8', windowsHide: true }).trim();
        evidence.trackedChanges = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: moduleDir, encoding: 'utf8', windowsHide: true }).trim();
    } catch {
        evidence.gitCommit = null;
        evidence.trackedChanges = 'Unavailable (e.g. extracted release modules).';
    }
    return evidence;
}

function isolatedEnvironment(scratch) {
    const env = {};
    // An allowlist excludes real API credentials, proxy settings, and NODE_OPTIONS.
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG']) {
        if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
        TEMP: scratch, TMP: scratch, HOME: scratch, USERPROFILE: scratch,
        PICGEN_PROVIDER_STORE: path.join(scratch, 'providers.json'),
        PICGEN_CHAT_PROVIDER_STORE: path.join(scratch, 'chat-providers.json'),
        PICGEN_FAILOVER_CONFIG: path.join(scratch, 'failover.json'),
        PICGEN_PROXY_CONFIG: path.join(scratch, 'proxy.json')
    });
    return env;
}

async function throughputWorker(moduleDir) {
    // Logging is deliberately excluded from both versions' measured work.
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
    const ProviderManager = require(path.join(moduleDir, 'providerManager.js'));
    const TaskQueue = require(path.join(moduleDir, 'taskQueue.js'));
    const providers = ['a', 'b'].map(id => ({ id, active: 0, peak: 0, requests: 0, responses: 0, busyMs: 0, idleMs: 0 }));
    const servers = [];
    const failures = [];
    let startedAt = 0;
    let lastAt = 0;
    let busySlotMs = 0;
    let idleOpportunitySlotMs = 0;
    let anyIdleOpportunityMs = 0;
    let peak = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let finishing = false;
    let manager;
    let queue;
    let timeout;
    let heartbeat;
    const activeCount = () => providers.reduce((sum, item) => sum + item.active, 0);

    function integrate() {
        if (!startedAt) return;
        const now = performance.now();
        const dt = now - lastAt;
        const active = activeCount();
        const outstanding = TASKS - completed - failed - cancelled;
        const potentialWaiting = Math.max(0, outstanding - active);
        const idleOpportunity = Math.min(Math.max(0, CAPACITY - active), potentialWaiting);
        busySlotMs += active * dt;
        idleOpportunitySlotMs += idleOpportunity * dt;
        if (idleOpportunity > 0) anyIdleOpportunityMs += dt;
        for (const provider of providers) {
            provider.busyMs += provider.active * dt;
            if (!provider.active && potentialWaiting > 0) provider.idleMs += dt;
        }
        lastAt = now;
    }

    function snapshot(status, reason) {
        integrate();
        const elapsedMs = startedAt ? performance.now() - startedAt : 0;
        return {
            status, reason, elapsedMs: round(elapsedMs), completed, failed, cancelled,
            unfinished: TASKS - completed - failed - cancelled,
            throughputTasksPerSecond: elapsedMs ? round(completed * 1000 / elapsedMs) : 0,
            actualHttpPeak: peak, configuredCapacity: CAPACITY,
            busySlotMs: round(busySlotMs),
            idleOpportunitySlotMs: round(idleOpportunitySlotMs),
            anyIdleOpportunityMs: round(anyIdleOpportunityMs),
            httpCapacityUtilization: elapsedMs ? round(busySlotMs / (CAPACITY * elapsedMs)) : 0,
            providers: providers.map(item => ({ ...item, busyMs: round(item.busyMs), idleMs: round(item.idleMs) })),
            failures
        };
    }

    function send(message, callback) {
        if (process.connected) process.send(message, callback);
        else if (callback) callback();
    }

    function finish(status, reason) {
        if (finishing) return;
        finishing = true;
        clearTimeout(timeout);
        clearInterval(heartbeat);
        const result = snapshot(status, reason);
        // Capture evidence before cancelling remaining synthetic tasks.
        if (queue && status !== 'complete') {
            for (const task of queue.listTasks()) queue.cancel(task.id);
        }
        if (manager) manager.close();
        for (const server of servers) {
            server.close();
            server.closeAllConnections?.();
        }
        send({ type: 'result', result }, () => process.exit(0));
    }

    for (const provider of providers) {
        const server = http.createServer((request, response) => {
            if (request.method !== 'POST' || request.url !== '/v1/images/generations') {
                response.writeHead(400).end('{}');
                return;
            }
            let body = '';
            request.setEncoding('utf8');
            request.on('data', chunk => { body += chunk; });
            request.on('end', () => {
                let index;
                try { index = Number(JSON.parse(body).prompt.match(/task-(\d+)/)[1]); }
                catch { response.writeHead(400).end('{}'); return; }
                integrate();
                provider.active += 1;
                provider.requests += 1;
                provider.peak = Math.max(provider.peak, provider.active);
                peak = Math.max(peak, activeCount());
                let ended = false;
                const endedRequest = () => {
                    if (ended) return;
                    ended = true;
                    integrate();
                    provider.active -= 1;
                    if (response.writableFinished) provider.responses += 1;
                };
                response.once('finish', endedRequest);
                response.once('close', endedRequest);
                setTimeout(() => {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ data: [{ b64_json: 'YWJj', mime_type: 'image/png' }] }));
                }, DELAYS[index % DELAYS.length]);
            });
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        servers.push(server);
    }

    manager = new ProviderManager({ strategy: 'balanced', enableFailover: false, respectPriority: false });
    manager.syncProviders(providers.map((provider, index) => ({
        id: provider.id, name: `Mock ${provider.id.toUpperCase()}`,
        baseUrl: `http://127.0.0.1:${servers[index].address().port}`,
        apiKey: 'local-fixture', models: [MODEL], enabled: true,
        maxConcurrent: 1, priority: 1, weight: 100,
        modelRouting: { [MODEL]: { protocol: 'openai-images' } }
    })));
    queue = new TaskQueue({
        providerManager: manager, maxConcurrentPerSequence: TASKS, maxGlobalConcurrent: TASKS,
        resultStore: async (_task, result) => ({ base64: result.base64, mimeType: result.mimeType }),
        onTaskEvent(type, data) {
            if (finishing) return;
            if (!['task:completed', 'task:failed', 'task:cancelled'].includes(type)) return;
            integrate();
            if (type === 'task:completed') completed += 1;
            if (type === 'task:cancelled') cancelled += 1;
            if (type === 'task:failed') {
                failed += 1;
                failures.push({ taskId: data.id, error: String(data.error || 'unknown').slice(0, 500) });
            }
            if (completed + failed + cancelled === TASKS) {
                setImmediate(() => finish(completed === TASKS ? 'complete' : 'incomplete', completed === TASKS ? 'All mock tasks completed.' : 'One or more mock tasks failed or were cancelled.'));
            }
        }
    });
    // No polling getStatus(): released versions can mutate their limiter there.
    startedAt = performance.now();
    lastAt = startedAt;
    timeout = setTimeout(() => finish('incomplete', `Worker deadline ${WORKER_TIMEOUT_MS} ms reached.`), WORKER_TIMEOUT_MS);
    heartbeat = setInterval(() => send({ type: 'progress', result: snapshot('running', 'Synthetic tasks in progress.') }), 250);
    for (let index = 0; index < TASKS; index += 1) {
        queue.enqueue({ sequenceId: 'benchmark', model: MODEL, prompt: `synthetic benchmark task-${index}`, operation: 'generate', ratio: '1:1', imageSize: '1K' });
    }
}

function runThroughput(moduleDir) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-benchmark-'));
    return new Promise(resolve => {
        let finalResult;
        let latest;
        let hardTimedOut = false;
        const worker = spawn(process.execPath, [__filename, '--worker', moduleDir], {
            cwd: scratch, env: isolatedEnvironment(scratch), windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc']
        });
        const deadline = setTimeout(() => {
            hardTimedOut = true;
            worker.kill();
        }, HARD_TIMEOUT_MS);
        worker.on('message', message => {
            if (message.type === 'progress') latest = message.result;
            if (message.type === 'result') finalResult = message.result;
        });
        worker.on('error', error => { finalResult = { status: 'incomplete', reason: `Worker launch failed: ${error.code || 'unknown'}` }; });
        worker.on('close', (exitCode, signal) => {
            clearTimeout(deadline);
            resolve({
                ...(finalResult || latest || { completed: 0, failed: 0, unfinished: TASKS }),
                ...(!finalResult || hardTimedOut ? { status: 'incomplete', reason: hardTimedOut ? `Parent hard deadline ${HARD_TIMEOUT_MS} ms reached; worker terminated.` : 'Worker exited without final measurements.' } : {}),
                workerExitCode: exitCode, workerSignal: signal,
                isolatedTemporaryDirectory: scratch
            });
        });
    });
}

function serializationBenchmark() {
    const rawBytes = 10 * 1024 * 1024;
    const reference = { base64: Buffer.alloc(rawBytes, 0x61).toString('base64'), mimeType: 'image/png' };
    const common = {
        sequenceId: 'benchmark', sequenceName: 'Benchmark', batchId: 'benchmark-batch', batchTotal: TASKS, batchIndex: 0,
        providerId: 'a', providerName: 'Mock A', model: MODEL, prompt: 'synthetic reference batch', ratio: '1:1', imageSize: '1K',
        referenceImages: [reference], generationConfig: { stream: false, disableStream: true }
    };
    function measure(batch) {
        let stringifyMs = 0;
        let byteCountMs = 0;
        let bytes = 0;
        const calls = batch ? 1 : TASKS;
        for (let index = 0; index < calls; index += 1) {
            const payload = batch ? { count: TASKS, ...common } : { ...common, batchIndex: index };
            const begin = performance.now();
            const json = JSON.stringify(payload);
            const serializedAt = performance.now();
            bytes += Buffer.byteLength(json, 'utf8');
            const countedAt = performance.now();
            stringifyMs += serializedAt - begin;
            byteCountMs += countedAt - serializedAt;
        }
        return { stringifyCalls: calls, bytes, stringifyMs: round(stringifyMs), byteCountMs: round(byteCountMs) };
    }
    JSON.stringify({ warmup: 'x'.repeat(1024) });
    const rounds = [];
    for (let index = 0; index < ROUNDS; index += 1) {
        // Alternate order to limit a consistent warm-cache / GC ordering bias.
        const order = index % 2 ? ['batch', 'individual'] : ['individual', 'batch'];
        const result = { order };
        for (const name of order) result[name] = measure(name === 'batch');
        rounds.push(result);
    }
    const individualMs = median(rounds.map(item => item.individual.stringifyMs));
    const batchMs = median(rounds.map(item => item.batch.stringifyMs));
    return {
        synthetic: true, rawReferenceBytes: rawBytes, referenceBase64Characters: reference.base64.length,
        tasks: TASKS, rounds,
        medianStringifyMs: { individual: individualMs, batch: batchMs },
        serializedBytes: { individual: rounds[0].individual.bytes, batch: rounds[0].batch.bytes },
        byteReductionFraction: round(1 - rounds[0].batch.bytes / rounds[0].individual.bytes),
        medianStringifyRatio: batchMs ? round(individualMs / batchMs) : null,
        limitations: 'Payload simulation only, not an HTTP endpoint test. 10 MiB raw binary becomes ~13.33 MiB base64. Timing excludes fixture creation and UTF-8 byte counting; garbage collection may occur. No claim about real upstream generation speed or measured memory savings.'
    };
}

async function main() {
    const moduleDir = path.resolve(process.argv[2] || ROOT);
    const evidence = sourceEvidence(moduleDir);
    const label = String(process.argv[3] || evidence.version).replace(/[^a-zA-Z0-9._-]/g, '_');
    const runs = [];
    for (let index = 0; index < ROUNDS; index += 1) {
        const result = await runThroughput(moduleDir);
        runs.push(result);
        if (result.status !== 'complete') break;
    }
    const completeRuns = runs.filter(result => result.status === 'complete');
    const report = {
        generatedAt: new Date().toISOString(), label, synthetic: true, evidence,
        throughput: {
            configuration: { tasks: TASKS, providers: 2, maxConcurrentPerProvider: 1, maxGlobalConcurrent: TASKS, maxConcurrentPerSequence: TASKS, strategy: 'balanced', priorities: [1, 1], weights: [100, 100], enableFailover: false, deterministicDelayMs: DELAYS, idealServiceLowerBoundMs: DELAYS.reduce((a, b) => a + b, 0) * (TASKS / DELAYS.length) / CAPACITY, requestedRounds: ROUNDS, workerTimeoutMs: WORKER_TIMEOUT_MS, hardTimeoutMs: HARD_TIMEOUT_MS },
            measurement: 'Real loopback HTTP requests through the selected TaskQueue, ProviderManager, and apiService. Timer begins immediately before enqueue; module load excluded. HTTP active counts span mock request body received to response finish/close. Idle opportunity integrates min(free HTTP slots, unfinished tasks minus HTTP active). This includes client/limiter overhead and is not proof of scheduler idle time alone. ResultStore uses an in-memory fixture; UI, network transit, image processing, disk writes, and business logging excluded. No getStatus polling or scheduler stubs.',
            status: completeRuns.length === ROUNDS ? 'complete' : 'incomplete', runs,
            summary: completeRuns.length === ROUNDS ? {
                medianElapsedMs: median(completeRuns.map(run => run.elapsedMs)),
                medianThroughputTasksPerSecond: median(completeRuns.map(run => run.throughputTasksPerSecond)),
                maximumActualHttpPeak: Math.max(...completeRuns.map(run => run.actualHttpPeak)),
                medianIdleOpportunitySlotMs: median(completeRuns.map(run => run.idleOpportunitySlotMs))
            } : null
        },
        serialization: serializationBenchmark()
    };
    const outputDir = path.join(ROOT, 'release-evidence');
    fs.mkdirSync(outputDir, { recursive: true });
    const output = path.join(outputDir, `performance-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ report: output, synthetic: true, throughputStatus: report.throughput.status, throughput: report.throughput.summary, serialization: report.serialization.medianStringifyMs }, null, 2));
    if (report.throughput.status !== 'complete') process.exitCode = 2;
}

if (process.argv[2] === '--worker') {
    throughputWorker(path.resolve(process.argv[3])).catch(error => {
        const result = { status: 'incomplete', reason: `Worker initialization failed: ${String(error.message).slice(0, 500)}`, completed: 0, failed: 0, unfinished: TASKS };
        if (process.connected) process.send({ type: 'result', result }, () => process.exit(1));
        else process.exit(1);
    });
} else {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
