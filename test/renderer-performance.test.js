const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

class Element {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
        this.attributes = {}; this.className = ''; this.hidden = false; this.value = ''; this.scrollTop = 0;
        this.listeners = {}; this.writes = 0; this._text = ''; this._html = '';
        const setClasses = classes => { this.className = [...classes].join(' '); };
        this.classList = {
            toggle: (name, force) => {
                const classes = new Set(this.className.split(' ').filter(Boolean));
                const enabled = force == null ? !classes.has(name) : force;
                if (enabled) classes.add(name); else classes.delete(name);
                setClasses(classes);
            },
            add: name => { const classes = new Set(this.className.split(' ').filter(Boolean)); classes.add(name); setClasses(classes); },
            remove: name => { const classes = new Set(this.className.split(' ').filter(Boolean)); classes.delete(name); setClasses(classes); },
            contains: name => this.className.split(' ').filter(Boolean).includes(name),
        };
    }
    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); this.writes++; }
    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = value; this.children = []; this.writes++; }
    appendChild(child) { return this.insertBefore(child, null); }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { [...this.children].forEach(child => child.remove()); children.forEach(child => this.appendChild(child)); }
    insertBefore(child, before) {
        if (child.tagName === '#FRAGMENT') { [...child.children].forEach(item => this.insertBefore(item, before)); return child; }
        child.remove(); const index = before ? this.children.indexOf(before) : -1;
        this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentNode = this; return child;
    }
    remove() { if (!this.parentNode) return; const parent = this.parentNode; parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null; }
    hasAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attributes, key); }
    removeAttribute(key) { delete this.attributes[key]; }
    toggleAttribute(key, force) { const on = force == null ? !this.hasAttribute(key) : !!force; if (on) this.setAttribute(key, ''); else this.removeAttribute(key); return on; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    focus() { this.focused = true; }
    scrollIntoView() {}
    querySelectorAll(selector) {
        if (selector.includes(',')) return [...new Set(selector.split(',').flatMap(part => this.querySelectorAll(part.trim())))];
        const matches = node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1))
            : selector === '[data-provider-id]' ? !!node.dataset.providerId : node.tagName.toLowerCase() === selector;
        return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function harness(desktop = {}) {
    const frames = [];
    const document = { addEventListener() {}, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('#fragment'), activeElement: null };
    const context = vm.createContext({ console, URL, Date, Map, Set, document, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
        // 用真实的 UMD 模块而不是手写的替身：替身每次都要跟着真实模块的导出手工同步，
        // 少一个函数就会在 generateImages 里抛出 TypeError，从而被 catch 当成
        // "入队结果未确认"，让这里看到的是 0 次请求而不是一个直白的报错。
        window: { PicGenImageApiProfiles: require('../imageApiProfiles'), PicGenRendererUtils: require('../rendererUtils'), picgenDesktop: desktop },
        fetch: async () => { throw new Error('Unexpected network request'); }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'desktop.js'), 'utf8'), context);
    const state = vm.runInContext('state', context); const el = vm.runInContext('el', context);
    const run = code => vm.runInContext(code, context);
    for (const name of ['queuePage', 'queueList', 'queueMeta', 'queueRunningCount', 'queuePendingCount', 'cancelAllTasksBtn', 'settingsOverlay', 'settingsProviderList', 'settingsProviderMeta', 'historyImages', 'historyCount']) el[name] = new Element();
    run('refreshLucideIcons = () => {}; showToast = () => {};');
    return { state, el, context, run, flush: () => { const pending = frames.splice(0); pending.forEach(callback => callback()); }, get frameCount() { return frames.length; } };
}

function status(id, extra = {}) { return { id, rating: 'available', ratingLabel: '可用', ratingReason: '已就绪', routeCount: 1, availableRouteCount: 1, ...extra }; }

// Supplier drawer draft logic moved to frontend/supplierDraft.mjs; its pure
// behaviors are covered by test/supplier-draft.test.js, and the interactive
// panel behaviors by scripts/supplier-ui-flow.js (packaged smoke).

test('empty provider lists remain empty after deleting the last image or chat group', async () => {
    const h = harness();
    h.context.fetch = async () => ({ok:true,json:async () => []});
    assert.equal((await h.run('loadProviders()')).length,0);
    assert.equal((await h.run('loadChatProviders()')).length,0);
});

test('strategy controls save all modes and keep fixed provider drafts separate from active routing', async () => {
    const h = harness();
    h.state.settingsMode = 'concurrency';
    for (const name of ['providerStrategySelect', 'fixedProviderField', 'fixedProviderSelect', 'saveFailoverBtn',
        'strategyProviderSelect', 'providerConcurrencyInput', 'failoverEnabledToggle', 'failoverMaxAttemptsInput',
        'providerPriorityInput', 'providerCapacityPanel', 'providerPriorityField', 'routingRanking',
        'maxGlobalConcurrentInput', 'failoverThresholdInput']) h.el[name] = new Element();
    for (const input of [h.el.providerConcurrencyInput, h.el.providerPriorityInput]) { input.value = '2'; input.checkValidity = () => true; }
    const radios = ['order', 'priority', 'balanced', 'fixed', 'price', 'speed'].map(value => ({ value, checked: false }));
    h.context.document.querySelectorAll = () => radios;
    h.state.presets = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }, { id: 'off', enabled: false }];
    h.run('refreshModernSelect = () => {}; setActiveProvider = () => {}; saveProviderCapacityFromForm = async () => {}; refreshConcurrencySettings = async () => {};');
    h.context.requests = [];
    h.run('requestProvider = async (url, options) => { const config = JSON.parse(options.body); requests.push(config); return {config}; };');
    for (const strategy of ['order', 'priority', 'balanced', 'price', 'speed', 'fixed']) {
        h.el.providerStrategySelect.value = strategy;
        h.el.fixedProviderSelect.value = 'p2';
        h.run('syncStrategyUi()');
        assert.equal(h.el.providerStrategySelect.value, strategy);
        assert.equal(radios.find(r => r.checked).value, strategy);
        assert.equal(h.el.fixedProviderField.hidden, strategy !== 'fixed');
        assert.equal(h.el.providerCapacityPanel.hidden, !['priority', 'balanced'].includes(strategy));
        assert.equal(h.el.routingRanking.hidden, !['price', 'speed'].includes(strategy));
        assert.notEqual(h.state.fixedProviderId, 'p2', 'unsaved choice cannot change active provider');
        await h.run('saveFailoverSettings()');
        const saved = h.context.requests.at(-1);
        assert.equal(saved.strategy, strategy);
        assert.equal(saved.selectedProviderId, strategy === 'fixed' ? 'p2' : '');
        assert.equal(h.state.routingStrategy, strategy);
        assert.equal(h.el.settingsProviderMeta.textContent, h.run('`当前策略：${ROUTING_STRATEGY_LABELS[state.routingStrategy]}`'));
    }
    assert.equal(h.state.automaticRoutingStrategy, 'speed', 'fixed mode remembers the previous automatic mode');
    h.el.fixedProviderSelect.value = 'off';
    await h.run('saveFailoverSettings()');
    assert.equal(h.context.requests.length, 6, 'disabled groups cannot be saved as fixed targets');
});

test('main provider selector shows the active automatic strategy', () => {
    const h = harness(); h.el.providerSelect = new Element();
    h.state.presets = [{ id: 'p1', name: 'One' }];
    h.run('refreshModernSelect = () => {};');
    for (const [strategy, label] of [['balanced', '负载均衡'], ['price', '价格优先'], ['speed', '速度优先']]) {
        h.context.config = { strategy };
        h.run('applyProviderRoutingConfig(config, {render:false}); renderProviderSelect()');
        assert.ok(h.el.providerSelect.children[0].textContent.endsWith(label));
    }
});

test('health events update only the matching badge and preserve capacity drafts and cards', () => {
    const h = harness(); h.state.settingsMode = 'concurrency';
    h.state.presets = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }];
    const cards = h.state.presets.map(preset => { const card = new Element('button'); card.dataset.providerId = preset.id; const badge = new Element('span'); badge.className = 'provider-health-badge'; card.appendChild(badge); h.el.settingsProviderList.appendChild(card); return card; });
    h.el.providerConcurrencyInput = new Element('input'); h.el.providerConcurrencyInput.value = '';
    h.el.providerStrategySelect = new Element('select'); h.el.providerStrategySelect.value = 'balanced';
    h.run('renderSettingsProviderList = () => { throw new Error("card reconstruction"); }; fillProviderCapacityForm = () => { throw new Error("draft overwritten"); };');
    h.context.statuses = [status('p1'), status('p2')]; h.run('applyProviderHealth(statuses)');
    const writes = cards.map(card => card.children[0].writes);
    h.run('applyProviderHealth(statuses)');
    assert.deepEqual(cards.map(card => card.children[0].writes), writes);
    h.context.statuses = [status('p1', { active: 4 }), status('p2')]; h.run('applyProviderHealth(statuses)');
    assert.deepEqual(cards.map(card => card.children[0].writes), writes, 'invisible counters do not repaint');
    h.context.statuses = [status('p1', { rating: 'failed', ratingLabel: '故障' }), status('p2')]; h.run('applyProviderHealth(statuses)');
    assert.equal(cards[0].children[0].textContent, '故障'); assert.equal(cards[1].children[0].writes, writes[1]);
    assert.equal(h.el.settingsProviderList.children[0], cards[0]); assert.equal(h.el.providerConcurrencyInput.value, '');
});

test('task events coalesce renders without GET and preserve queue action nodes and scroll', async () => {
    const h = harness(); h.state.activeView = 'queue'; h.el.queueList.scrollTop = 345;
    await h.run('handleSocketMessage("task:created", { id: "t1", status: "pending", sequenceId: "other" })'); h.flush();
    const item = h.el.queueList.children[0]; const cancel = item._queueElements.cancel;
    h.context.document.activeElement = cancel;
    for (let i = 0; i < 25; i++) { h.context.percent = i; await h.run('handleSocketMessage("task:progress", { id: "t1", status: "running", sequenceId: "other", providerName: "Chosen API", attempts: [{}, {}], progress: { displayProgress: percent } })'); }
    assert.equal(h.frameCount, 1); h.flush();
    assert.equal(h.el.queueList.children[0], item); assert.equal(item._queueElements.cancel, cancel);
    assert.equal(h.context.document.activeElement, cancel); assert.equal(h.el.queueList.scrollTop, 345);
    assert.equal(h.state.queueTasks[0].progress.displayProgress, 24);
    assert.equal(item._queueElements.provider.textContent, 'Chosen API');
    assert.match(item._queueElements.detail.textContent, /尝试 2/);
    await h.run('handleSocketMessage("task:completed", { id: "t1", status: "completed", sequenceId: "other" })'); h.flush();
    assert.equal(h.state.queueTasks.length, 0);
});

