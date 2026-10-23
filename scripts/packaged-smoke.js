// Usage: node scripts/packaged-smoke.js <absolute-portable.exe> [expected-version]
// Runs only against a new temporary portable profile and two loopback mocks.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fetch = require('node-fetch');
const WebSocket = require('ws');

const execFileAsync = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let MODEL = 'picgen-smoke-image';
const MOCK_KEY = 'picgen-local-smoke-fixture';
let report = { ok: false, stages: {}, screenshots: [] };
let root;
let child;
let client;
let debugPort;
let launchCount = 0;
const mocks = [];
const sourceMode = process.argv.includes('--source');

function check(value, message) {
    if (!value) throw new Error(message);
}

// CDP exceptionDetails carries the real cause; without it every renderer
// failure reads as a bare "Renderer evaluation failed".
function describeException(details) {
    if (!details) return 'unknown';
    const thrown = details.exception;
    const where = details.lineNumber != null ? ` @${details.lineNumber}:${details.columnNumber ?? 0}` : '';
    return `${thrown?.description || thrown?.value || details.text || 'unknown'}${where}`;
}

function within(directory, candidate) {
    const relative = path.relative(path.resolve(directory), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function loopback(value) {
    const url = new URL(value);
    check(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Refused non-loopback URL');
    check(!url.username && !url.password, 'Refused URL credentials');
    return url;
}

async function localJson(url, options = {}) {
    loopback(url);
    const response = await fetch(url, { timeout: 5000, redirect: 'error', ...options });
    check(response.ok, `Local HTTP request failed (${response.status})`);
    return response.json();
}

async function waitFor(action, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await action();
        if (result) return result;
        await pause(100);
    }
    throw new Error(`Timed out: ${label}`);
}

function pngFixture() {
    function chunk(type, data) {
        const name = Buffer.from(type);
        const content = Buffer.concat([name, data]);
        let crc = 0xffffffff;
        for (const byte of content) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([length, content, checksum]);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(32, 0);
    header.writeUInt32BE(32, 4);
    header[8] = 8;
    header[9] = 6;
    const pixels = Buffer.alloc(32 * (1 + 32 * 4));
    for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
            pixels.set([52 + x * 3, 130 + y, 210, 255], y * 129 + 1 + x * 4);
        }
    }
    return Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
    ]);
}

async function createMock(name) {
    const mock = { name, requests: 0, generated: 0, responded: 0, aborted: 0, unexpected: 0, authValid: true,
        holdResponses: false, delayMs: 0, pendingResponses: new Set(), generationLog: [] };
    const image = pngFixture().toString('base64');
    mock.releaseResponses = () => {
        mock.holdResponses = false;
        for (const send of [...mock.pendingResponses]) send();
    };
    mock.server = http.createServer((request, response) => {
        mock.requests++;
        const chunks = [];
        let length = 0;
        request.on('data', chunk => {
            length += chunk.length;
            if (length > 1024 * 1024) request.destroy();
            else chunks.push(chunk);
        });
        request.on('end', () => {
            response.setHeader('Content-Type', 'application/json');
            if (request.method === 'GET' && request.url === '/v1/models') {
                response.end(JSON.stringify({ data: [{ id: MODEL, supported_endpoint_types: ['image-generation'] }] }));
                return;
            }
            if (request.method === 'POST' && request.url === '/v1/chat/completions') {
                const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                check(payload.stream === true, 'Prompt request was not streaming');
                response.setHeader('Content-Type', 'text/event-stream');
                let index = 0;
                const parts = ['流式输出：', '构图、', '光线与材质。'];
                const timer = setInterval(() => {
                    if (index < parts.length) response.write(`data: ${JSON.stringify({choices:[{delta:{content:parts[index++]}}]})}\n\n`);
                    else { clearInterval(timer); response.end('data: [DONE]\n\n'); }
                }, 350);
                response.on('close', () => clearInterval(timer));
                return;
            }
            if (request.method === 'POST' && ['/v1/images/generations', '/v1/images/edits'].includes(request.url)) {
                try {
                    const body = Buffer.concat(chunks).toString('utf8');
                    const multipart = String(request.headers['content-type'] || '').startsWith('multipart/form-data;');
                    const model = multipart ? body.match(/name="model"\r\n\r\n([^\r\n]+)/)?.[1] : JSON.parse(body).model;
                    const referenceParts = multipart ? (body.match(/name="image(?:\[\])?"/g) || []).length : 0;
                    check(model === MODEL, 'Unexpected mock model');
                    // 官方 /v1/images/edits 允许多张图、修改区域只作用于第 1 张：工作台的局部修改会带上标注图等参考图
                    check(request.url !== '/v1/images/edits' || referenceParts >= 1, 'Expected at least one multipart reference image');
                    check(request.url !== '/v1/images/edits' || referenceParts === 1 || /name="mask"/.test(body), 'Multiple edit images without a mask');
                    mock.authValid = mock.authValid && request.headers.authorization === `Bearer ${MOCK_KEY}`;
                    mock.generated++;
                    const entry = { index: mock.generated, path: request.url, referenceParts, receivedAt: Date.now(), responded: false, aborted: false };
                    mock.generationLog.push(entry);
                    let timer;
                    let sent = false;
                    const send = () => {
                        if (sent) return;
                        sent = true;
                        clearTimeout(timer);
                        mock.pendingResponses.delete(send);
                        if (!response.destroyed) response.end(JSON.stringify({ data: [{ b64_json: image, mime_type: 'image/png' }] }));
                    };
                    mock.pendingResponses.add(send);
                    response.once('finish', () => { entry.responded = true; entry.finishedAt = Date.now(); mock.responded++; });
                    response.once('close', () => {
                        clearTimeout(timer);
                        mock.pendingResponses.delete(send);
                        if (!response.writableFinished) { entry.aborted = true; mock.aborted++; }
                    });
                    if (!mock.holdResponses) {
                        if (mock.delayMs > 0) timer = setTimeout(send, mock.delayMs);
                        else send();
                    }
                    return;
                } catch { /* Return a generic mock error without request content. */ }
            }
            mock.unexpected++;
            response.writeHead(400);
            response.end(JSON.stringify({ error: { message: 'Unexpected local smoke request' } }));
        });
    });
    await new Promise((resolve, reject) => {
        mock.server.once('error', reject);
        mock.server.listen(0, '127.0.0.1', resolve);
    });
    mock.url = `http://127.0.0.1:${mock.server.address().port}`;
    mocks.push(mock);
    return mock;
}

