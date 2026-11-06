const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A renderer crash right at startup (STATUS_BREAKPOINT while loading desktop.html)
// left a blank 60x60 window and, because loadFile threw, no tray icon either.
const source = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');
// A top-level closing brace on its own line, with either line ending.
const FUNCTION_END = /\r?\n}\r?\n/;
const between = (start, end) => {
    const rest = source.slice(source.indexOf(start));
    const stop = end instanceof RegExp ? rest.search(end) : rest.indexOf(end);
    return stop < 0 ? rest : rest.slice(0, stop);
};

test('a crashed main renderer is reloaded, with a crash-loop limit', () => {
    const handler = between("mainWindow.webContents.on('render-process-gone'", "mainWindow.webContents.on('did-fail-load'");
    assert.match(handler, /recoverMainRenderer\(\)/);
    const recover = between('function recoverMainRenderer', FUNCTION_END);
    assert.match(recover, /RENDERER_RECOVERY_LIMIT/);
    assert.match(recover, /loadFile\(DESKTOP_PAGE\)/);
    assert.match(source, /const RENDERER_RECOVERY_LIMIT = 3;/);
});

test('a failed first page load does not abort startup (the tray still gets created)', () => {
    const load = between('await mainWindow.loadFile(DESKTOP_PAGE);', FUNCTION_END);
    assert.doesNotMatch(load, /throw error/);
    assert.match(load, /recoverMainRenderer\(\)/);
    assert.match(source, /await createWindow\(\);\s*createTray\(\);/);
});

test('launching PicGen again reloads a dead window', () => {
    const handler = between("app.on('second-instance'", "app.on('activate'");
    assert.match(handler, /isCrashed\(\)[\s\S]*recoverMainRenderer\(\{ force: true \}\)/);
});

test('crash dumps are kept locally and never uploaded', () => {
    assert.match(source, /app\.setPath\('crashDumps', path\.join\(app\.getPath\('userData'\), 'Crashpad'\)\)/);
    assert.match(source, /crashReporter\.start\(\{ uploadToServer: false/);
    // userData must be final (portable PicGenData) before the dump path is derived from it.
    assert.ok(source.indexOf("app.setPath('userData'") < source.indexOf("app.setPath('crashDumps'"));
});

test('a crashed image preview window is dropped and rebuilt on demand', () => {
    const create = between('function createImagePreviewWindow', 'function raiseImagePreviewWindow');
    assert.match(create, /render-process-gone[\s\S]*previewWindow\.destroy\(\)/);
});
