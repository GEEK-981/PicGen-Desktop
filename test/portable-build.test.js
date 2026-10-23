const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPortable, promoteArtifact } = require('../scripts/build-portable');

test('a locked portable EXE publishes beside the running version', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-locked-exe-'));
    t.after(() => fs.rmSync(root, {recursive:true, force:true}));
    const source = path.join(root, 'built.exe');
    const destination = path.join(root, 'PicGen.exe');
    fs.writeFileSync(source, 'new-build'); fs.writeFileSync(destination, 'running-version');
    const result = promoteArtifact(source, destination, () => { throw Object.assign(new Error('locked'), {code:'EPERM'}); });
    assert.notEqual(result, destination);
    assert.equal(path.dirname(result), root);
    assert.equal(fs.readFileSync(result, 'utf8'), 'new-build');
    assert.equal(fs.readFileSync(destination, 'utf8'), 'running-version');
});

for (const fail of [false, true]) test(`portable build preserves the live profile ${fail ? 'on failure' : 'on success'}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-build-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const output = path.join(root, 'dist', 'release');
    const data = path.join(output, 'PicGenData');
    fs.mkdirSync(path.join(data, 'desktop-cache'), { recursive: true });
    const original = {
        'providers.json': '{"fixture":"encrypted-test-only"}',
        'Local State': 'fixture-encryption-profile',
        'desktop-cache/recent-images.json': '{"images":[{"id":"history"}]}',
        'desktop-cache/history-usage.json': '{"version":1,"entries":{"history.png|42":{"dragCount":1,"referenceCount":0}}}',
        'desktop-cache/history-trash.json': '{"version":1,"entries":[]}'
    };
    for (const [name, content] of Object.entries(original)) fs.writeFileSync(path.join(data, name), content);
    fs.writeFileSync(path.join(output, 'PicGen-2.2.1-x64.exe'), 'old-exe');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.2.1', build: { productName: 'PicGen' } }));
    const build = async options => {
        const stage = options.config.directories.output;
        assert.equal(path.dirname(stage), path.join(root, 'dist'));
        assert.notEqual(stage, output);
        assert.equal(options.publish, 'never');
        // A builder may clear all its output. Live data must remain in place.
        fs.rmSync(stage, { recursive: true });
        assert.ok(fs.existsSync(path.join(data, 'providers.json')));
        if (fail) throw new Error('simulated build failure');
        fs.mkdirSync(path.join(stage, 'PicGenData'), { recursive: true });
        fs.writeFileSync(path.join(stage, 'PicGenData', 'providers.json'), 'unwanted-profile');
        fs.writeFileSync(path.join(stage, 'PicGen-2.2.1-x64.exe'), 'new-exe');
    };
    if (fail) await assert.rejects(buildPortable({ root, build }), /simulated build failure/);
    else assert.deepEqual(await buildPortable({ root, build }), [path.join(output, 'PicGen-2.2.1-x64.exe')]);
    for (const [name, content] of Object.entries(original)) assert.equal(fs.readFileSync(path.join(data, name), 'utf8'), content);
    assert.equal(fs.readFileSync(path.join(output, 'PicGen-2.2.1-x64.exe'), 'utf8'), fail ? 'old-exe' : 'new-exe');
});