async function reservePort() {
    const server = http.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function connect(port, preview = false) {
    const target = await waitFor(async () => {
        try {
            const targets = await localJson(`http://127.0.0.1:${port}/json/list`);
            return targets.find(item => item.type === 'page' && (preview ? item.url.endsWith('/image-preview.html') : item.title === 'PicGen Desktop'));
        } catch { return null; }
    }, 'portable DevTools target', 90000);
    const debuggerUrl = loopback(target.webSocketDebuggerUrl);
    check(Number(debuggerUrl.port) === port, 'Unexpected debugger port');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    let nextId = 0;
    const pending = new Map();
    const errors = [];
    let pausedFrames = null;
    const dialogs = [];
    socket.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.method === 'Runtime.exceptionThrown') errors.push('renderer exception');
        if (message.method === 'Page.javascriptDialogOpening') dialogs.push(`${message.params?.type}: ${message.params?.message}`);
        if (message.method === 'Debugger.paused') pausedFrames = (message.params?.callFrames || []).slice(0, 12)
            .map(frame => `${frame.functionName || '(anonymous)'}:${Number(frame.location?.lineNumber) + 1}`);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`CDP ${request.method} failed`));
        else request.resolve(message.result || {});
    });
    socket.on('close', () => {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error('CDP connection closed'));
        }
        pending.clear();
    });
    socket.on('error', () => {});
    function send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`CDP ${method} timed out`));
            }, 20000);
            pending.set(id, { resolve, reject, timer, method });
            socket.send(JSON.stringify({ id, method, params }));
        });
    }
    // A renderer that stops answering is stuck in a script: pause it once and report where.
    async function rendererStack(error) {
        if (!/timed out/.test(error.message)) return '';
        if (dialogs.length) return `\n--- renderer blocked by a JS dialog ---\n${dialogs.join('\n')}`;
        pausedFrames = null;
        send('Debugger.enable').catch(() => {});
        send('Debugger.pause').catch(() => {});
        for (let i = 0; i < 30 && !pausedFrames; i++) await pause(100);
        return pausedFrames ? `\n--- renderer stack ---\n${pausedFrames.join('\n')}` : '\n--- renderer did not pause ---';
    }
    async function evaluate(expression) {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).catch(async error => {
            throw new Error(`${error.message}${await rendererStack(error)}\n--- expression ---\n${String(expression).slice(0, 400)}`);
        });
        check(!result.exceptionDetails, `Renderer evaluation failed: ${describeException(result.exceptionDetails)}\n--- expression ---\n${String(expression).slice(0, 400)}`);
        return result.result?.value;
    }
    await send('Runtime.enable');
    await send('Page.enable');
    return { socket, send, evaluate, errors };
}

// extraEnv: smoke-only switches for one launch (PICGEN_SMOKE_PURGE_FAIL); everything else is scrubbed.
async function launch(exe, dataDirectory, extraEnv = {}) {
    const port = await reservePort();
    debugPort = port;
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|COOKIE|PROXY|^PICGEN_|^IMAGE_|^TTS_|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/i.test(name)) delete env[name];
    }
    env.PORTABLE_EXECUTABLE_DIR = root;
    env.PORTABLE_EXECUTABLE_FILE = exe;
    env.PICGEN_PROVIDER_STORE = path.join(dataDirectory, 'api-providers.json');
    env.PICGEN_CHAT_PROVIDER_STORE = path.join(dataDirectory, 'chat-providers.json');
    env.PICGEN_FAILOVER_CONFIG = path.join(dataDirectory, 'failover-config.json');
    env.PICGEN_PROXY_CONFIG = path.join(dataDirectory, 'proxy-config.json');
    // Smoke-only IPC. History deletes go to PicGen's in-app bin inside the profile, never to the
    // Windows Recycle Bin.
    env.PICGEN_SMOKE = '1';
    // 「另存为」（右键菜单、详情抽屉、工作台）在冒烟里跳过系统对话框，直接存进报告目录
    env.PICGEN_SMOKE_SAVE_AS_DIR = path.join(root, 'save-as');
    await fs.mkdir(env.PICGEN_SMOKE_SAVE_AS_DIR, { recursive: true });
    // 复制图片 / 复制提示词不写用户的系统剪贴板，只记进 desktop:smoke-clipboard-log
    env.PICGEN_SMOKE_CLIPBOARD = 'dry';
    for (const [name, value] of Object.entries(extraEnv)) {
        check(name === 'PICGEN_SMOKE_PURGE_FAIL', `Refused smoke environment override ${name}`);
        env[name] = String(value);
    }
    const entryArgs = [];
    if (sourceMode) {
        const runner = path.join(root, 'source-runner.cjs');
        await fs.writeFile(runner, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(dataDirectory)});app.setAppPath(${JSON.stringify(path.resolve(__dirname, '..'))});require(${JSON.stringify(path.resolve(__dirname, '../electron-main.js'))});`);
        entryArgs.push(runner);
    }
    // Main-process output of every launch stays beside the report (launch-N.log) for diagnosis.
    launchCount += 1;
    const launchLog = require('node:fs').openSync(path.join(root, `launch-${launchCount}.log`), 'a');
    child = spawn(exe, [...entryArgs,
        `--user-data-dir=${dataDirectory}`, `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1', '--disable-background-networking',
        // A window covered by other apps would otherwise stop requestAnimationFrame (occlusion
        // backgrounding) and every rAF-gated click check would hang while the developer keeps working.
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'
    ], { cwd: root, env, windowsHide: true, stdio: ['ignore', launchLog, launchLog] });
    child.on('error', () => {});
    client = await connect(port);
    const url = await waitFor(() => client.evaluate(
        `typeof state !== 'undefined' && state.serverUrl && window.picgenDesktop ? state.serverUrl : null`
    ), 'renderer local server');
    loopback(url);
    await waitFor(() => client.evaluate(`typeof el !== 'undefined' && !!el.apiSettingsBtn`), 'renderer controls');
    await waitFor(() => client.evaluate('!!state.currentSequenceId && state.sequences.length > 0'), 'sequence initialization');
    check(within(root, dataDirectory), 'Profile escaped smoke directory');
    // The unified provider store is canonical; the legacy files are only
    // migration inputs and are not created for a fresh portable profile.
    await fs.access(path.join(dataDirectory, 'providers.json'));
    return url;
}

