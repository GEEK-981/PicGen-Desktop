const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const promptModule = import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'annotation', 'annotationPrompt.mjs')).href);

const size = { w: 900, h: 900 };

function doc(items, color = '#FF00FF') {
    return { version: 1, sourceSize: size, style: { color, stroke: 4 }, items };
}

test('builds a numbered instruction list referencing both aliases', async () => {
    const { buildAnnotationPrompt } = await promptModule;
    const text = buildAnnotationPrompt(doc([
        { id: 'a', type: 'rect', x: 0, y: 0, w: 100, h: 100, pin: 1, instruction: '把杯子换成蓝色' },
        { id: 'b', type: 'arrow', points: [100, 450, 800, 450], pin: 2, instruction: '台灯移到这里' }
    ]), { annotatedAlias: '标注-桌面', sourceAlias: '桌面' });
    assert.match(text, /^@\{标注-桌面\}为@\{桌面\}的标注副本（标注颜色为洋红）/);
    assert.match(text, /①框（左上）：把杯子换成蓝色/);
    assert.match(text, /②箭头（从左侧指向右侧）：台灯移到这里/);
    assert.match(text, /其余内容与@\{桌面\}保持一致/);
    assert.match(text, /不得出现任何标注、编号、框线或箭头/);
});

test('orders by pin number, skips empty instructions and lists unpinned notes', async () => {
    const { buildAnnotationPrompt } = await promptModule;
    const text = buildAnnotationPrompt(doc([
        { id: 'a', type: 'rect', x: 800, y: 0, w: 90, h: 90, pin: 2, instruction: '删除' },
        { id: 'b', type: 'pin', x: 10, y: 850, pin: 1, instruction: '加一盆绿植' },
        { id: 'c', type: 'rect', x: 400, y: 400, w: 50, h: 50, pin: 3, instruction: '   ' },
        { id: 'd', type: 'pen', points: [400, 400, 450, 450], instruction: '去掉污渍' }
    ]), { annotatedAlias: 'A', sourceAlias: 'B' });
    assert.ok(text.indexOf('①') < text.indexOf('②'));
    assert.match(text, /①标记点（左下）：加一盆绿植/);
    assert.doesNotMatch(text, /③/);
    assert.match(text, /其他标记：涂画（中间）：去掉污渍/);
});

test('quotes on-image text items and uses the fallback colour name', async () => {
    const { buildAnnotationPrompt } = await promptModule;
    const text = buildAnnotationPrompt(doc([
        { id: 't', type: 'text', x: 450, y: 20, text: '换成"SALE"字样', pin: 1, instruction: '' }
    ], '#00FFFF'), { annotatedAlias: 'A', sourceAlias: 'B' });
    assert.match(text, /标注颜色为青色/);
    assert.match(text, /①文字（上方）：图中标注文字「换成"SALE"字样」/);
});

test('escapes mention braces inside user text so they never become references', async () => {
    const { buildAnnotationPrompt } = await promptModule;
    const text = buildAnnotationPrompt(doc([
        { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, pin: 1, instruction: '参考 @{别的图} 的颜色' }
    ]), { annotatedAlias: 'A', sourceAlias: 'B' });
    // 生成的引用：@{A} 一次 + @{B} 三次；用户文本里的 @{别的图} 必须被转义掉
    assert.equal((text.match(/@\{/g) || []).length, 4, 'only the generated A/B mentions remain');
    assert.match(text, /@｛别的图｝/);
});

test('without a source alias the prompt edits the annotated image itself', async () => {
    const { buildAnnotationPrompt } = await promptModule;
    const text = buildAnnotationPrompt(doc([
        { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, pin: 1, instruction: '换色' }
    ]), { annotatedAlias: 'A' });
    assert.match(text, /^按@\{A\}上的标注修改这张图/);
    assert.match(text, /其余内容保持不变/);
});

test('returns an empty string when nothing actionable was annotated', async () => {
    const { buildAnnotationPrompt } = await promptModule;
    assert.equal(buildAnnotationPrompt(doc([
        { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, pin: 1, instruction: '' }
    ]), { annotatedAlias: 'A', sourceAlias: 'B' }), '');
});
