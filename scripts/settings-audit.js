// Narrow-window audit of the settings page, on a throwaway profile:
//   node scripts/settings-audit.js --source <outDir>          current source tree
//   node scripts/settings-audit.js <absolute PicGen.exe> <outDir>  a packaged build (run from a copy)
// For every settings tab it reports content that sticks out to the right and whether the
// panel scrolls, checks the tab row (centring, edge buttons) and the 新增供应商 templates,
// and saves a screenshot per tab. Nothing is saved to any profile but the temporary one.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const sourceMode = process.argv.includes('--source');
const args = process.argv.slice(2).filter(arg => arg !== '--source');
const outDir = sourceMode ? args[0] : args[1];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitFor(fn, label, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn().catch(() => null);
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await sleep(300);
    }
}

function launch(root, port) {
    const dataDir = path.join(root, 'PicGenData');
    const env = { ...process.env, PICGEN_SMOKE: '1', PICGEN_SMOKE_CLIPBOARD: 'dry' };
    for (const name of Object.keys(env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|COOKIE|PROXY|^IMAGE_|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/i.test(name)) delete env[name];
    }
    const flags = [`--user-data-dir=${dataDir}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
    const log = fs.openSync(path.join(outDir, 'launch.log'), 'w');
    if (sourceMode) {
        const repo = path.resolve(__dirname, '..');
        const runner = path.join(root, 'source-runner.cjs');
        fs.writeFileSync(runner, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(dataDir)});app.setAppPath(${JSON.stringify(repo)});require(${JSON.stringify(path.join(repo, 'electron-main.js'))});`);
        return spawn(require('electron'), [runner, ...flags], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
    }
    // The portable launcher keeps PicGenData next to the EXE, so run a copy: otherwise this
    // launch shares the user's profile, hits the single-instance lock and exits.
    const copy = path.join(root, path.basename(args[0]));
    fs.copyFileSync(args[0], copy);
    env.PORTABLE_EXECUTABLE_DIR = root;
    env.PORTABLE_EXECUTABLE_FILE = copy;
    return spawn(copy, flags, { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
}

(async () => {
    fs.mkdirSync(outDir, { recursive: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-settings-audit-'));
    const port = await freePort();
    const child = launch(root, port);
    try {
        const target = await waitFor(async () => {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            return list.find(item => item.type === 'page' && item.title === 'PicGen Desktop');
        }, 'devtools target');
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        let id = 0;
        const pending = new Map();
        socket.on('message', raw => { const m = JSON.parse(raw); pending.get(m.id)?.(m); pending.delete(m.id); });
        const send = (method, params = {}) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); socket.send(JSON.stringify({ id: n, method, params })); });
        const evaluate = async expression => {
            const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (reply.result?.exceptionDetails) throw new Error(`Renderer: ${reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text}`);
            return reply.result?.result?.value;
        };
        const shot = async name => {
            const reply = await send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(outDir, name), Buffer.from(reply.result.data, 'base64'));
        };
        await waitFor(() => evaluate("typeof el !== 'undefined' && !!el.apiSettingsBtn && !!state.serverUrl"), 'renderer ready');
        await evaluate('window.picgenDesktop.setExpanded(true); 1');
        await sleep(800);
        await evaluate('openSettings(); 1');
        await sleep(800);

        const report = { viewport: await evaluate('[innerWidth, innerHeight]'), tabs: {}, modes: {} };
        // Every tab: content sticking out to the right, and whether its panel scrolls.
        for (const mode of ['image', 'concurrency', 'optimize', 'network', 'output', 'mcp']) {
            await evaluate(`setSettingsMode(${JSON.stringify(mode)}); 1`);
            await sleep(700);
            report.modes[mode] = await evaluate(`(() => {
                const panel = [...document.querySelectorAll('#settingsOverlay .settings-panel')].find(p => !p.hidden);
                const box = panel.getBoundingClientRect();
                const overflow = [...panel.querySelectorAll('*')].filter(node => {
                    const r = node.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && r.right > box.right + 1 && getComputedStyle(node).visibility !== 'hidden';
                }).slice(0, 8).map(node => (node.id ? '#' + node.id : node.tagName.toLowerCase() + '.' + String(node.className).split(' ').slice(0, 2).join('.')) + ' right+' + Math.round(node.getBoundingClientRect().right - box.right));
                const scrollers = [panel, ...panel.querySelectorAll('*')].filter(node => {
                    const s = getComputedStyle(node);
                    return /(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 1;
                }).map(node => (node.id || node.className) + ' ' + node.scrollHeight + '/' + node.clientHeight);
                const strip = document.querySelector('#settingsTabsWrap .settings-mode-tabs');
                const tab = strip.querySelector('.active');
                const center = tab.getBoundingClientRect().left + tab.offsetWidth / 2 - strip.getBoundingClientRect().left;
                return { overflow, scrollers, panelWidth: Math.round(box.width), activeTabOffCentre: Math.round(center - strip.clientWidth / 2),
                    wrap: document.getElementById('settingsTabsWrap').className };
            })()`);
            await shot(`settings-${mode}.png`);
        }

        await evaluate('setSettingsMode("image"); 1');
        await sleep(700);
        report.tabs.atStart = await evaluate("document.getElementById('settingsTabsWrap').className");
        await evaluate("document.getElementById('settingsTabsNext').click(); 1");
        await sleep(700);
        report.tabs.afterNext = await evaluate("({ wrap: document.getElementById('settingsTabsWrap').className, scrollLeft: document.querySelector('#settingsTabsWrap .settings-mode-tabs').scrollLeft })");

        // 新增供应商 templates.
        await evaluate("document.getElementById('unifiedNewSupplierBtn').click(); 1");
        await waitFor(() => evaluate("!!document.getElementById('supplierTemplate-zivv')"), 'template row', 15000);
        report.templates = {};
        for (const templateId of ['zivv', 'xuedingmao']) {
            await evaluate(`document.getElementById('supplierTemplate-${templateId}').click(); 1`);
            await sleep(600);
            report.templates[templateId] = await evaluate(`(() => {
                const value = id => document.getElementById(id)?.value;
                const form = document.querySelector('[data-editor="new-supplier"]');
                return {
                    name: value('unifiedSupplierNameInput'), baseUrl: value('unifiedSupplierBaseUrlInput'),
                    models: [...form.querySelectorAll('.unified-model-name')].map(input => input.value),
                    maxConcurrent: form.querySelector('#unifiedGroupMaxConcurrentInput')?.value,
                    apiKeyFocused: document.activeElement?.id === 'unifiedGroupApiKeyInput',
                    hint: document.querySelector('.supplier-template-hint')?.textContent.trim()
                };
            })()`);
            await evaluate("document.querySelector('[data-editor=\"new-supplier\"]').scrollIntoView({ block: 'start' }); 1");
            await sleep(300);
            await shot(`template-${templateId}.png`);
        }
        console.log(JSON.stringify(report, null, 2));
        socket.close();
    } finally {
        child.kill();
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
