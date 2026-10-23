const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { UnifiedProviderStore, ProviderStore, ChatProviderStore } = require('../providerStore');

async function temporaryDirectory() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'picgen-secret-'));
}

test('keeps encrypted credentials when safe storage cannot decrypt them', async t => {
    const directory = await temporaryDirectory();
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const encrypted = 'enc:v1:credential-from-another-profile';
    const codec = { encrypt: value => `enc:v1:${value}`, decrypt: () => { throw new Error('unavailable'); } };
    const files = [
        [path.join(directory, 'providers.json'), { schemaVersion: 1, providers: [{ id: 'u1', name: 'A', baseUrl: 'https://a.invalid', groups: [{ id: 'g1', role: 'image', apiKey: encrypted, models: ['m'] }] }] }],
        [path.join(directory, 'api-providers.json'), { schemaVersion: 2, providers: [{ id: 'p1', name: 'A', baseUrl: 'https://a.invalid', apiKey: encrypted, models: ['m'] }] }],
        [path.join(directory, 'chat-providers.json'), { schemaVersion: 2, providers: [{ id: 'c1', name: 'A', baseUrl: 'https://a.invalid', apiKey: encrypted, models: ['m'] }] }]
    ];
    for (const [file, value] of files) await fs.writeFile(file, `${JSON.stringify(value)}\n`);

    const unified = new UnifiedProviderStore({ filePath: files[0][0], secretCodec: codec });
    await unified.load();
    const imageKey = JSON.parse(await fs.readFile(files[0][0], 'utf8')).providers[0].groups[0].apiKey;
    assert.equal(imageKey, encrypted);

    const image = new ProviderStore({ filePath: files[1][0], secretCodec: codec });
    await image.load();
    await image.save();
    assert.equal(JSON.parse(await fs.readFile(files[1][0], 'utf8')).providers[0].apiKey, encrypted);

    const chat = new ChatProviderStore({ filePath: files[2][0], secretCodec: codec });
    await chat.load();
    assert.equal(JSON.parse(await fs.readFile(files[2][0], 'utf8')).providers[0].apiKey, encrypted);
});

