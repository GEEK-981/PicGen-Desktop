const test = require('node:test');
const assert = require('node:assert/strict');
const {
    toMm, formatLength, tierFor, pickAnchor, ratioPhrase, layoutScene
} = require('../sizeReferenceLayout');
const { buildSizeReferencePrompt } = require('../sizeReferencePrompt');

const catalog = [
    { id: 'finger', tier: 0, isDefault: true, realHeightMm: 75, realWidthMm: 18, short: '食指' },
    { id: 'coin', tier: 0, isDefault: false, realHeightMm: 25, realWidthMm: 25, short: '硬币' },
    { id: 'finger-2', tier: 1, isDefault: true, realHeightMm: 75, realWidthMm: 18, short: '食指' },
    { id: 'hand', tier: 2, isDefault: true, realHeightMm: 190, realWidthMm: 95, short: '成人的手' },
    { id: 'bust', tier: 3, isDefault: true, realHeightMm: 520, realWidthMm: 460, short: '成人头肩' },
    { id: 'adult-male', tier: 5, isDefault: true, person: 'male', realHeightMm: 1750, realWidthMm: 520, short: '成年男性' },
    { id: 'adult-female', tier: 5, isDefault: true, person: 'female', realHeightMm: 1620, realWidthMm: 460, short: '成年女性' },
    { id: 'child', tier: 5, isDefault: false, person: 'child', realHeightMm: 1100, realWidthMm: 340, short: '5 岁儿童' },
    { id: 'door', tier: 6, isDefault: true, realHeightMm: 2030, realWidthMm: 1500, short: '门和成人' },
    { id: 'car', tier: 7, isDefault: true, realHeightMm: 1750, realWidthMm: 5600, short: '轿车和成人' },
    { id: 'bad', tier: 2, isDefault: true, realHeightMm: 150, realWidthMm: 70, recognitionPassed: false, short: '失败素材' }
];

test('toMm converts every supported unit and rejects nonsense', () => {
    assert.equal(toMm(12, 'mm'), 12);
    assert.equal(toMm(12.5, 'cm'), 125);
    assert.equal(toMm(1.75, 'm'), 1750);
    assert.equal(toMm(10, 'in'), 254);
    assert.equal(toMm('30', 'cm'), 300);
    assert.throws(() => toMm(0, 'cm'), /大于 0/);
    assert.throws(() => toMm(-3, 'cm'), /大于 0/);
    assert.throws(() => toMm(NaN, 'cm'), /数字/);
    assert.throws(() => toMm(10, 'ft'), /单位/);
    assert.throws(() => toMm(60, 'm'), /50 m/);
});

test('formatLength picks a readable metric unit and pairs it with imperial', () => {
    assert.equal(formatLength(8.5).text, '8.5 mm / 0.33 in');
    assert.equal(formatLength(150).text, '15 cm / 5.9 in');
    assert.equal(formatLength(1200).text, '1.2 m / 3.9 ft');
    assert.equal(formatLength(1750).metric, '1.75 m');
    assert.equal(formatLength(4700).imperial, '15.4 ft');
});

test('tierFor follows the 8-tier ladder boundaries', () => {
    assert.equal(tierFor(29.9), 0);
    assert.equal(tierFor(30), 1);
    assert.equal(tierFor(299), 2);
    assert.equal(tierFor(300), 3);
    assert.equal(tierFor(999), 4);
    assert.equal(tierFor(1000), 5);
    assert.equal(tierFor(4999), 6);
    assert.equal(tierFor(5000), 7);
});

test('pickAnchor chooses the tier default and honours the person preference', () => {
    assert.equal(pickAnchor({ heightMm: 150, widthMm: 40 }, catalog).id, 'hand');
    assert.equal(pickAnchor({ heightMm: 1200, widthMm: 1200 }, catalog).id, 'adult-male');
    assert.equal(pickAnchor({ heightMm: 1200, widthMm: 1200 }, catalog, { person: 'female' }).id, 'adult-female');
    assert.equal(pickAnchor({ heightMm: 1200, widthMm: 1200 }, catalog, { person: 'child' }).id, 'child');
    assert.equal(pickAnchor({ heightMm: 1450, widthMm: 4700 }, catalog).id, 'door');
    assert.equal(pickAnchor({ heightMm: 1450, widthMm: 5200 }, catalog).id, 'car');
});

test('pickAnchor respects an explicit override but never a failed-recognition asset', () => {
    assert.equal(pickAnchor({ heightMm: 150, widthMm: 40 }, catalog, { anchorId: 'coin' }).id, 'coin');
    assert.equal(pickAnchor({ heightMm: 150, widthMm: 40 }, catalog, { anchorId: 'bad' }).id, 'hand');
    assert.equal(pickAnchor({ heightMm: 150, widthMm: 40 }, catalog, { anchorId: 'missing' }).id, 'hand');
});

test('pickAnchor jumps to a closer anchor when the tier default breaks the 1:4..4:1 ratio', () => {
    // 0.7 m：测试目录里档位 4 没有参照物 → 取比例最接近且在 1:4..4:1 内的可用参照物（头肩 52 cm）
    assert.equal(pickAnchor({ heightMm: 700, widthMm: 300 }, catalog).id, 'bust');
    // 8 mm：档位默认的食指 75 mm 超过 4 倍 → 同样按比例改选硬币（25 mm ≈ 3 倍）
    assert.equal(pickAnchor({ heightMm: 8, widthMm: 8 }, catalog).id, 'coin');
    // 什么都不在 4 倍以内时，退回比例最接近的那个
    assert.equal(pickAnchor({ heightMm: 2, widthMm: 2 }, catalog).id, 'coin');
});

