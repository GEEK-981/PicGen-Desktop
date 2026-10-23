const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { UnifiedProviderStore } = require('../providerStore');
const { ProviderRoleStore } = require('../providerRoleStore');

async function fixture(t, images = [], chats = []) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-supplier-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const options = { filePath: path.join(dir, 'unified.json'), providerStoreFile: path.join(dir, 'image.json'), chatProviderStoreFile: path.join(dir, 'chat.json'),
        secretCodec: { encrypt: key => `enc:v1:${Buffer.from(key).toString('base64')}`, decrypt: key => Buffer.from(key.slice(7), 'base64').toString() } };
    await fs.writeFile(options.providerStoreFile, JSON.stringify({ providers: images }));
    await fs.writeFile(options.chatProviderStoreFile, JSON.stringify({ providers: chats }));
    const store = new UnifiedProviderStore(options);
    await store.load();
    return { store, options, dir, images: new ProviderRoleStore(store, 'image'), chats: new ProviderRoleStore(store, 'chat') };
}
function group(id, extra = {}) { return { id, name: 'Fzl', baseUrl: 'https://fixture.invalid/v1', apiKey: `key-${id}`, models: ['model'], ...extra }; }

test('supplier and group CRUD preserves sibling credentials and stays deleted after restart', async t => {
    const f = await fixture(t, [group('image')], [group('chat')]);
    const supplier = (await f.store.list())[0];
    await f.store.addGroup(supplier.id, {id:'second-image',role:'image',apiKey:'key-second',models:['one','two'],activeModel:'two'});
    await f.store.update(supplier.id, {name:'Renamed',baseUrl:'https://renamed.invalid'});
    await f.store.updateGroup(supplier.id, 'second-image', {models:['two-renamed'],activeModel:'two-renamed',modelPricing:{'two-renamed':0.1}});
    let reloaded = new UnifiedProviderStore(f.options);
    let current = await reloaded.get(supplier.id);
    assert.equal(current.groups.length,3);
    assert.equal(current.name,'Renamed');
    assert.equal(current.groups.find(g => g.id === 'chat').apiKey,'key-chat');
    assert.equal(current.groups.find(g => g.id === 'image').apiKey,'key-image');
    assert.equal(current.groups.find(g => g.id === 'second-image').activeModel,'two-renamed');
    await reloaded.deleteGroup(supplier.id,'second-image');
    reloaded = new UnifiedProviderStore(f.options);
    assert.deepEqual((await reloaded.get(supplier.id)).groups.map(g => g.id), ['image','chat']);
    await reloaded.delete(supplier.id);
    assert.deepEqual(await new UnifiedProviderStore(f.options).list(), []);
});

test('migration unifies identity but preserves independent keys, models and IDs across restart', async t => {
    const f = await fixture(t, [group('image', { models: ['image-a', 'image-b'] })], [group('chat', { models: ['vision-a', 'vision-b'], activeModel: 'vision-b' })]);
    const suppliers = await f.store.list();
    assert.equal(suppliers.length, 1);
    assert.equal(suppliers[0].groups.length, 2);
    assert.equal(await f.images.get('chat'), null);
    assert.equal(await f.chats.get('image'), null);
    assert.equal((await f.chats.get('chat')).model, 'vision-b');
    assert.equal((await fs.readdir(f.dir)).filter(name => name.includes('.bak-')).length, 2);
    assert.ok(!(await fs.readFile(f.options.filePath, 'utf8')).includes('key-image'));
    await f.store.updateGroup(suppliers[0].id, 'image', { apiKey: 'key-rotated', enabled: false });
    await f.store.updateGroup(suppliers[0].id, 'image', { enabled: true });
    const restarted = new UnifiedProviderStore(f.options);
    const image = await new ProviderRoleStore(restarted, 'image').get('image');
    assert.equal(image.apiKey, 'key-rotated');
    assert.equal(image.enabled, true);
    assert.deepEqual(image.models, ['image-a', 'image-b']);
    assert.equal((await new ProviderRoleStore(restarted, 'chat').get('chat')).apiKey, 'key-chat');
});

test('changing route order keeps each key attached to its original supplier and survives restart', async t => {
    const f = await fixture(t, [group('a'), group('b', { name: 'Second', baseUrl: 'https://second.invalid' })]);
    await f.images.reorder(['b', 'a']);
    const restarted = new ProviderRoleStore(new UnifiedProviderStore(f.options), 'image');
    const rows = await restarted.list();
    assert.deepEqual(rows.map(row => row.id), ['b', 'a']);
    assert.equal(rows[0].baseUrl, 'https://second.invalid');
    assert.equal(rows[0].apiKey, 'key-b');
    assert.equal(rows[1].baseUrl, 'https://fixture.invalid/v1');
});

test('legacy editor writes and supplier editor writes share one canonical configuration', async t => {
    const f = await fixture(t, [group('image')], [group('chat')]);
    const supplier = (await f.store.list())[0];
    await f.images.update('image', { maxConcurrent: 4, modelRouting: { model: { protocol: 'openai-images' } } });
    await f.store.update(supplier.id, { name: 'Renamed', baseUrl: 'https://updated.invalid' });
    await f.store.updateGroup(supplier.id, 'image', { apiKey: 'new-image' });
    assert.equal((await f.images.get('image')).maxConcurrent, 4);
    assert.equal((await f.images.get('image')).modelRouting.model.protocol, 'openai-images');
    assert.equal((await f.images.get('image')).apiKey, 'new-image');
    assert.equal((await f.chats.get('chat')).baseUrl, 'https://updated.invalid');
    await f.images.delete('image');
    assert.equal((await f.images.list()).length, 0);
    assert.equal((await new ProviderRoleStore(new UnifiedProviderStore(f.options), 'image').list()).length, 0);
    assert.equal((await f.chats.get('chat')).apiKey, 'key-chat');
});

test('malformed canonical config fails without replacing it or reimporting old keys', async t => {
    const f = await fixture(t, [group('image')]);
    await fs.writeFile(f.options.filePath, '{ broken');
    await assert.rejects(new UnifiedProviderStore(f.options).load());
    assert.equal(await fs.readFile(f.options.filePath, 'utf8'), '{ broken');
});

test('merges configured legacy stores when canonical file is only an empty placeholder', async t => {
    const f = await fixture(t, [group('image')], [group('chat')]);
    await fs.writeFile(f.options.filePath, JSON.stringify({ schemaVersion: 1, providers: [{ id: 'placeholder', name: '当前 API', baseUrl: '', groups: [{ id: 'placeholder-group', role: 'image', models: [] }] }] }));
    const reloaded = new UnifiedProviderStore(f.options);
    const suppliers = await reloaded.list();
    assert.equal(suppliers.length, 1);
    assert.deepEqual(suppliers[0].groups.map(item => item.id).sort(), ['chat', 'image']);
    assert.equal(suppliers[0].groups.find(item => item.id === 'image').apiKey, 'key-image');
    assert.equal(suppliers[0].groups.find(item => item.id === 'chat').apiKey, 'key-chat');
    const secondLoad = await new UnifiedProviderStore(f.options).list();
    assert.deepEqual(secondLoad[0].groups.map(item => item.id).sort(), ['chat', 'image']);
});
