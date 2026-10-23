const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fetch = require('node-fetch');
const { startServer } = require('../server');

test('supplier alias supports deleting a unified supplier', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-server-suppliers-'));
    const runtime = await startServer({
        port: 0,
        unifiedProviderStoreFile: path.join(directory, 'unified.json'),
        providerStoreFile: path.join(directory, 'providers.json'),
        chatProviderStoreFile: path.join(directory, 'chat-providers.json'),
        proxyConfigFile: path.join(directory, 'proxy.json'),
        failoverConfigFile: path.join(directory, 'failover.json')
    });
    t.after(async () => {
        runtime.close();
        await fs.rm(directory, { recursive: true, force: true });
    });

    const createdResponse = await fetch(`${runtime.url}/api/suppliers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Delete me', baseUrl: 'https://delete.invalid/v1' })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    const deletedResponse = await fetch(`${runtime.url}/api/suppliers/${encodeURIComponent(created.id)}`, { method: 'DELETE' });
    assert.equal(deletedResponse.status, 200);
    const deleted = await deletedResponse.json();
    assert.equal(deleted.success, true);
    assert.ok(Array.isArray(deleted.suppliers));
    assert.equal(deleted.suppliers.some(item => item.id === created.id), false);

    const missingResponse = await fetch(`${runtime.url}/api/suppliers/missing-supplier`, { method: 'DELETE' });
    assert.equal(missingResponse.status, 404);
});
