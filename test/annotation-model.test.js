const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modelModule = import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'annotation', 'annotationModel.mjs')).href);

function solidPixels(count, rgb) {
    const data = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) data.set(rgb, i * 3);
    return data;
}

test('adaptiveStroke scales with the short side and never drops below 4px (numbers must stay legible to the model)', async () => {
    const { adaptiveStroke } = await modelModule;
    assert.equal(adaptiveStroke(100, 80), 4);
    assert.equal(adaptiveStroke(2048, 1536), 8);
    assert.equal(adaptiveStroke(4096, 4096), 20);
    assert.equal(adaptiveStroke(0, 0), 4);
});

test('pickAnnotationColor keeps magenta unless the image is already magenta-heavy', async () => {
    const { pickAnnotationColor } = await modelModule;
    assert.equal(pickAnnotationColor(solidPixels(100, [30, 120, 40]), 3), '#FF00FF');
    assert.equal(pickAnnotationColor(solidPixels(100, [230, 20, 220]), 3), '#00FFFF');
    // magenta + cyan heavy → falls through to yellow
    const mixed = new Uint8Array([...solidPixels(50, [230, 20, 220]), ...solidPixels(50, [20, 230, 230])]);
    assert.equal(pickAnnotationColor(mixed, 3), '#FFFF00');
    // grey / dark pixels do not count as clashing hues
    assert.equal(pickAnnotationColor(solidPixels(100, [128, 120, 128]), 3), '#FF00FF');
});

test('pickAnnotationColor reads RGBA buffers', async () => {
    const { pickAnnotationColor } = await modelModule;
    const rgba = new Uint8Array(400);
    for (let i = 0; i < 100; i++) rgba.set([230, 20, 220, 255], i * 4);
    assert.equal(pickAnnotationColor(rgba, 4), '#00FFFF');
});

test('renumberPins compacts pin numbers in creation order after deletion', async () => {
    const { renumberPins, nextPinNumber } = await modelModule;
    const items = [
        { id: 'a', type: 'rect', pin: 1 },
        { id: 'b', type: 'pen' },
        { id: 'c', type: 'arrow', pin: 3 },
        { id: 'd', type: 'pin', pin: 4 }
    ];
    const renumbered = renumberPins(items);
    assert.deepEqual(renumbered.map(item => item.pin ?? null), [1, null, 2, 3]);
    assert.equal(nextPinNumber(renumbered), 4);
    assert.equal(items[2].pin, 3, 'input is not mutated');
});

test('circledNumber uses circled digits up to 20 and parentheses beyond', async () => {
    const { circledNumber } = await modelModule;
    assert.equal(circledNumber(1), '①');
    assert.equal(circledNumber(20), '⑳');
    assert.equal(circledNumber(21), '(21)');
});

test('positionLabel names the 3x3 grid cell of the item centre', async () => {
    const { positionLabel } = await modelModule;
    const size = { w: 900, h: 900 };
    assert.equal(positionLabel({ type: 'rect', x: 0, y: 0, w: 100, h: 100 }, size), '左上');
    assert.equal(positionLabel({ type: 'rect', x: 400, y: 400, w: 100, h: 100 }, size), '中间');
    assert.equal(positionLabel({ type: 'pin', x: 850, y: 850 }, size), '右下');
    assert.equal(positionLabel({ type: 'pen', points: [400, 10, 500, 20] }, size), '上方');
});

test('normalizeDoc drops malformed items, clamps numbers and keeps known types', async () => {
    const { normalizeDoc } = await modelModule;
    const doc = normalizeDoc({
        sourceRefId: 'ref_1',
        sourceSize: { w: 1000, h: 500 },
        items: [
            { id: 'a', type: 'rect', x: -20, y: 10, w: 50, h: 40, pin: 1, instruction: '  换成蓝色 ' },
            { id: 'b', type: 'laser', x: 1 },
            { id: 'c', type: 'arrow', points: [0, 0, 'x', 5] },
            { id: 'd', type: 'arrow', points: [10, 10, 200, 200] },
            null
        ]
    });
    assert.equal(doc.version, 1);
    assert.equal(doc.items.length, 2);
    assert.equal(doc.items[0].x, 0);
    assert.equal(doc.items[0].instruction, '换成蓝色');
    assert.equal(doc.items[1].id, 'd');
    assert.equal(doc.style.color, '#FF00FF');
    assert.equal(doc.style.stroke, 4);
});

test('isLargeRegion flags boxes over 40% of the image', async () => {
    const { isLargeRegion } = await modelModule;
    const size = { w: 1000, h: 1000 };
    assert.equal(isLargeRegion({ type: 'rect', x: 0, y: 0, w: 700, h: 700 }, size), true);
    assert.equal(isLargeRegion({ type: 'rect', x: 0, y: 0, w: 300, h: 300 }, size), false);
    assert.equal(isLargeRegion({ type: 'arrow', points: [0, 0, 999, 999] }, size), false);
});

test('editor helpers: translate, badge anchor, rect normalisation, auto-pin and removal renumbering', async () => {
    const m = await import('../frontend/annotation/annotationModel.mjs');
    assert.deepEqual(m.translateItem({ type: 'arrow', points: [0, 0, 10, 20] }, 5, -5).points, [5, -5, 15, 15]);
    assert.deepEqual(m.translateItem({ type: 'rect', x: 1, y: 2, w: 3, h: 4 }, 1, 1), { type: 'rect', x: 2, y: 3, w: 3, h: 4 });
    assert.deepEqual(m.badgeAnchor({ type: 'pen', points: [7, 8, 9, 10] }), { x: 7, y: 8 });
    assert.deepEqual(m.normalizeRect(50, 60, 10, 20), { x: 10, y: 20, w: 40, h: 40 });
    let items = m.addItem([], { id: 'a', type: 'rect' });
    items = m.addItem(items, { id: 't', type: 'text', text: 'hi' });
    items = m.addItem(items, { id: 'b', type: 'arrow', points: [0, 0, 1, 1] });
    assert.deepEqual(items.map(item => item.pin), [1, undefined, 2]);
    assert.deepEqual(m.removeItem(items, 'a').map(item => item.pin), [undefined, 1]);
});

test('annotationWarnings flags too many pins, oversized boxes and empty instructions', async () => {
    const m = await import('../frontend/annotation/annotationModel.mjs');
    const doc = m.createDoc({ sourceSize: { w: 100, h: 100 } });
    doc.items = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, type: 'pin', x: 1, y: 1, pin: i + 1, instruction: 'x' }));
    assert.ok(m.annotationWarnings(doc).some(text => text.includes('7 处编号')));
    doc.items = [{ id: 'r', type: 'rect', x: 0, y: 0, w: 90, h: 90, pin: 1, instruction: '' }];
    const warnings = m.annotationWarnings(doc);
    assert.ok(warnings.some(text => text.includes('40%')));
    assert.ok(warnings.some(text => text.includes('还没写修改要求')));
});