test('in-flight queue snapshot cannot resurrect a completed task or drop a newly created task', async () => {
    const h = harness(); h.state.activeView = 'queue'; let resolveFetch;
    h.context.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
    h.run('applyQueueTask({id: "old", status: "pending"})');
    const loading = h.run('refreshQueue()'); const same = h.run('refreshQueue()');
    h.run('applyQueueTask({id: "old", status: "completed"}); applyQueueTask({id: "new", status: "running"})');
    resolveFetch({ ok: true, json: async () => [{ id: 'old', status: 'pending' }] }); await Promise.all([loading, same]);
    assert.deepEqual([...h.state.queueTasksById.keys()], ['new']);
});

test('completed image merges by id without history IPC and hidden history waits for display', async () => {
    const h = harness(); h.state.historyLoaded = true; h.state.activeView = 'generation';
    h.state.recentImages = [{ id: 'existing', filePath: 'existing.png' }];
    h.context.window.picgenDesktop.listHistoryImages = () => { throw new Error('full history IPC'); };
    h.run('renderRecentImages = () => {}; reconcileHistoryImages = () => { throw new Error("hidden history rendered"); };');
    h.context.task = { id: 'new', status: 'completed', model: 'image', result: { filePath: 'new.png', url: 'file:///new.png' } };
    await h.run('persistCompletedTask(task)'); await h.run('persistCompletedTask(task)');
    assert.equal(h.state.recentImages.length, 2); assert.equal(h.state.recentImages[0].id, 'new');
    assert.equal(h.state.historyDirty, true); h.flush();
});

test('history reconciliation retains visible nodes, selections and scroll after prepending', () => {
    const h = harness(); h.state.activeView = 'history'; h.state.historyRenderedCount = 2;
    h.state.recentImages = [{ id: 'old1' }, { id: 'old2' }];
    h.run('getFilteredHistoryImages = () => state.recentImages; updateHistorySelectionUi = () => {}; createHistoryItem = image => { const item = document.createElement("article"); item.className = "history-item"; item.dataset.historyId = image.id; return item; };');
    h.run('reconcileHistoryImages()'); const old = h.el.historyImages.children[0];
    h.el.historyImages.scrollTop = 820; h.state.historySelectedIds.add('old1');
    h.run('renderRecentImages = () => {}; mergeHistoryRecord({id: "new"})'); h.flush();
    assert.equal(h.el.historyImages.children[1], old); assert.equal(h.el.historyImages.scrollTop, 820);
    assert.equal(h.state.historySelectedIds.has('old1'), true); assert.equal(h.state.historyDirty, false);
});

test('history snapshot merges images completed while its IPC was in flight', async () => {
    const h = harness(); let resolveHistory;
    h.context.window.picgenDesktop.listHistoryImages = () => new Promise(resolve => { resolveHistory = resolve; });
    h.run('renderRecentImages = () => {};');
    const loading = h.run('refreshRecentImages({full: true})');
    h.run('mergeHistoryRecord({id: "new", filePath: "new.png"})');
    resolveHistory([{ id: 'old', filePath: 'old.png' }]); await loading;
    assert.deepEqual([...h.state.recentImages.map(image => image.id)].sort(), ['new', 'old']);
    assert.equal(h.state.savedImageTaskIds.has('new'), true);
});

function generationHarness(count = 4) {
    const h = harness();
    const sequence = { id: 's1', count, model: 'image-model', prompt: 'draw', references: [{ base64: 'image-fixture-data', mimeType: 'image/png' }], runningTasks: new Set(), taskProgress: new Map() };
    const batch = { id: 'b1', taskIds: new Set(), taskStates: new Map(), sourceBatchTotals: new Map([['b1', count]]), total: count };
    sequence.batch = batch; h.state.sequences = [sequence]; h.context.sequence = sequence; h.context.batch = batch;
    h.run('saveCurrentSequenceFromForm = () => {}; getCurrentSequence = () => sequence; getSequencePreset = () => ({id:"p1", name:"Provider", baseUrl:"https://example.invalid", apiKey:"fixture"}); resolvePromptMentions = () => "draw"; buildGenerationConfig = () => ({}); startBatch = () => ({batch, startIndex: 0, batchTotal: sequence.count}); setSequenceStatus = () => {}; updateActionState = () => {}; updateBatchProgress = () => {}; finishBatchSubmission = () => {};');
    return { h, sequence, batch };
}

test('a batch uses one POST with one reference array and does not resurrect an early completion', async () => {
    const { h, sequence, batch } = generationHarness(); const calls = [];
    h.context.fetch = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        batch.taskStates.set('t1', 'completed'); batch.taskIds.add('t1');
        batch.taskStates.set('t2', 'running'); batch.taskIds.add('t2');
        return { ok: true, json: async () => ({ taskIds: ['t1', 't2', 't3', 't4'], status: 'pending' }) };
    };
    await h.run('generateImages()');
    assert.equal(calls.length, 1); assert.match(calls[0].url, /\/api\/tasks\/batch$/);
    assert.equal(calls[0].body.count, 4); assert.equal(calls[0].body.referenceImages.length, 1);
    assert.equal(JSON.stringify(calls[0].body).split('image-fixture-data').length - 1, 1);
    assert.equal(sequence.runningTasks.has('t1'), false); assert.equal(batch.taskStates.get('t2'), 'running');
    assert.deepEqual([...sequence.runningTasks], ['t2', 't3', 't4']);
});

test('uncertain batch submission is not retried', async () => {
    const { h, batch } = generationHarness(); let calls = 0;
    h.context.fetch = async () => { calls++; throw new Error('connection lost'); };
    await h.run('generateImages()'); assert.equal(calls, 1);
    assert.equal(batch.taskIds.size, 0, 'unknown submissions are not fabricated failed tasks');
});

function liveSequenceHarness() {
    const h = harness();
    h.run('updateBatchProgress = () => {}; updateActionState = () => {}; setSequenceStatus = () => {}; persistCompletedTask = async task => { state.savedImageTaskIds.add(task.id); }; state.sequences = [{ id: "s", runningTasks: new Set(["t"]), taskProgress: new Map(), batch: createEmptyBatch({ id: "b", total: 1, sourceBatchTotals: [["b", 1]], taskIds: ["t"], taskStates: [["t", "running"]], createdAt: 1 }) }]; getCurrentSequence = () => state.sequences[0];');
    return h;
}

const liveTask = overrides => ({ id: 't', sequenceId: 's', batchId: 'b', batchTotal: 1, batchIndex: 0, status: 'running', createdAt: 2, ...overrides });

test('reconnect snapshot preserves websocket terminal state in both queue and sequence runtime', async () => {
    const h = liveSequenceHarness(); let reply;
    h.context.fetch = () => new Promise(resolve => { reply = resolve; });
    const loading = h.run('syncTasks()');
    h.context.completed = liveTask({ status: 'completed', completedAt: 3, result: { filePath: 'x.png' } });
    await h.run('handleSocketMessage("task:completed", completed)');
    reply({ ok: true, json: async () => [liveTask()] }); await loading;
    assert.equal(h.state.queueTasksById.size, 0);
    assert.equal(h.state.sequences[0].runningTasks.size, 0);
    assert.equal(h.state.sequences[0].batch.taskStates.get('t'), 'completed');
});

test('reconnect removes tasks that failed or were cancelled while disconnected', async () => {
    const h = liveSequenceHarness();
    h.context.fetch = async () => ({ ok: true, json: async () => [liveTask({ status: 'failed' })] });
    await h.run('syncTasks()');
    assert.equal(h.state.sequences[0].runningTasks.size, 0);
    assert.equal(h.state.sequences[0].batch.taskStates.get('t'), 'failed');
});

test('a rejected saving-phase cancellation cannot overwrite completion that arrived before its response', async () => {
    const h = liveSequenceHarness(); let deleteReply;
    const completed = liveTask({ status: 'completed', result: { filePath: 'x.png' } });
    h.context.fetch = (url, options) => options?.method === 'DELETE'
        ? new Promise(resolve => { deleteReply = resolve; })
        : Promise.resolve({ ok: true, json: async () => [completed] });
    const cancelling = h.run('cancelQueuedTask("t")');
    h.context.completed = completed; await h.run('handleSocketMessage("task:completed", completed)');
    deleteReply({ ok: true, json: async () => ({ success: false }) }); await cancelling;
    assert.equal(h.state.sequences[0].batch.taskStates.get('t'), 'completed');
    assert.equal(h.state.sequences[0].runningTasks.size, 0);
    assert.equal(h.state.savedImageTaskIds.has('t'), true);
});

test('cancel all and stop sequence keep saving tasks running when the server refuses cancellation', async () => {
    const h = liveSequenceHarness(); h.state.queueTasks = [liveTask({ phase: 'saving' })];
    h.run('askConfirm = async () => true;');
    h.context.fetch = async (url, options) => ({ ok: true, json: async () => options?.method === 'DELETE'
        ? (url.includes('?sequenceId=') ? { cancelled: 0 } : { success: false })
        : [liveTask({ phase: 'saving' })] });
    await h.run('cancelAllQueuedTasks()');
    assert.equal(h.state.sequences[0].runningTasks.has('t'), true);
    assert.equal(h.state.sequences[0].batch.taskStates.get('t'), 'running');
    await h.run('stopCurrentSequence()');
    assert.equal(h.state.sequences[0].runningTasks.has('t'), true);
    assert.equal(h.state.sequences[0].batch.taskStates.get('t'), 'running');
});

test('recent strip shows newest timestamps first after out-of-order reconnect merges', () => {
    const h = harness(); h.el.recentImages = new Element();
    h.run('attachHistoryThumbnail = () => {}; for (const createdAt of [12,2,9,1,10,4,11,5,8,3,7,6]) mergeHistoryRecord({id:`image${createdAt}`, fileName:`image${createdAt}.png`, createdAt});');
    h.flush();
    assert.equal(h.state.recentImages.length, 12, 'the full history index remains untruncated');
    assert.equal(h.el.recentImages.children.length, 10, 'the recent strip shows only ten images');
    h.el.recentImages.children.forEach((item, index) => assert.ok(item.getAttribute('aria-label').startsWith(`image${12 - index}.png`)));
});

// --- similar view (v3.1 WP11) ------------------------------------------------------------------------
// Synthetic fixtures only. Keys follow historyKey (id first).
function similarImage(id, createdAt, prompt = `prompt ${id}`) {
    return { id, filePath: `C:/fixtures/${id}.png`, fileName: `${id}.png`, url: `file:///C:/fixtures/${id}.png`, prompt, createdAt, ratio: '1:1', model: 'fixture' };
}

