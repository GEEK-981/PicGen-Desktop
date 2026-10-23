const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PreviewCache } = require('../previewCache');
const image = { isEmpty: () => false, getSize: () => ({ width: 1000, height: 1000 }), toPNG: () => Buffer.from('thumbnail') };

test('hover cache reuses a decoded image, persists it, and invalidates changed files', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-preview-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source.png'); await fs.writeFile(source, 'original');
    let decodes = 0;
    const options = { directory: path.join(root, 'cache'), createThumbnail: async () => { decodes++; return image; } };
    const cache = new PreviewCache(options);
    const [first, second] = await Promise.all([cache.get(source), cache.get(source)]);
    assert.equal(first, second); assert.equal(decodes, 1);
    assert.equal(await cache.get(source), first);
    assert.equal(await new PreviewCache(options).get(source), first); assert.equal(decodes, 1);
    await fs.writeFile(source, 'changed original');
    assert.notEqual(await cache.get(source), first); assert.equal(decodes, 2);
});

test('a fast sweep decodes only the active and latest images and serializes native work', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-preview-sweep-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sources = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
        const file = path.join(root, `${i}.png`); await fs.writeFile(file, `image-${i}`); return file;
    }));
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const decoded = [];
    const cache = new PreviewCache({ directory: path.join(root, 'cache'), createThumbnail: async source => {
        decoded.push(source);
        if (source === sources[0]) { started(); await blocked; }
        return image;
    } });
    let current = 0;
    const requests = [cache.get(sources[0], () => current === 0)];
    await ready;
    for (let i = 1; i < sources.length; i++) { current = i; requests.push(cache.get(sources[i], () => current === i)); }
    release();
    const results = await Promise.all(requests);
    assert.deepEqual(decoded, [sources[0], sources.at(-1)]);
    assert.ok(results.slice(0, -1).every(result => result === null)); assert.ok(results.at(-1));
});
