const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const fetch = require('node-fetch');
const { startServer } = require('../server');

test('a batch parses references once and enqueues shared references with consecutive indices', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-batch-'));
    const runtime = await startServer({ port: 0,
        providerStoreFile: path.join(directory, 'providers.json'), chatProviderStoreFile: path.join(directory, 'chat.json'),
        proxyConfigFile: path.join(directory, 'proxy.json'), failoverConfigFile: path.join(directory, 'failover.json')
    });
    t.after(() => runtime.close());
    const accepted = [];
    runtime.taskQueue.enqueue = payload => { accepted.push(payload); return `batch-${accepted.length}`; };
    const payload = { count: 20, prompt: 'mock', model: 'gpt-image-2', provider: 'http://127.0.0.1:1',
        apiKey: 'fixture', batchId: 'batch', batchIndex: 5, batchTotal: 25,
        referenceImages: [{ base64: 'YWJj', mimeType: 'image/png' }] };
    const response = await fetch(`${runtime.url}/api/tasks/batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.equal(result.taskIds.length, 20);
    assert.equal(accepted.length, 20);
    assert.deepEqual(accepted.map(item => item.batchIndex), Array.from({ length: 20 }, (_, i) => i + 5));
    assert.ok(accepted.every(item => item.referenceImages === accepted[0].referenceImages));
    for (const count of [0, 101, 1.5]) {
        const invalid = await fetch(`${runtime.url}/api/tasks/batch`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, count })
        });
        assert.equal(invalid.status, 400);
    }
    assert.equal(accepted.length, 20, 'invalid batches must not partially enqueue');
});