function similarGroup(id, members, extra = {}) {
    return { id, members, pinned: null, latestAt: 0, promptVariants: 1, ratios: ['1:1'], provisional: false, parts: null, rest: [], failed: [], ...extra };
}

function similarSnapshot(revision, groups, singles = [], extra = {}) {
    return { version: 3, revision, mode: 'hd', modeReason: null, preset: 'standard', stage: 'final', groups, singles,
        missing: 0, failed: 0, pending: 0, analyzed: 0, total: 0, stats: { decoded: 0 }, error: null, ...extra };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function similarHarness(images, snapshot) {
    const h = harness();
    h.context.window.PicGenSimilarProjection = require('../similarProjection');
    const calls = { groups: [], neighbors: [] };
    h.calls = calls;
    h.context.window.picgenDesktop.getSimilarityGroups = async query => {
        calls.groups.push(query);
        const next = h.nextSnapshot; h.nextSnapshot = null;
        return next || { notModified: true, revision: query.since };
    };
    h.context.window.picgenDesktop.getSimilarNeighbors = async query => {
        calls.neighbors.push(query);
        return h.neighbors || { items: [], analyzed: true, mode: 'hd' };
    };
    for (const name of ['historySimilarToolbar', 'historySimilarStatus', 'historySimilarProgress', 'historySimilarPreset', 'historySimilarSort', 'historySimilarSingles']) h.el[name] = new Element();
    h.state.activeView = 'history'; h.state.historyLayout = 'similar'; h.state.historyLoaded = true;
    h.state.recentImages = images; h.state.similarSnapshot = snapshot;
    h.context.filterText = '';
    h.run('updateHistorySelectionUi = () => {}; formatHistoryRelativeDate = () => ""; getFilteredHistoryImages = () => state.recentImages.filter(image => !filterText || String(image.prompt).includes(filterText));');
    return h;
}

const rowIds = h => h.state.similarDom.rows.children.map(row => row.dataset.groupId);

test('similar view: filter typing re-projects the cached snapshot with no similarity IPC', async () => {
    const images = [similarImage('a', 60, 'red cat'), similarImage('b', 50, 'red cat'), similarImage('c', 40, 'blue dog'), similarImage('d', 30, 'blue dog'), similarImage('s', 20, 'single')];
    const h = similarHarness(images, similarSnapshot(5, [similarGroup('g1', ['a', 'b']), similarGroup('g2', ['c', 'd'])], ['s']));
    h.run('renderHistoryImages()'); await tick();
    assert.deepEqual(rowIds(h), ['g1', 'g2']);
    assert.equal(h.calls.groups.length, 1, 'opening the view asks once, with since');
    assert.equal(h.calls.groups[0].since, 5);
    assert.equal(h.calls.groups[0].preset, 'standard');
    assert.equal(h.el.historySimilarToolbar.hidden, false);
    assert.equal(h.el.historySimilarStatus.textContent, '2 组 · 4 张 · 另有 1 张单张');
    for (const text of ['b', 'bl', 'blue', 'blue d', '']) {
        h.context.filterText = text;
        h.run('renderHistoryImages()');
    }
    h.context.filterText = 'blue';
    h.run('renderHistoryImages()'); await tick();
    assert.equal(h.calls.groups.length, 1, 'filter keystrokes cause no similarity IPC');
    assert.deepEqual(rowIds(h), ['g2']);
    assert.deepEqual(h.state.similarGroups.map(group => group.id), ['g2']);
    assert.equal(h.el.historyCount.textContent, '2 张 · 1 组相似');
});

test('similar view: a push with an unchanged revision rebuilds nothing', async () => {
    const images = [similarImage('a', 60), similarImage('b', 50), similarImage('c', 40), similarImage('d', 30)];
    const h = similarHarness(images, similarSnapshot(5, [similarGroup('g1', ['a', 'b']), similarGroup('g2', ['c', 'd'])]));
    h.run('renderHistoryImages()'); await tick();
    const rows = [...h.state.similarDom.rows.children];
    h.run('createSimilarGroupRow = () => { throw new Error("row rebuilt"); };');
    h.el.historyImages.replaceChildren = () => { throw new Error('host cleared'); };
    const asked = h.calls.groups.length;
    h.run('handleSimilarityUpdated({ revision: 5, stage: "final", pending: 0 })'); await tick();
    assert.equal(h.calls.groups.length, asked, 'same revision: no IPC');
    // A new revision the service answers with notModified patches nothing either.
    h.run('handleSimilarityUpdated({ revision: 6, stage: "final" })'); await tick();
    assert.equal(h.calls.groups.length, asked + 1);
    assert.deepEqual([...h.state.similarDom.rows.children], rows);
    // Not visible: remember the push, refetch when the view is shown again.
    h.state.activeView = 'generation'; h.state.historyDirty = false;
    h.run('handleSimilarityUpdated({ revision: 7 })'); await tick();
    assert.equal(h.calls.groups.length, asked + 1);
    assert.equal(h.state.similarStale, true);
    assert.equal(h.state.historyDirty, true, 'showHistoryView will reconcile the similar view');
    h.state.activeView = 'history';
    h.nextSnapshot = similarSnapshot(7, [similarGroup('g1', ['a', 'b']), similarGroup('g2', ['c', 'd'])]);
    h.run('reconcileHistoryImages()'); await tick();
    assert.equal(h.calls.groups.length, asked + 2, 'the stale view refetches once it is shown');
    assert.equal(h.calls.groups.at(-1).since, 5);
    assert.equal(h.state.similarSnapshot.revision, 7);
    assert.equal(h.state.similarStale, false);
});

test('similar view: a patch keeps the open group, its rows and scroll; new groups wait behind the pill', async () => {
    const images = [similarImage('a', 60), similarImage('b', 50), similarImage('c', 40), similarImage('d', 30), similarImage('x', 20), similarImage('y', 10)];
    const h = similarHarness(images.filter(image => !['x', 'y'].includes(image.id)), similarSnapshot(5, [similarGroup('g1', ['a', 'b']), similarGroup('g2', ['c', 'd'])]));
    h.run('renderHistoryImages()'); await tick();
    const row = h.state.similarRows.get('g2');
    row.open = true; row.listeners.toggle();
    assert.equal(h.state.similarOpenIds.has('g2'), true);
    assert.deepEqual(row._similar.content.querySelectorAll('.history-item').map(item => item.dataset.historyId), ['c', 'd']);
    const actions = row._similar.actions.children.map(button => button.dataset.action);
    assert.deepEqual(actions, ['select', 'find', 'collapse']);
    h.el.historyImages.scrollTop = 40;
    h.el.historyImages.replaceChildren = () => { throw new Error('host cleared'); };
    h.state.recentImages = images;
    // Revision 6: g2 gains x, g1 keeps one visible member, and a new group appears.
    h.nextSnapshot = similarSnapshot(6, [similarGroup('g3', ['y', 'a']), similarGroup('g1', ['b', 'z']), similarGroup('g2', ['x', 'c', 'd'])]);
    h.run('handleSimilarityUpdated({ revision: 6 })'); await tick();
    assert.equal(h.state.similarRows.get('g2'), row, 'the open row is patched, not rebuilt');
    assert.equal(row.open, true);
    assert.equal(row._similar.count.textContent, '3 张');
    assert.deepEqual(row._similar.content.querySelectorAll('.history-item').map(item => item.dataset.historyId), ['x', 'c', 'd']);
    assert.deepEqual(rowIds(h), ['g2'], 'g1 lost a visible member and left; g3 is deferred');
    assert.equal(h.state.similarDom.pill.hidden, false);
    assert.equal(h.state.similarDom.pill.textContent, '1 个新分组 · 查看');
    assert.equal(h.el.historyImages.scrollTop, 40);
    // Three forced revisions with the same content keep everything in place.
    for (const revision of [7, 8, 9]) h.run(`applySimilaritySnapshot({ ...state.similarSnapshot, revision: ${revision} })`);
    assert.equal(h.state.similarRows.get('g2'), row); assert.equal(row.open, true); assert.equal(h.el.historyImages.scrollTop, 40);
    // The pill shows the deferred groups in projection order.
    h.state.similarDom.pill.listeners.click();
    assert.deepEqual(rowIds(h), ['g3', 'g2']);
    assert.equal(h.state.similarDom.pill.hidden, true);
    assert.equal(h.state.similarRows.get('g2'), row);
});

test('similar view: a group that loses its id reopens under the largest-overlap id', async () => {
    const images = [similarImage('a', 60), similarImage('b', 50), similarImage('c', 40), similarImage('d', 30), similarImage('x', 20)];
    const h = similarHarness(images, similarSnapshot(5, [similarGroup('g1', ['a', 'b', 'c', 'd'])]));
    h.run('renderHistoryImages()'); await tick();
    const row = h.state.similarRows.get('g1');
    row.open = true; row.listeners.toggle();
    h.run('applySimilaritySnapshot(' + JSON.stringify(similarSnapshot(6, [similarGroup('n1', ['a', 'b', 'c']), similarGroup('n2', ['d', 'x'])])) + ')');
    assert.equal(h.state.similarRows.get('n1'), row, 'the open row follows its members to the new id');
    assert.equal(row.dataset.groupId, 'n1');
    assert.equal(row.open, true);
    assert.equal(h.state.similarOpenIds.has('n1'), true);
    assert.equal(h.state.similarOpenIds.has('g1'), false);
    assert.deepEqual(row._similar.content.querySelectorAll('.history-item').map(item => item.dataset.historyId), ['a', 'b', 'c']);
});

test('similar view: singles stay hidden until the switch is on and never render one card each', async () => {
    const images = [similarImage('a', 60), similarImage('b', 50), similarImage('s1', 40), similarImage('s2', 30)];
    const h = similarHarness(images, similarSnapshot(5, [similarGroup('g1', ['a', 'b'])], ['s1', 's2']));
    h.run('renderHistoryImages()'); await tick();
    const dom = h.state.similarDom;
    assert.equal(dom.footer.hidden, false);
    assert.equal(dom.footerText.textContent, '另有 2 张没有相似图片 ·');
    assert.equal(dom.singles.hidden, true);
    assert.equal(dom.singles.children.length, 0);
    dom.footerButton.listeners.click();
    assert.equal(h.state.showSingles, true);
    assert.equal(h.el.historySimilarSingles.checked, true);
    assert.equal(dom.singles.hidden, false);
    assert.deepEqual(dom.singles.children.map(item => item.dataset.historyId), ['s1', 's2']);
    assert.equal(h.calls.groups.length, 1, 'the singles switch causes no IPC');
});

test('find similar shows scores and chips, refetches on toggles and restores the view', async () => {
    const images = [similarImage('a', 60), similarImage('b', 50), similarImage('c', 40), similarImage('d', 30)];
    const h = similarHarness(images, similarSnapshot(5, [similarGroup('g1', ['a', 'b']), similarGroup('g2', ['c', 'd'])]));
    h.run('renderHistoryImages()'); await tick();
    h.el.historyImages.scrollTop = 24;
    h.neighbors = { analyzed: true, mode: 'hd', items: [
        { key: 'b', similarity: 97, samePrompt: true, nearPrompt: false, sameGroup: true },
        { key: 'c', similarity: 81, samePrompt: false, nearPrompt: true, sameGroup: false },
        { key: 'gone', similarity: 80, samePrompt: false, nearPrompt: false, sameGroup: false }] };
    h.run('openFindSimilar(state.recentImages[0])'); await tick();
    assert.deepEqual({ ...h.calls.neighbors.at(-1) }, { key: 'a', preset: 'standard', limit: 60, mode: 'combined', samePromptOnly: false });
    const find = h.state.similarFind;
    assert.equal(h.el.historySimilarToolbar.hidden, true);
    assert.equal(find.dom.title.textContent, '与此图相似 · 2 张');
    const items = [...find.dom.grid.children];
    assert.deepEqual(items.map(item => item.dataset.historyId), ['b', 'c']);
    assert.equal(items[0]._similarScore.textContent, '97%');
    assert.deepEqual(items[0]._similarChips.children.map(chip => chip.textContent), ['同提示词', '本组']);
    assert.deepEqual(items[1]._similarChips.children.map(chip => chip.textContent), ['近似提示词']);
    find.dom.visual.listeners.click(); await tick();
    assert.equal(h.calls.neighbors.at(-1).mode, 'visual');
    assert.equal(find.dom.visual.attributes['aria-pressed'], 'true');
    find.dom.samePrompt.listeners.click(); await tick();
    assert.equal(h.calls.neighbors.at(-1).samePromptOnly, true);
    assert.equal(find.dom.grid.children[0], items[0], 'result items are reused across refetches');
    find.dom.close.listeners.click();
    assert.equal(h.state.similarFind, null);
    assert.deepEqual(rowIds(h), ['g1', 'g2']);
    assert.equal(h.el.historyImages.scrollTop, 24);
    assert.equal(h.el.historySimilarToolbar.hidden, false);
});

test('similar status names the stage and the basic mode with its reason', async () => {
    const images = [similarImage('a', 60), similarImage('b', 50)];
    const h = similarHarness(images, similarSnapshot(5, [similarGroup('g1', ['a', 'b'], { provisional: true })], [],
        { stage: 'partial', mode: 'h', modeReason: 'model-missing', analyzed: 1200, total: 5819 }));
    h.run('renderHistoryImages()'); await tick();
    assert.equal(h.el.historySimilarStatus.textContent, '分析中 1,200/5,819 · 未分析的图片暂按提示词分组 · 基础模式');
    assert.equal(h.el.historySimilarStatus.title, '视觉模型未加载：模型文件缺失');
    assert.equal(h.el.historySimilarProgress.hidden, false);
    assert.equal(h.state.similarRows.get('g1').hasAttribute('data-provisional'), true);
});

// --- usage badges and the Recycle-Bin trash (v3.1 WP12) ------------- ------------------------------
const SELECTION_ELEMENTS = ['historySelectionBar', 'historySelectionMeta', 'historyDetailDrawer', 'historyDetailBody', 'historySelectAllBtn',
    'historyInvertBtn', 'historyClearSelectionBtn', 'historyTrashBtn', 'historyTrashProtectedToggle',
    'historyTrashIncludeProtected', 'historyTrashProtectedText', 'historyTrashResult', 'historyTrashResultText', 'historyTrashOpenBinBtn',
    'historyTrashRetryBtn', 'historyTrashDismissBtn'];

function withSelectionUi(h) {
    for (const name of SELECTION_ELEMENTS) h.el[name] = new Element();
    for (const name of ['historyTrashResult', 'historyTrashRetryBtn', 'historyTrashProtectedToggle']) h.el[name].hidden = true;
    h.context.window.PicGenHistoryUsage = require('../historyUsage');
    h.toasts = [];
    h.context.toasts = h.toasts;
    h.run('showToast = message => { toasts.push(String(message)); };');
    return h;
}

function usageImage(id, createdAt, extra = {}) {
    return { ...similarImage(id, createdAt, 'same prompt'), fileSize: 1000 + createdAt, ...extra };
}

// A similar view with the real selection UI (similarHarness stubs it).
async function similarSelectionView(images, snapshot) {
    const h = withSelectionUi(harness());
    h.context.window.PicGenSimilarProjection = require('../similarProjection');
    h.context.window.picgenDesktop.getSimilarityGroups = async query => ({ notModified: true, revision: query.since });
    for (const name of ['historySimilarToolbar', 'historySimilarStatus', 'historySimilarProgress', 'historySimilarPreset', 'historySimilarSort', 'historySimilarSingles']) h.el[name] = new Element();
    h.state.activeView = 'history'; h.state.historyLayout = 'similar'; h.state.historyLoaded = true;
    h.state.recentImages = images; h.state.similarSnapshot = snapshot;
    h.run('formatHistoryRelativeDate = () => ""; getFilteredHistoryImages = () => state.recentImages;');
    h.run('renderHistoryImages()'); await tick();
    return h;
}

test('a usage push patches the record and its badge in place without rebuilding history', () => {
    let listener = null;
    const h = withSelectionUi(harness({ onHistoryUsageUpdated: callback => { listener = callback; return () => {}; } }));
    assert.equal(typeof listener, 'function', 'desktop.js subscribes to usage pushes at load');
    h.state.activeView = 'history'; h.state.historyLayout = 'grid'; h.state.historyLoaded = true;
    const images = [usageImage('a', 20), usageImage('b', 10)];
    h.state.recentImages = images;
    const items = images.map(image => h.run(`createHistoryItem(state.recentImages.find(image => image.id === ${JSON.stringify(image.id)}))`));
    items.forEach(item => h.el.historyImages.appendChild(item));
    assert.equal(items[0].querySelector('.history-usage-badge'), null, 'an unused image has no badge');
    h.run('createHistoryItem = () => { throw new Error("item rebuilt"); }; renderRecentImages = () => { throw new Error("strip rebuilt"); }; reconcileHistoryImages = () => { throw new Error("history rebuilt"); };');
    const revision = h.state.historyRevision;
    const push = usage => listener({ usageKey: 'a.png|1020', filePath: images[0].filePath, usage });
    push({ dragCount: 1, referenceCount: 0, lastUsedAt: Date.UTC(2026, 8, 24, 6, 3), lastUsedKind: 'drag-out' });
    assert.equal(images[0].dragCount, 1);
    assert.equal(h.state.historyRevision, revision + 1);
    assert.equal(h.state.historyChanges.get('a').record, images[0], 'an in-flight refresh cannot revert the counters');
    const badge = items[0].querySelector('.history-usage-badge');
    assert.ok(badge, 'the badge is added in place');
    assert.equal(badge.querySelector('b').textContent, '1');
    assert.match(badge.title, /^拖出\/复制\/另存 1 次\n最近使用：/);
    assert.match(items[0].getAttribute('aria-label'), /，已使用 1 次$/);
    assert.equal(h.el.historyImages.children[0], items[0]);
    assert.equal(items[1].querySelector('.history-usage-badge'), null, 'other items are untouched');
    // Absolute values: a repeat changes nothing; a higher count updates the same badge node.
    push({ dragCount: 1, referenceCount: 0, lastUsedAt: Date.UTC(2026, 8, 24, 6, 3), lastUsedKind: 'drag-out' });
    assert.equal(h.state.historyRevision, revision + 1, 'an identical push is a no-op');
    push({ dragCount: 1, referenceCount: 2, lastUsedAt: Date.UTC(2026, 8, 24, 7, 0), lastUsedKind: 'reference' });
    assert.equal(items[0].querySelector('.history-usage-badge'), badge);
    assert.equal(badge.querySelector('b').textContent, '3');
    assert.match(items[0].getAttribute('aria-label'), /，已使用 3 次$/);
});

test('history tiles carry no title, so Windows cannot raise its infotip over the hover preview', () => {
    const h = withSelectionUi(harness());
    h.state.recentImages = [usageImage('a', 20, { fileName: 'sunset.png' })];
    const item = h.run('createHistoryItem(state.recentImages[0])');
    assert.equal(item.hasAttribute('title'), false, 'a title attribute renders as a system infotip that covers the preview');
    assert.equal(item.querySelector('.history-file-name').hasAttribute('title'), false);
    const label = item.getAttribute('aria-label');
    assert.match(label, /^sunset\.png，点击查看详情/);
    assert.match(label, /可多选$/);
    const recent = h.run('el.recentImages = document.createElement("div"); renderRecentImages(); el.recentImages');
    const recentItem = recent.querySelector('.recent-item');
    assert.equal(recentItem.hasAttribute('title'), false);
    assert.match(recentItem.getAttribute('aria-label'), /^sunset\.png，点击查看详情/);
    const binItem = h.run('createHistoryBinItem({ filePath: "C:/pic/sunset.png", fileName: "sunset.png" })');
    assert.equal(binItem.hasAttribute('title'), false);
    assert.equal(binItem.querySelector('.history-file-name').hasAttribute('title'), false);
    assert.match(binItem.getAttribute('aria-label'), /^sunset\.png，点击选择/);
});

test('an in-flight history refresh cannot bring trashed records back', async () => {
    let resolveHistory;
    const h = withSelectionUi(harness({ listHistoryImages: () => new Promise(resolve => { resolveHistory = resolve; }) }));
    h.run('renderRecentImages = () => {};');
    const images = [usageImage('a', 30), usageImage('b', 20), usageImage('c', 10)];
    h.state.recentImages = images.map(image => ({ ...image })); h.state.historyLoaded = true;
    h.state.historySelectedIds.add('b');
    const loading = h.run('refreshRecentImages({ full: true })');
    h.run('removeHistoryRecordsLocally(["b"])');
    assert.deepEqual(h.state.recentImages.map(image => image.id), ['a', 'c']);
    assert.equal(h.state.historySelectedIds.has('b'), false);
    resolveHistory(images.map(image => ({ ...image })));
    await loading;
    assert.deepEqual([...h.state.recentImages.map(image => image.id)].sort(), ['a', 'c'], 'the stale snapshot still listed b');
    // A refresh that starts after the removal no longer needs the guard.
    const next = h.run('refreshRecentImages({ full: true })');
    resolveHistory([images[0], images[2]].map(image => ({ ...image })));
    await next;
    assert.equal(h.state.historyRemovals.size, 0);
});

test('trash asks the in-app dialog, keeps failed ids selected and retries only those', async () => {
    const calls = [];
    const results = [];
    const h = withSelectionUi(harness({ trashHistoryImages: async payload => { calls.push(payload); return results.shift(); } }));
    h.run('renderRecentImages = () => {}; reconcileHistoryImages = () => {};');
    const images = [usageImage('a', 30), usageImage('b', 20), usageImage('c', 10, { dragCount: 2 })];
    h.state.recentImages = images; h.state.historyLoaded = true; h.state.activeView = 'history';
    for (const id of ['a', 'b', 'c']) h.state.historySelectedIds.add(id);
    // No Appica confirm and no #confirmOverlay: the strict confirm refuses, nothing is trashed.
    await h.run('confirmTrash()');
    assert.equal(calls.length, 0, 'no dialog, no trash');
    const questions = [];
    h.context.window.PicGenAppica = { confirm: async (message, options) => { questions.push({ message, options }); return true; } };
    results.push({ batchId: 't1', trashed: [{ id: 'a', filePath: images[0].filePath }], missing: [],
        failed: [{ id: 'b', filePath: images[1].filePath, message: '无法移到回收站' }], skipped: [], total: 2 });
    await h.run('confirmTrash()');
    assert.equal(questions.length, 1);
    assert.equal(questions[0].options.danger, true);
    assert.equal(questions[0].options.okText, '移到回收站');
    assert.match(questions[0].message, /^将 2 张图片（共 2 KB）移到回收站。保留：拖用过的 1 张。/);
    assert.equal(calls.length, 1);
    assert.deepEqual([...calls[0].items.map(item => item.id)], ['a', 'b'], 'the protected image stays out unless the switch is on');
    assert.equal(calls[0].includeProtected, false);
    assert.deepEqual([...calls[0].confirmProtected], []);
    assert.equal(calls[0].reason, 'selection');
    assert.ok(calls[0].requestId);
    assert.deepEqual(h.state.recentImages.map(image => image.id), ['b', 'c']);
    assert.deepEqual([...h.state.historySelectedIds].sort(), ['b', 'c'], 'the failed id stays selected');
    assert.equal(h.el.historyTrashResult.hidden, false);
    assert.match(h.el.historyTrashResultText.textContent, /^已移到回收站 1 张；1 张未能移动/);
    assert.equal(h.el.historyTrashRetryBtn.hidden, false);
    assert.equal(h.state.historyTrashBusy, false);
    results.push({ batchId: 't2', trashed: [{ id: 'b', filePath: images[1].filePath }], missing: [], failed: [], skipped: [], total: 1 });
    await h.run('retryHistoryTrash()');
    assert.equal(calls.length, 2);
    assert.deepEqual([...calls[1].items.map(item => item.id)], ['b'], '重试 resends only the failed ids');
    assert.notEqual(calls[1].requestId, calls[0].requestId);
    assert.deepEqual(h.state.recentImages.map(image => image.id), ['c']);
    assert.equal(h.el.historyTrashRetryBtn.hidden, true);
    assert.match(h.el.historyTrashResultText.textContent, /^已移到回收站 1 张。/);
    // The protected image goes only with the switch on, and is then listed as confirmed.
    h.el.historyTrashIncludeProtected.checked = true;
    h.state.historyTrashIncludeProtected = true;
    results.push({ batchId: 't3', trashed: [{ id: 'c', filePath: images[2].filePath }], missing: [], failed: [], skipped: [], total: 0 });
    await h.run('confirmTrash()');
    assert.deepEqual([...calls[2].items.map(item => item.id)], ['c']);
    assert.equal(calls[2].includeProtected, true);
    assert.deepEqual([...calls[2].confirmProtected], ['c']);
    assert.match(questions.at(-1).message, /其中 1 张拖用过（可能正被用作 AI 参考图）/);
});

test('the group row counts used members; 选中本组 selects the group and protected members stay out by default', async () => {
    const images = [usageImage('a', 60), usageImage('b', 50, { referenceCount: 1 }), usageImage('c', 40), usageImage('d', 30), usageImage('e', 20)];
    const h = await similarSelectionView(images, similarSnapshot(5, [similarGroup('g1', ['a', 'b', 'c', 'd', 'e'], { pinned: 'a', failed: ['e'] })]));
    const row = h.state.similarRows.get('g1');
    const chip = row._similar.used;
    assert.equal(chip.hidden, false, 'the group row shows how many members were used');
    assert.equal(chip.querySelector('b').textContent, '1');
    assert.equal(chip.title, '本组 1 张被拖出、复制、另存或用作参考图，批量删除时默认保留');
    row.open = true; row.listeners.toggle();
    const button = action => row._similar.actions.children.find(node => node.dataset.action === action);
    assert.equal(button('cleanup'), undefined, '清理本组 is gone');
    button('select').listeners.click();
    assert.deepEqual([...h.state.historySelectedIds].sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(h.el.historySelectAllBtn.hidden, false);
    assert.equal(h.el.historyInvertBtn.hidden, false);
    assert.equal(h.el.historySelectionMeta.textContent, '已选择 5 张（含 1 张拖用过，默认保留）');
    assert.equal(h.el.historyTrashProtectedToggle.hidden, false, 'a selected protected image shows the switch');
    assert.equal(h.el.historyTrashProtectedText.textContent, '同时删除拖用过的 (1)');
    assert.equal(h.el.historyTrashBtn.textContent, '移到回收站 (4)');
});

test('closing find similar shows the same similar rows at the same scroll position', async () => {
    const images = [similarImage('a', 60), similarImage('b', 50), similarImage('c', 40), similarImage('d', 30)];
    const h = similarHarness(images, similarSnapshot(5, [similarGroup('g1', ['a', 'b']), similarGroup('g2', ['c', 'd'])]));
    h.run('renderHistoryImages()'); await tick();
    const row = h.state.similarRows.get('g2');
    row.open = true; row.listeners.toggle();
    const dom = h.state.similarDom;
    const rows = [...dom.rows.children];
    h.el.historyImages.scrollTop = 612;
    h.run('openFindSimilar(state.recentImages[2])'); await tick();
    assert.equal(dom.root.hidden, true, 'the similar list is parked, not destroyed');
    assert.equal(h.state.similarFind.dom.root.hidden, false);
    assert.equal(h.el.historyImages.scrollTop, 0, 'results start at the top');
    h.run('createSimilarGroupRow = () => { throw new Error("row rebuilt"); }; createHistoryItem = () => { throw new Error("item rebuilt"); };');
    h.state.similarFind.dom.close.listeners.click();
    assert.equal(h.state.similarFind, null);
    assert.equal(h.state.similarDom, dom);
    assert.equal(dom.root.hidden, false);
    assert.deepEqual([...dom.rows.children], rows);
    assert.equal(h.state.similarRows.get('g2'), row);
    assert.equal(row.open, true);
    assert.equal(h.el.historyImages.scrollTop, 612);
    assert.equal(h.el.historyImages.classList.contains('similar-layout'), true);
    assert.equal(h.el.historyImages.classList.contains('find-similar-layout'), false);
    assert.deepEqual(h.el.historyImages.children, [dom.root], 'the results view is removed');
});

// --- filters (vendor, date, usage), sort, search, drag-to-trash and the in-app recycle bin ----------
function filterHarness(h, usage) {
    for (const name of ['historySearchInput', 'historySearchClearBtn']) h.el[name] = new Element();
    h.context.window.PicGenHistorySearch = require('../historySearch');
    h.context.window.PicGenHistoryFilters = require('../historyFilters');
    h.renders = [];
    h.context.renders = h.renders;
    h.context.window.PicGenAppica = { renderHistoryFilters: props => h.renders.push(props) };
    h.run('loadHistoryFilterPreferences()');
    h.state.historyFilters = h.context.window.PicGenHistoryFilters.normalize({ usage: usage || '' });
    return h;
}
const ids = h => h.run('getFilteredHistoryImages()').map(image => image.id);

test('the usage filter keeps used (dragged or referenced) or unused images; the sort applies on top', () => {
    const h = filterHarness(withSelectionUi(harness()), 'used');
    h.state.recentImages = [usageImage('c', 10, { referenceCount: 2 }), usageImage('b', 20), usageImage('a', 30, { dragCount: 1 })];
    assert.deepEqual(ids(h), ['a', 'c']);
    h.state.historySort = 'oldest';
    assert.deepEqual(ids(h), ['c', 'a']);
    h.state.historySort = 'used';
    assert.deepEqual(ids(h), ['c', 'a'], 'most used first');
    h.state.historyFilters = { usage: 'unused' };
    assert.deepEqual(ids(h), ['b']);
    h.state.historyFilters = {};
    h.state.historySort = 'newest';
    assert.deepEqual(ids(h), ['a', 'b', 'c']);
});

test('the vendor filter groups models by maker, several at once', () => {
    const h = filterHarness(withSelectionUi(harness()), '');
    h.state.recentImages = [
        { ...usageImage('a', 40), model: 'gemini-3.1-flash-image' },
        { ...usageImage('b', 30), model: 'nano-banana-2' },
        { ...usageImage('c', 20), model: 'gpt-image-2' },
        { ...usageImage('d', 10), model: 'doubao-seedream-5-0-pro-260628' }
    ];
    h.state.historyFilters = { vendors: ['gemini'] };
    assert.deepEqual(ids(h), ['a', 'b']);
    h.state.historyFilters = { vendors: ['gemini', 'seedream'] };
    assert.deepEqual(ids(h), ['a', 'b', 'd']);
    h.run('renderHistoryFilterControls()');
    assert.deepEqual(h.renders.at(-1).vendors.map(vendor => `${vendor.id}:${vendor.count}`), ['gemini:2', 'gpt:1', 'seedream:1']);
});

test('the search box takes words, phrases, exclusions and the ratio', () => {
    const h = filterHarness(withSelectionUi(harness()), '');
    h.state.recentImages = [
        { ...usageImage('a', 30), prompt: '雨夜的霓虹街道 cinematic lighting', ratio: '16:9' },
        { ...usageImage('b', 20), prompt: '水墨山水 霓虹', ratio: '1:1' },
        { ...usageImage('c', 10), prompt: 'product shot', ratio: '16:9' }
    ];
    const search = query => { h.el.historySearchInput.value = query; return ids(h); };
    assert.deepEqual(search('霓虹'), ['a', 'b']);
    assert.deepEqual(search('霓虹 -水墨'), ['a']);
    assert.deepEqual(search('１６：９'), ['a', 'c']);
    assert.deepEqual(search('"cinematic lighting"'), ['a']);
    assert.deepEqual(search('"lighting cinematic"'), []);
});

test('a filter change drops the images it hides from the selection; chips and 清除全部 go through the state', () => {
    const h = filterHarness(withSelectionUi(harness()), '');
    h.run('renderHistoryImages = () => { renderHistoryFilterControls(); };');
    h.state.recentImages = [usageImage('a', 30, { dragCount: 1 }), usageImage('b', 20), usageImage('c', 10)];
    for (const id of ['a', 'b', 'c']) h.state.historySelectedIds.add(id);
    h.state.historyActiveImageId = 'b';
    h.run('setHistoryFilters({ usage: "used" })');
    assert.deepEqual([...h.state.historySelectedIds], ['a'], 'b and c are filtered out, so they leave the selection');
    assert.equal(h.state.historyActiveImageId, null, 'the open detail was for a hidden image');
    const props = h.renders.at(-1);
    assert.deepEqual(props.catalog.describe(props.filters).map(chip => chip.label), ['用过的']);

    props.onRemoveChip(props.catalog.describe(props.filters)[0]);
    assert.equal(h.state.historyFilters.usage, '');
    h.el.historySearchInput.value = 'same';
    h.run('setHistoryFilters({ vendors: ["gpt"] })');
    h.renders.at(-1).onClear();
    assert.equal(h.el.historySearchInput.value, '');
    assert.equal(h.context.window.PicGenHistoryFilters.activeCount(h.state.historyFilters), 0);
    assert.deepEqual([...h.state.historySelectedIds], [], 'the GPT filter hid a, clearing filters never adds it back');
});

test('sort and the open panel are remembered; the filters are not', () => {
    const h = filterHarness(withSelectionUi(harness()), '');
    const stored = new Map();
    h.context.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) };
    h.run('renderHistoryImages = () => {};');
    h.run('setHistorySort("name"); setHistoryFiltersExpanded(true); setHistoryFilters({ usage: "unused" });');
    assert.equal(stored.get('picgen.historySort'), 'name');
    assert.equal(stored.get('picgen.historyFiltersExpanded'), '1');
    h.run('loadHistoryFilterPreferences()');
    assert.equal(h.state.historySort, 'name');
    assert.equal(h.state.historyFiltersExpanded, true);
    assert.equal(h.state.historyFilters.usage, '', 'a restart opens the full list');
    stored.set('picgen.historySort', 'bogus');
    h.run('loadHistoryFilterPreferences()');
    assert.equal(h.state.historySort, 'newest');
});

