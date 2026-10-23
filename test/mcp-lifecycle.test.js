const test = require('node:test');
const assert = require('node:assert/strict');

const { createMcpLifecycle } = require('../mcpLifecycle');

function memoryStore(initial = {}) {
    let config = { enabled: false, port: 47823, token: 't0', ...initial };
    let issued = 0;
    return {
        get: async () => ({ ...config }),
        update: async updates => {
            if (updates.enabled != null) config.enabled = updates.enabled === true;
            if (updates.regenerateToken) config.token = `t${++issued}`;
            return { ...config };
        }
    };
}

// A server whose start() takes a while, so two operations can overlap.
function fakeServers({ failWith = null } = {}) {
    const created = [];
    const createServer = config => {
        const server = {
            token: config.token,
            open: false,
            async start() {
                await new Promise(resolve => setTimeout(resolve, 20));
                if (failWith) throw failWith;
                this.open = true;
                return this;
            },
            async close() { this.open = false; }
        };
        created.push(server);
        return server;
    };
    return { created, createServer, open: () => created.filter(server => server.open) };
}

test('switching on and rotating the token at once leaves one server on the new token', async () => {
    const store = memoryStore();
    const servers = fakeServers();
    const lifecycle = createMcpLifecycle({ store, createServer: servers.createServer });
    await Promise.all([lifecycle.update({ enabled: true }), lifecycle.update({ regenerateToken: true })]);
    const open = servers.open();
    assert.equal(open.length, 1, 'no orphan keeps listening');
    assert.equal(open[0].token, (await store.get()).token, 'the old token is not accepted anywhere');
    assert.equal(lifecycle.server, open[0]);
});

test('switching off while the startup start is still running stops it', async () => {
    const store = memoryStore({ enabled: true });
    const servers = fakeServers();
    const lifecycle = createMcpLifecycle({ store, createServer: servers.createServer });
    await Promise.all([lifecycle.reconcile(), lifecycle.update({ enabled: false })]);
    assert.equal(servers.open().length, 0);
    assert.equal(lifecycle.server, null);
});

test('a server that fails to start rolls the switch back', async () => {
    const store = memoryStore();
    const failure = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    const lifecycle = createMcpLifecycle({ store, createServer: fakeServers({ failWith: failure }).createServer });
    await assert.rejects(lifecycle.update({ enabled: true }), /EACCES/);
    assert.equal((await store.get()).enabled, false, 'the settings page and the file agree it is off');
    assert.equal(lifecycle.server, null);
});

test('quitting while a start is in flight closes the new server', async () => {
    const store = memoryStore({ enabled: true });
    const servers = fakeServers();
    let quitting = false;
    const lifecycle = createMcpLifecycle({ store, createServer: servers.createServer, isQuitting: () => quitting });
    const starting = lifecycle.reconcile();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(servers.created.length, 1, 'start() is under way');
    quitting = true;
    lifecycle.closeNow();
    await starting;
    assert.equal(servers.open().length, 0);
    assert.equal(lifecycle.server, null);
});

test('started and stopped hooks follow the running server', async () => {
    const store = memoryStore();
    const events = [];
    const lifecycle = createMcpLifecycle({
        store,
        createServer: fakeServers().createServer,
        onStarted: server => events.push(`start:${server.token}`),
        onStopped: () => events.push('stop')
    });
    await lifecycle.update({ enabled: true });
    await lifecycle.update({ regenerateToken: true });
    await lifecycle.update({ enabled: false });
    assert.deepEqual(events, ['start:t0', 'stop', 'start:t1', 'stop']);
});
