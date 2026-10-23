const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../frontend/workspace/workspaceModel.mjs');

test('frameForRatio keeps the long side at 2048 and honours the ratio', async () => {
    const { frameForRatio } = await load();
    assert.deepEqual(frameForRatio('4:3'), { ratio: '4:3', w: 2048, h: 1536 });
    assert.deepEqual(frameForRatio('3:4'), { ratio: '3:4', w: 1536, h: 2048 });
    assert.deepEqual(frameForRatio('1:1'), { ratio: '1:1', w: 2048, h: 2048 });
    assert.deepEqual(frameForRatio('16:9'), { ratio: '16:9', w: 2048, h: 1152 });
    assert.deepEqual(frameForRatio('bogus'), { ratio: '4:3', w: 2048, h: 1536 });
});

test('fitIntoFrame centres an image inside the frame with a margin and keeps its aspect', async () => {
    const { fitIntoFrame } = await load();
    const box = fitIntoFrame({ w: 3000, h: 2000 }, { w: 2048, h: 1536 }, 0.1);
    assert.ok(Math.abs(box.w / box.h - 1.5) < 1e-9);
    assert.ok(box.w <= 2048 * 0.8 + 1e-6 && box.h <= 1536 * 0.8 + 1e-6);
    assert.ok(Math.abs(box.x + box.w / 2 - 1024) < 1e-6 && Math.abs(box.y + box.h / 2 - 768) < 1e-6);
});

test('createWorkspaceDoc places the first image and starts with no anchors or annotations', async () => {
    const { createWorkspaceDoc } = await load();
    const doc = createWorkspaceDoc({ ratio: '4:3', image: { id: 'i1', refId: 'ref_1', name: 'tent.jpg', naturalW: 3000, naturalH: 2000 } });
    assert.equal(doc.images.length, 1);
    assert.equal(doc.scale, undefined, 'no scale lock any more');
    assert.deepEqual(doc.anchors, []);
    assert.deepEqual(doc.annotations, []);
});

test('templateForModel picks the native mask only for OpenAI image models', async () => {
    const { templateForModel } = await load();
    for (const model of ['gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1-mini', 'dall-e-2', 'chatgpt-image-latest']) {
        assert.equal(templateForModel(model), 'openai', model);
    }
    for (const model of ['gemini-3-pro-image-preview', 'nano-banana-pro', 'doubao-seedream-5-0', 'grok-imagine-image', 'flux-kontext-pro', '']) {
        assert.equal(templateForModel(model), 'marked', model);
    }
});

test('planOutputs assembles references per model template without technical wording', async () => {
    const { planOutputs } = await load();
    const common = { hasImages: true, hasAnnotations: true, hasMask: true, hasLayout: false };
    const openai = planOutputs({ ...common, template: 'openai' });
    assert.deepEqual(openai.references.map(r => r.role), ['original', 'annotated']);
    assert.equal(openai.mask, 'separate');
    assert.deepEqual(openai.thumbnails.map(t => t.label), ['原图', '标注图', '修改区域']);
    const gemini = planOutputs({ ...common, template: 'marked' });
    assert.deepEqual(gemini.references.map(r => r.role), ['original', 'annotated']);
    assert.equal(gemini.mask, 'painted');
    assert.deepEqual(gemini.thumbnails.map(t => t.label), ['原图', '标注图']);
    assert.match(gemini.thumbnails[1].sub, /涂抹/);
    const layout = planOutputs({ hasImages: true, hasAnnotations: false, hasMask: false, hasLayout: true, template: 'marked' });
    assert.deepEqual(layout.references.map(r => r.role), ['layout', 'original']);
    const plain = planOutputs({ hasImages: true, hasAnnotations: false, hasMask: false, hasLayout: false, template: 'openai' });
    assert.deepEqual(plain.references.map(r => r.role), ['original']);
});