function dragTrashHarness(onTrash) {
    const h = withSelectionUi(harness({ trashHistoryImages: async payload => onTrash(payload) }));
    h.el.historyDragTrash = new Element();
    h.el.historyDragTrash.hidden = true;
    h.el.historyDragTrash.getBoundingClientRect = () => ({ left: 350, top: 700, right: 446, bottom: 784, width: 96, height: 84 });
    h.el.historyTrashUndoBtn = new Element();
    Object.assign(h.context.window, { screenX: 100, screenY: 50 });
    h.state.activeView = 'history';
    h.run('renderRecentImages = () => {}; reconcileHistoryImages = () => {};');
    return h;
}

test('dragging a history image shows the trash, and a drop on it bins the image without asking', async () => {
    const payloads = [];
    const h = dragTrashHarness(payload => {
        payloads.push(payload);
        return { batchId: 'b1', trashed: payload.items, missing: [], failed: [], skipped: [], total: 1 };
    });
    const images = [usageImage('a', 30, { dragCount: 2 }), usageImage('b', 20)];
    h.state.recentImages = images;
    h.run('askConfirmStrict = () => { throw new Error("drag-to-trash must not ask"); };');
    const body = new Element('body');
    h.context.document.body = body;
    h.run('rememberDraggedRecentImage(state.recentImages[0])');
    assert.equal(h.el.historyDragTrash.hidden, false, 'the trash appears when the drag starts');
    const shield = body.querySelector('.image-drag-shield');
    assert.ok(shield, 'a shield covers the window so edge autoscroll cannot scroll the gallery');
    assert.equal(shield.hidden, false);
    // Screen point → window point: (500,800) - (100,50) = (400,750), inside the trash.
    assert.equal(h.run('historyDragTrashHitFromPoint({ x: 500, y: 800 })'), true);
    assert.equal(h.run('historyDragTrashHitFromPoint({ x: 200, y: 300 })'), false);
    await h.run('dropHistoryImageToTrash(state.recentImages[0])');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].reason, 'drag');
    assert.equal(payloads[0].includeProtected, true, 'a used image is binned too');
    assert.deepEqual([...payloads[0].confirmProtected], ['a']);
    assert.deepEqual([...payloads[0].items.map(item => item.id)], ['a']);
    assert.deepEqual(h.state.recentImages.map(image => image.id), ['b']);
    assert.equal(h.el.historyTrashUndoBtn.hidden, false, '撤销 is offered');
    assert.match(h.el.historyTrashResultText.textContent, /^已移到回收站 1 张。$/);
    h.run('clearDraggedRecentImage()');
    assert.equal(h.el.historyDragTrash.hidden, true);
    assert.equal(shield.hidden, true, 'the shield goes when the drag ends');
    assert.equal(body.querySelectorAll('.image-drag-shield').length, 1, 'one shield, reused');
    // Outside the history view the trash never shows and never hits.
    h.state.activeView = 'generation';
    h.run('rememberDraggedRecentImage(state.recentImages[0])');
    assert.equal(h.el.historyDragTrash.hidden, true);
    assert.equal(h.run('historyDragTrashHitFromPoint({ x: 500, y: 800 })'), false);
    h.run('clearDraggedRecentImage(); hideHistoryTrashResult()');
});

