const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OutputConfigStore, normalizeDirectory } = require('../outputConfig');

test('persists and resets an absolute default output directory', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-output-config-'));
    const filePath = path.join(directory, 'data', 'output-config.json');
    const outputDirectory = path.join(directory, 'generated-images');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const store = new OutputConfigStore({ filePath });
    assert.deepEqual(await store.get(), { directory: '', saveAsDirectory: '' });
    assert.equal((await store.update({ directory: outputDirectory })).directory, outputDirectory);
    assert.equal((await new OutputConfigStore({ filePath }).get()).directory, outputDirectory);
    assert.deepEqual(await store.update({ directory: '' }), { directory: '', saveAsDirectory: '' });
});

test('remembers the folder last picked in 另存为 across restarts, and a bad value never resets the output directory', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-output-config-'));
    const filePath = path.join(directory, 'output-config.json');
    const picked = path.join(directory, 'exports');
    const outputDirectory = path.join(directory, 'generated-images');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const store = new OutputConfigStore({ filePath });
    await store.update({ directory: outputDirectory });
    assert.equal((await store.update({ saveAsDirectory: picked })).saveAsDirectory, picked);
    assert.equal((await store.get()).directory, outputDirectory, 'remembering the save-as folder leaves the output directory alone');
    assert.deepEqual(await new OutputConfigStore({ filePath }).get(), { directory: outputDirectory, saveAsDirectory: picked });

    // Concurrent updates (settings changes 保存目录 while a Save As remembers its folder) both land; no temp file is left.
    await Promise.all([store.update({ directory: path.join(directory, 'other') }), store.update({ saveAsDirectory: path.join(directory, 'later') })]);
    assert.deepEqual(await new OutputConfigStore({ filePath }).get(), { directory: path.join(directory, 'other'), saveAsDirectory: path.join(directory, 'later') });
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), []);

    // A hand-edited relative value is only a hint: dropped, while the output directory survives.
    fs.writeFileSync(filePath, JSON.stringify({ directory: outputDirectory, saveAsDirectory: 'relative/exports' }));
    assert.deepEqual(await new OutputConfigStore({ filePath }).get(), { directory: outputDirectory, saveAsDirectory: '' });
});

test('rejects relative output directories', () => {
    assert.throws(() => normalizeDirectory('relative/output'), /绝对路径/);
});

test('places the save directory tab immediately after network settings', () => {
    const html = require('../scripts/read-ui-source')();
    const networkTab = html.indexOf('id="networkSettingsTab"');
    const outputTab = html.indexOf('id="outputSettingsTab"');
    const panels = html.indexOf('id="imageSettingsPanel"');

    assert.ok(networkTab >= 0 && outputTab > networkTab && outputTab < panels);
    assert.match(html.slice(networkTab, outputTab), /网络设置/);
    assert.match(html.slice(outputTab, panels), /保存目录/);
});
