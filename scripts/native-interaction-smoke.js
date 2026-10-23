if (!process.versions.electron) {
    const { spawn } = require('node:child_process');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|COOKIE|PROXY|^PICGEN_|^IMAGE_|^TTS_|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/i.test(key)) delete env[key];
    const child = spawn(require('electron'), [__filename, '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'], {env,stdio:'inherit',windowsHide:true});
    child.on('exit', code => { process.exitCode = code ?? 1; });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
} else {
// Run with Electron. This process uses only a fresh temporary profile and local fixtures.
const { app, BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(action, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const result = await action(); if (result) return result; await pause(50); }
    throw new Error(`Timed out: ${label}`);
}

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-native-interaction-'));
    app.setPath('userData', root);
    app.setAppPath(path.resolve(__dirname, '..'));
    process.env.PICGEN_PROVIDER_STORE = path.join(root, 'api-providers.json');
    process.env.PICGEN_CHAT_PROVIDER_STORE = path.join(root, 'chat-providers.json');
    process.env.PICGEN_FAILOVER_CONFIG = path.join(root, 'failover-config.json');
    process.env.PICGEN_PROXY_CONFIG = path.join(root, 'proxy-config.json');
    // 预览只在真实光标位于 PicGen 窗口内时显示；本冒烟直接调用显示接口、不移动系统光标
    process.env.PICGEN_SMOKE_PREVIEW_ANY_CURSOR = '1';
    await fs.writeFile(process.env.PICGEN_FAILOVER_CONFIG, '{"enabled":false,"strategy":"fixed","maxGlobalConcurrent":1}');
    await fs.writeFile(process.env.PICGEN_PROXY_CONFIG, '{"mode":"direct"}');
    await app.whenReady();
    // The adapter reads the normal screen API. Override only the pointer in this test process.
    let point = { x: -99999, y: -99999 };
    screen.getCursorScreenPoint = () => point;
    let decodes = 0;
    const originalThumbnail = nativeImage.createThumbnailFromPath;
    nativeImage.createThumbnailFromPath = async (...args) => { decodes++; return originalThumbnail(...args); };
    require('../electron-main');
    const win = await waitFor(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/desktop.html')), 'main window');
    const run = expression => win.webContents.executeJavaScript(expression, true);
    await waitFor(() => run(`typeof state!=='undefined' && !!state.currentSequenceId`), 'renderer');
    await run('window.picgenDesktop.setExpanded(true)');
    await waitFor(() => run(`window.picgenDesktop.getWindowState().then(s=>s.expanded)`), 'expanded');
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const original = win.getBounds();
    // Native titlebar movement emits will-move/moved; custom launcher movement uses IPC.
    win.emit('will-move');
    win.setPosition(area.x, area.y + 20);
    win.emit('moved');
    await waitFor(() => run(`window.picgenDesktop.getWindowState().then(s=>s.dock.hidden)`), 'automatic hide after pointer leaves');
    const edgeWindow = await waitFor(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/edge-tab.html')), 'edge window loaded');
    const tab = (await run('window.picgenDesktop.getWindowState()')).bounds;
    assert.equal(tab.width, 12); assert.equal(tab.height, 72);
    await fs.writeFile(path.join(root, 'edge-tab.png'), (await edgeWindow.capturePage()).toPNG());
    point = { x: tab.x + 6, y: tab.y + 20 };
    await waitFor(() => run(`window.picgenDesktop.getWindowState().then(s=>s.expanded)`), 'hover reveals without click');
    assert.equal(win.getBounds().width, original.width); assert.equal(win.getBounds().height, original.height);
    win.focus();
    await run(`document.getElementById('promptInput').focus()`);
    await waitFor(() => run(`document.hasFocus() && document.activeElement.id==='promptInput'`), 'focused editing fixture');
    point = { x: area.x + area.width - 10, y: area.y + 10 };
    await pause(1100);
    assert.equal((await run('window.picgenDesktop.getWindowState()')).expanded, true);
    await run(`window.picgenDesktop.pinWindow(true); document.activeElement.blur()`);
    await pause(1100);
    assert.equal((await run('window.picgenDesktop.getWindowState()')).expanded, true);
    await run('window.picgenDesktop.pinWindow(false)');
    await waitFor(() => run(`window.picgenDesktop.getWindowState().then(s=>s.dock.hidden)`), 'unpin resumes auto-hide');
    // A quick press on the thin tab (before hover intent) must restore the ordinary launcher size.
    await run(`window.picgenDesktop.startWindowMove({x:0,y:0}); window.picgenDesktop.moveWindow({x:160,y:0}); window.picgenDesktop.endWindowMove()`);
    const dragged = await waitFor(() => run(`window.picgenDesktop.getWindowState().then(s=>s.dock.edge===null ? s : null)`), 'drag tab away');
    assert.equal(dragged.bounds.width, 60); assert.equal(dragged.bounds.height, 60);
    await fs.writeFile(path.join(root, 'circular-launcher.png'), (await win.capturePage()).toPNG());
    await run('window.picgenDesktop.setExpanded(true)');

    // Make a real 4096px fixture before measuring the UI path.
    const pixels = Buffer.alloc(64 * 64 * 4, 255);
    for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 160; pixels[i + 1] = 100 + (i / 4) % 64; pixels[i + 2] = 70; }
    const fixture = nativeImage.createFromBitmap(pixels, {width:64, height:64}).resize({ width: 4096, height: 4096 });
    assert.equal(fixture.isEmpty(), false);
    const fixtureDirectory = path.join(root, 'desktop-cache', 'images');
    await fs.mkdir(fixtureDirectory, { recursive: true });
    const file = path.join(fixtureDirectory, 'large-preview.png');
    await fs.writeFile(file, fixture.toPNG());
    const preview = await waitFor(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/image-preview.html')), 'warm preview window');
    const payload = JSON.stringify({ filePath: file, width: 4096, height: 4096, model: '本地测试', providerName: '无 API 调用', x: area.x + 500, y: area.y + 500 });
    const firstStart = performance.now();
    const decodesBefore = decodes;
    let maxHeartbeatGap = 0, previous = performance.now();
    const heartbeat = setInterval(() => { const now = performance.now(); maxHeartbeatGap = Math.max(maxHeartbeatGap, now - previous); previous = now; }, 10);
    await run(`window.picgenDesktop.showImagePreview(${payload})`);
    await waitFor(() => preview.isVisible(), '4096px preview visible');
    const coldMs = performance.now() - firstStart;
    const dimensions = await preview.webContents.executeJavaScript('({width:previewImage.naturalWidth,height:previewImage.naturalHeight})');
    assert.ok(Math.max(dimensions.width, dimensions.height) <= 1000);
    await run('window.picgenDesktop.hideImagePreview()');
    await waitFor(() => !preview.isVisible(), 'preview hidden');
    const warmStart = performance.now();
    await run(`window.picgenDesktop.showImagePreview(${payload})`);
    await waitFor(() => preview.isVisible(), 'cached preview visible');
    const warmMs = performance.now() - warmStart;
    clearInterval(heartbeat);
    assert.equal(decodes - decodesBefore, 0);
    await run('window.picgenDesktop.hideImagePreview()');
    await waitFor(() => !preview.isVisible(), 'preview hidden for fallback');
    nativeImage.createThumbnailFromPath = async () => { throw new Error('Simulated missing Windows codec'); };
    const fallbackFile = path.join(fixtureDirectory, 'fallback-preview.png');
    await fs.copyFile(file, fallbackFile);
    await run(`window.picgenDesktop.showImagePreview(${JSON.stringify({ filePath: fallbackFile, width:4096,height:4096,x:area.x+500,y:area.y+500 })})`);
    await waitFor(() => preview.isVisible(), 'Chromium fallback preview visible');
    const fallbackDimensions = await preview.webContents.executeJavaScript('({width:previewImage.naturalWidth,height:previewImage.naturalHeight})');
    assert.ok(Math.max(fallbackDimensions.width, fallbackDimensions.height) <= 1000);
    const report = { ok: true, automaticHide: true, hoverReveal: true, preservesSize: true, editingProtected: true,
        pinProtected: true, quickTabDrag: true, missingWindowsCodecFallback: true, sourceImage: '4096 x 4096', preview: dimensions,
        nativeDecodesForTwoHovers: decodes - decodesBefore, workerDecoder: true, coldMs, warmMs, maxHeartbeatGapMs: maxHeartbeatGap };
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, reportPath: path.join(root, 'report.json') }, null, 2));
    app.quit();
})().catch(error => { console.error(error.stack); app.exit(1); });

}
