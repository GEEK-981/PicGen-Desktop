const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    createSerialTaskQueue,
    readJsonFile,
    writeJsonAtomic,
    writeFileExclusive,
    buildGeneratedImageFileName
} = require('../historyPersistence');

async function temporaryDirectory() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'picgen-history-'));
}

test('serializes concurrent history index mutations without losing records', async t => {
    const directory = await temporaryDirectory();
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const indexFile = path.join(directory, 'recent-images.json');
    const enqueue = createSerialTaskQueue();
    await writeJsonAtomic(indexFile, { schemaVersion: 4, images: [] });

    await Promise.all(Array.from({ length: 40 }, (_, index) => enqueue(async () => {
        const current = await readJsonFile(indexFile, { schemaVersion: 4, images: [] });
        await new Promise(resolve => setTimeout(resolve, index % 3));
        current.images.unshift({ id: `task-${index}`, filePath: `image-${index}.png` });
        await writeJsonAtomic(indexFile, current);
    })));

    const saved = await readJsonFile(indexFile, null);
    assert.equal(saved.images.length, 40);
    assert.equal(new Set(saved.images.map(image => image.id)).size, 40);
});

test('writes generated files exclusively when names collide', async t => {
    const directory = await temporaryDirectory();
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const paths = await Promise.all([
        writeFileExclusive(directory, 'same.png', Buffer.from('first')),
        writeFileExclusive(directory, 'same.png', Buffer.from('second'))
    ]);

    assert.equal(new Set(paths).size, 2);
    assert.deepEqual(
        new Set(await Promise.all(paths.map(filePath => fs.readFile(filePath, 'utf8')))),
        new Set(['first', 'second'])
    );
});

test('includes the task id in generated image file names', () => {
    const fileName = buildGeneratedImageFileName({
        id: 'task_123_abc',
        prompt: 'white cable',
        extension: 'png',
        safeName: value => String(value).replace(/\s+/g, '-'),
        now: new Date('2026-08-26T03:09:26.182Z')
    });
    assert.equal(fileName, '2026-08-26T03-09-26-182Z_white-cable_task_123_abc.png');
});
