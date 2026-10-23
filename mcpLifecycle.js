// Keeps the running MCP server in line with mcp-config.json. Every start, stop,
// switch and token change runs through one queue: an overlapping switch and
// token reset once left an orphan server that still accepted the old token.
function createMcpLifecycle({ store, createServer, onStarted, onStopped, isQuitting = () => false }) {
    let server = null;
    let queue = Promise.resolve();

    function serial(task) {
        const run = queue.then(task);
        queue = run.catch(() => {});
        return run;
    }

    async function stop() {
        const running = server;
        server = null;
        if (!running) return;
        await running.close();
        await onStopped?.();
    }

    async function reconcile() {
        const config = await store.get();
        const wanted = config.enabled && !isQuitting();
        if (server && (!wanted || server.token !== config.token)) await stop();
        if (!wanted || server) return;
        const next = createServer(config);
        await next.start();
        if (isQuitting()) { await next.close(); return; }
        server = next;
        await onStarted?.(next);
    }

    return {
        get server() { return server; },
        reconcile: () => serial(reconcile),
        update: updates => serial(async () => {
            const before = await store.get();
            await store.update(updates);
            try {
                await reconcile();
            } catch (error) {
                // Leave the switch where the server actually is, not where it was asked to be.
                if (updates.enabled === true && !before.enabled) await store.update({ enabled: false });
                throw error;
            }
        }),
        // For quit: no time to wait on the queue. A start still in flight sees
        // isQuitting() and closes its own server.
        closeNow() {
            const running = server;
            server = null;
            running?.close();
        }
    };
}

module.exports = { createMcpLifecycle };
