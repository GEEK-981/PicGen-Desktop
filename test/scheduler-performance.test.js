const test = require('node:test');
const assert = require('node:assert/strict');
const ProviderManager = require('../providerManager');
const TaskQueue = require('../taskQueue');

const model = 'shared-image';
const image = { base64: Buffer.from('mock-image').toString('base64'), mimeType: 'image/png' };
function provider(id, extra = {}) {
    return { id, name: id, baseUrl: `https://${id}.invalid`, apiKey: `mock-${id}`,
        models: [model], priority: 1, maxConcurrent: 1, ...extra };
}
function setup(t, providers = [provider('a'), provider('b')], options = {}) {
    const manager = new ProviderManager(options);
    manager.syncProviders(providers);
    t.after(() => manager.close());
    return manager;
}
async function waitFor(predicate, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for mock scheduler');
        await new Promise(resolve => setTimeout(resolve, 3));
    }
}
function queuedTask(extra = {}) {
    return { sequenceId: 'sequence', operation: 'generate', model, prompt: 'mock prompt', ...extra };
}
function assertInputsReleased(task) {
    assert.deepEqual(task.referenceImages, []);
    assert.equal(task.maskImage, null);
    assert.equal(task.providerConfig, null);
    assert.equal(task.apiKey, '');
    assert.equal(task.provider, '');
    assert.deepEqual(task.generationConfig, {});
}

test('order routing fills the first group before spilling over and ignores legacy weights and priorities', t => {
    const manager = setup(t, [
        provider('a', { maxConcurrent: 3, priority: 100, weight: 1 }),
        provider('b', { maxConcurrent: 2, priority: 1, weight: 1000 })
    ]);
    const reservations = Array.from({ length: 5 }, () => manager.reserve(queuedTask()));
    assert.deepEqual(reservations.map(item => item.providerId), ['a', 'a', 'a', 'b', 'b']);
    assert.equal(manager.reserve(queuedTask()), null);
    manager.releaseReservation(reservations[0]);
    const next = manager.reserve(queuedTask());
    assert.equal(next.providerId, 'a');
    for (const reservation of [...reservations, next]) manager.releaseReservation(reservation);
});

test('global capacity stops spillover until a running task completes', async t => {
    const manager = setup(t, [provider('a', { maxConcurrent: 2 }), provider('b', { maxConcurrent: 2 })]);
    const jobs = [];
    const queue = new TaskQueue({ providerManager: manager, maxGlobalConcurrent: 3,
        maxConcurrentPerSequence: 8, generateImage: async config => {
            await new Promise(resolve => jobs.push({ provider: new URL(config.provider).hostname, resolve }));
            return image;
        }, resultStore: async task => ({ id: task.id, filePath: `mock/${task.id}.png` }) });
    t.after(() => queue.close());
    const ids = Array.from({ length: 5 }, () => queue.enqueue(queuedTask()));
    await waitFor(() => jobs.length === 3);
    const firstGroupJobs = jobs.filter(item => item.provider === 'a.invalid');
    assert.equal(firstGroupJobs.length, 2);
    assert.equal(jobs.filter(item => item.provider === 'b.invalid').length, 1);
    assert.equal(queue.activeTasks.size, 3);
    assert.equal(manager.runtime.get('b').active + manager.runtime.get('b').reserved, 1);
    firstGroupJobs[0].resolve();
    await waitFor(() => jobs.length === 4);
    assert.equal(jobs[3].provider, 'a.invalid');
    firstGroupJobs[1].resolve();
    await waitFor(() => jobs.length === 5);
    assert.equal(jobs[4].provider, 'a.invalid');
    jobs.forEach(job => job.resolve());
    await waitFor(() => ids.every(id => queue.getTask(id).status === 'completed'));
});

