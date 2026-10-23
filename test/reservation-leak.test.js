const test = require('node:test');
const assert = require('node:assert/strict');

const ProviderManager = require('../providerManager');
const TaskQueue = require('../taskQueue');

function providerConfig(overrides = {}) {
    return {
        id: 'p1',
        name: 'Provider One',
        url: 'https://example.invalid/v1',
        baseUrl: 'https://example.invalid',
        apiKey: 'k1',
        apiKeys: ['k1'],
        weight: 1,
        enabled: true,
        models: ['gemini-3.1-flash-image-preview'],
        modelRouting: {},
        ...overrides
    };
}

function reservedTotal(manager) {
    return manager.getStatus().reduce((sum, p) => sum + (p.reserved || 0), 0);
}

function managerWith(...configs) {
    const manager = new ProviderManager();
    manager.syncProviders(configs.length ? configs : [providerConfig()]);
    return manager;
}

test('reserve() increments reserved and releaseReservation() gives it back', t => {
    const manager = managerWith();
    t.after(() => manager.close());
    assert.equal(reservedTotal(manager), 0);

    const reservation = manager.reserve({
        operation: 'generate',
        model: 'gemini-3.1-flash-image-preview'
    });
    assert.ok(reservation, 'expected a reservation');
    assert.equal(reservedTotal(manager), 1);

    manager.releaseReservation(reservation);
    assert.equal(reservedTotal(manager), 0);

    manager.releaseReservation(reservation);
    assert.equal(reservedTotal(manager), 0, 'release must be idempotent');
});

test('an unconsumed reservation remains reserved until explicitly released', t => {
    const manager = managerWith();
    t.after(() => manager.close());
    const reservation = manager.reserve({
        operation: 'generate',
        model: 'gemini-3.1-flash-image-preview'
    });
    assert.ok(reservation);
    assert.equal(reservedTotal(manager), 1);
    assert.equal(reservation._released, false);
    manager.releaseReservation(reservation);
});

test('cancelling a running task does not strand a provider reservation', async t => {
    const manager = managerWith();
    t.after(() => manager.close());

    let releaseGate;
    const gate = new Promise(resolve => { releaseGate = resolve; });
    let sawRequest = false;

    // TaskQueue requires generateImage at module load, so intercept at the
    // reservation boundary instead — that is where reserved -> active happens.
    manager.executeReservation = async reservation => {
        sawRequest = true;
        reservation._state.reserved = Math.max(0, reservation._state.reserved - 1);
        reservation._state.active += 1;
        try {
            await gate;
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
        } finally {
            reservation._state.active = Math.max(0, reservation._state.active - 1);
            reservation._released = true;
        }
    };

    const queue = new TaskQueue({
        providerManager: manager,
        maxConcurrentPerSequence: 1,
        maxGlobalConcurrent: 1,
        onTaskEvent: () => {},
        resultStore: async (_task, result) => result
    });

    const taskId = queue.enqueue({
        sequenceId: 's1',
        sequenceName: 'seq',
        operation: 'generate',
        prompt: 'a cat',
        model: 'gemini-3.1-flash-image-preview'
    });

    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(sawRequest, 'task should have reached the generate call');

    assert.equal(queue.cancel(taskId), true);
    releaseGate();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(queue.getTask(taskId).status, 'cancelled');
    assert.equal(queue.activeTasks.size, 0);

    assert.equal(
        reservedTotal(manager),
        0,
        `reserved leaked after cancel: ${JSON.stringify(manager.getStatus())}`
    );
});
