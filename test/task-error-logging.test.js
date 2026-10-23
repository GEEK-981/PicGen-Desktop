const test = require('node:test');
const assert = require('node:assert/strict');

const TaskQueue = require('../taskQueue');

async function waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for task completion');
}

test('records one sanitized final error with every provider attempt', async () => {
    const reservations = [
        {
            providerId: 'provider-one',
            providerName: 'Provider One',
            provider: 'https://one.example.invalid',
            apiKey: 'secret-one',
            model: 'gpt-image-2',
            protocol: 'openai-images'
        },
        {
            providerId: 'provider-two',
            providerName: 'Provider Two',
            provider: 'https://two.example.invalid',
            apiKey: 'secret-two',
            model: 'gpt-image-2',
            protocol: 'openai-images'
        }
    ];
    const providerManager = {
        reserve(_task, excludedProviderIds = []) {
            return reservations.find(item => !excludedProviderIds.includes(item.providerId)) || null;
        },
        hasCompatibleProvider: () => true,
        shouldFailover: () => true,
        executeReservation: async reservation => {
            const error = new Error(`upstream failure from ${reservation.providerName}`);
            error.status = reservation.providerId === 'provider-one' ? 429 : 500;
            throw error;
        },
        getStatus: () => []
    };
    const reports = [];
    const queue = new TaskQueue({
        providerManager,
        maxConcurrentPerSequence: 1,
        maxGlobalConcurrent: 1,
        onTaskEvent: () => {},
        onError: report => reports.push(report)
    });

    const taskId = queue.enqueue({
        sequenceId: 'sequence-one',
        prompt: 'private prompt must not be logged',
        model: 'gpt-image-2',
        ratio: '1:1',
        imageSize: '2K',
        referenceImages: [{ base64: 'A'.repeat(400) }],
        maskImage: { base64: 'B'.repeat(400) }
    });

    await waitFor(() => queue.getTask(taskId)?.status === 'failed' && reports.length === 1);

    assert.equal(reports.length, 1);
    assert.equal(reports[0].taskId, taskId);
    assert.equal(reports[0].details.attempts.length, 2);
    assert.deepEqual(reports[0].details.attempts.map(item => item.providerId), [
        'provider-one',
        'provider-two'
    ]);
    const serialized = JSON.stringify(reports[0]);
    assert.doesNotMatch(serialized, /private prompt|A{20}|B{20}|secret-one|secret-two/);
});