// Items in the real Recycle Bin (read only). The smoke must never add any: history uses the in-app bin.
async function realRecycleBinCount() {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(New-Object -ComObject Shell.Application).NameSpace(10).Items().Count'], { windowsHide: true });
    const count = Number.parseInt(String(stdout).trim(), 10);
    check(Number.isFinite(count), 'Could not read the Recycle Bin item count');
    return count;
}

async function stopOwnedProcess() {
    if (client) {
        try { await client.send('Browser.close'); } catch { /* Browser closes the CDP connection. */ }
        client.socket.terminate();
        client = null;
    }
    if (!child) return;
    const ownedChild = child;
    const deadline = Date.now() + 5000;
    while (ownedChild.exitCode === null && ownedChild.signalCode === null && Date.now() < deadline) await pause(100);
    if (ownedChild.pid && ownedChild.exitCode === null && ownedChild.signalCode === null) {
        // Never terminate by executable name: this PID belongs to our spawn only.
        await execFileAsync('taskkill.exe', ['/PID', String(ownedChild.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    }
    child = null;
}

async function screenshot(name) {
    const response = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const file = path.join(root, name);
    await fs.writeFile(file, Buffer.from(response.data, 'base64'));
    report.screenshots.push(file);
}

async function openSettings() {
    await client.evaluate(`window.picgenDesktop.setExpanded(true); true`);
    await waitFor(() => client.evaluate(`innerWidth >= 450 && innerHeight >= 590`), 'expanded window');
    await client.evaluate(`document.getElementById('apiSettingsBtn').click(); true`);
    await waitFor(() => client.evaluate(`!document.getElementById('settingsOverlay').hidden`), 'settings visible');
    const layout = await client.evaluate(`(() => {
        const sheet = document.querySelector('#settingsOverlay .settings-sheet');
        const rect = sheet.getBoundingClientRect();
        return { width: innerWidth, height: innerHeight,
            fits: rect.top >= -1 && rect.left >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
            overflow: sheet.scrollWidth > sheet.clientWidth + 1 };
    })()`);
    check(layout.fits && !layout.overflow, 'Settings viewport layout failed');
    return layout;
}

async function saveProviderInUI(mock, serverUrl) {
    await clickControl('unifiedNewSupplierBtn');
    // The persistent identity form also carries unifiedSupplierNameInput, so gate on
    // the new-supplier editor marker specifically.
    await waitFor(() => client.evaluate("!!document.querySelector('[data-editor=\"new-supplier\"]') && !!document.getElementById('unifiedGroupApiKeyInput')"), 'new supplier editor open');
    check(await client.evaluate(`document.getElementById('unifiedGroupApiKeyInput').type === 'password'`), 'API key control is not masked');
    // The panel is React-controlled: write through the prototype setter and
    // dispatch input events so controlled fields observe the new values.
    await client.evaluate(`(() => {
        const values = ${JSON.stringify({ unifiedSupplierNameInput: mock.name, unifiedSupplierBaseUrlInput: mock.url, unifiedGroupNameInput: mock.name, unifiedGroupApiKeyInput: MOCK_KEY })};
        const write = (input, value) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        for (const [id, value] of Object.entries(values)) write(document.getElementById(id), value);
        write(document.querySelector('#unifiedGroupModelsRows .unified-model-name'), ${JSON.stringify(MODEL)});
        // Protocol is a native <select>; set it directly (bridged-select clicks
        // are covered by gui-smoke and are flaky against this long form).
        const proto = document.querySelector('#unifiedGroupModelsRows .unified-model-protocol');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(proto, 'openai-images');
        proto.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await clickControl('unifiedDrawerSave');
    const saved = await waitFor(async () => {
        const providers = await localJson(`${serverUrl}/api/providers`);
        return providers.find(provider => provider.name === mock.name && provider.baseUrl === mock.url && provider.models.includes(MODEL));
    }, 'provider UI save');
    check(saved.apiKey === MOCK_KEY || saved.hasApiKey === true, 'Mock credential was not saved');
    check(saved.modelRouting?.[MODEL]?.protocol === 'openai-images', 'Model protocol was not saved');
    await waitFor(() => client.evaluate("!document.querySelector('[data-editor=\"new-supplier\"]')"), 'new supplier editor closed');
    return { id: saved.id, name: saved.name, baseUrl: saved.baseUrl };
}

async function verifyStrategyControls(serverUrl, providers) {
    await clickControl('concurrencySettingsTab');
    await client.evaluate('refreshConcurrencySettings().then(() => true)');
    const verified = [];
    for (const strategy of ['order', 'priority', 'balanced', 'fixed', 'price', 'speed']) {
        await client.evaluate(`(() => {
            const radio = document.querySelector('[name="providerStrategy"][value="${strategy}"]');
            if (!radio) return false;
            radio.id = 'smokeStrategyChoice';
            return true;
        })()`);
        await clickControl('smokeStrategyChoice');
        check(await client.evaluate(`el.providerStrategySelect.value === '${strategy}'
            && el.fixedProviderField.hidden === ${strategy !== 'fixed'}`), 'Strategy controls did not follow the selected mode');
        if (strategy === 'fixed') await client.evaluate(`(() => {
            el.fixedProviderSelect.value = ${JSON.stringify(providers[1].id)};
            el.fixedProviderSelect.dispatchEvent(new Event('change', {bubbles:true}));
            refreshModernSelect(el.fixedProviderSelect);
            return true;
        })()`);
        await waitFor(async () => {
            const config = await localJson(`${serverUrl}/api/providers/failover`);
            return config.strategy === strategy && (strategy !== 'fixed' || config.selectedProviderId === providers[1].id);
        }, `saved ${strategy} strategy`);
        await client.evaluate('refreshConcurrencySettings().then(() => true)');
        check(await client.evaluate(`document.querySelector('[name="providerStrategy"]:checked')?.value === '${strategy}'`), 'Strategy reload changed the radio selection');
        // The settings header (and its "当前策略：…" heading) was removed; the saved
        // strategy is verified above via the persisted config and the reloaded radio.
        await client.evaluate(`document.getElementById('smokeStrategyChoice').removeAttribute('id'); true`);
        verified.push(strategy);
    }
    await client.evaluate(`document.querySelector('#concurrencySettingsPanel .settings-scroll-panel').scrollTop = 0; true`);
    await screenshot('08-routing-strategies.png');
    return { savedAndReloaded: verified, fixedProvider: providers[1].name, usesVisibleControls: true };
}

async function generate(serverUrl, provider, sequenceId, dataDirectory) {
    const accepted = await localJson(`${serverUrl}/api/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sequenceId, providerId: provider.id, model: MODEL,
            prompt: 'Local packaged smoke fixture', operation: 'generate', ratio: '1:1', imageSize: '1K' })
    });
    check(accepted.taskId, 'Task was not accepted');
    const task = await waitFor(async () => {
        const item = await localJson(`${serverUrl}/api/tasks/${encodeURIComponent(accepted.taskId)}`);
        check(item.status !== 'failed' && item.status !== 'cancelled', `Mock task ${item.status}`);
        return item.status === 'completed' ? item : null;
    }, 'mock generation');
    const file = task.result?.filePath;
    check(file && within(dataDirectory, file), 'Generated image is outside the isolated profile');
    const bytes = await fs.readFile(file);
    check(bytes.length > 32 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Generated PNG is invalid');
    const history = await client.evaluate(`window.picgenDesktop.listHistoryImages().then(items => items.map(item => ({ id: item.id, filePath: item.filePath })))`);
    check(history.some(item => item.id === task.id && item.filePath === file), 'Generated image missing from history');
    return { taskId: task.id, filePath: file, bytes: bytes.length, historyCount: history.length };
}

async function clickControl(id) { return clickSelector(`#${id}`); }

// modifiers: CDP bit mask (Alt=1, Ctrl=2, Meta=4, Shift=8).
async function clickSelector(selector, { modifiers = 0 } = {}) {
    const point = await waitFor(() => client.evaluate(`(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const control = document.querySelector(${JSON.stringify(selector)});
        if (!control || control.disabled || control.closest('[hidden]')) return null;
        control.scrollIntoView({ block: 'center', inline: 'center' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = control.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        if (!rect.width || !rect.height || !control.contains(document.elementFromPoint(x, y))) return null;
        return { x, y };
    })()`), `clickable ${selector}`, 12000);
    check(point, `GUI control is not clickable: ${selector}`);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, modifiers });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1, modifiers });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1, modifiers });
}