test('twenty tasks use two providers fairly without hiding work in limiter queues', async t => {
    const manager = setup(t);
    const jobs = [];
    const active = new Map([['a', 0], ['b', 0]]);
    const counts = new Map([['a', 0], ['b', 0]]);
    const queue = new TaskQueue({ providerManager: manager, maxGlobalConcurrent: 12,
        maxConcurrentPerSequence: 12, generateImage: async config => {
            const id = new URL(config.provider).hostname.split('.')[0];
            active.set(id, active.get(id) + 1);
            counts.set(id, counts.get(id) + 1);
            assert.equal(active.get(id), 1);
            assert.ok(queue.activeTasks.size <= 2);
            await new Promise(resolve => jobs.push({ id, resolve }));
            active.set(id, active.get(id) - 1);
            return image;
        }, resultStore: async task => ({ id: task.id, filePath: `mock/${task.id}.png` }) });
    const ids = Array.from({ length: 20 }, () => queue.enqueue(queuedTask()));
    for (let wave = 0; wave < 10; wave++) {
        await waitFor(() => jobs.length === (wave + 1) * 2);
        assert.equal(queue.activeTasks.size, 2);
        assert.deepEqual(new Set(jobs.slice(wave * 2).map(job => job.id)), new Set(['a', 'b']));
        for (const state of manager.runtime.values()) assert.ok(state.active + state.reserved <= 1);
        jobs[wave * 2].resolve();
        jobs[wave * 2 + 1].resolve();
    }
    await waitFor(() => ids.every(id => queue.getTask(id).status === 'completed'));
    assert.equal(counts.get('a'), 10);
    assert.equal(counts.get('b'), 10);
    assert.equal(queue.activeTasks.size, 0);
    for (const state of manager.runtime.values()) assert.equal(state.active + state.reserved, 0);
});

test('reserved capacity survives the limiter scheduling gap and latency starts at execution', async t => {
    const manager = setup(t, [provider('a')]);
    const reservation = manager.reserve(queuedTask());
    const state = manager.runtime.get('a');
    let start;
    state.limiter.schedule = work => new Promise(resolve => { start = () => resolve(work()); });
    let recorded;
    manager.recordSuccess = (_id, latency) => { recorded = latency; };
    const run = manager.executeReservation(reservation, async () => image);
    assert.equal(state.reserved, 1);
    assert.equal(state.active, 0);
    assert.equal(manager.reserve(queuedTask()), null);
    await new Promise(resolve => setTimeout(resolve, 40));
    start();
    await run;
    assert.ok(recorded < 35, `execution latency incorrectly includes scheduling wait: ${recorded}`);
    assert.equal(state.reserved + state.active, 0);
    assert.equal(reservation.apiKey, '');
});

test('managed snapshots cannot resurrect disabled, cooling or removed providers', t => {
    const manager = setup(t, [provider('a', { enabled: false })]);
    const snapshot = queuedTask({ providerId: 'a', provider: 'https://a.invalid', apiKey: 'old-mock' });
    assert.equal(manager.reserve(snapshot), null);
    assert.equal(manager.hasCompatibleProvider(snapshot), false);
    manager.syncProviders([provider('a')]);
    manager.recordFailure('a', Object.assign(new Error('rate limit'), { status: 429 }));
    assert.equal(manager.reserve(snapshot), null);
    assert.equal(manager.hasCompatibleProvider(snapshot), true);
    manager.setFailoverOptions({ strategy: 'fixed', selectedProviderId: 'a' });
    const fixed = manager.reserve(snapshot);
    assert.equal(fixed.providerId, 'a');
    manager.releaseReservation(fixed);
    manager.syncProviders([provider('a', { enabled: false })]);
    assert.equal(manager.reserve(snapshot), null);
    manager.syncProviders([]);
    assert.equal(manager.reserve(snapshot), null);
    assert.equal(manager.hasCompatibleProvider(snapshot), false);
});

test('cancelling or disabling a reservation before execution never submits a request', async t => {
    const manager = setup(t, [provider('a')]);
    const state = manager.runtime.get('a');
    let start;
    state.limiter.schedule = work => new Promise(resolve => { start = () => resolve(work()); });
    const controller = new AbortController();
    const reservation = manager.reserve(queuedTask());
    let calls = 0;
    const run = manager.executeReservation(reservation, async () => { calls++; }, { signal: controller.signal });
    controller.abort();
    start();
    await assert.rejects(run, { name: 'AbortError' });
    assert.equal(calls, 0);
    assert.equal(state.active + state.reserved, 0);
    const second = manager.reserve(queuedTask());
    const disabledRun = manager.executeReservation(second, async () => { calls++; });
    manager.syncProviders([provider('a', { enabled: false })]);
    start();
    await assert.rejects(disabledRun, { code: 'PROVIDER_UNAVAILABLE' });
    assert.equal(calls, 0);
    assert.equal(state.failures, 0);
    assert.equal(state.active + state.reserved, 0);
});

