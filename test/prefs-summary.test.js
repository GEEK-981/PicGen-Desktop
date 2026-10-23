// 生成区「画面设置」触发按钮上的摘要（供应商 · 模型 · 比例 · 数量）必须与隐藏下拉、置顶窗镜像同源。
//
// 背景：摘要从前只在 saveCurrentSequenceFromForm / renderProviderSelect 里写，而后者跑在
// 模型/档位重建之前——启动、切序列、WS 路由推送后按钮一直是旧值，置顶窗却是新值，
// 用户在弹窗里点已选中的值也不会派发 change，只有点「生成」才对上。这里把这些不变量钉死。
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const profiles = require('../imageApiProfiles');

class Element {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
        this.attributes = {}; this.className = ''; this.value = ''; this.options = []; this.hidden = false;
        this.title = ''; this._html = ''; this._text = ''; this.listeners = {}; this.replaceCount = 0;
        this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    }
    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = value; this.children = []; this.options = []; }
    // 与 DOM 一致：有子节点时 textContent 是子节点文本拼接。
    get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this._text; }
    set textContent(value) { this._text = String(value); this.children = []; }
    appendChild(child) { this.children.push(child); child.parentNode = this; if (this.tagName === 'SELECT') this.options.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.replaceCount += 1; this.children = []; this.options = []; this._text = ''; children.forEach(child => this.appendChild(child)); }
    remove() {}
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    dispatchEvent(event) { (this.listeners[event.type] || []).forEach(handler => handler(event)); return true; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    focus() {}
}

// desktop.js 是浏览器脚本，只能在 vm 里跑；只补摘要链路碰到的元素，绘制类兄弟函数换成空函数。
function harness() {
    const summary = new Element('b');
    const sent = [];
    const document = {
        addEventListener() {}, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'),
        activeElement: null, querySelector: () => null, querySelectorAll: () => [],
        getElementById: id => (id === 'prefsValueProvider' ? summary : null)
    };
    const context = vm.createContext({
        console, URL, Date, Map, Set, document, setTimeout, clearTimeout, setInterval, clearInterval,
        Event: class { constructor(type) { this.type = type; } },
        requestAnimationFrame: () => 0,
        window: {
            PicGenImageApiProfiles: profiles, PicGenRendererUtils: {},
            picgenDesktop: { syncPrefsWindow: snapshot => sent.push(snapshot) }
        },
        fetch: async () => { throw new Error('Unexpected network request'); }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'desktop.js'), 'utf8'), context);
    const run = code => vm.runInContext(code, context);
    const el = run('el');
    for (const name of ['providerSelect', 'modelSelect', 'ratioSelect', 'ratioLabel', 'countSelect', 'imageSizeField', 'imageSizeSelect', 'referenceRail']) {
        el[name] = new Element(name.includes('Select') ? 'select' : 'div');
    }
    el.providerSelect.selectedOptions = [{ textContent: 'Grsai' }];
    run(`refreshLucideIcons = () => {}; showToast = () => {}; persistState = () => {};
        renderGenerationSliders = () => {}; renderRatioPickerOptions = () => {}; refreshModernSelect = () => {};
        updateRatioPickerSelection = () => {}; updateRatioLabelHint = () => {}; renderRatioGrid = () => {};
        updateModelSpecificAdvancedOptions = () => {}; getDimensionOptions = profile => profile.dimensionOptions;
        NATIVE_PREFS_SOURCES.image.serialize = () => ({ panel: 'image', ratio: el.ratioSelect.value });
        NATIVE_PREFS_SOURCES.advanced.serialize = () => ({ panel: 'advanced' });`);
    return { el, run, context, summary, sent };
}

// 把序列放进 vm 的 realm 再调，避免跨 realm 取值。
function reloadForm(h, fields) {
    const sequence = h.run('createSequence()');
    Object.assign(sequence, fields);
    h.el.modelSelect.value = sequence.model;
    h.context.__sequence = sequence;
    h.run('updateDimensionOptions(__sequence)');
    return sequence;
}

const legacySummary = parts => parts.filter(Boolean).join(' · ');

test('重建档位后按钮摘要随即对上序列的模型/比例/数量（启动、切序列不必等生成）', () => {
    const h = harness();
    // 模拟切序列前按钮停在上一个序列的值。
    h.summary.textContent = 'Grsai · gpt-image-2.5-sunburst · 3:4 · 5张';
    reloadForm(h, { model: 'nano-banana-2', ratio: '16:9', count: '3' });
    assert.equal(h.summary.textContent, 'Grsai · nano-banana-2 · 16:9 · 3张');
});