async function chooseOption(selector, value) {
    const id = await client.evaluate(`document.querySelector(${JSON.stringify(selector)})?.id`);
    check(id, `Select missing: ${selector}`);
    await clickSelector(`.modern-select[data-select-id="${id}"] .modern-select-trigger`);
    await clickSelector(`#${id}ModernMenu [data-modern-value="${value}"]`);
    check(await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(value)}`), 'Dropdown choice was not applied');
}

async function installRendererAudit(serverUrl) {
    await client.evaluate(`(() => {
        const expectedOrigin = ${JSON.stringify(serverUrl)};
        const audit = window.__picgenSmokeAudit = { posts: [], deletes: [], historyRefreshCalls: 0 };
        const originalFetch = window.fetch;
        window.fetch = async function(input, options = {}) {
            const url = new URL(typeof input === 'string' ? input : input.url, location.href);
            const method = String(options.method || input?.method || 'GET').toUpperCase();
            let entry;
            if (url.origin === expectedOrigin && method === 'POST' && /^\\/api\\/tasks(?:\\/batch)?$/.test(url.pathname)) {
                const text = String(options.body || '');
                const payload = JSON.parse(text);
                const refs = Array.isArray(payload.referenceImages) ? payload.referenceImages : [];
                entry = { path: url.pathname, count: payload.count || 1, sequenceId: payload.sequenceId,
                    referenceCount: refs.length, referenceBase64Characters: refs.reduce((n, ref) => n + String(ref.base64 || '').length, 0),
                    referencePayloadCopies: refs.reduce((n, ref) => n + (ref.base64 ? text.split(ref.base64).length - 1 : 0), 0),
                    bodyBytes: new TextEncoder().encode(text).length, status: null, taskIds: [] };
                audit.posts.push(entry);
            } else if (url.origin === expectedOrigin && method === 'DELETE' && url.pathname.startsWith('/api/tasks')) {
                entry = { path: url.pathname, sequenceId: url.searchParams.get('sequenceId'), status: null };
                audit.deletes.push(entry);
            }
            const response = await Reflect.apply(originalFetch, this, [input, options]);
            if (entry) {
                entry.status = response.status;
                response.clone().json().then(body => {
                    if (Array.isArray(body.taskIds)) entry.taskIds = body.taskIds;
                    else if (body.taskId) entry.taskIds = [body.taskId];
                    if (Number.isFinite(body.cancelled)) entry.cancelled = body.cancelled;
                    entry.responseRead = true;
                }).catch(() => { entry.responseRead = true; entry.responseParseFailed = true; });
            }
            return response;
        };
        const originalRefresh = refreshRecentImages;
        refreshRecentImages = function(...args) {
            audit.historyRefreshCalls++;
            return Reflect.apply(originalRefresh, this, args);
        };
        return true;
    })()`);
}

async function prepareGuiBatch(provider, referencePath = null) {
    await clickControl('generateNavBtn');
    await clickControl('addSequenceBtn');
    await client.evaluate(`(() => {
        const select = document.getElementById('providerSelect');
        select.value = ${JSON.stringify(provider.id)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(() => client.evaluate(`!el.providerSelect.disabled && el.providerSelect.value === ${JSON.stringify(provider.id)}`), 'GUI provider selection');
    const selected = await client.evaluate(`(() => {
        el.modelSelect.value = ${JSON.stringify(MODEL)};
        el.modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
        el.countSelect.value = '3';
        el.countSelect.dispatchEvent(new Event('change', { bubbles: true }));
        el.promptInput.textContent = '';
        el.promptInput.focus();
        return { sequenceId: getCurrentSequence().id, model: el.modelSelect.value, count: el.countSelect.value };
    })()`);
    check(selected.model === MODEL && selected.count === '3', 'GUI does not offer the expected model / count=3');
    await client.send('Input.insertText', { text: referencePath ? 'Local GUI batch with one reference image' : 'Local GUI cancel while request is running' });
    if (referencePath) {
        const document = await client.send('DOM.getDocument', { depth: 1 });
        const node = await client.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#referenceFileInput' });
        check(node.nodeId, 'Reference file input is missing');
        await client.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [referencePath] });
        await waitFor(() => client.evaluate(`getCurrentSequence().references.length === 1 && !!getCurrentSequence().references[0].base64`), 'GUI reference upload');
    }
    await waitFor(() => client.evaluate(`!el.generateBtn.disabled && !!el.promptInput.textContent.trim()`), 'GUI generate button ready');
    return selected.sequenceId;
}

async function acceptedGuiBatch(sequenceId) {
    return waitFor(async () => {
        const record = await client.evaluate(`window.__picgenSmokeAudit.posts.find(item => item.sequenceId === ${JSON.stringify(sequenceId)}) || null`);
        if (!record || !record.responseRead) return null;
        check(record.path === '/api/tasks/batch' && record.count === 3 && record.status === 202, 'GUI did not use one accepted count=3 batch request');
        check(record.taskIds.length === 3 && new Set(record.taskIds).size === 3, 'GUI batch receipt must contain three unique task IDs');
        return record;
    }, 'GUI batch response');
}

async function verifyGuiBatchAndCancellation(serverUrl, provider, mock, dataDirectory) {
    const fixturePath = path.join(root, 'reference-fixture.png');
    await fs.writeFile(fixturePath, pngFixture());
    await waitFor(() => client.evaluate(`state.historyLoaded === true && document.querySelectorAll('#historyImages .history-item').length > 0`), 'initial full history ready');
    await installRendererAudit(serverUrl);
    const before = await client.evaluate(`(() => {
        window.__picgenSmokeHistoryAnchor = document.querySelector('#historyImages .history-item');
        return { ids: state.recentImages.map(item => item.id), revision: state.historyRevision };
    })()`);
    const requestsBefore = mock.generated;
    mock.holdResponses = true;
    const sequenceId = await prepareGuiBatch(provider, fixturePath);
    await clickControl('generateBtn');
    const receipt = await acceptedGuiBatch(sequenceId);
    check(receipt.referenceCount === 1 && receipt.referencePayloadCopies === 1, 'Reference image was duplicated in the renderer batch payload');
    check(receipt.referenceBase64Characters === pngFixture().toString('base64').length, 'Renderer reference payload differs from the uploaded fixture');
    await waitFor(() => mock.generated === requestsBefore + 1, 'first held GUI upstream request');
    await clickControl('historyBtn');
    await waitFor(() => client.evaluate(`state.activeView === 'history' && !el.historyPage.hidden`), 'history visible during batch');
    const refreshCallsBefore = await client.evaluate('window.__picgenSmokeAudit.historyRefreshCalls');
    mock.delayMs = 150;
    mock.releaseResponses();
    const tasks = await waitFor(async () => {
        const items = await Promise.all(receipt.taskIds.map(id => localJson(`${serverUrl}/api/tasks/${encodeURIComponent(id)}`)));
        check(items.every(item => !['failed', 'cancelled'].includes(item.status)), 'GUI batch task failed or was cancelled');
        return items.every(item => item.status === 'completed') ? items : null;
    }, 'three GUI generated images');
    const images = [];
    for (const task of tasks) {
        const file = task.result?.filePath;
        check(file && within(dataDirectory, file), 'GUI image is outside the isolated profile');
        const bytes = await fs.readFile(file);
        check(bytes.length > 32 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'GUI generated PNG is invalid');
        images.push({ taskId: task.id, filePath: file, bytes: bytes.length });
    }
    const history = await waitFor(() => client.evaluate(`(() => {
        const expected = ${JSON.stringify(receipt.taskIds)};
        const visible = [...document.querySelectorAll('#historyImages .history-item')].map(item => item.dataset.historyId);
        if (!expected.every(id => state.recentImages.some(item => item.id === id) && visible.includes(id))) return null;
        return { count: state.recentImages.length, visibleCount: visible.length, revision: state.historyRevision,
            anchorPreserved: window.__picgenSmokeHistoryAnchor?.parentNode === el.historyImages,
            refreshCalls: window.__picgenSmokeAudit.historyRefreshCalls };
    })()`), 'incremental history contains three new images');
    check(history.count === before.ids.length + 3 && history.anchorPreserved, 'History did not append three records while preserving the existing DOM item');
    check(history.refreshCalls === refreshCallsBefore, 'Batch completion triggered a full history refresh');
    const persisted = await client.evaluate(`window.picgenDesktop.listHistoryImages().then(items => items.map(item => ({ id: item.id, filePath: item.filePath })))`);
    check(persisted.length === history.count && images.every(image => persisted.some(item => item.id === image.taskId && item.filePath === image.filePath)), 'GUI batch history was not persisted');
    check(mock.generated === requestsBefore + 3, 'GUI batch made extra or missing upstream submissions');
    check(mock.generationLog.slice(requestsBefore).every(item => item.path === '/v1/images/edits' && item.referenceParts === 1), 'Each upstream edit did not receive exactly one reference image');
    const batchPosts = await client.evaluate(`window.__picgenSmokeAudit.posts.filter(item => item.sequenceId === ${JSON.stringify(sequenceId)})`);
    check(batchPosts.length === 1, 'GUI batch submitted more than once');
    report.stages.guiBatch = { via: 'CDP mouse click on visible generate button', count: 3, receipt, images,
        historyBefore: before.ids.length, historyAfter: history.count, incrementalHistory: history,
        fullHistoryRefreshesDuringCompletion: history.refreshCalls - refreshCallsBefore,
        upstreamSubmissions: mock.generated - requestsBefore, referenceUpload: 'one renderer batch JSON; one reference per actual upstream edit' };
    await screenshot('05-gui-batch-history.png');

    mock.delayMs = 0;
    mock.holdResponses = true;
    const cancelRequestsBefore = mock.generated;
    const cancelSequence = await prepareGuiBatch(provider);
    await clickControl('generateBtn');
    const cancelReceipt = await acceptedGuiBatch(cancelSequence);
    await waitFor(() => mock.generated === cancelRequestsBefore + 1 && mock.pendingResponses.size === 1, 'running request held before cancellation');
    await waitFor(() => client.evaluate(`!el.stopBtn.disabled`), 'GUI stop button ready');
    await screenshot('06-gui-running-before-stop.png');
    await clickControl('stopBtn');
    const cancelled = await waitFor(async () => {
        const items = await Promise.all(cancelReceipt.taskIds.map(id => localJson(`${serverUrl}/api/tasks/${encodeURIComponent(id)}`)));
        check(items.every(item => item.status !== 'completed' && item.status !== 'failed'), 'Held cancellation unexpectedly completed or failed');
        return items.every(item => item.status === 'cancelled') ? items : null;
    }, 'running and queued tasks cancelled');
    await waitFor(() => mock.pendingResponses.size === 0, 'cancelled upstream request aborted');
    mock.releaseResponses();
    const observationMs = 1500;
    await pause(observationMs);
    check(mock.generated === cancelRequestsBefore + 1, 'Cancellation caused another upstream submission');
    const cancellationAudit = await client.evaluate(`({
        posts: window.__picgenSmokeAudit.posts.filter(item => item.sequenceId === ${JSON.stringify(cancelSequence)}),
        deletes: window.__picgenSmokeAudit.deletes.filter(item => item.sequenceId === ${JSON.stringify(cancelSequence)}),
        historyCount: state.recentImages.length
    })`);
    check(cancellationAudit.posts.length === 1 && cancellationAudit.deletes.length === 1 && cancellationAudit.deletes[0].status === 200, 'Cancel flow submitted or cancelled more than once');
    check(cancellationAudit.historyCount === history.count, 'Cancelled tasks appeared in history');
    const persistedAfterCancel = await client.evaluate('window.picgenDesktop.listHistoryImages().then(items => items.length)');
    check(persistedAfterCancel === persisted.length, 'Cancellation added a persisted history record');
    report.stages.guiCancellation = { via: 'CDP mouse click on visible stop button while HTTP response is held',
        receipt: cancelReceipt, statuses: cancelled.map(item => ({ taskId: item.id, status: item.status })),
        upstreamSubmissions: mock.generated - cancelRequestsBefore, expectedUpstreamSubmissions: 1,
        cancelledTasks: 3, responseAborted: mock.generationLog.at(-1)?.aborted === true,
        observationMs, noRepeatedRendererSubmission: true, noRepeatedUpstreamSubmission: true,
        historyUnchanged: true, audit: cancellationAudit };
    check(report.stages.guiCancellation.responseAborted, 'Mock did not observe the running response abort');
    await screenshot('07-gui-cancelled.png');
    return history.count;
}

async function main() {
    check(process.platform === 'win32', 'This portable smoke runner requires Windows');
    const source = sourceMode ? require('electron') : process.argv[2];
    const expectedVersion = sourceMode ? require('../package.json').version : process.argv[3] || '';
    const extended = ['2.2.1', '2.2.2', '2.3.0', '2.3.1', '2.3.2'].includes(expectedVersion);
    if (extended) MODEL = 'gpt-image-2';
    // 修订流程的闸门原本写成 `=== '2.3.2'`：版本号一越过 2.3.2（现在是 2.3.9）整段
    // 流程就被静默跳过，覆盖率随每次发版下降。改成「不低于」比较，恢复它原本的意图。
    const runsRefinements = (() => {
        const parse = value => String(value || '').split('.').map(part => Number.parseInt(part, 10) || 0);
        const [major, minor, patch] = parse(expectedVersion);
        const [minMajor, minMinor, minPatch] = parse('2.3.2');
        if (major !== minMajor) return major > minMajor;
        if (minor !== minMinor) return minor > minMinor;
        return patch >= minPatch;
    })();
    check(source && path.isAbsolute(source) && /\.exe$/i.test(source), 'Usage: node scripts/packaged-smoke.js <absolute-portable.exe> [expected-version]');
    check((await fs.stat(source)).isFile(), 'Portable EXE was not found');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-packaged-smoke-'));
    report.outputDirectory = root;
    report.expectedVersion = expectedVersion || null;
    report.realRecycleBin = { before: await realRecycleBinCount() };
    const exe = sourceMode ? source : path.join(root, path.basename(source));
    const dataDirectory = path.join(root, 'PicGenData');
    if (!sourceMode) await fs.copyFile(source, exe);
    await fs.mkdir(dataDirectory);
    // Seed these before startup: otherwise legacy failover migration can read ~/.picgen.
    await fs.writeFile(path.join(dataDirectory, 'failover-config.json'), JSON.stringify({ enabled: false, strategy: 'fixed', maxGlobalConcurrent: 1 }));
    await fs.writeFile(path.join(dataDirectory, 'proxy-config.json'), JSON.stringify({ mode: 'direct', customProxy: '' }));
    const pe = sourceMode ? {stdout:expectedVersion} : await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `[System.Diagnostics.FileVersionInfo]::GetVersionInfo('${exe.replace(/'/g, "''")}').ProductVersion`], { windowsHide: true });
    const artifactVersion = pe.stdout.trim();
    check(artifactVersion, 'Portable EXE product version is missing');
    if (expectedVersion) check(artifactVersion === expectedVersion, 'Portable EXE version mismatch');
    report.version = { value: artifactVersion, source: sourceMode ? 'source package.json' : 'Windows EXE ProductVersion' };
    const mockA = await createMock('Local Smoke A');
    const mockB = await createMock('Local Smoke B');
    if (process.argv.includes('--cleanup-only')) {
        // Iterating on the history trash/bin flow alone: one launch for the flow, one restart for persistence.
        const cleanupFlow = require('./history-cleanup-flow');
        await launch(exe, dataDirectory, { PICGEN_SMOKE_PURGE_FAIL: cleanupFlow.REFUSE_TOKEN });
        const cleanup = cleanupFlow({ client, check, clickControl, clickSelector, waitFor, screenshot, profileDir: dataDirectory });
        report.stages.historyCleanup = await cleanup.run();
        await stopOwnedProcess();
        await launch(exe, dataDirectory);
        // The flow holds the CDP client it was created with; the restarted app has a new one.
        report.stages.historyCleanup.afterRestart = await cleanupFlow({ client, check, clickControl, clickSelector, waitFor, screenshot, profileDir: dataDirectory })
            .afterRestart(report.stages.historyCleanup);
        report.realRecycleBin.after = await realRecycleBinCount();
        check(report.realRecycleBin.after === report.realRecycleBin.before, 'The real Recycle Bin changed during the smoke');
        check(client.errors.length === 0, 'Renderer reported an uncaught exception');
        report.ok = true;
        return;
    }
    let serverUrl = await launch(exe, dataDirectory);
    const bridgeVersion = await client.evaluate(`typeof window.picgenDesktop.getVersion === 'function' ? window.picgenDesktop.getVersion() : null`);
    if (bridgeVersion) {
        const value = typeof bridgeVersion === 'object' ? bridgeVersion.version : bridgeVersion;
        if (!sourceMode) check(value === artifactVersion, 'Runtime and artifact versions differ');
        report.version.runtimeVerified = !sourceMode;
    } else report.version.runtimeVerified = false;
    const [initialProviders, initialChat] = await Promise.all([
        localJson(`${serverUrl}/api/providers`), localJson(`${serverUrl}/api/chat-providers`)
    ]);
    const initialEntries = [...initialProviders, ...initialChat];
    check(initialEntries.every(item => !(item.baseUrl || item.url || item.apiKey || item.hasApiKey) && !(item.models || []).length), 'Profile contains configured providers or credentials');
    report.stages.cleanProfile = { configuredProviders: 0, credentials: 0, placeholders: initialEntries.length };
    report.stages.settings = await openSettings();
    await screenshot('01-settings-empty.png');
    const providers = [await saveProviderInUI(mockA, serverUrl), await saveProviderInUI(mockB, serverUrl)];
    report.stages.providerSave = { count: providers.length, via: 'renderer new-supplier form and save button; verified by GET' };
    await screenshot('02-settings-saved.png');
    const supplierTests = require('./supplier-ui-flow')({ client: {evaluate: expression => client.evaluate(expression)},
        clickControl, clickSelector, chooseOption, waitFor, localJson, saveProviderInUI, screenshot, check });
    const supplierFlow = await supplierTests.edit(serverUrl, mockA);
    report.stages.routingStrategies = await verifyStrategyControls(serverUrl, providers);
    await localJson(`${serverUrl}/api/providers/failover`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, strategy: 'fixed', selectedProviderId: providers[0].id }) });
    report.stages.generation = await generate(serverUrl, providers[0], 'smoke-first', dataDirectory);
    await client.evaluate(`document.getElementById('historyBtn').click(); true`);
    await waitFor(() => client.evaluate(`!document.getElementById('historyPage').hidden && document.querySelectorAll('#historyImages .history-item').length > 0`), 'history UI');
    await screenshot('03-history.png');
    const persistedBeforeRestart = extended
        ? await verifyGuiBatchAndCancellation(serverUrl, providers[0], mockA, dataDirectory)
        : report.stages.generation.historyCount;
    check(client.errors.length === 0, 'Renderer reported an uncaught exception');
    await stopOwnedProcess();
    serverUrl = await launch(exe, dataDirectory);
    const persistedRouting = await localJson(`${serverUrl}/api/providers/failover`);
    check(persistedRouting.strategy === 'fixed' && persistedRouting.selectedProviderId === providers[0].id,
        'Fixed routing strategy did not survive restart');
    const reloaded = await localJson(`${serverUrl}/api/providers`);
    check(providers.every(expected => reloaded.some(item => item.id === expected.id && item.name === expected.name && item.baseUrl === expected.baseUrl && item.models.includes(MODEL))), 'Provider configuration did not survive restart');
    await localJson(`${serverUrl}/api/providers/failover`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, strategy: 'fixed', selectedProviderId: providers[1].id }) });
    const second = await generate(serverUrl, providers[1], 'smoke-restart', dataDirectory);
    check(second.historyCount === persistedBeforeRestart + 1, 'History did not survive restart');
    report.stages.restart = { providersPersisted: 2, credentialsUsable: true, historyPersisted: true, secondTask: second };
    // saveAsDir: the 另存为 step also checks its copy on disk (PICGEN_SMOKE_SAVE_AS_DIR of launch()).
    const uxFlow = require('./ux-ui-flow')({ client, check, clickControl, clickSelector, waitFor, screenshot, saveAsDir: path.join(root, 'save-as') });
    report.stages.userExperience = await uxFlow.run();
    if (await client.evaluate('!!window.PicGenAppica')) report.stages.appica = await require('./appica-ui-flow')({ client, check, clickControl, clickSelector, waitFor, screenshot });
    if (await client.evaluate('!!window.PicGenAppica?.renderWorkspace')) report.stages.workspace = await require('./workspace-flow')({ client, check, clickSelector, waitFor, screenshot }).run();
    if (['2.3.1', '2.3.2'].includes(expectedVersion)) {
        const native = await require('./native-window-flow')({ client, connectPreview: () => connect(debugPort, true), check, waitFor, screenshot, clickControl });
        const previewScreenshot = path.join(root, '25-native-preview.png');
        await fs.writeFile(previewScreenshot, Buffer.from(native.screenshot, 'base64'));
        delete native.screenshot;
        report.screenshots.push(previewScreenshot);
        report.stages.nativeWindow = native;
    }
    if (runsRefinements) {
        const chatProvider = await localJson(`${serverUrl}/api/chat-providers`, {method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({id:'stream-chat',name:'Local Stream',baseUrl:mockA.url,apiKey:MOCK_KEY,models:['gpt-4o'],activeModel:'gpt-4o'})});
        report.stages.refinements = await require('./refinement-ui-flow')({client,check,clickControl,waitFor,screenshot,serverUrl,chatProvider,imageProvider:providers[1],localJson});
    }
    await openSettings();
    report.stages.supplierManagement = await supplierTests.afterRestart(serverUrl, supplierFlow);
    await screenshot('04-restarted.png');
    check(client.errors.length === 0, 'Renderer reported an uncaught exception after restart');
    check(mockA.generated === (extended ? 5 : 1) && mockB.generated === (runsRefinements ? 2 : 1)
        && mocks.every(mock => mock.unexpected === 0 && mock.authValid), 'Local mock request verification failed');
    report.stages.mockRequests = mocks.map(({ name, requests, generated, unexpected, authValid }) => ({ name, requests, generated, unexpected, authValid }));
    await stopOwnedProcess();
    const cleanupFlow = require('./history-cleanup-flow');
    // This launch refuses to purge the one cleanup-flow file named with the refuse token (partial failure).
    serverUrl = await launch(exe, dataDirectory, { PICGEN_SMOKE_PURGE_FAIL: cleanupFlow.REFUSE_TOKEN });
    const restartedUx = require('./ux-ui-flow')({ client, check, clickControl, clickSelector, waitFor, screenshot });
    report.stages.userExperience.restartPersisted = await restartedUx.afterRestart(report.stages.userExperience);
    // 重启后 client 是新连接：流程实例必须重新创建
    if (report.stages.workspace) report.stages.workspace.restartPersisted = await require('./workspace-flow')({ client, check, clickSelector, waitFor, screenshot }).afterRestart(report.stages.workspace);
    await supplierTests.deletedAfterRestart(serverUrl, supplierFlow);
    // The UX stage saved its similar-view fixture; its 选中本组 delete was cancelled, so nothing was trashed.
    const expectedHistory = second.historyCount + (runsRefinements ? 1 : 0) + report.stages.userExperience.fixture.count
        + (report.stages.workspace?.savedHistory || 0);
    check(await client.evaluate(`window.picgenDesktop.listHistoryImages().then(items => items.length === ${expectedHistory})`),
        'Supplier deletion changed history');
    report.stages.supplierManagement.deletionPersisted = true;
    await supplierTests.emptyState(serverUrl,mockA);
    report.stages.supplierManagement.emptyStateAndAddAgain = true;
    check(await client.evaluate('window.picgenDesktop.getHistoryBinCount().then(bin => bin.total === 0)'), 'Something was deleted before the cleanup flow');
    const cleanup = cleanupFlow({ client, check, clickControl, clickSelector, waitFor, screenshot, profileDir: dataDirectory });
    report.stages.historyCleanup = await cleanup.run();
    check(client.errors.length === 0, 'Renderer reported an uncaught exception during the cleanup flow');
    await stopOwnedProcess();
    serverUrl = await launch(exe, dataDirectory);
    // The flow holds the CDP client it was created with; the restarted app has a new one.
        report.stages.historyCleanup.afterRestart = await cleanupFlow({ client, check, clickControl, clickSelector, waitFor, screenshot, profileDir: dataDirectory })
            .afterRestart(report.stages.historyCleanup);
    // Cleanup flow: 4 saved, 2 marked then restored (1 of them refused a purge), 1 more saved and purged: 4 remain.
    check(await client.evaluate(`window.picgenDesktop.listHistoryImages().then(items => items.length === ${expectedHistory + 4})`),
        'History count after the cleanup flow is wrong');
    check(await client.evaluate('window.picgenDesktop.getHistoryBinCount().then(bin => bin.total === 0)'), 'The in-app bin is not empty at the end');
    report.realRecycleBin.after = await realRecycleBinCount();
    check(report.realRecycleBin.after === report.realRecycleBin.before, 'The real Recycle Bin changed during the smoke');
    check(client.errors.length === 0, 'Renderer reported an uncaught exception after the cleanup restart');
    report.ok = true;
}

(async () => {
    try { await main(); }
    catch (error) {
        report.error = String(error.message || 'Smoke failed').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').split(MOCK_KEY).join('[mock-key]');
        process.exitCode = 1;
        if (client && root) await screenshot('failure.png').catch(() => {});
    } finally {
        await stopOwnedProcess();
        for (const mock of mocks) {
            mock.server.closeAllConnections?.();
            await new Promise(resolve => mock.server.close(resolve));
        }
        report.completedAt = new Date().toISOString();
        if (root) {
            report.reportPath = path.join(root, 'report.json');
            await fs.writeFile(report.reportPath, JSON.stringify(report, null, 2));
        }
        // Retain only our isolated artifacts; no directories are deleted.
        console.log(JSON.stringify(report, null, 2));
    }
})();