test('dragging one image of a multi-selection bins the whole selection', async () => {
    const payloads = [];
    const h = dragTrashHarness(payload => {
        payloads.push(payload);
        return { batchId: 'b2', trashed: payload.items, missing: [], failed: [], skipped: [], total: 1 };
    });
    h.state.recentImages = [usageImage('a', 30), usageImage('b', 20), usageImage('c', 10)];
    h.state.historySelectedIds.add('a'); h.state.historySelectedIds.add('c');
    await h.run('dropHistoryImageToTrash(state.recentImages[2])');
    assert.deepEqual([...payloads[0].items.map(item => item.id)].sort(), ['a', 'c']);
    // Not part of the selection: only the dragged image goes.
    h.state.recentImages = [usageImage('b', 20), usageImage('d', 5)];
    h.state.historySelectedIds.add('b'); h.state.historySelectedIds.add('d');
    await h.run('dropHistoryImageToTrash({ ...state.recentImages[0], id: "x", filePath: "C:/x.png" })');
    assert.deepEqual([...payloads[1].items.map(item => item.id)], ['x']);
});

function binHarness(api) {
    const h = harness(api);
    for (const name of ['historyBinImages', 'historyBinCount', 'historyBinBadge', 'historyBinSelectionBar', 'historyBinSelectionMeta',
        'historyBinRestoreBtn', 'historyBinDeleteBtn', 'historyBinRestoreAllBtn', 'historyBinEmptyBtn']) h.el[name] = new Element();
    h.toasts = [];
    h.context.toasts = h.toasts;
    h.run('showToast = message => { toasts.push(String(message)); }; formatHistoryRelativeDate = () => "刚刚"; attachHistoryBinThumbnail = () => {};');
    h.state.activeView = 'bin';
    return h;
}

