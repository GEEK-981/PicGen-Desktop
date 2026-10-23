const test = require('node:test');
const assert = require('node:assert/strict');
const ux = require('../userExperience');
const { resolvePromptMentions } = require('../rendererUtils');
const ProviderManager = require('../providerManager');

test('error advice preserves uncertain billing and distinguishes quota from rate limit', () => {
    assert.match(ux.explainError({ code: 'OUTCOME_UNCERTAIN', httpStatus: 504 }).advice, /先.*核对/);
    assert.equal(ux.explainError({ httpStatus: 429, message: 'insufficient_quota' }).title, '供应商额度不足');
    assert.equal(ux.explainError({ httpStatus: 429 }).action, 'concurrency');
    assert.equal(ux.explainError({ httpStatus: 401 }).action, 'provider');
    assert.equal(ux.explainError({ code: 'ENOSPC' }).action, 'output');
    assert.equal(ux.explainError({ code: 'ENOTFOUND' }).action, 'network');
    assert.equal(ux.explainError({ code: 'RESULT_DOWNLOAD_FAILED', message: 'DEPTH_ZERO_SELF_SIGNED_CERT' }).title, '结果图下载被假证书拦住');
    assert.equal(ux.explainError({ code: 'RESULT_DOWNLOAD_FAILED', message: 'DEPTH_ZERO_SELF_SIGNED_CERT' }).action, 'network');
});

test('reference reordering preserves image identity and updates resolved mention positions', () => {
    const refs = [{ id: 'a', name: 'subject.png' }, { id: 'b', name: 'style.png' }, { id: 'c', name: 'layout.png' }];
    const next = ux.reorderReferences(refs, 'a', 'c', true);
    assert.deepEqual(next.map(ref => ref.id), ['b', 'c', 'a']);
    assert.equal(resolvePromptMentions('@{subject} follows @{style}', next), '参考图3 follows 参考图1');
    assert.deepEqual(refs.map(ref => ref.id), ['a', 'b', 'c']);
    assert.equal(ux.reorderReferences(refs, 'missing', 'b'), refs);
});

test('historyKey prefers the record id, then the path, then the file name', () => {
    assert.equal(ux.historyKey({ id: 'task_1', filePath: 'D:\\a.png', fileName: 'a.png' }), 'task_1');
    assert.equal(ux.historyKey({ filePath: 'D:\\a.png', fileName: 'a.png' }), 'D:\\a.png');
    assert.equal(ux.historyKey({ id: '', filePath: '', fileName: 'a.png' }), 'a.png');
    assert.equal(ux.historyKey({ id: 42 }), '42');
    assert.equal(ux.historyKey({}), '');
    assert.equal(ux.historyKey(null), '');
    assert.equal(ux.historyKey(undefined), '');
    // The v2 perceptual-hash helpers are gone with blockhash-core.
    assert.equal(ux.clusterImages, undefined);
    assert.equal(ux.hashDistance, undefined);
});

test('explicit aliases override repeated filenames after sorting', () => {
    const references = [{ id: 'a', name: 'subject.png', alias: 'subject' }, { id: 'b', name: 'subject.png', alias: 'subject (2)' }];
    const reordered = ux.reorderReferences(references, 'a', 'b', true);
    assert.equal(resolvePromptMentions('@{subject} with @{subject (2)}', reordered), '参考图2 with 参考图1');
});

test('priority affects only priority mode and balanced ties; ranking has honest missing data', t => {
    const manager = new ProviderManager({ strategy: 'priority' }); t.after(() => manager.close());
    manager.syncProviders(Array.from({ length: 7 }, (_, i) => ({ id: String(i), name: `Group ${i}`, baseUrl: 'https://fixture.invalid', apiKey: 'fixture',
        models: ['model'], priority: i === 1 ? 1 : 10, modelPricing: { model: i === 6 ? null : i }, maxConcurrent: 1 })));
    const selected = manager.reserve({ model: 'model' }); assert.equal(selected.providerId, '1'); manager.releaseReservation(selected);
    assert.equal(manager.getRanking('model', 'speed')[0].latencyMs, null);
    manager.recordSuccess('2', 1250);
    const ranking = manager.getRanking('model', 'speed');
    assert.equal(ranking.length, 5); assert.equal(ranking[0].id, '2'); assert.equal(ranking[0].latencyMs, 1250);
    assert.equal(ranking[0].samples, 1); assert.equal(manager.getRanking('model', 'price')[0].price, 0);
    assert.equal(manager.getRanking('missing', 'price').length, 0);
});