test('price strategy puts unknown prices last and ignores legacy priority', t => {
    const manager = setup(t, [provider('a'), provider('b', { pricing: { [model]: 1 }, priority: 2 })], { strategy: 'price' });
    const first = manager.reserve(queuedTask());
    assert.equal(first.providerId, 'b');
    manager.releaseReservation(first);
    manager.setFailoverOptions({ respectPriority: false });
    const second = manager.reserve(queuedTask());
    assert.equal(second.providerId, 'b');
    manager.releaseReservation(second);
});

test('price strategy distinguishes missing prices from explicit zero and overflows when full', t => {
    const manager = setup(t, [
        provider('blank', { pricing: { [model]: ' ' } }),
        provider('null', { pricing: { [model]: null } }),
        provider('paid', { pricing: { [model]: 0.5 } }),
        provider('free', { pricing: { [model]: 0 } })
    ], { strategy: 'price' });
    const reservations = Array.from({ length: 4 }, () => manager.reserve(queuedTask()));
    assert.deepEqual(reservations.map(r => r.providerId), ['free', 'paid', 'blank', 'null']);
    reservations.forEach(r => manager.releaseReservation(r));
});

test('balanced routing uses occupied capacity including reservations and ignores old weights', t => {
    const manager = setup(t, [
        provider('a', { maxConcurrent: 2, priority: 100, weight: 1 }),
        provider('b', { maxConcurrent: 4, priority: 1, weight: 1000 })
    ], { strategy: 'balanced' });
    const reservations = Array.from({ length: 6 }, () => manager.reserve(queuedTask()));
    assert.deepEqual(reservations.map(r => r.providerId), ['b', 'a', 'b', 'b', 'a', 'b']);
    assert.equal(manager.reserve(queuedTask()), null);
    reservations.forEach(r => manager.releaseReservation(r));
    manager.runtime.get('a').active = 1;
    const next = manager.reserve(queuedTask());
    assert.equal(next.providerId, 'b');
    manager.releaseReservation(next);
    manager.runtime.get('a').active = 0;
});

test('speed routing learns request latency, uses order initially and overflows when fastest is full', t => {
    const manager = setup(t, [provider('a'), provider('b', { priority: 100 })], { strategy: 'speed' });
    const initial = manager.reserve(queuedTask());
    assert.equal(initial.providerId, 'a');
    manager.releaseReservation(initial);
    manager.recordSuccess('a', 12000);
    manager.recordSuccess('b', 1000);
    const fastest = manager.reserve(queuedTask());
    const overflow = manager.reserve(queuedTask());
    assert.equal(fastest.providerId, 'b');
    assert.equal(overflow.providerId, 'a');
    [fastest, overflow].forEach(r => manager.releaseReservation(r));
});

test('fixed routing queues at the selected capacity and never spills into another provider', async t => {
    const manager = setup(t, [provider('a'), provider('b')], { strategy: 'fixed', selectedProviderId: 'b' });
    const jobs = [];
    const queue = new TaskQueue({ providerManager: manager, maxGlobalConcurrent: 4,
        generateImage: async config => {
            assert.equal(new URL(config.provider).hostname, 'b.invalid');
            await new Promise(resolve => jobs.push(resolve));
            return image;
        } });
    t.after(() => queue.close());
    const ids = [queue.enqueue(queuedTask()), queue.enqueue(queuedTask())];
    await waitFor(() => jobs.length === 1);
    assert.equal(queue.getTask(ids[1]).status, 'pending');
    assert.equal(manager.runtime.get('a').active + manager.runtime.get('a').reserved, 0);
    assert.equal(manager.reserve(queuedTask(), ['b']), null, 'failover cannot escape the selected group');
    jobs[0]();
    await waitFor(() => jobs.length === 2);
    jobs[1]();
    await waitFor(() => ids.every(id => queue.getTask(id).status === 'completed'));
});

test('all cooling providers wake queued tasks at the deadline without polling', async t => {
    const manager = setup(t, [provider('a')]);
    manager.cooldownMs = 60;
    manager.recordFailure('a', Object.assign(new Error('rate limit'), { status: 429 }));
    let reserveCalls = 0;
    const reserve = manager.reserve.bind(manager);
    manager.reserve = (...args) => { reserveCalls++; return reserve(...args); };
    const queue = new TaskQueue({ providerManager: manager, generateImage: async () => image });
    const id = queue.enqueue(queuedTask());
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(queue.getTask(id).status, 'pending');
    assert.equal(reserveCalls, 1);
    await waitFor(() => queue.getTask(id).status === 'completed');
    assert.ok(reserveCalls <= 3);
});