test('摘要拆成可截断的头段与不收缩的尾段，拼起来与原格式逐字一致', () => {
    const h = harness();
    reloadForm(h, { model: 'gemini-3.1-flash-image-preview', ratio: '21:9', count: '5' });
    const [head, tail] = h.summary.children;
    assert.equal(head.className, 'prefs-tab-value-head');
    assert.equal(head.textContent, 'Grsai · gemini-3.1-flash-image-preview');
    assert.equal(tail.className, 'prefs-tab-value-tail');
    assert.equal(tail.textContent, ' · 21:9 · 5张');
    assert.equal(h.summary.title, 'Grsai · gemini-3.1-flash-image-preview · 21:9 · 5张');

    // 头段为空时尾段不带前导分隔符；全空时不留子节点（CSS :empty 隐藏）。
    h.el.providerSelect.selectedOptions = [];
    h.el.modelSelect.value = '';
    h.run('updatePrefsTriggerValues()');
    assert.deepEqual(h.summary.children.map(node => node.className), ['prefs-tab-value-tail']);
    assert.equal(h.summary.textContent, legacySummary(['', '', '21:9', '5张']));
    h.el.ratioSelect.value = '';
    h.el.countSelect.value = '';
    h.run('updatePrefsTriggerValues()');
    assert.equal(h.summary.children.length, 0);
});

test('参考图 / 智能比例在摘要里显示为中文标签', () => {
    const h = harness();
    reloadForm(h, { model: 'nano-banana-2', ratio: '1:1', count: '2' });
    h.el.ratioSelect.value = 'reference';
    h.run('updatePrefsTriggerValues()');
    assert.equal(h.summary.textContent, 'Grsai · nano-banana-2 · 参考图 · 2张');
    h.el.ratioSelect.value = 'auto';
    h.run('updatePrefsTriggerValues()');
    assert.equal(h.summary.textContent, 'Grsai · nano-banana-2 · 智能 · 2张');
});

test('值没变时不重建摘要节点', () => {
    const h = harness();
    reloadForm(h, { model: 'nano-banana-2', ratio: '16:9', count: '3' });
    const before = h.summary.replaceCount;
    h.run('updatePrefsTriggerValues(); updatePrefsTriggerValues();');
    assert.equal(h.summary.replaceCount, before);
});

test('置顶窗里点已选中的值（不派发 change）也会修复过期的按钮摘要', () => {
    const h = harness();
    reloadForm(h, { model: 'nano-banana-2', ratio: '16:9', count: '3' });
    h.summary.textContent = '__stale__';
    h.run(`applyNativePrefsChange({ panel: 'image', field: 'ratio', value: '16:9' })`);
    assert.equal(h.summary.textContent, 'Grsai · nano-banana-2 · 16:9 · 3张');
});

test('同一轮同步代码里的多次刷新只向置顶窗推一份最新快照', async () => {
    const h = harness();
    reloadForm(h, { model: 'nano-banana-2', ratio: '16:9', count: '3' });
    await Promise.resolve();
    h.sent.length = 0;
    h.run(`state.nativePrefsOpen = 'image';`);
    h.run('updatePrefsTriggerValues();');
    h.el.ratioSelect.value = '4:3';
    h.run('updatePrefsTriggerValues(); updatePrefsTriggerValues();');
    assert.equal(h.sent.length, 0, '快照在微任务里发出，而不是每次调用同步发');
    await Promise.resolve();
    assert.equal(h.sent.length, 1);
    assert.deepEqual({ ...h.sent[0] }, { panel: 'image', ratio: '4:3' }, '推的是这一轮最后的状态');
});

test('排队的快照在置顶窗关闭或切换面板后按当时状态处理', async () => {
    const h = harness();
    await Promise.resolve();
    h.sent.length = 0;
    h.run(`state.nativePrefsOpen = 'image'; updatePrefsTriggerValues(); state.nativePrefsOpen = null;`);
    await Promise.resolve();
    assert.equal(h.sent.length, 0, '关闭后不再推快照，免得把隐藏的置顶窗唤回');

    h.run(`state.nativePrefsOpen = 'image'; updatePrefsTriggerValues(); state.nativePrefsOpen = 'advanced';`);
    await Promise.resolve();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].panel, 'advanced', '按触发时打开的面板序列化');
});
