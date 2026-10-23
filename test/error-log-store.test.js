const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { ErrorLogStore } = require('../errorLogStore');

async function withStore(options, run) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-errors-'));
    const filePath = path.join(directory, 'logs', 'recent-errors.json');
    try {
        const store = new ErrorLogStore({ filePath, ...options });
        await run(store, filePath);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

test('persists recent errors and reloads them', async () => {
    await withStore({}, async (store, filePath) => {
        await store.record({ source: 'generation', title: '生成失败', message: 'upstream 500', taskId: 'task_1' });
        const reloaded = new ErrorLogStore({ filePath });
        const entries = await reloaded.list();
        assert.equal(entries.length, 1);
        assert.equal(await reloaded.count(), 1);
        assert.equal(entries[0].source, 'generation');
        assert.equal(entries[0].taskId, 'task_1');
    });
});

test('deduplicates matching errors inside the configured window', async () => {
    let now = 1000000;
    await withStore({ now: () => now, dedupeWindowMs: 300000 }, async store => {
        await store.record({ source: 'provider', title: '连接失败', message: 'HTTP 429', providerId: 'p1' });
        now += 1000;
        await store.record({ source: 'provider', title: '连接失败', message: 'HTTP 429', providerId: 'p1' });
        const entries = await store.list();
        assert.equal(entries.length, 1);
        assert.equal(entries[0].occurrences, 2);
        assert.equal(entries[0].timestamp, 1000000);
        assert.equal(entries[0].lastSeenAt, 1001000);
    });
});

test('redacts secrets, prompts and image data before writing', async () => {
    await withStore({}, async (store, filePath) => {
        await store.record({
            source: 'network',
            title: '请求失败',
            message: 'Bearer token-value sk-supersecret https://api.example.com/v1?key=secret-value',
            details: {
                apiKey: 'secret-key',
                prompt: 'private prompt',
                referenceImages: [{ base64: 'A'.repeat(400) }],
                endpoint: 'https://api.example.com/v1?token=token-value'
            }
        });
        const raw = await fs.readFile(filePath, 'utf8');
        assert.doesNotMatch(raw, /token-value|supersecret|secret-key|private prompt|A{100}/);
        assert.match(raw, /\[redacted\]|\[omitted\]|\*\*\*/);
    });
});

test('serializes concurrent writes without losing distinct errors', async () => {
    await withStore({ dedupeWindowMs: 0 }, async store => {
        await Promise.all(Array.from({ length: 40 }, (_, index) => store.record({
            source: 'system',
            title: `错误 ${index}`,
            message: `distinct-${index}`
        })));
        const entries = await store.list();
        assert.equal(entries.length, 40);
        assert.equal(new Set(entries.map(entry => entry.message)).size, 40);
    });
});

test('zero dedupe window keeps identical errors as separate entries', async () => {
    await withStore({ dedupeWindowMs: 0 }, async store => {
        await store.record({ source: 'system', title: '相同错误', message: 'same-message' });
        await store.record({ source: 'system', title: '相同错误', message: 'same-message' });
        const entries = await store.list();
        assert.equal(entries.length, 2);
        assert.ok(entries.every(entry => entry.occurrences === 1));
    });
});

test('keeps useful image dimensions while omitting image payloads', async () => {
    await withStore({}, async store => {
        await store.record({
            source: 'generation',
            message: 'normalization failed',
            details: {
                imageSize: '2048x2048',
                imageData: 'A'.repeat(400),
                referenceImages: [{ base64: 'B'.repeat(400) }]
            }
        });
        const [entry] = await store.list();
        assert.equal(entry.details.imageSize, '2048x2048');
        assert.equal(entry.details.imageData, '[omitted]');
        assert.equal(entry.details.referenceImages, '[omitted]');
    });
});

test('enforces maximum count and age', async () => {
    let now = 1000000;
    await withStore({ now: () => now, maxEntries: 10, maxAgeMs: 60000, dedupeWindowMs: 0 }, async store => {
        for (let index = 0; index < 12; index += 1) {
            await store.record({ source: 'system', title: `错误 ${index}`, message: `message-${index}` });
            now += 1000;
        }
        assert.equal((await store.list()).length, 10);
        now += 61000;
        assert.equal((await store.list()).length, 0);
    });
});