function binItem(name, extra = {}) {
    return { id: name, fileName: `${name}.png`, filePath: `C:/out/${name}.png`, model: 'm', binnedAt: 1, ...extra };
}

test('the recycle bin lists binned images, badges the total and restores the selection', async () => {
    let items = [binItem('a'), binItem('b'), binItem('c')];
    const restores = [];
    const h = binHarness({
        listHistoryBin: async () => ({ items, total: items.length }),
        restoreHistoryBin: async ({ paths }) => {
            restores.push(paths);
            const back = items.filter(item => paths === null || paths.includes(item.filePath));
            items = items.filter(item => !back.includes(item));
            return { restored: back.map(item => item.id), missing: [], failed: [] };
        }
    });
    await h.run('refreshHistoryBin()');
    const tiles = () => h.el.historyBinImages.querySelectorAll('.history-bin-item');
    assert.equal(tiles().length, 3);
    assert.equal(h.el.historyBinCount.textContent, '3 张');
    assert.equal(h.el.historyBinBadge.hidden, false);
    assert.equal(h.el.historyBinBadge.textContent, '3');
    assert.equal(h.el.historyBinSelectionBar.hidden, true);
    assert.equal(tiles()[0].querySelector('.history-item-meta').textContent, 'm · 删除于 刚刚');
    tiles()[0].listeners.click();
    tiles()[2].listeners.click();
    assert.equal(h.el.historyBinSelectionBar.hidden, false);
    assert.equal(h.el.historyBinSelectionMeta.textContent, '已选择 2 张');
    assert.equal(tiles()[0].classList.contains('selected'), true);
    await h.run('restoreHistoryBin([...state.historyBin.selected])');
    assert.deepEqual([...restores[0]].sort(), ['C:/out/a.png', 'C:/out/c.png']);
    assert.equal(h.toasts.at(-1), '已还原 2 张');
    assert.equal(tiles().length, 1, 'the bin re-reads its list');
    assert.equal(h.state.historyBin.selected.size, 0);
    assert.equal(h.state.historyDirty, true, 'history reloads when shown next');
    await h.run('restoreHistoryBin(null)');
    assert.equal(restores[1], null, '全部还原 sends null');
    assert.equal(tiles().length, 0);
    assert.equal(h.el.historyBinBadge.hidden, true);
    assert.equal(h.el.historyBinEmptyBtn.disabled, true);
    assert.equal(h.el.historyBinImages.querySelector('.history-empty').children[1].textContent, '回收站是空的');
});

test('permanent delete and 清空 always ask first and report failures', async () => {
    let items = [binItem('a'), binItem('b')];
    const purges = [];
    const answers = [];
    const h = binHarness({
        listHistoryBin: async () => ({ items, total: items.length }),
        purgeHistoryBin: async ({ paths }) => {
            purges.push(paths);
            if (paths === null) {
                const gone = items.slice(0, 1);
                items = items.slice(1);
                return { deleted: gone.map(item => item.filePath), failed: [{ filePath: 'C:/out/b.png', message: 'EBUSY' }] };
            }
            items = items.filter(item => !paths.includes(item.filePath));
            return { deleted: paths, failed: [] };
        }
    });
    h.context.answers = answers;
    h.run('askConfirmStrict = (message, options) => { answers.push({ message, options }); return Promise.resolve(answers.length !== 1); };');
    await h.run('refreshHistoryBin()');
    await h.run('purgeHistoryBin(["C:/out/a.png"])');
    assert.equal(purges.length, 0, 'cancel deletes nothing');
    assert.equal(answers[0].options.title, '永久删除');
    assert.equal(answers[0].options.danger, true);
    assert.match(answers[0].message, /^将永久删除选中的 1 张图片。\n文件会从磁盘删除，无法找回。$/);
    await h.run('purgeHistoryBin(null)');
    assert.equal(answers[1].options.title, '清空回收站');
    assert.match(answers[1].message, /^将永久删除回收站中的全部 2 张图片。/);
    assert.deepEqual(purges, [null]);
    assert.equal(h.toasts.at(-1), '已删除 1 张，1 张删除失败（文件可能被占用）');
    assert.equal(h.el.historyBinImages.querySelectorAll('.history-bin-item').length, 1);
});

