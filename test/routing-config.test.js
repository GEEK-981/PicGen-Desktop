const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fetch = require('node-fetch');
const { startServer } = require('../server');
const { FailoverConfigStore } = require('../failoverConfig');

test('all routing modes survive API save and restart and reach the scheduler', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-routing-test-'));
    const options = { port: 0, unifiedProviderStoreFile: path.join(directory, 'unified.json'),
        providerStoreFile: path.join(directory, 'image.json'), chatProviderStoreFile: path.join(directory, 'chat.json'),
        failoverConfigFile: path.join(directory, 'failover.json'), proxyConfigFile: path.join(directory, 'proxy.json') };
    let runtime = await startServer(options);
    t.after(async () => { runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
    const request = async (route, body) => {
        const response = await fetch(`${runtime.url}${route}`, body ? { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
        assert.ok(response.ok, `HTTP ${response.status}`);
        return response.json();
    };
    const a = await request('/api/providers', { name: 'a', baseUrl: 'https://a.invalid', apiKey: 'fixture-a',
        models: ['model'], modelPricing: { model: 5 }, maxConcurrent: 2 });
    const b = await request('/api/providers', { name: 'b', baseUrl: 'https://b.invalid', apiKey: 'fixture-b',
        models: ['model'], modelPricing: { model: 1 }, priority: 99, weight: 1000, maxConcurrent: 4 });
    for (const strategy of ['order', 'priority', 'balanced', 'price', 'speed', 'fixed']) {
        const saved = await request('/api/providers/failover', { strategy, selectedProviderId: strategy === 'fixed' ? b.id : '' });
        assert.equal(saved.config.strategy, strategy);
        assert.equal(runtime.providerManager.failoverOptions.strategy, strategy);
        runtime.close();
        runtime = await startServer(options);
        // Reorder invokes startup/store synchronization without submitting API work.
        await request('/api/providers/reorder', { ids: [a.id, b.id] });
        const loaded = await request('/api/providers/failover');
        assert.equal(loaded.strategy, strategy);
        assert.equal(runtime.providerManager.failoverOptions.strategy, strategy);
        const reserved = runtime.providerManager.reserve({ model: 'model' });
        assert.equal(reserved.providerId, ['price', 'fixed'].includes(strategy) ? b.id : a.id);
        runtime.providerManager.releaseReservation(reserved);
    }
    const rejected = await fetch(`${runtime.url}/api/providers/failover`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy: 'fixed', selectedProviderId: 'missing' }) });
    assert.equal(rejected.status, 400);
    assert.equal((await request('/api/providers/failover')).selectedProviderId, b.id);
});

test('priority is retained and unknown strategies fall back to order', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-strategy-migrate-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'failover.json');
    for (const strategy of ['priority', 'invalid', null]) {
        await fs.writeFile(filePath, JSON.stringify({ strategy }));
        const store = new FailoverConfigStore({ filePath });
        assert.equal((await store.get()).strategy, strategy === 'priority' ? 'priority' : 'order');
    }
});
