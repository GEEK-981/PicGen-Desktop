// 拖拽图片不得带出悬停大图预览；主页最近图条要显示并就地更新使用次数。
//
// 背景：预览由 mouseenter 起 80ms 意图定时器、再由主进程异步显示，而拖拽屏蔽只在 dragstart 才升起——
// 按下到越过拖拽阈值之间大图会闪出来。窗内落下后，Chromium 在陈旧的指针位置补发悬停（遮罩收起、
// 图条重建都会触发），固定 400ms 屏蔽挡不住。这里把按键闸、真实移动闸、锚点与屏蔽归属钉死。
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const profiles = require('../imageApiProfiles');

class Element {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
        this.attributes = {}; this.className = ''; this.value = ''; this.hidden = false; this.title = '';
        this._text = ''; this._html = ''; this.isConnected = true; this.rect = { left: 0, top: 0, width: 0, height: 0 };
        this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    }
    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = value; this.children = []; }
    get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this._text; }
    set textContent(value) { this._text = String(value); this.children = []; }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return key in this.attributes ? this.attributes[key] : null; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener() {}
    getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
    // 只支持本文件用到的 '.class' / 'tag' 选择器。
    matches(selector) { return selector.startsWith('.') ? this.className.split(/\s+/).includes(selector.slice(1)) : this.tagName === selector.toUpperCase(); }
    querySelectorAll(selector) {
        const found = [];
        const walk = node => node.children.forEach(child => { if (child.matches(selector)) found.push(child); walk(child); });
        walk(this);
        return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selectors) {
        for (let node = this; node; node = node.parentNode) {
            if (selectors.split(',').some(selector => node.matches?.(selector.trim()))) return node;
        }
        return null;
    }
}

function harness() {
    const calls = { show: [], hide: 0, drag: [] };
    const document = {
        addEventListener() {}, createElement: tag => new Element(tag), querySelector: () => null, querySelectorAll: () => [],
        getElementById: () => null, body: null
    };
    const context = vm.createContext({
        console, URL, Date, Map, Set, document, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: () => 0, cancelAnimationFrame() {},
        window: {
            PicGenImageApiProfiles: profiles, PicGenRendererUtils: {},
            picgenDesktop: {
                showImagePreview: payload => calls.show.push(payload),
                hideImagePreview: () => { calls.hide += 1; },
                startImageDrag: filePath => calls.drag.push(filePath)
            }
        },
        fetch: async () => { throw new Error('Unexpected network request'); }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'desktop.js'), 'utf8'), context);
    const run = code => vm.runInContext(code, context);
    const el = run('el');
    for (const name of ['imageHoverPreview', 'imageHoverPreviewImg', 'imageHoverPreviewDimensions', 'imageHoverPreviewModel', 'imageHoverPreviewProvider']) {
        el[name] = new Element(name.endsWith('Img') ? 'img' : 'div');
    }
    el.recentImages = new Element('div');
    run('renderReferences = () => {}; setImageDragShield = () => {};');
    return { el, run, context, calls, state: run('state') };
}