test('a bin-changed push updates the badge and re-reads an open bin', async () => {
    let listener = null;
    let lists = 0;
    const h = binHarness({
        onHistoryBinChanged: callback => { listener = callback; return () => {}; },
        listHistoryBin: async () => { lists += 1; return { items: [binItem('a')], total: 1 }; }
    });
    assert.equal(typeof listener, 'function', 'desktop.js subscribes at load');
    h.state.activeView = 'history';
    listener({ total: 4 });
    assert.equal(h.el.historyBinBadge.textContent, '4');
    assert.equal(lists, 0, 'a closed bin is not re-read');
    assert.equal(h.state.historyBin.loaded, false);
    h.state.activeView = 'bin';
    listener({ total: 1 });
    await tick();
    assert.equal(lists, 1);
    listener({ total: 120 });
    assert.equal(h.el.historyBinBadge.textContent, '99+');
});

test('dragging a selected image drags the whole selection, dragged image first; otherwise only that image', () => {
    const sent = [];
    const h = dragTrashHarness(() => ({}));
    h.context.window.picgenDesktop.startImageDrag = payload => sent.push(payload);
    h.run('hideImageContextMenu = () => {};');
    h.state.recentImages = [usageImage('a', 30), usageImage('b', 20), usageImage('c', 10)];
    h.state.historySelectedIds.add('a'); h.state.historySelectedIds.add('c');
    h.run('beginRecentImageDrag(state.recentImages[2])');
    h.flush();
    assert.deepEqual([...sent[0]], [h.state.recentImages[2].filePath, h.state.recentImages[0].filePath]);
    assert.deepEqual([...h.state.draggedRecentBatch.map(image => image.id)], ['c', 'a']);
    h.run('clearDraggedRecentImage()');
    assert.equal(h.state.draggedRecentBatch, null);
    h.run('beginRecentImageDrag(state.recentImages[1])');
    h.flush();
    assert.equal(sent[1], h.state.recentImages[1].filePath, 'an unselected image drags alone, as a plain path');
    h.run('clearDraggedRecentImage()');
    // Outside the history view a leftover selection never widens a drag.
    h.state.activeView = 'generation';
    h.run('beginRecentImageDrag(state.recentImages[0])');
    h.flush();
    assert.equal(sent[2], h.state.recentImages[0].filePath);
    h.run('clearDraggedRecentImage(); hideHistoryTrashResult()');
});

test('the detail drawer opens compact, hides the selection bar while viewing one image, and trashes just that image', async () => {
    const payloads = [];
    const h = withSelectionUi(harness({
        trashHistoryImages: async payload => { payloads.push(payload); return { batchId: 't', trashed: payload.items, missing: [], failed: [], skipped: [], total: 2 }; }
    }));
    for (const name of ['historyDetailSummary', 'historyDetailExpandBtn', 'historyDetailTrashBtn', 'historyPage', 'historyTrashUndoBtn']) h.el[name] = new Element();
    h.run('renderRecentImages = () => {}; reconcileHistoryImages = () => {}; formatHistoryFileSize = () => "11 KB";');
    h.state.activeView = 'history';
    h.state.recentImages = [usageImage('a', 30, { dragCount: 2, width: 512, height: 512, model: 'm' }), usageImage('b', 20), usageImage('c', 10)];
    h.state.historySelectedIds.add('a'); h.state.historyActiveImageId = 'a';
    h.run('updateHistorySelectionUi()');
    assert.equal(h.el.historyDetailDrawer.hidden, false);
    assert.equal(h.el.historyDetailDrawer.dataset.mode, 'compact');
    assert.equal(h.el.historySelectionBar.hidden, true, 'viewing one image keeps the selection bar out of the way');
    assert.equal(h.el.historyPage.dataset.selectionBar, 'hidden');
    const copy = h.el.historyDetailSummary.children[1];
    assert.equal(copy.children[0].textContent, 'a.png');
    assert.match(copy.children[1].textContent, /^m · 512 × 512 \(1:1\) · 11 KB · 已使用 2 次$/);
    const thumb = h.el.historyDetailSummary.children[0];
    h.run('updateHistorySelectionUi()');
    assert.equal(h.el.historyDetailSummary.children[0], thumb, 'an unchanged summary is not rebuilt (no thumbnail reload)');
    // A second selected image brings the bar back.
    h.state.historySelectedIds.add('b');
    h.run('updateHistorySelectionUi()');
    assert.equal(h.el.historySelectionBar.hidden, false);
    assert.equal(h.el.historyPage.dataset.selectionBar, 'shown');
    h.state.historySelectedIds.delete('b');
    // 展开 shows the tabs; 收起 goes back.
    h.run('setHistoryDetailExpanded(true)');
    assert.equal(h.el.historyDetailDrawer.dataset.mode, 'expanded');
    assert.equal(h.el.historyDetailExpandBtn.getAttribute('aria-expanded'), 'true');
    assert.equal(h.el.historyDetailExpandBtn.title, '收起详情');
    h.run('setHistoryDetailExpanded(false)');
    assert.equal(h.el.historyDetailDrawer.dataset.mode, 'compact');
    // The drawer's own 移到回收站: only the shown image, no dialog, a used image included.
    h.run('askConfirmStrict = () => { throw new Error("no dialog for the drawer trash"); };');
    h.state.historySelectedIds.add('c');
    await h.run('trashActiveHistoryImage()');
    assert.deepEqual([...payloads[0].items.map(item => item.id)], ['a']);
    assert.equal(payloads[0].includeProtected, true);
    assert.deepEqual([...payloads[0].confirmProtected], ['a']);
    assert.deepEqual(h.state.recentImages.map(image => image.id), ['b', 'c']);
    assert.equal(h.state.historySelectedIds.has('c'), true, 'the rest of the selection stays');
    h.run('hideHistoryTrashResult()');
});

// --- 统一图片右键菜单：按目标禁用、复制 / 另存 / 复制提示词、参考图卡发到新序列 -------------------------------
function contextMenuHarness(desktop = {}) {
    const h = harness(desktop);
    h.toasts = [];
    h.context.toasts = h.toasts;
    h.run('showToast = message => { toasts.push(String(message)); };');
    for (const name of ['imageContextMenu', 'desktopPanel']) h.el[name] = new Element();
    for (const name of ['sendReferenceActiveBtn', 'sendReferenceNewBtn', 'findSimilarImageBtn', 'setCoverImageBtn', 'detachImageBtn']) h.el[name] = new Element('button');
    h.el.desktopPanel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 460, height: 800 });
    Object.assign(h.el.imageContextMenu, { hidden: true, offsetWidth: 272, offsetHeight: 300 });
    return h;
}

// Right-click event; `closest` answers for the element that was right-clicked.
function menuEvent(closest = () => null) {
    return { clientX: 40, clientY: 60, preventDefault() {}, stopPropagation() {}, target: { closest } };
}

test('the image menu disables what a target cannot do and names the reason at the end of the row', () => {
    const h = contextMenuHarness();
    h.state.historyLoaded = true;
    h.state.recentImages = [{ id: 'a', fileName: 'task_a.png', filePath: 'C:/out/task_a.png' }];
    const blocked = code => ({ ...h.run(`imageContextBlocked(${code})`) });
    assert.deepEqual(blocked('toImageContextTarget(state.recentImages[0])'), { sendReferenceActiveBtn: '', findSimilarImageBtn: '' });
    assert.deepEqual(blocked(`{ kind: 'bin', record: state.recentImages[0], filePath: 'C:/bin/task_a.png' }`), { sendReferenceActiveBtn: '', findSimilarImageBtn: '还原后可用' });
    assert.deepEqual(blocked(`{ kind: 'data', name: 'x.png', base64: 'AAAA' }`), { sendReferenceActiveBtn: '', findSimilarImageBtn: '仅限历史图片' });
    // A card sent from history keeps the history file name (it carries the task id), so it maps back.
    assert.deepEqual(blocked(`referenceContextTarget('s1', { id: 'r1', name: 'TASK_A.png' })`), { sendReferenceActiveBtn: '已在本序列', findSimilarImageBtn: '' });
    assert.deepEqual(blocked(`referenceContextTarget('s1', { id: 'r2', name: 'upload.png' })`), { sendReferenceActiveBtn: '已在本序列', findSimilarImageBtn: '仅限历史图片' });
    h.state.historyLoaded = false;
    assert.equal(blocked(`referenceContextTarget('s1', { id: 'r2', name: 'upload.png' })`).findSimilarImageBtn, '', 'until history is fully loaded the card is looked up on click');
});

test('the image menu hints a disabled item on a reference card and restores it for a history image', async () => {
    const overrides = [];
    const h = contextMenuHarness({ setSimilarityOverride: async payload => { overrides.push(payload); } });
    h.run('similarViewVisible = () => false;');
    h.state.historyLayout = 'similar';
    const record = { id: 'a', fileName: 'a.png', filePath: 'C:/out/a.png' };
    h.context.record = record;
    const inGroup = selector => (selector === '.similar-group' ? { dataset: { groupId: 'g1' } } : null);
    h.context.event = menuEvent(inGroup);
    h.run(`showReferenceContextMenu('s1', { id: 'r1', name: 'a.png', filePath: 'C:/refs/r1.png' }, event)`);
    const active = h.el.sendReferenceActiveBtn;
    assert.equal(h.el.imageContextMenu.hidden, false);
    assert.equal(h.state.imageContextTarget.kind, 'reference');
    assert.equal(active.disabled, true);
    assert.equal(active.dataset.hint, '已在本序列');
    assert.equal(active.title, '不可用：已在本序列');
    assert.equal(h.el.sendReferenceNewBtn.disabled, undefined, 'the other items are never touched');
    assert.equal(h.el.setCoverImageBtn.hidden, true, 'a card never offers the group actions, even over a group row');
    assert.equal(h.el.detachImageBtn.hidden, true);
    // The same menu for a history image inside a similar group: everything enabled, the group actions shown.
    h.run('showImageContextMenu(record, event)');
    assert.equal(active.disabled, false);
    assert.equal('hint' in active.dataset, false);
    assert.equal(active.title, '');
    assert.equal(h.state.imageContextTarget.kind, 'history');
    assert.equal(h.state.imageContextTarget.record, record);
    assert.equal(h.el.setCoverImageBtn.hidden, false);
    assert.equal(h.el.detachImageBtn.hidden, false);
    // 设为封面 takes the target and the group it was right-clicked in, then closes the menu.
    await h.run(`applySimilarOverrideFromContext('setCover')`);
    assert.deepEqual({ ...overrides[0] }, { op: 'setCover', key: 'a', groupId: 'g1', preset: 'standard' });
    assert.equal(h.el.imageContextMenu.hidden, true);
    assert.equal(h.state.imageContextTarget, null);
    assert.equal(h.state.imageContextGroupId, null);
});

