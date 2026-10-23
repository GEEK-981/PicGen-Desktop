// 画面设置里的分辨率下拉框：默认档位、以及"显示的档位"与"真正发出去的档位"必须一致。
//
// 背景：新建序列默认 4K，可有的模型根本没有这一档（Gemini 2.5 Flash Image 只有 1K，
// grok 只有小写的 1k/2k）。如果让 renderSelectOptions 静默回落到首项、提交时又按
// resolveImageSizePreference 收敛到最高可用档，下拉框就会在骗人——grok 显示 1k、实发 2k。
// 这里把这个不变量钉死。
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
        this._html = ''; this._text = ''; this.listeners = {};
        this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    }
    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = value; this.children = []; this.options = []; }
    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); }
    appendChild(child) { this.children.push(child); child.parentNode = this; if (this.tagName === 'SELECT') this.options.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children = []; this.options = []; children.forEach(child => this.appendChild(child)); }
    insertBefore(child) { this.children.push(child); if (this.tagName === 'SELECT') this.options.push(child); return child; }
    remove() {}
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    focus() {}
}

// desktop.js 是浏览器脚本，只能在 vm 里跑。这里只补 updateDimensionOptions 真正碰到的
// 那几个元素，并把会画图的兄弟函数换掉——本文件断言的是档位选择，不是绘制。
function harness() {
    const document = { addEventListener() {}, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'), activeElement: null };
    const context = vm.createContext({
        console, URL, Date, Map, Set, document, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: () => 0,
        window: { PicGenImageApiProfiles: profiles, PicGenRendererUtils: {}, picgenDesktop: {} },
        fetch: async () => { throw new Error('Unexpected network request'); }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'desktop.js'), 'utf8'), context);
    const run = code => vm.runInContext(code, context);
    const el = vm.runInContext('el', context);
    for (const name of ['modelSelect', 'ratioSelect', 'ratioLabel', 'countSelect', 'imageSizeField', 'imageSizeSelect', 'referenceRail']) {
        el[name] = new Element(name.includes('Select') ? 'select' : 'div');
    }
    run(`refreshLucideIcons = () => {}; showToast = () => {}; persistState = () => {};
        renderGenerationSliders = () => {}; renderRatioPickerOptions = () => {}; refreshModernSelect = () => {};
        updateRatioPickerSelection = () => {}; updateRatioLabelHint = () => {}; renderRatioGrid = () => {};
        updateModelSpecificAdvancedOptions = () => {}; getDimensionOptions = profile => profile.dimensionOptions;`);
    return { el, run, context, mount };
}

// 把序列放进 vm 的 realm 再调 updateDimensionOptions，避免跨 realm 取值。
function mount(h, model, stored) {
    const sequence = h.run('createSequence()');
    sequence.model = model;
    if (stored !== undefined) sequence.imageSize = stored;
    h.context.__sequence = sequence;
    h.run('updateDimensionOptions(__sequence)');
    return sequence;
}

// 提交时 desktop.js 用的就是这条规则（generateImages 里 try 之外算出的 imageSize）。
function submittedFor(sequence) {
    const options = profiles.getImageApiProfile(sequence.model).imageSizeOptions;
    return profiles.resolveImageSizePreference(sequence.imageSize, options) || sequence.imageSize;
}

test('新建序列的默认分辨率档位是 4K', () => {
    const h = harness();
    assert.equal(h.run('createSequence()').imageSize, '4K');
});

test('下拉框显示什么档位，提交就发什么档位', () => {
    // grok 只有小写 1k/2k 是曾经的破绽：界面回落首项显示 1k，提交却收敛到 2k。
    for (const model of [
        'gpt-image-2.5-flare',
        'gemini-3.1-flash-image-preview',
        'gemini-2.5-flash-image',
        'grok-imagine-image-quality',
        'grok4.5'
    ]) {
        const h = harness();
        const sequence = mount(h, model);
        const shown = h.el.imageSizeSelect.value;
        assert.equal(shown, submittedFor(sequence), `${model}: 显示 ${shown} 但会发出 ${submittedFor(sequence)}`);
        // 显示的档位必须真的在这个模型的选项里，不能是空串。
        const options = profiles.getImageApiProfile(model).imageSizeOptions.map(option => option.value);
        assert.ok(options.includes(shown), `${model}: 显示值 ${shown} 不在 ${JSON.stringify(options)} 里`);
    }
});

test('模型没有 4K 档时保留用户偏好，只把回落标记挂上', () => {
    const h = harness();
    const grok = mount(h, 'grok-imagine-image-quality');
    assert.equal(h.el.imageSizeSelect.value, '2k', 'grok 应显示它支持的最高档');
    assert.equal(grok.imageSize, '4K', '序列里仍是用户偏好，没有被回落值覆盖');
    assert.equal(h.el.imageSizeSelect.dataset.fallback, '1', '回落值不能被 saveCurrentSequenceFromForm 写回序列');

    const gemini = mount(h, 'gemini-2.5-flash-image');
    assert.equal(h.el.imageSizeSelect.value, '1K');
    assert.equal(gemini.imageSize, '4K');
    assert.equal(h.el.imageSizeSelect.dataset.fallback, '1');
});

test('模型支持 4K 时不挂回落标记，偏好原样显示', () => {
    const h = harness();
    const openai = mount(h, 'gpt-image-2.5-flare');
    assert.equal(h.el.imageSizeSelect.value, '4K');
    assert.equal(openai.imageSize, '4K');
    assert.equal(h.el.imageSizeSelect.dataset.fallback, undefined, '精确命中就不该有回落标记');

    const flash31 = mount(h, 'gemini-3.1-flash-image-preview');
    assert.equal(h.el.imageSizeSelect.value, '4K');
    assert.equal(flash31.imageSize, '4K');
    assert.equal(h.el.imageSizeSelect.dataset.fallback, undefined);
});

test('用户手动选过的档位原样保留', () => {
    const h = harness();
    const grok = mount(h, 'grok-imagine-image-quality', '1k');
    assert.equal(h.el.imageSizeSelect.value, '1k', '用户选的 1k 是精确命中');
    assert.equal(h.el.imageSizeSelect.dataset.fallback, undefined);
    assert.equal(submittedFor(grok), '1k');
});
