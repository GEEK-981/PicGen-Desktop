const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../frontend/workspace/workspacePrompt.mjs');

const meta = {
    bench: { id: 'bench', short: '长椅', renderable: true },
    'adult-male': { id: 'adult-male', short: '成年男性', renderable: false, omit: '人', omitPhrase: '这个人' }
};
const aliases = { layout: '比例版面', original: '太空帐篷', annotated: '标注图' };

test('layout part keeps positions, turns renderable anchors real and removes scale-only ones', async () => {
    const { buildWorkspacePrompt } = await load();
    const text = buildWorkspacePrompt({
        doc: { frame: { w: 2048, h: 1536 }, images: [{ id: 'i1' }],
            anchors: [{ anchorId: 'bench', renderable: true }, { anchorId: 'adult-male', renderable: false }], annotations: [] },
        anchorMeta: meta, aliases, template: 'marked', hasLayout: true
    });
    assert.match(text, /^以@\{比例版面\}为底图/);
    assert.match(text, /位置和大小完全不变/);
    assert.match(text, /把灰色的长椅换成真实的长椅（不要带品牌标志或文字）/);
    assert.match(text, /不要生成这个人/);
    assert.match(text, /产品外观以@\{太空帐篷\}为准/);
    assert.doesNotMatch(text, /产品高|真实比例/, 'sizes come from the layout itself, not a locked height');
});

test('annotation part numbers the edits and references the original', async () => {
    const { buildWorkspacePrompt } = await load();
    const text = buildWorkspacePrompt({
        doc: { frame: { w: 2000, h: 1000 }, images: [], anchors: [],
            annotations: [{ id: 'a', type: 'rect', x: 900, y: 400, w: 200, h: 200, pin: 1, instruction: '换成地球' }] },
        anchorMeta: meta, aliases, template: 'openai', hasLayout: false
    });
    assert.match(text, /@\{标注图\}为@\{太空帐篷\}的标注副本/);
    assert.match(text, /①框（中间）：换成地球/);
    assert.doesNotMatch(text, /底图/);
});

test('mask part is worded per template and never leaks technical terms', async () => {
    const { buildWorkspacePrompt } = await load();
    const base = { doc: { frame: { w: 2000, h: 1000 }, images: [], anchors: [], annotations: [] }, anchorMeta: meta, aliases, hasLayout: false, hasMask: true, maskBounds: { x: 1500, y: 100, w: 300, h: 200 } };
    const openai = buildWorkspacePrompt({ ...base, template: 'openai' });
    assert.match(openai, /只修改@\{太空帐篷\}右上的指定区域/);
    const marked = buildWorkspacePrompt({ ...base, template: 'marked' });
    assert.match(marked, /@\{标注图\}中红色半透明涂抹的区域（右上）/);
    assert.match(marked, /不要出现红色涂抹/);
    for (const text of [openai, marked]) assert.doesNotMatch(text, /alpha|RGBA|蒙版|mask/i);
});

test('returns an empty string when nothing needs a prompt', async () => {
    const { buildWorkspacePrompt } = await load();
    assert.equal(buildWorkspacePrompt({ doc: { frame: { w: 1, h: 1 }, images: [], anchors: [], annotations: [] }, anchorMeta: meta, aliases, template: 'openai' }), '');
});

test('the mask instruction typed in the panel is part of the snippet for both templates', async () => {
    const { buildWorkspacePrompt } = await load();
    const base = { doc: { frame: { w: 2000, h: 1000 }, images: [], anchors: [], annotations: [] }, anchorMeta: meta, aliases, hasLayout: false, hasMask: true,
        maskBounds: { x: 900, y: 400, w: 200, h: 200 }, maskInstruction: '换成一颗蓝绿色的地球' };
    assert.match(buildWorkspacePrompt({ ...base, template: 'openai' }), /只修改@\{太空帐篷\}中间的指定区域：换成一颗蓝绿色的地球。其余部分保持完全不变/);
    assert.match(buildWorkspacePrompt({ ...base, template: 'marked' }), /红色半透明涂抹的区域（中间）需要修改：换成一颗蓝绿色的地球。/);
});

test('the scene typed in the scale panel replaces the generic background wording', async () => {
    const { buildWorkspacePrompt } = await load();
    const text = buildWorkspacePrompt({
        doc: { frame: { w: 2048, h: 1536 }, images: [{ id: 'i1' }], anchors: [{ anchorId: 'bench', renderable: true }], annotations: [] },
        anchorMeta: meta, aliases, template: 'marked', hasLayout: true, scene: '户外平坦的草地，远处有树木'
    });
    assert.match(text, /把灰色背景换成户外平坦的草地，远处有树木；/);
});