function tile(className, rect = { left: 10, top: 20, width: 76, height: 76 }) {
    const node = new Element('div');
    node.className = className;
    node.rect = rect;
    return node;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const image = { id: 'a', filePath: 'C:\\images\\a.png', fileName: 'a.png', fileSize: 10, width: 1024, height: 1024 };
const enter = node => ({ clientX: 40, clientY: 50, screenX: 140, screenY: 150, currentTarget: node });

test('悬停预览带上发起它的图块矩形，主进程据此核对真实光标', async () => {
    const h = harness();
    const node = tile('recent-item');
    h.context.__args = [image, enter(node)];
    h.run('showImageHoverPreview(...__args)');
    assert.equal(h.calls.show.length, 0, '80ms 意图延时之内不弹');
    await sleep(120);
    assert.equal(h.calls.show.length, 1);
    assert.deepEqual({ ...h.calls.show[0].anchor }, { x: 10, y: 20, width: 76, height: 76 });
});

test('按下图片即收起预览并取消待弹的定时器，按住期间不弹，松开后恢复', async () => {
    const h = harness();
    const node = tile('recent-item');
    h.context.__args = [image, enter(node)];
    h.run('showImageHoverPreview(...__args)');
    h.context.__down = { button: 0, target: node };
    h.run('handleImagePointerDown(__down)');
    await sleep(120);
    assert.equal(h.calls.show.length, 0, '按下之后定时器不得再弹出预览');
    h.run('showImageHoverPreview(...__args)');
    await sleep(120);
    assert.equal(h.calls.show.length, 0, '按住期间不弹');

    // 右键或按在非图片处不算"准备拖拽"。
    h.run('handleImagePointerRelease()');
    h.context.__down = { button: 2, target: node };
    h.run('handleImagePointerDown(__down)');
    assert.equal(h.state.imagePointerPressed, false);
    h.run('showImageHoverPreview(...__args)');
    await sleep(120);
    assert.equal(h.calls.show.length, 1, '松开后正常预览');
});

test('拖拽结束后补发的悬停不弹预览，直到出现一次真实移动', async () => {
    const h = harness();
    const node = tile('history-item');
    h.run('beginImageDragPreviewGuard(); endImageDragPreviewGuard();');
    h.context.__args = [image, enter(node)];
    h.run('showImageHoverPreview(...__args)');
    await sleep(500);
    assert.equal(h.calls.show.length, 0, '远超旧的 400ms 也不弹：落下后的图条重建/慢 IPC 常晚于 400ms');
    h.run('handleHoverPreviewRealMove()');
    h.run('showImageHoverPreview(...__args)');
    await sleep(120);
    assert.equal(h.calls.show.length, 1, '真实移动之后重新进入图块正常预览');
});

test('拖拽结束时系统在落点补发的原地 mousemove 不算真实移动，离开基准 ≥2px 才开闸', () => {
    const h = harness();
    h.run('beginImageDragPreviewGuard(); endImageDragPreviewGuard();');
    h.run('handleHoverPreviewRealMove({ screenX: 300, screenY: 400 })');
    assert.equal(h.state.hoverPreviewNeedsMove, true, '第一条只记基准点');
    h.run('handleHoverPreviewRealMove({ screenX: 301, screenY: 400 })');
    assert.equal(h.state.hoverPreviewNeedsMove, true, '1px 抖动不算');
    h.run('handleHoverPreviewRealMove({ screenX: 303, screenY: 400 })');
    assert.equal(h.state.hoverPreviewNeedsMove, false);
    assert.equal(h.state.hoverPreviewMoveFrom, null);

    // 再次上锁要清掉上一轮的基准点
    h.run('handleHoverPreviewRealMove({ screenX: 10, screenY: 10 }); armHoverPreviewMoveGate();');
    h.run('handleHoverPreviewRealMove({ screenX: 500, screenY: 500 })');
    assert.equal(h.state.hoverPreviewNeedsMove, true);
});

test('拖拽结束会清掉按键闸（OLE 模态循环吞掉了 pointerup）', () => {
    const h = harness();
    h.context.__down = { button: 0, target: tile('recent-item') };
    h.run('handleImagePointerDown(__down); beginImageDragPreviewGuard(); endImageDragPreviewGuard();');
    assert.equal(h.state.imagePointerPressed, false);
    assert.equal(h.state.imageDragPreviewGuard, false);
    assert.equal(h.state.hoverPreviewNeedsMove, true);
});

test('意图延时内开始拖拽、或图块已被重建，定时器到点都不弹', async () => {
    const h = harness();
    const node = tile('recent-item');
    h.context.__args = [image, enter(node)];
    h.run('showImageHoverPreview(...__args)');
    h.state.imageDragPreviewGuard = true;
    await sleep(120);
    assert.equal(h.calls.show.length, 0);

    h.state.imageDragPreviewGuard = false;
    h.run('showImageHoverPreview(...__args)');
    node.isConnected = false; // 图条 replaceChildren 重建
    await sleep(120);
    assert.equal(h.calls.show.length, 0);
});

test('只有自己的拖拽能解除预览屏蔽：主页拖拽的兜底清理不碰参考图卡拖拽', () => {
    const h = harness();
    h.run(`startReferenceCardDrag('seq', { id: 'r1', filePath: 'C:\\\\refs\\\\r1.png' })`);
    assert.equal(h.state.imageDragPreviewGuard, true);
    h.run('clearDraggedRecentImage()');
    assert.equal(h.state.imageDragPreviewGuard, true, '没有主页/历史拖拽在进行，不该解除参考图卡的屏蔽');
    h.run('endReferenceCardDrag()');
    assert.equal(h.state.imageDragPreviewGuard, false);
    assert.equal(h.state.hoverPreviewNeedsMove, true);
});

test('没有原图文件的参考图卡不进入拖拽态（否则预览要被屏蔽 20s）', () => {
    const h = harness();
    h.run(`startReferenceCardDrag('seq', { id: 'r2', filePath: '' })`);
    assert.equal(h.state.draggedReferenceCard, null);
    assert.equal(h.state.imageDragPreviewGuard, false);
    assert.equal(h.calls.drag.length, 0);
});

test('主页最近图条的使用次数角标随使用推送就地更新', () => {
    const h = harness();
    const record = { ...image };
    h.state.recentImages = [record];
    const item = tile('recent-item');
    item.dataset.historyId = 'a';
    h.el.recentImages.appendChild(item);
    h.context.__update = { usageKey: 'a.png|10', filePath: record.filePath, usage: { dragCount: 1, referenceCount: 1, lastUsedAt: 0, lastUsedKind: 'reference' } };
    h.run('applyHistoryUsage(__update)');
    const badge = item.querySelector('.history-usage-badge');
    assert.ok(badge, '用过的图显示角标');
    assert.equal(badge.querySelector('b').textContent, '2');
    // 操作说明写在 aria-label 里（title 会触发 Windows 系统信息提示，盖住悬停预览），使用次数跟在末尾
    assert.match(item.getAttribute('aria-label'), /^a\.png，点击查看详情.*，已使用 2 次$/);
});
