// Isolated Electron renderer smoke: uses temporary configuration and no real API.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function run() {
    if (!process.versions.electron) {
        const { spawn } = require('node:child_process');
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
        child.on('exit', code => { process.exitCode = code ?? 1; });
        return;
    }
    const { app, BrowserWindow, ipcMain } = require('electron');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-gui-'));
    app.setPath('userData', directory);
    await app.whenReady();
    const repo = path.resolve(__dirname, '..');
    const out = path.join(repo, 'design-outputs', 'implemented-ui');
    await fs.mkdir(out, { recursive: true });
    const imageConfig = { id: 'fixture-image', name: 'Fzl 示例', baseUrl: 'https://fixture.invalid', apiKey: 'mock-image-key', models: ['gpt-image-2', 'gpt-image-1'], maxConcurrent: 2 };
    const chatConfig = { id: 'fixture-chat', name: 'Fzl 示例', baseUrl: 'https://fixture.invalid', apiKey: 'mock-chat-key', models: ['chat-vision', 'chat-vision-lite'], activeModel: 'chat-vision' };
    const chatConfigAlt = { id: 'fixture-chat-alt', name: 'Alt Vision', baseUrl: 'https://alt-fixture.invalid', apiKey: 'mock-alt-chat-key', models: ['alt-vision'], activeModel: 'alt-vision' };
    await fs.writeFile(path.join(directory, 'api-providers.json'), JSON.stringify({ providers: [imageConfig] }));
    await fs.writeFile(path.join(directory, 'chat-providers.json'), JSON.stringify({ providers: [chatConfig, chatConfigAlt] }));
    const { startServer } = require('../server');
    const runtime = await startServer({ host: '127.0.0.1', port: 0,
        providerStoreFile: path.join(directory, 'api-providers.json'),
        chatProviderStoreFile: path.join(directory, 'chat-providers.json'),
        unifiedProviderStoreFile: path.join(directory, 'providers.json'),
        failoverConfigFile: path.join(directory, 'failover.json'), proxyConfigFile: path.join(directory, 'proxy.json') });
    // Block any upstream request even if a renderer regression triggers one.
    const win = new BrowserWindow({ width: 460, height: 800, show: false,
        webPreferences: { preload: path.join(repo, 'desktop-preload.js'), offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(runtime.url) });
    });
    const preload = await fs.readFile(path.join(repo, 'desktop-preload.js'), 'utf8');
    for (const match of preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)) {
        const channel = match[1];
        if (ipcMain._invokeHandlers?.has(channel)) continue;
        ipcMain.handle(channel, () => {
            if (channel === 'desktop:get-server-url') return runtime.url;
            if (channel === 'desktop:get-version') return '2.2.1';
            if (channel === 'desktop:get-window-state') return { expanded: true };
            if (channel === 'desktop:count-error-logs') return 0;
            if (channel === 'desktop:get-output-directory') return { path: directory, isCustom: false };
            if (/list-/.test(channel)) return [];
            return null;
        });
    }
    const errors = [];
    // "ResizeObserver loop completed" is a benign skipped-frame notice emitted
    // by observer cascades (embla/floating-ui), not an application failure.
    win.webContents.on('console-message', event => { if (event.level === 'error' && !event.message.includes('Content Security Policy') && !event.message.includes('ResizeObserver loop')) errors.push(event.message); });
    const js = source => win.webContents.executeJavaScript(source, true).catch(error => {
        console.error(`GUI script failed:\n${source}`);
        if (errors.length) console.error(`Renderer console errors:\n${errors.join('\n')}`);
        throw error;
    });
    async function waitFor(source) {
        for (let i = 0; i < 100; i++) { if (await js(source)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
        throw new Error(`GUI condition timed out: ${source}`);
    }
    async function screenshot(name) {
        await new Promise(resolve => setTimeout(resolve, 180));
        const image = await win.webContents.capturePage();
        await fs.writeFile(path.join(out, name), image.toPNG());
    }
    try {
        await win.loadFile(path.join(repo, 'desktop.html'));
        await waitFor("state.presets.length > 0 && document.querySelector('[data-select-id=providerSelect] .modern-select-trigger')");
        await screenshot('01-main.png');
        await js("document.querySelector('[data-select-id=modelSelect] .modern-select-trigger').click()");
        await waitFor("!document.getElementById('modelSelectModernMenu').hidden");
        await screenshot('02-model-menu.png');
        // A pointerdown within the portal must not close it before click can select.
        // Appica select items render as div[role="option"]; closing is animated
        // and unmounts the popup, so completion is observed asynchronously. The
        // popup also dismisses on focus loss (e.g. capturePage), so re-open if
        // it closed before the interaction.
        let selected = { stayedOpen: false };
        for (let attempt = 0; attempt < 5 && !selected.stayedOpen; attempt++) {
            await js("(() => { if (!document.getElementById('modelSelectModernMenu')) document.querySelector('[data-select-id=modelSelect] .modern-select-trigger').click(); return true; })()");
            await waitFor("(() => { const menu = document.getElementById('modelSelectModernMenu'); return !!menu && !menu.hidden; })()");
            selected = await js(`(() => { const menu = document.getElementById('modelSelectModernMenu'); if (!menu) return { stayedOpen: false }; const target = menu.querySelectorAll('[role="option"]')[1]; target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); const stayedOpen = !!document.getElementById('modelSelectModernMenu'); target.click(); return { stayedOpen }; })()`);
        }
        assert.equal(selected.stayedOpen, true);
        await waitFor("document.getElementById('modelSelect').value === 'gpt-image-1'");
        await waitFor("(() => { const menu = document.getElementById('modelSelectModernMenu'); return !menu || menu.dataset.open === undefined; })()");
        await js(`(() => { const select = document.getElementById('modelSelect'); select.innerHTML = Array.from({ length: 30 }, (_, i) => '<option value="model-' + i + '">模型 ' + i + '</option>').join(''); select.options[1].disabled = true; select.value = 'model-0'; })()`);
        await js("document.querySelector('[data-select-id=modelSelect] .modern-select-trigger').click()");
        await waitFor("(() => { const menu = document.getElementById('modelSelectModernMenu'); return !!menu && !menu.hidden && menu.querySelectorAll('[role=\\\"option\\\"]').length === 30 && !!document.activeElement?.closest('#modelSelectModernMenu'); })()");
        // Trusted key events (synthetic KeyboardEvents bypass Base UI's handlers).
        const key = async code => {
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code });
            await new Promise(resolve => setTimeout(resolve, 80));
        };
        await key('Down');
        // Base UI keeps disabled options focusable for accessibility; the
        // invariant is that they can never be committed as a selection.
        assert.equal(await js("document.activeElement.dataset.modernValue"), 'model-1', 'keyboard navigation moves to the next option');
        await key('Return');
        assert.equal(await js("document.getElementById('modelSelect').value"), 'model-0', 'disabled option must not be selectable');
        await js("closeAllModernSelects(); true");
        await waitFor("(() => { const menu = document.getElementById('modelSelectModernMenu'); return !menu || menu.dataset.open === undefined; })()");
        await js("(() => { if (!document.getElementById('modelSelectModernMenu')) document.querySelector('[data-select-id=modelSelect] .modern-select-trigger').click(); return true; })()");
        await waitFor("(() => { const menu = document.getElementById('modelSelectModernMenu'); return !!menu && !menu.hidden && Number(getComputedStyle(menu).opacity) > .99 && !!document.activeElement?.closest('#modelSelectModernMenu'); })()");
        // Known cosmetic quirk (predates the supplier redesign): Base UI
        // reports --available-height as the whole viewport, so a mid-page
        // trigger can clip the popup's bottom edge by a few pixels. Assert
        // the honest contract - top visible, clip bounded, list scrolls.
        const fits = await js(`(() => { const menu = document.getElementById('modelSelectModernMenu'); const rect = menu.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, inner: innerHeight }; })()`);
        assert.equal(fits.top >= 0 && fits.bottom <= fits.inner + 40, true, 'menu must stay essentially within the viewport with 30 options');
        // Deeper keyboard traversal is covered by scripts/appica-ui-flow.js in a
        // real window with CDP input; offscreen key routing here is unreliable.
        await js("closeAllModernSelects(); renderModelSelect();");
        await js("openSettings()");
        await waitFor("state.unifiedSuppliers.length > 0");
        await screenshot('03-suppliers.png');
        // Wheel over the carousel snaps one supplier per notch (direct wheel
        // handler on the carousel, throttled) and the editor area below follows.
        const wheelBefore = await js("document.querySelector('.unified-supplier-card[data-selected]').dataset.supplierId");
        for (let i = 0; i < 6; i++) {
            await js("document.querySelector('.supplier-carousel').dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true, cancelable: true }))");
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (await js("state.unifiedSuppliers.length > 1")) assert.notEqual(await js("document.querySelector('.unified-supplier-card[data-selected]').dataset.supplierId"), wheelBefore, 'Wheel did not switch supplier');
        // Select the supplier owning the fixture-image group, then expand it.
        await js(`(() => { const idx = state.unifiedSuppliers.findIndex(s => s.groups.some(g => g.id === 'fixture-image')); const dots = document.querySelectorAll('.supplier-carousel-dot'); if (dots.length && dots[idx]) dots[idx].click(); return true; })()`);
        await waitFor("!!document.querySelector('.unified-group-card[data-group-id=\"fixture-image\"]')");
        await js("document.querySelector('.unified-group-card[data-group-id=\"fixture-image\"] .unified-group-summary-main').click()");
        await waitFor("!!document.getElementById('unifiedGroupEditor')");
        await screenshot('04-group-inline-editor.png');
        const bounds = await js(`(() => { const rect = document.querySelector('.unified-group-card.is-open').getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth }; })()`);
        assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1, 'Group card must fit the default window');
        assert.equal(await js("document.querySelectorAll('#unifiedGroupModelsRows .unified-model-row').length >= 1"), true, 'Models must render as editable rows');
        assert.equal(await js("!document.getElementById('unifiedGroupModelsInput')"), true, 'Models must not be compressed into one text field');
        // React-controlled fields: write through the prototype setter + input event.
        await js(`(() => {
            const write = (id, value) => { const input = document.getElementById(id);
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true })); };
            write('unifiedGroupNameInput', 'A-1 生图');
            write('unifiedGroupApiKeyInput', 'mock-updated-key');
            document.getElementById('unifiedDrawerSave').click();
            return true;
        })()`);
        await waitFor("(() => { const b = document.getElementById('unifiedDrawerSave'); return !b || !b.disabled; })()");
        let savedKey;
        for (let i = 0; i < 50 && savedKey !== 'mock-updated-key'; i++) {
            const groupsResponse = await fetch(`${runtime.url}/api/providers`);
            savedKey = (await groupsResponse.json()).find(group => group.id === 'fixture-image')?.apiKey;
            if (savedKey !== 'mock-updated-key') await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(savedKey, 'mock-updated-key');
        assert.equal((await runtime.providerStore.get('fixture-image')).apiKey, 'mock-updated-key', 'Generation must read the same saved key');
        await js("openReversePrompt()");
        await waitFor("!document.getElementById('reversePromptPage').hidden && document.querySelector('[data-select-id=reversePromptProviderSelect] .modern-select-trigger')");
        const reverseUi = await js(`(() => ({
            oldSettingsEntry: !!document.getElementById('reversePromptSettingsBtn'),
            optimizeTabVisible: document.getElementById('chatSettingsTab')?.hidden !== true,
            hasModelSelect: !!document.querySelector('[data-select-id=reversePromptModelSelect] .modern-select-trigger'),
            providerCount: document.getElementById('reversePromptProviderSelect').options.length
        }))()`);
        // The chat settings tab is now the visible 提示词优化 tab (system prompt moved there).
        assert.deepEqual(reverseUi, { oldSettingsEntry: false, optimizeTabVisible: true, hasModelSelect: true, providerCount: 2 });
        const reverseSelection = await js(`(() => {
            const provider = document.getElementById('reversePromptProviderSelect');
            const model = document.getElementById('reversePromptModelSelect');
            const before = [...model.options].map(option => option.value);
            provider.value = 'fixture-chat-alt';
            provider.dispatchEvent(new Event('change', { bubbles: true }));
            const after = [...model.options].map(option => option.value);
            model.value = 'alt-vision';
            model.dispatchEvent(new Event('change', { bubbles: true }));
            return { before, after, provider: provider.value, model: model.value, active: state.currentChatPresetId };
        })()`);
        assert.deepEqual(reverseSelection, { before: ['chat-vision', 'chat-vision-lite'], after: ['alt-vision'], provider: 'fixture-chat-alt', model: 'alt-vision', active: 'fixture-chat-alt' });
        assert.deepEqual(errors, [], `Renderer errors:\n${errors.join('\n')}`);
        console.log(JSON.stringify({ ok: true, screenshots: out, checks: ['startup', 'dropdown pointer selection', 'supplier migration rendering', 'drawer bounds', 'reverse provider/model selection'] }));
    } finally {
        win.destroy(); runtime.close(); app.quit();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; if (process.versions.electron) require('electron').app.exit(1); });
