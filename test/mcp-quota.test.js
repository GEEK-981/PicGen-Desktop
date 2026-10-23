const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { McpDailyQuota } = require('../mcpQuota');
const { McpConfigStore } = require('../mcpConfig');

async function quotaFile() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-quota-'));
    return path.join(dir, 'mcp-usage.json');
}

test('zero means no daily limit', async () => {
    const quota = new McpDailyQuota({ filePath: await quotaFile() });
    const usage = await quota.reserve(500, 0);
    assert.equal(usage.used, 500);
    assert.equal(usage.remaining, null);
});

test('a call that would pass the limit is refused whole and says what is left', async () => {
    const quota = new McpDailyQuota({ filePath: await quotaFile() });
    await quota.reserve(8, 10);
    await assert.rejects(quota.reserve(3, 10), error => error.code === 'MCP_DAILY_LIMIT' && /还剩 2 张/.test(error.message));
    assert.equal((await quota.usage(10)).used, 8, 'a refused call takes nothing');
    assert.equal((await quota.reserve(2, 10)).remaining, 0);
});

test('concurrent reservations never overshoot the limit', async () => {
    const quota = new McpDailyQuota({ filePath: await quotaFile() });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => quota.reserve(3, 10)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
    assert.equal((await quota.usage(10)).used, 9);
});

test('the count survives a restart and starts over on a new day', async () => {
    const filePath = await quotaFile();
    let now = new Date(2026, 9, 23, 23, 50).getTime();
    await new McpDailyQuota({ filePath, now: () => now }).reserve(7, 10);
    const reopened = new McpDailyQuota({ filePath, now: () => now });
    assert.equal((await reopened.usage(10)).used, 7);
    now = new Date(2026, 9, 24, 0, 5).getTime();
    assert.equal((await reopened.usage(10)).used, 0, 'midnight in local time resets it');
});

test('a refund gives back images that were never submitted', async () => {
    const quota = new McpDailyQuota({ filePath: await quotaFile() });
    await quota.reserve(5, 10);
    await quota.refund(2);
    assert.equal((await quota.usage(10)).used, 3);
    await quota.refund(10);
    assert.equal((await quota.usage(10)).used, 0, 'never below zero');
});

test('the daily limit is a setting with zero as the default', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-mcp-'));
    const store = new McpConfigStore({ filePath: path.join(dir, 'mcp-config.json') });
    assert.equal((await store.get()).dailyImageLimit, 0);
    assert.equal((await store.update({ dailyImageLimit: 200 })).dailyImageLimit, 200);
    assert.equal((await store.update({ dailyImageLimit: -1 })).dailyImageLimit, 200, 'invalid values are ignored');
    assert.equal((await store.update({ dailyImageLimit: '50' })).dailyImageLimit, 50);
    assert.equal((await new McpConfigStore({ filePath: store.filePath }).get()).dailyImageLimit, 50);
});

test('a count that cannot be saved is not counted, and a torn file does not reset it', async () => {
    const filePath = await quotaFile();
    const quota = new McpDailyQuota({ filePath });
    await quota.reserve(4, 10);
    const original = quota._write;
    quota._write = async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    await assert.rejects(quota.reserve(3, 10), /EPERM/);
    quota._write = original;
    assert.equal((await quota.usage(10)).used, 4);
    const leftovers = (await fs.readdir(path.dirname(filePath))).filter(name => name !== path.basename(filePath));
    assert.deepEqual(leftovers, [], 'the temp file is replaced by rename, never left behind');
});