test('setFrameRatio re-centres every item in the new frame without resizing it', async () => {
    const { createWorkspaceDoc, setFrameRatio, placeAnchor } = await load();
    let doc = createWorkspaceDoc({ ratio: '4:3', image: { id: 'i1', naturalW: 100, naturalH: 100 } });
    doc = placeAnchor(doc, { id: 'coin', realWidthMm: 25, realHeightMm: 25, renderable: true });
    doc.annotations = [{ id: 'a', type: 'rect', x: 10, y: 10, w: 5, h: 5, pin: 1 }];
    const before = doc.images[0];
    const next = setFrameRatio(doc, '1:1');
    assert.deepEqual(next.frame, { ratio: '1:1', w: 2048, h: 2048 });
    const dy = (2048 - 1536) / 2;
    assert.ok(Math.abs(next.images[0].y - (before.y + dy)) < 1e-9);
    assert.equal(next.images[0].w, before.w);
    assert.ok(Math.abs(next.anchors[0].y - (doc.anchors[0].y + dy)) < 1e-9);
    assert.ok(Math.abs(next.annotations[0].y - (10 + dy)) < 1e-9);
});

test('the 原图 frame follows the image aspect with no margin (local edits keep the photo, not a padded frame)', async () => {
    const { frameForRatio, createWorkspaceDoc } = await load();
    assert.deepEqual(frameForRatio('original', { w: 4000, h: 3000 }), { ratio: 'original', w: 2048, h: 1536 });
    assert.deepEqual(frameForRatio('original', { w: 800, h: 1000 }), { ratio: 'original', w: 800, h: 1008 });
    assert.deepEqual(frameForRatio('original'), { ratio: '4:3', w: 2048, h: 1536 });
    const doc = createWorkspaceDoc({ ratio: 'original', image: { id: 'i1', naturalW: 4000, naturalH: 3000 } });
    assert.deepEqual(doc.frame, { ratio: 'original', w: 2048, h: 1536 });
    const img = doc.images[0];
    assert.deepEqual([img.x, img.y, img.w, img.h], [0, 0, 2048, 1536]);
});

test('every frame size is a multiple of 16 (OpenAI Image2 rejects other custom sizes)', async () => {
    const { frameForRatio, RATIOS } = await load();
    for (const ratio of RATIOS.filter(r => r !== 'original')) {
        const f = frameForRatio(ratio);
        assert.equal(f.w % 16, 0, `${ratio} w=${f.w}`);
        assert.equal(f.h % 16, 0, `${ratio} h=${f.h}`);
    }
    for (const natural of [{ w: 6349, h: 4233 }, { w: 1000, h: 777 }, { w: 333, h: 999 }]) {
        const f = frameForRatio('original', natural);
        assert.equal(f.w % 16, 0, JSON.stringify(f));
        assert.equal(f.h % 16, 0, JSON.stringify(f));
        assert.ok(Math.abs(f.w / f.h - natural.w / natural.h) < 0.03, 'aspect stays close to the photo');
    }
});

test('placeAnchor puts a comparison object beside the product at product height, keeping its real aspect', async () => {
    const { createWorkspaceDoc, placeAnchor, contentBoxOf } = await load();
    let doc = createWorkspaceDoc({ ratio: '4:3', image: { id: 'i1', naturalW: 1000, naturalH: 1000, content: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } } });
    const p = contentBoxOf(doc.images[0]);
    doc = placeAnchor(doc, { id: 'door', realWidthMm: 560, realHeightMm: 2030, renderable: true });
    const a = doc.anchors[0];
    assert.ok(Math.abs(a.w / a.h - 560 / 2030) < 1e-9, 'real aspect');
    assert.ok(Math.abs(a.h - Math.min(p.h, doc.frame.h * 0.45)) < 1e-9, 'starts at product height, capped');
    assert.ok(a.x + a.w <= p.x + 1e-6, 'left of the product');
    assert.ok(Math.abs(a.y + a.h - (p.y + p.h)) < 1e-6, 'bottoms aligned');
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= doc.frame.w && a.y + a.h <= doc.frame.h, 'inside the frame');
});