test('ratioPhrase snaps to friendly fractions and multiples', () => {
    assert.equal(ratioPhrase(1200, 1750), '约 2/3');
    assert.equal(ratioPhrase(150, 190), '约 4/5');
    assert.equal(ratioPhrase(1750, 1750), '大致相当');
    assert.equal(ratioPhrase(5600, 1750), '约 3 倍');
    assert.equal(ratioPhrase(40, 190), '约 1/5');
});

test('layoutScene shares one px/mm between anchor and product and aligns the baseline', () => {
    const anchor = catalog.find(item => item.id === 'adult-male');
    const scene = layoutScene({
        image: { w: 2000, h: 1500 },
        region: { x: 200, y: 100, w: 1600, h: 1200 },
        dimsMm: { heightMm: 1200, widthMm: 1600 },
        anchor,
        canvas: { w: 2048, h: 1536 }
    });
    const ppm = scene.pxPerMm;
    assert.ok(Math.abs(scene.anchorBox.h - anchor.realHeightMm * ppm) <= 1);
    assert.ok(Math.abs(scene.regionBox.h - 1200 * ppm) <= 1);
    assert.equal(Math.round(scene.anchorBox.y + scene.anchorBox.h), Math.round(scene.baselineY));
    assert.equal(Math.round(scene.regionBox.y + scene.regionBox.h), Math.round(scene.baselineY));
    // 整张图按同一缩放放置，范围框左上角对齐
    assert.ok(Math.abs(scene.image.x + 200 * scene.image.scale - scene.regionBox.x) < 0.01);
    // 全部内容在画布内
    for (const box of [scene.anchorBox, scene.regionBox]) {
        assert.ok(box.x >= 0 && box.x + box.w <= 2048);
        assert.ok(box.y >= 0);
    }
    assert.ok(scene.anchorBox.x + scene.anchorBox.w < scene.regionBox.x, 'anchor sits left of the product');
    const height = scene.lines.find(line => line.kind === 'height');
    const width = scene.lines.find(line => line.kind === 'width');
    assert.equal(height.label, '1.2 m / 3.9 ft');
    assert.equal(width.label, '1.6 m / 5.2 ft');
    assert.deepEqual(scene.warnings, []);
});

test('layoutScene warns when the entered proportions disagree with the photo region', () => {
    const scene = layoutScene({
        image: { w: 1000, h: 1000 },
        region: { x: 0, y: 0, w: 1000, h: 500 },
        dimsMm: { heightMm: 150, widthMm: 40 },
        anchor: catalog.find(item => item.id === 'hand'),
        canvas: { w: 2048, h: 1536 }
    });
    assert.ok(scene.warnings.some(warning => warning.code === 'aspect-mismatch'));
});

test('buildSizeReferencePrompt names the anchor, the dimensions and the ratio', () => {
    const anchor = { ...catalog.find(item => item.id === 'adult-male'), description: '一个身高 1.75 m 的成年男性' };
    const text = buildSizeReferencePrompt({ alias: '尺寸参照-帐篷', dimsMm: { heightMm: 1200, widthMm: 1200, depthMm: 1000 }, anchor });
    assert.match(text, /^@\{尺寸参照-帐篷\}为尺寸参照图/);
    assert.match(text, /左侧灰色剪影是一个身高 1\.75 m 的成年男性/);
    assert.match(text, /产品高 1\.2 m、宽 1\.2 m、深 1 m/);
    assert.match(text, /产品高度约为成年男性身高的 2\/3/);
    assert.match(text, /不要放大或缩小产品/);
});

test('buildSizeReferencePrompt compares against measureMm when the asset carries extra canvas', () => {
    const hand = { ...catalog.find(item => item.id === 'hand'), realHeightMm: 210, measureMm: 190, short: "成人", measure: "手长" };
    const text = buildSizeReferencePrompt({ alias: '尺寸参照', dimsMm: { heightMm: 150 }, anchor: hand });
    assert.match(text, /产品高度约为成人手长的 4\/5/);
});

test('buildSizeReferencePrompt explicitly forbids drawing the scale anchor itself', () => {
    const hand = { ...catalog.find(item => item.id === 'hand'), measureMm: 190, short: '成人', measure: '手长', omit: '手', omitPhrase: '这只手' };
    const text = buildSizeReferencePrompt({ alias: '尺寸参照', dimsMm: { heightMm: 120 }, anchor: hand });
    assert.match(text, /参照图里的手只用来表示大小，不要在输出图中生成这只手/);
    // 没有 omit 字段时退回用简称，仍然点名
    const male = { ...catalog.find(item => item.id === 'adult-male'), omit: '', omitPhrase: '' };
    assert.match(buildSizeReferencePrompt({ alias: 'x', dimsMm: { heightMm: 1200 }, anchor: male }), /不要在输出图中生成这个成年男性/);
});

test('every catalog anchor names what must not be drawn', () => {
    const { loadAnchorCatalog } = require('../sizeAnchors');
    for (const anchor of loadAnchorCatalog()) {
        assert.ok(anchor.omit && anchor.omitPhrase, `${anchor.id} needs omit + omitPhrase`);
    }
});

test('buildSizeReferencePrompt pins a same-depth scale cue so the model cannot hide it in the distance', () => {
    const male = { ...catalog.find(item => item.id === 'adult-male'), omit: '人', omitPhrase: '这个人' };
    const text = buildSizeReferencePrompt({ alias: 'x', dimsMm: { heightMm: 5000 }, anchor: male });
    assert.match(text, /至少有一个要与产品放在同一地面、同一深度/);
    assert.match(text, /不要把它们推到远处/);
});