test('half-open recovery notifies the central queue', async t => {
    const manager = new ProviderManager();
    manager.cooldownMs = 40;
    manager.syncProviders([provider('a')]);
    t.after(() => manager.close());
    manager.runtime.get('a').breaker.open();
    const queue = new TaskQueue({ providerManager: manager, generateImage: async () => image });
    const id = queue.enqueue(queuedTask());
    await waitFor(() => queue.getTask(id).status === 'completed');
    assert.equal(manager.runtime.get('a').breaker.closed, true);
});

test('pending and running cancellations release inputs without reporting provider failure', async t => {
    const manager = setup(t, [provider('a')]);
    let started = false;
    const queue = new TaskQueue({ providerManager: manager, generateImage: async config => {
        started = true;
        return new Promise((_resolve, reject) => config.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        }, { once: true }));
    } });
    const inputs = { providerId: 'a', provider: 'https://a.invalid', apiKey: 'mock-key',
        providerConfig: { nested: 'private-config' }, referenceImages: [{ base64: 'A'.repeat(1000) }],
        maskImage: { base64: 'B'.repeat(1000) }, generationConfig: { extra: 'large-input' } };
    const running = queue.enqueue(queuedTask(inputs));
    const pending = queue.enqueue(queuedTask(inputs));
    await waitFor(() => started);
    assert.equal(queue.getTask(pending).status, 'pending');
    assert.equal(queue.cancel(pending), true);
    assertInputsReleased(queue.tasks.get(pending));
    assert.equal(queue.cancel(running), true);
    await waitFor(() => queue.activeTasks.size === 0);
    assertInputsReleased(queue.tasks.get(running));
    const state = manager.runtime.get('a');
    assert.equal(state.failures, 0);
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.active + state.reserved, 0);
    assert.equal(queue.getTask(running).status, 'cancelled');
});

test('completed and incompatible tasks release inputs but retain results and attempts', async t => {
    const manager = setup(t, [provider('a')]);
    const queue = new TaskQueue({ providerManager: manager, generateImage: async () => image });
    const extra = { providerConfig: { secret: 'mock' }, apiKey: 'mock',
        referenceImages: [{ base64: 'mock-reference' }], maskImage: { base64: 'mock-mask' } };
    const completed = queue.enqueue(queuedTask(extra));
    const failed = queue.enqueue(queuedTask({ ...extra, model: 'unsupported' }));
    await waitFor(() => queue.getTask(completed).status === 'completed' && queue.getTask(failed).status === 'failed');
    assertInputsReleased(queue.tasks.get(completed));
    assertInputsReleased(queue.tasks.get(failed));
    assert.equal(queue.getTask(completed).result.base64, image.base64);
    assert.equal(queue.getTask(completed).attempts.length, 1);
    assert.equal(queue.getTask(completed).prompt, 'mock prompt');
});

test('a busy fallback waits centrally and resumes without repeating the failed provider', async t => {
    const manager = setup(t);
    const busy = manager.reserve(queuedTask(), ['a']);
    let releaseBusy;
    const busyRun = manager.executeReservation(busy, () => new Promise(resolve => { releaseBusy = resolve; }));
    await waitFor(() => !!releaseBusy);
    const requests = [];
    const queue = new TaskQueue({ providerManager: manager, generateImage: async config => {
        requests.push(config.provider);
        if (config.provider.includes('a.invalid')) throw Object.assign(new Error('unavailable'), { status: 503 });
        return image;
    } });
    const id = queue.enqueue(queuedTask());
    await waitFor(() => queue.getTask(id).attempts.length === 1 && queue.getTask(id).status === 'pending');
    assert.equal(queue.activeTasks.size, 0);
    releaseBusy(image);
    await busyRun;
    await waitFor(() => queue.getTask(id).status === 'completed');
    assert.deepEqual(requests, ['https://a.invalid', 'https://b.invalid']);
    assert.equal(queue.getTask(id).attempts.length, 2);
});