test('placeAnchor never overflows the frame: wide objects are capped and fall back to the right side', async () => {
    const { createWorkspaceDoc, placeAnchor } = await load();
    // 产品占满画框左侧：左边放不下 → 放右边；汽车很宽 → 宽度不超过画框 60%
    let doc = createWorkspaceDoc({ ratio: 'original', image: { id: 'i1', naturalW: 1000, naturalH: 1000 } });
    doc = placeAnchor(doc, { id: 'car', realWidthMm: 4680, realHeightMm: 1480, renderable: true });
    const a = doc.anchors[0];
    assert.ok(a.w <= doc.frame.w * 0.6 + 1e-6);
    assert.ok(Math.abs(a.w / a.h - 4680 / 1480) < 1e-9);
    assert.ok(a.x >= 0 && a.x + a.w <= doc.frame.w + 1e-6 && a.y >= 0 && a.y + a.h <= doc.frame.h + 1e-6);
});

test('dropping an anchor centres it on the drop point; it can then be moved, resized and rotated freely', async () => {
    const { createWorkspaceDoc, placeAnchor, updateAnchor } = await load();
    let doc = createWorkspaceDoc({ ratio: '4:3', image: { id: 'i1', naturalW: 100, naturalH: 100 } });
    doc = placeAnchor(doc, { id: 'coin', realWidthMm: 25, realHeightMm: 25, renderable: true }, { cx: 1000, cy: 700 });
    const a = doc.anchors[0];
    assert.ok(Math.abs(a.x + a.w / 2 - 1000) < 1e-9 && Math.abs(a.y + a.h / 2 - 700) < 1e-9);
    doc = updateAnchor(doc, a.id, { x: 5, y: 6, w: 300, h: 300, rotation: 30 });
    assert.deepEqual([doc.anchors[0].x, doc.anchors[0].y, doc.anchors[0].w, doc.anchors[0].rotation], [5, 6, 300, 30]);
});

test('models are grouped by family; prefix anchoring keeps gpt-image-mini out of Nano Banana', async () => {
    const { modelFamily, groupModelsByFamily } = await load();
    const cases = {
        'gemini-3-pro-image-preview': 'nanobanana', 'nano-banana-pro': 'nanobanana', 'google/gemini-2.5-flash-image': 'nanobanana', 'imagen-4.0': 'nanobanana',
        'gpt-image-2': 'gpt', 'gpt-image-mini': 'gpt', 'gpt-image-2.5-sunburst': 'gpt', 'dall-e-3': 'gpt',
        'grok-imagine-image': 'grok', 'x-ai/grok-2-image': 'grok',
        'doubao-seedream-5-0': 'seedream', 'seedream-4.0': 'seedream',
        'flux-kontext-pro': 'other', '': 'other'
    };
    for (const [model, family] of Object.entries(cases)) assert.equal(modelFamily(model), family, model);
    const groups = groupModelsByFamily(['gpt-image-2', 'nano-banana-pro', 'flux-kontext-pro', 'gemini-3-pro-image-preview']);
    assert.deepEqual(groups.map(g => [g.id, g.models]), [['nanobanana', ['nano-banana-pro', 'gemini-3-pro-image-preview']], ['gpt', ['gpt-image-2']], ['other', ['flux-kontext-pro']]]);
});

