const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const usage = require('../historyUsage');

test('usageKey is lower(fileName)|size, survives a folder move and differs by size', () => {
    const original = { filePath: 'D:\\a\\images\\X.png', fileSize: 10 };
    const moved = { filePath: 'E:/moved/images-[PH2]/x.PNG', fileSize: 10 };
    assert.equal(usage.usageKey(original), 'x.png|10');
    assert.equal(usage.usageKey(original), usage.usageKey(moved));
    assert.notEqual(usage.usageKey({ filePath: 'x.png', fileSize: 10 }), usage.usageKey({ filePath: 'x.png', fileSize: 11 }));
    // fileName wins over the path's basename; a missing size keys as 0
    assert.equal(usage.usageKey({ fileName: 'Named.JPG', filePath: 'D:\\other.png', fileSize: '7' }), 'named.jpg|7');
    assert.equal(usage.usageKey({ filePath: 'D:\\a\\b.webp' }), 'b.webp|0');
    assert.equal(usage.usageKey({}), '');
    assert.equal(usage.usageKey(null), '');
});

test('usageTotal and isProtected sum both counters', () => {
    assert.equal(usage.usageTotal({ dragCount: 2, referenceCount: 3 }), 5);
    assert.equal(usage.usageTotal({ dragCount: '1' }), 1);
    assert.equal(usage.usageTotal(null), 0);
    assert.equal(usage.isProtected({ referenceCount: 1 }), true);
    assert.equal(usage.isProtected({ dragCount: 0, referenceCount: 0 }), false);
    assert.equal(usage.isProtected(undefined), false);
});

test('classifyDragEnd tells inside, outside and unknown', () => {
    const windows = [
        { bounds: { x: 100, y: 100, width: 460, height: 800 } }, // main window
        { bounds: { x: 0, y: 0, width: 12, height: 60 } } // docked edge tab
    ];
    assert.equal(usage.classifyDragEnd({ point: { x: 300, y: 500 }, windows }), 'inside');
    assert.equal(usage.classifyDragEnd({ point: { x: 5, y: 5 }, windows }), 'inside');
    assert.equal(usage.classifyDragEnd({ point: { x: 1200, y: 500 }, windows }), 'outside');
    // right and bottom edges are exclusive
    assert.equal(usage.classifyDragEnd({ point: { x: 560, y: 500 }, windows }), 'outside');
    assert.equal(usage.classifyDragEnd({ point: { x: 100, y: 100 }, windows }), 'inside');
    assert.equal(usage.classifyDragEnd({ point: null, windows }), 'unknown');
    assert.equal(usage.classifyDragEnd({ point: { x: Number.NaN, y: 1 }, windows }), 'unknown');
    assert.equal(usage.classifyDragEnd({ point: { x: 1, y: 1 } }), 'outside');
});

test('applyTombstones drops, revives, clears and never revives an in-flight path', () => {
    const existing = new Set(['d:\\h\\restored.png', 'd:\\h\\live.png']);
    const exists = filePath => existing.has(usage.pathKey(filePath));
    const records = [
        { id: 'live', filePath: 'D:\\h\\live.png', createdAt: 30 },
        { id: 'dead', filePath: 'D:\\h\\dead.png', createdAt: 20 }
    ];
    const tombstones = [
        { path: 'D:\\h\\dead.png', record: { id: 'dead' } },
        { path: 'D:\\h\\restored.png', record: { id: 'r', prompt: 'a red cat', createdAt: 25 } },
        { path: 'D:\\h\\gone.png', record: { id: 'g' } },
        { path: 'd:/H/LIVE.png', record: { id: 'live' } }
    ];
    const out = usage.applyTombstones(records, tombstones, exists);
    // revived records are merged in createdAt-descending order
    assert.deepEqual(out.records.map(record => record.id), ['live', 'r']);
    assert.deepEqual(out.dropped.map(record => record.id), ['dead']);
    assert.deepEqual(out.revived.map(record => record.id), ['r']);
    assert.equal(out.revived[0].prompt, 'a red cat');
    assert.equal(out.revived[0].filePath, 'D:\\h\\restored.png');
    // the revived tombstone and the one whose record is already present are cleared
    assert.deepEqual(out.cleared.map(entry => entry.record.id).sort(), ['live', 'r']);
    assert.deepEqual(out.tombstones.map(entry => entry.record.id), ['dead', 'g']);
    assert.equal(out.changed, true);
    // inputs are not mutated
    assert.equal(records.length, 2);
    assert.equal(tombstones.length, 4);

    const inFlight = new Set([usage.pathKey('D:\\h\\live.png')]);
    const blocked = usage.applyTombstones([], [{ path: 'D:\\h\\live.png', record: { id: 'live' } }], exists, inFlight);
    assert.equal(blocked.records.length, 0);
    assert.equal(blocked.tombstones.length, 1);
    assert.equal(blocked.changed, false);

    // an in-flight record that is still listed is not dropped either
    const kept = usage.applyTombstones([{ id: 'x', filePath: 'D:\\h\\x.png' }], [{ path: 'D:\\h\\x.png', record: { id: 'x' } }],
        () => false, new Set([usage.pathKey('D:\\h\\x.png')]));
    assert.deepEqual(kept.records.map(record => record.id), ['x']);
    assert.equal(kept.dropped.length, 0);

    const untouched = usage.applyTombstones(records, [], exists);
    assert.equal(untouched.changed, false);
    assert.deepEqual(untouched.records.map(record => record.id), ['live', 'dead']);
});

