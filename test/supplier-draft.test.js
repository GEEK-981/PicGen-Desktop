const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const draftModule = import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'supplierDraft.mjs')).href);

test('readModelRows keeps prices, protocols and untouched routing metadata', async () => {
    const { readModelRows } = await draftModule;
    const draft = readModelRows([
        { name: 'first', price: '0.12', protocol: 'openai-images', routingExtras: { group: 'custom', enabled: false } },
        { name: ' second ', price: '', protocol: 'auto', routingExtras: {} },
        { name: '', price: '9', protocol: 'auto', routingExtras: {} }
    ], { activeModel: 'second' });
    assert.deepEqual(draft.models, ['first', 'second']);
    assert.equal(draft.modelPricing.first, 0.12);
    assert.equal('second' in draft.modelPricing, false);
    assert.equal(draft.modelRouting.first.protocol, 'openai-images');
    assert.equal(draft.modelRouting.first.group, 'custom');
    assert.equal(draft.modelRouting.first.enabled, false);
    assert.equal(draft.activeModel, 'second');
});

test('readModelRows validation rejects duplicates, bad prices and empty lists', async () => {
    const { readModelRows } = await draftModule;
    assert.throws(() => readModelRows([
        { name: 'dup', price: '', protocol: 'auto' },
        { name: 'dup', price: '', protocol: 'auto' }
    ], { validate: true }), /模型名称重复：dup/);
    assert.throws(() => readModelRows([
        { name: 'one', price: '-1', protocol: 'auto' }
    ], { validate: true }), /有效的非负价格/);
    assert.throws(() => readModelRows([{ name: '', price: '', protocol: 'auto' }], { validate: true }), /至少填写一个模型名称/);
    // Zero is a real price and duplicates without validation are skipped quietly.
    const lenient = readModelRows([
        { name: 'one', price: '0', protocol: 'auto' },
        { name: 'one', price: '3', protocol: 'auto' }
    ], {});
    assert.deepEqual(lenient.models, ['one']);
    assert.equal(lenient.modelPricing.one, 0);
    assert.equal(lenient.activeModel, 'one');
});

test('rowsFromGroup round-trips a persisted group through readModelRows', async () => {
    const { rowsFromGroup, readModelRows } = await draftModule;
    const group = {
        models: ['a', 'b'],
        modelPricing: { a: 0.5 },
        modelRouting: { a: { protocol: 'gemini-native', group: 'g1', enabled: false } },
        activeModel: 'b'
    };
    const rows = rowsFromGroup(group);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.key));
    const draft = readModelRows(rows, { validate: true, activeModel: 'b' });
    assert.deepEqual(draft.models, ['a', 'b']);
    assert.equal(draft.modelPricing.a, 0.5);
    assert.deepEqual(draft.modelRouting.a, { group: 'g1', enabled: false, protocol: 'gemini-native' });
    assert.deepEqual(draft.modelRouting.b, { protocol: 'auto' });
    assert.equal(draft.activeModel, 'b');
    const blank = rowsFromGroup(null);
    assert.equal(blank.length, 1);
    assert.equal(blank[0].name, '');
});

test('identity and capacity validation match the panel error copy', async () => {
    const { validateSupplierIdentity, validateGroupCapacity } = await draftModule;
    assert.throws(() => validateSupplierIdentity({ name: '', baseUrl: 'https://x.example' }), /名称和 Base URL/);
    assert.throws(() => validateSupplierIdentity({ name: 'x', baseUrl: 'ftp://x.example' }), /http:\/\/ 或 https:\/\//);
    assert.doesNotThrow(() => validateSupplierIdentity({ name: 'x', baseUrl: 'https://x.example' }));
    assert.throws(() => validateGroupCapacity({ role: 'image', maxConcurrent: '9' }), /1～8 的整数/);
    assert.throws(() => validateGroupCapacity({ role: 'image', maxConcurrent: '1.5' }), /1～8 的整数/);
    assert.doesNotThrow(() => validateGroupCapacity({ role: 'chat', maxConcurrent: '99' }));
    assert.doesNotThrow(() => validateGroupCapacity({ role: 'image', maxConcurrent: '8' }));
});

test('mergeDiscoveredModels dedupes by id and accepts strings or objects', async () => {
    const { mergeDiscoveredModels } = await draftModule;
    const merged = mergeDiscoveredModels(
        [{ id: 'a', supported_endpoint_types: ['openai'], discoveredAt: 1 }],
        ['a', 'b', { id: 'c', supported_endpoint_types: ['gemini'] }],
        99
    );
    assert.deepEqual(merged.map(item => item.id), ['a', 'b', 'c']);
    assert.equal(merged[0].discoveredAt, 1, 'existing entries keep their metadata');
    assert.equal(merged[1].discoveredAt, 99);
    assert.deepEqual(merged[2].supported_endpoint_types, ['gemini']);
});