test('when neither side of the product has room, the object shrinks into the wider side instead of covering the product', async () => {
    const { createWorkspaceDoc, placeAnchor, contentBoxOf } = await load();
    // 900×600 照片，产品居中偏右，左右空位都放不下原大小的长椅
    let doc = createWorkspaceDoc({ ratio: 'original', image: { id: 'i1', naturalW: 900, naturalH: 600, content: { x: 250 / 900, y: 100 / 600, w: 400 / 900, h: 450 / 600 } } });
    const p = contentBoxOf(doc.images[0]);
    doc = placeAnchor(doc, { id: 'bench', realWidthMm: 1600, realHeightMm: 850, renderable: true });
    const a = doc.anchors[0];
    assert.ok(a.x + a.w <= p.x + 1e-6 || a.x >= p.x + p.w - 1e-6, `beside the product: ${JSON.stringify({ a, p })}`);
    assert.ok(Math.abs(a.w / a.h - 1600 / 850) < 1e-9, 'aspect kept');
    assert.ok(Math.abs(a.y + a.h - (p.y + p.h)) < 1e-6, 'bottoms aligned');
});

test('isBlankDoc is true only when the canvas holds no image, comparison object or annotation (清空 is disabled then)', async () => {
    const { createWorkspaceDoc, addImage, placeAnchor, isBlankDoc } = await load();
    const blank = createWorkspaceDoc();
    assert.equal(isBlankDoc(blank), true);
    assert.equal(isBlankDoc(addImage(blank, { id: 'i1', naturalW: 900, naturalH: 600 })), false);
    // 没有图也能放进对比物体（画布未挂载、看不见），这时也要能清空
    const anchorOnly = placeAnchor(blank, { id: 'coin', realWidthMm: 25, realHeightMm: 25, renderable: true });
    assert.equal(anchorOnly.images.length, 0);
    assert.equal(isBlankDoc(anchorOnly), false);
    assert.equal(isBlankDoc({ ...blank, annotations: [{ id: 'a', type: 'rect', x: 1, y: 1, w: 5, h: 5, pin: 1 }] }), false);
});

test('blankWorkspaceDoc is the nav entry\'s empty 4:3 canvas and leaves the cleared doc untouched for undo', async () => {
    const { createWorkspaceDoc, placeAnchor, blankWorkspaceDoc, isBlankDoc } = await load();
    let doc = createWorkspaceDoc({ ratio: 'original', image: { id: 'i1', naturalW: 900, naturalH: 600 } });
    doc = placeAnchor(doc, { id: 'bench', realWidthMm: 1600, realHeightMm: 850, renderable: true });
    doc = { ...doc, annotations: [{ id: 'a', type: 'rect', x: 1, y: 1, w: 5, h: 5, pin: 1 }], annotationStyle: { color: '#FF00FF', stroke: 8 } };
    const before = JSON.stringify(doc);
    Object.freeze(doc);
    const cleared = blankWorkspaceDoc();
    assert.equal(isBlankDoc(cleared), true);
    assert.deepEqual(cleared.frame, { ratio: '4:3', w: 2048, h: 1536 });
    assert.deepEqual([cleared.images, cleared.anchors, cleared.annotations], [[], [], []]);
    assert.equal(cleared.annotationStyle, undefined, 'annotation colour is re-sampled from the next image');
    assert.deepEqual(cleared, createWorkspaceDoc({ ratio: '4:3' }));
    assert.equal(JSON.stringify(doc), before, 'the doc kept on the undo timeline is not mutated');
    assert.notEqual(blankWorkspaceDoc().images, cleared.images, 'every blank doc gets its own arrays');
});

test('deleting the only image keeps leftover objects and annotations, so 清空 stays available', async () => {
    const { createWorkspaceDoc, removeItem, isBlankDoc } = await load();
    const doc = { ...createWorkspaceDoc({ ratio: 'original', image: { id: 'i1', naturalW: 900, naturalH: 600 } }),
        annotations: [{ id: 'a', type: 'pin', x: 10, y: 10, pin: 1 }] };
    const after = removeItem(doc, 'i1');
    assert.equal(after.images.length, 0, 'the workspace shows its empty state');
    assert.equal(isBlankDoc(after), false);
    assert.equal(isBlankDoc(removeItem(after, 'a')), true);
});