test('startup store hydration does not retire an already accepted legacy direct reservation', async t => {
    const manager = setup(t, []);
    const reservation = manager.reserve(queuedTask({ provider: 'https://legacy.invalid', apiKey: 'mock-direct' }));
    const state = reservation._state;
    let start;
    state.limiter.schedule = work => new Promise(resolve => { start = () => resolve(work()); });
    let calls = 0;
    const run = manager.executeReservation(reservation, async () => { calls++; return image; });
    manager.syncProviders([provider('placeholder')]);
    assert.equal(state.retired, true);
    start();
    assert.equal(await run, image);
    assert.equal(calls, 1);
    assert.equal(state.active + state.reserved, 0);
});

test('completed events and task recovery preserve saved image metadata without heavy inputs', async t => {
    const manager = setup(t, [provider('a')]);
    const metadata = { id: 'saved', url: 'file:///mock/saved.png', filePath: 'mock/saved.png',
        fileName: 'saved.png', mimeType: 'image/png', createdAt: 123456,
        width: 2048, height: 2048, fileSize: 4096, sourceWidth: 1254, sourceHeight: 1254,
        requestedWidth: 2048, requestedHeight: 2048, dimensionAdjusted: true, thoughtText: '' };
    let completed;
    const queue = new TaskQueue({ providerManager: manager, generateImage: async () => image,
        resultStore: async () => ({ ...metadata, ignoredPrivateField: 'not-for-client' }),
        onTaskEvent: (type, task) => { if (type === 'task:completed') completed = task; }
    });
    const id = queue.enqueue(queuedTask({ generationConfig: { private: 'not-for-client' } }));
    await waitFor(() => !!completed);
    assert.deepEqual(completed.result, metadata);
    assert.deepEqual(queue.getTask(id).result, metadata);
    assert.deepEqual(queue.listTasks()[0].result, metadata);
    assert.equal(JSON.stringify(completed).includes('not-for-client'), false);
    assert.equal(completed.result.base64, undefined);
});

test('saving is a completion commit that survives single, sequence and close cancellation', async t => {
    const manager = setup(t, [provider('a')]);
    let finishSave;
    const events = [];
    const queue = new TaskQueue({ providerManager: manager, maxConcurrentPerSequence: 1,
        generateImage: async () => image,
        resultStore: task => new Promise(resolve => {
            finishSave = () => {
                assert.equal(task.generationConfig.preserveUntilSaved, true);
                resolve({ id: task.id, filePath: `mock/${task.id}.png`, width: 1024, height: 1024 });
            };
        }), onTaskEvent: (type, task) => events.push({ type, id: task.id })
    });
    const saving = queue.enqueue(queuedTask({ generationConfig: { preserveUntilSaved: true } }));
    const pending = queue.enqueue(queuedTask());
    await waitFor(() => !!finishSave);
    assert.equal(queue.getTask(saving).phase, 'saving');
    assert.equal(queue.cancel(saving), false);
    assert.equal(queue.cancelBySequence('sequence'), 1);
    assert.equal(queue.getTask(pending).status, 'cancelled');
    assert.equal(queue.getTask(saving).status, 'running');
    queue.close();
    manager.close();
    assert.equal(queue.getTask(saving).phase, 'saving');
    finishSave();
    await waitFor(() => queue.getTask(saving).status === 'completed');
    assert.equal(events.filter(event => event.id === saving && event.type === 'task:completed').length, 1);
    assert.equal(events.some(event => event.id === saving && event.type === 'task:cancelled'), false);
    assert.equal(queue.getTask(saving).result.width, 1024);
    assertInputsReleased(queue.tasks.get(saving));
    assert.equal(queue.activeTasks.size, 0);
    assert.equal(manager.runtime.size, 0, 'finishing persistence must not restart a closed provider manager');
});

test('closing during a request cancels it without recreating provider runtimes', async t => {
    const manager = setup(t, [provider('a')]);
    let started = false;
    const queue = new TaskQueue({ providerManager: manager, generateImage: config => new Promise((_resolve, reject) => {
        started = true;
        config.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
    }) });
    const id = queue.enqueue(queuedTask());
    await waitFor(() => started);
    queue.close();
    manager.close();
    await waitFor(() => queue.activeTasks.size === 0);
    assert.equal(queue.getTask(id).status, 'cancelled');
    assertInputsReleased(queue.tasks.get(id));
    assert.equal(manager.runtime.size, 0);
});