test('buildTrashConfirmText states counts, size and each warning', () => {
    const MB = 1024 * 1024;
    assert.equal(
        usage.buildTrashConfirmText({ count: 5, bytes: 23.4 * MB, keptProtected: 2 }),
        '将 5 张图片（共 23.4 MB）移到回收站。保留：拖用过的 2 张。'
    );
    assert.equal(usage.buildTrashConfirmText({ count: 3, bytes: 0 }), '将 3 张图片移到回收站。');
    assert.equal(usage.buildTrashConfirmText({ count: 1, bytes: 300 * 1024, keptProtected: 1 }),
        '将 1 张图片（共 300 KB）移到回收站。保留：拖用过的 1 张。');
    assert.equal(usage.buildTrashConfirmText({ count: 2, bytes: 2.5 * 1024 * MB }), '将 2 张图片（共 2.50 GB）移到回收站。');

    const full = usage.buildTrashConfirmText({
        count: 120,
        bytes: 512 * MB,
        keptProtected: 1,
        includedProtected: 2
    });
    assert.deepEqual(full.split('\n'), [
        '将 120 张图片（共 512.0 MB）移到回收站。保留：拖用过的 1 张。',
        '其中 2 张拖用过（可能正被用作 AI 参考图）',
        '数量较多，请确认筛选条件'
    ]);
    // "large" defaults to count > 100 and can be forced either way
    assert.equal(usage.buildTrashConfirmText({ count: 100 }).includes('数量较多'), false);
    assert.equal(usage.buildTrashConfirmText({ count: 101 }).includes('数量较多'), true);
    assert.equal(usage.buildTrashConfirmText({ count: 5, large: true }).includes('数量较多'), true);
    assert.equal(usage.buildTrashConfirmText({ count: 500, large: false }).includes('数量较多'), false);
});

test('formatUsageTooltip lists counts, the last use and the protection note', () => {
    const now = new Date(2026, 8, 25, 9, 0).getTime();
    const lastUsedAt = new Date(2026, 8, 24, 14, 3).getTime();
    assert.equal(
        usage.formatUsageTooltip({ dragCount: 3, referenceCount: 1, lastUsedAt }, now),
        '拖出/复制/另存 3 次 · 用作参考图 1 次\n最近使用：9月24日 14:03\n批量删除时默认保留'
    );
    assert.equal(
        usage.formatUsageTooltip({ dragCount: 0, referenceCount: 2, lastUsedAt }, now),
        '用作参考图 2 次\n最近使用：9月24日 14:03\n批量删除时默认保留'
    );
    // dragCount counts every way out of PicGen: native drag-out, 复制图片, 另存为.
    assert.equal(usage.formatUsageTooltip({ dragCount: 1 }, now), '拖出/复制/另存 1 次\n批量删除时默认保留');
    // a use from another year carries the year
    const lastYear = new Date(2025, 0, 5, 8, 7).getTime();
    assert.equal(
        usage.formatUsageTooltip({ dragCount: 1, lastUsedAt: lastYear }, new Date(now)),
        '拖出/复制/另存 1 次\n最近使用：2025年1月5日 08:07\n批量删除时默认保留'
    );
    assert.equal(usage.formatUsageTooltip({ dragCount: 0, referenceCount: 0 }, now), '');
    assert.equal(usage.formatUsageTooltip(null, now), '');
});

test('historyUsage.js is a UMD module exposing window.PicGenHistoryUsage', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'historyUsage.js'), 'utf8');
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source, sandbox, { filename: 'historyUsage.js' });
    const api = sandbox.PicGenHistoryUsage;
    assert.ok(api, 'global PicGenHistoryUsage is defined');
    for (const name of ['usageKey', 'usageTotal', 'isProtected', 'classifyDragEnd',
        'applyTombstones', 'buildTrashConfirmText', 'formatUsageTooltip']) {
        assert.equal(typeof api[name], 'function', name);
    }
    assert.equal(api.usageKey({ filePath: 'C:\\x\\A.png', fileSize: 1 }), 'a.png|1');
});