test('复制提示词 copies the prompt to the clipboard and never creates a sequence', async () => {
    const copied = [];
    const lookups = [];
    const answers = [];
    const h = contextMenuHarness({
        copyText: async text => { copied.push(text); },
        getGeneratedImagePrompt: async payload => { lookups.push(payload); const prompt = answers.shift() || ''; return { found: !!prompt, prompt }; }
    });
    h.run('createSequenceFromImagePrompt = () => { throw new Error("no new sequence"); }; showGenerationView = () => { throw new Error("no view switch"); };');
    const sequences = h.state.sequences.length;
    h.state.imageContextTarget = { id: 'a', fileName: 'a.png', filePath: 'C:/out/a.png', prompt: '  red fox in snow ' };
    await h.run('copyPromptFromContextImage()');
    assert.deepEqual(copied, ['red fox in snow']);
    assert.equal(lookups.length, 0, 'a recorded prompt needs no metadata lookup');
    assert.equal(h.toasts.at(-1), '已复制提示词');
    assert.equal(h.state.imageContextTarget, null, 'the menu target is taken');
    // No recorded prompt: main is asked by path and file name; nothing found → a note, clipboard untouched.
    h.state.imageContextTarget = { id: 'b', fileName: 'b.png', filePath: 'C:/out/b.png' };
    await h.run('copyPromptFromContextImage()');
    assert.deepEqual({ ...lookups[0] }, { filePath: 'C:/out/b.png', fileName: 'b.png' });
    assert.equal(copied.length, 1);
    assert.equal(h.toasts.at(-1), '这张图片没有记录提示词');
    // Pixels only (the reverse-prompt image): main reads the metadata embedded in the bytes.
    answers.push('embedded prompt');
    h.state.imageContextTarget = { kind: 'data', name: 'x.png', base64: 'AAAA', mimeType: 'image/png' };
    await h.run('copyPromptFromContextImage()');
    assert.deepEqual({ ...lookups[1] }, { base64: 'AAAA' });
    assert.deepEqual(copied, ['red fox in snow', 'embedded prompt']);
    assert.equal(h.state.sequences.length, sequences);
});

test('复制图片 and 另存为 send a path when there is a file, pixels otherwise, and apply the usage main counted', async () => {
    const copies = [];
    const saves = [];
    const saveAnswers = [];
    const h = contextMenuHarness({
        copyImage: async payload => { copies.push(payload); return payload.filePath
            ? { copied: true, width: 4, height: 4, counted: true, usageKey: 'a.png|1', usage: { dragCount: 1, referenceCount: 0, lastUsedAt: 5, lastUsedKind: 'drag-out' } }
            : { copied: true, width: 4, height: 4, counted: false }; },
        saveImageAs: async payload => { saves.push(payload); return saveAnswers.shift(); }
    });
    h.run('renderUsageBadge = () => {}; setHistoryItemLabel = () => {};');
    const record = { id: 'a', fileName: 'a.png', filePath: 'C:/out/a.png', fileSize: 1 };
    h.state.recentImages = [record];
    h.state.imageContextTarget = record;
    await h.run('copyContextImage()');
    assert.deepEqual({ ...copies[0] }, { filePath: 'C:/out/a.png' });
    assert.equal(record.dragCount, 1, 'the count main returned is applied at once');
    assert.equal(h.toasts.at(-1), '已复制图片');
    assert.equal(h.state.copyingImage, false);
    h.state.imageContextTarget = { kind: 'data', name: 'x.png', base64: 'AAAA', mimeType: 'image/webp' };
    await h.run('copyContextImage()');
    assert.deepEqual({ ...copies[1] }, { base64: 'AAAA', mimeType: 'image/webp' });
    // 另存为: a cancelled dialog says nothing; a save names the file.
    saveAnswers.push({ cancelled: true });
    h.state.imageContextTarget = record;
    await h.run('saveContextImageAs()');
    assert.deepEqual({ ...saves[0] }, { filePath: 'C:/out/a.png', fileName: 'a.png' });
    assert.equal(h.toasts.at(-1), '已复制图片');
    saveAnswers.push({ saved: true, filePath: 'D:/picked/a.png', fileName: 'a.png', counted: true, usageKey: 'a.png|1', usage: { dragCount: 2, referenceCount: 0, lastUsedAt: 6, lastUsedKind: 'drag-out' } });
    h.run(`state.imageContextTarget = referenceContextTarget('s1', { id: 'r1', name: 'card.png', mimeType: 'image/png', base64: 'CARD' })`);
    await h.run('saveContextImageAs()');
    assert.deepEqual({ ...saves[1] }, { base64: 'CARD', mimeType: 'image/png', fileName: 'card.png' }, 'a card without a cached file saves its pixels');
    assert.equal(h.toasts.at(-1), '已另存为 a.png');
    assert.equal(h.state.savingImageAs, false);
    // Picking the original itself in the dialog: no success toast.
    saveAnswers.push({ cancelled: false, saved: false, sameFile: true, counted: false });
    h.state.imageContextTarget = record;
    await h.run('saveContextImageAs()');
    assert.equal(h.toasts.at(-1), '选中的就是原图，没有另存');
    // A second 复制图片 while the first is still decoding says so instead of silently doing nothing.
    h.state.copyingImage = true;
    h.state.imageContextTarget = record;
    await h.run('copyContextImage()');
    assert.equal(copies.length, 2);
    assert.equal(h.toasts.at(-1), '正在复制上一张图片，请稍候');
    h.state.copyingImage = false;
});

test('发送到参考图（新建序列）from a reference card copies its pixels and name, never its workspace, and counts nothing', async () => {
    const h = contextMenuHarness();
    const uses = [];
    const reads = [];
    h.context.uses = uses;
    h.context.reads = reads;
    h.run(`saveCurrentSequenceFromForm = () => {}; hydrateSequenceReferences = async () => {};
        persistReferenceImage = async reference => ({ ...reference, filePath: 'C:/refs/' + reference.id + '.png' });
        referenceImageData = async reference => { reads.push(reference.id); return { base64: 'CARD', mimeType: 'image/png' }; };
        uniqueReferenceAlias = reference => reference.name; saveSequences = () => {}; renderSequenceTabs = () => {};
        loadCurrentSequenceToForm = () => {}; showGenerationView = () => {}; noteHistoryImageUse = (...args) => { uses.push(args); };`);
    const card = { id: 'r1', name: 'subject.png', alias: 'subject', mimeType: 'image/png', filePath: 'C:/refs/r1.png',
        workspace: { doc: { images: [] }, sourceFiles: [{ filePath: 'C:/refs/src.png', name: '原图.png' }] } };
    h.state.sequences = [{ id: 's1', name: '序列1', model: 'gpt-image-2', providerId: 'p1', ratio: '1:1', references: [card] }];
    h.state.currentSequenceId = 's1';
    // 活动序列 is the card's own sequence: the item is disabled, and the action refuses too.
    h.run(`state.imageContextTarget = referenceContextTarget('s1', state.sequences[0].references[0])`);
    await h.run('sendContextImageToReference(false)');
    assert.equal(h.state.sequences.length, 1);
    assert.equal(h.state.sequences[0].references.length, 1);
    assert.equal(reads.length, 0);
    h.run(`state.imageContextTarget = referenceContextTarget('s1', state.sequences[0].references[0])`);
    await h.run('sendContextImageToReference(true)');
    assert.equal(h.state.sequences.length, 2);
    const created = h.state.sequences[1];
    assert.equal(h.state.currentSequenceId, created.id);
    assert.equal(created.model, 'gpt-image-2');
    assert.equal(created.references.length, 1);
    const copy = created.references[0];
    assert.equal(copy.name, 'subject.png');
    assert.equal(copy.base64, 'CARD');
    assert.notEqual(copy.id, 'r1');
    assert.notEqual(copy.filePath, card.filePath, 'the copy gets its own cache file');
    assert.equal('workspace' in copy, false, 'two cards must never share workspace source files');
    assert.deepEqual(reads, ['r1']);
    assert.equal(uses.length, 0, 'a reference card is not a history record');
    assert.equal(h.state.sequences[0].references.length, 1, 'the source sequence keeps its one card');
    assert.equal(h.state.sendingReference, false);
    assert.equal(h.toasts.at(-1), '已新建序列并添加参考图');
});

// 原生复制会把引用图 token 的 <img src="data:…完整 base64"> 写进 text/html，粘进 Obsidian 会把它卡死。
test('copying or cutting from the prompt editor writes plain text only, with references as @{name}', () => {
    const h = harness();
    const written = [];
    const deletes = [];
    h.context.document.execCommand = command => { deletes.push(command); return true; };
    h.context.clipboardData = { setData: (type, value) => written.push([type, value]) };
    h.run(`promptSelection = () => ({ range: { collapsed: false, cloneContents: () => ({ fragment: true }) } });
        serializePromptChildren = () => '把 @{大张}\u00a0放左边\u200b';`);
    const fire = type => {
        let prevented = false;
        h.context.event = { type, clipboardData: h.context.clipboardData, preventDefault() { prevented = true; } };
        h.run('handlePromptCopy(event)');
        return prevented;
    };
    assert.equal(fire('copy'), true);
    assert.deepEqual(written, [['text/plain', '把 @{大张} 放左边']], 'only text/plain, never text/html');
    assert.deepEqual(deletes, [], 'a copy leaves the editor alone');
    assert.equal(fire('cut'), true);
    assert.deepEqual(written.at(-1), ['text/plain', '把 @{大张} 放左边']);
    assert.deepEqual(deletes, ['delete'], 'a cut still removes the selection, through the native editing path');
    // A collapsed selection (or none) is left to the browser.
    written.length = 0;
    h.run('promptSelection = () => ({ range: { collapsed: true } });');
    assert.equal(fire('copy'), false);
    h.run('promptSelection = () => null;');
    assert.equal(fire('cut'), false);
    assert.equal(written.length, 0);
});

test('the prompt editor registers the copy and cut handlers', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'desktop.js'), 'utf8');
    assert.match(source, /el\.promptInput\.addEventListener\('copy', handlePromptCopy\)/);
    assert.match(source, /el\.promptInput\.addEventListener\('cut', handlePromptCopy\)/);
});
