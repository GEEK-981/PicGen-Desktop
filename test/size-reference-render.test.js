const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
    loadAnchorCatalog, detectProductRegion, renderSizeReference
} = require('../sizeReferenceRender');

// 白底 600×900，中间一块 400×600 的红色"产品"
async function fixtureProduct() {
    const red = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#DC2626' } }).png().toBuffer();
    return sharp({ create: { width: 600, height: 900, channels: 3, background: '#FFFFFF' } })
        .composite([{ input: red, left: 100, top: 150 }])
        .png()
        .toBuffer();
}

async function scan(buffer, predicate) {
    const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1; let count = 0;
    for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
            const i = (y * info.width + x) * 3;
            if (!predicate(data[i], data[i + 1], data[i + 2])) continue;
            count += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    return { count, minX, minY, maxX, maxY, h: maxY - minY + 1, w: maxX - minX + 1, info };
}

const isRed = (r, g, b) => r > 180 && g < 80 && b < 80;
const isDark = (r, g, b) => Math.max(r, g, b) < 60;

test('catalog loads every anchor with a readable SVG whose viewBox matches the real size', () => {
    const catalog = loadAnchorCatalog();
    assert.ok(catalog.length >= 11);
    for (const anchor of catalog) {
        assert.ok(anchor.svg.includes('<svg'), anchor.id);
        const [, , w, h] = anchor.svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
        assert.equal(w, anchor.realWidthMm, `${anchor.id} width`);
        assert.equal(h, anchor.realHeightMm, `${anchor.id} height`);
        assert.ok(Number.isInteger(anchor.tier) && anchor.tier >= 0 && anchor.tier <= 7, anchor.id);
    }
    assert.ok(catalog.some(anchor => anchor.id === 'adult-male' && anchor.isDefault));
});

test('detectProductRegion trims a plain background down to the product', async () => {
    const result = await detectProductRegion(await fixtureProduct());
    assert.deepEqual(result.image, { w: 600, h: 900 });
    assert.ok(Math.abs(result.region.x - 100) <= 2 && Math.abs(result.region.y - 150) <= 2, JSON.stringify(result.region));
    assert.ok(Math.abs(result.region.w - 400) <= 3 && Math.abs(result.region.h - 600) <= 3, JSON.stringify(result.region));
});

test('detectProductRegion falls back to the whole frame for a busy or uniform photo', async () => {
    const flat = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#FFFFFF' } }).png().toBuffer();
    const result = await detectProductRegion(flat);
    assert.deepEqual(result.region, { x: 0, y: 0, w: 320, h: 200 });
});

test('clean variant keeps the true product:anchor ratio and carries no text or lines', async () => {
    const source = await fixtureProduct();
    const region = { x: 100, y: 150, w: 400, h: 600 };
    const result = await renderSizeReference({
        source, region, dimsMm: { heightMm: 1200, widthMm: 800 }, variant: 'clean', alias: '尺寸参照-测试'
    });
    assert.equal(result.anchor.id, 'adult-male');
    assert.equal(result.width, 2048);
    assert.equal(result.height, 1536);
    assert.equal(result.mimeType, 'image/png');

    const product = await scan(result.buffer, isRed);
    const anchor = await scan(result.buffer, (r, g, b) => Math.abs(r - 0x5F) < 14 && Math.abs(g - 0x63) < 14 && Math.abs(b - 0x68) < 14);
    const expected = anchor.h * (1200 / 1750);
    assert.ok(Math.abs(product.h - expected) <= 2, `product ${product.h}px vs expected ${expected.toFixed(1)}px`);
    // 同一地面线
    assert.ok(Math.abs(product.maxY - anchor.maxY) <= 2, `baselines ${product.maxY} / ${anchor.maxY}`);
    assert.ok(anchor.maxX < product.minX, 'anchor sits left of the product');
    assert.equal((await scan(result.buffer, isDark)).count, 0, 'clean output must not contain text');

    assert.match(result.prompt, /^@\{尺寸参照-测试\}为尺寸参照图/);
    assert.match(result.prompt, /成年男性身高的 2\/3/);
});

test('chart variant adds dimension labels; a manual anchor override is honoured', async () => {
    const source = await fixtureProduct();
    const result = await renderSizeReference({
        source, region: { x: 100, y: 150, w: 400, h: 600 }, dimsMm: { heightMm: 150, widthMm: 100 }, variant: 'chart', anchorId: 'soda-can'
    });
    assert.equal(result.anchor.id, 'soda-can');
    assert.ok((await scan(result.buffer, isDark)).count > 200, 'chart output carries text');
    assert.ok(result.scene.lines.some(line => line.kind === 'width'));
});

test('preview variant is a small JPEG', async () => {
    const result = await renderSizeReference({
        source: await fixtureProduct(), region: { x: 100, y: 150, w: 400, h: 600 }, dimsMm: { heightMm: 300 }, variant: 'preview'
    });
    assert.equal(result.mimeType, 'image/jpeg');
    assert.ok(result.width <= 1024);
    const meta = await sharp(result.buffer).metadata();
    assert.equal(meta.format, 'jpeg');
});

test('renderSizeReference rejects a missing height and clamps a region outside the photo', async () => {
    const source = await fixtureProduct();
    await assert.rejects(renderSizeReference({ source, region: { x: 0, y: 0, w: 10, h: 10 }, dimsMm: {}, variant: 'clean' }), /高度/);
    const result = await renderSizeReference({
        source, region: { x: -50, y: 800, w: 2000, h: 900 }, dimsMm: { heightMm: 100 }, variant: 'clean'
    });
    assert.equal(result.width, 2048);
});

test('every anchor asset stands on the ground line (viewBox bottom) so baselines really align', async () => {
    for (const anchor of loadAnchorCatalog()) {
        const k = 1200 / Math.max(anchor.realWidthMm, anchor.realHeightMm);
        const w = Math.round(anchor.realWidthMm * k);
        const h = Math.round(anchor.realHeightMm * k);
        const svg = anchor.svg.replace(/<svg /, `<svg width="${w}" height="${h}" `);
        const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let bottom = -1;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 128) bottom = Math.floor(i / 4 / info.width);
        assert.ok(info.height - 1 - bottom <= Math.max(2, info.height * 0.004), `${anchor.id} floats ${info.height - 1 - bottom}px above the ground`);
    }
});

// 手机照片多带 EXIF 方向：检测和渲染都必须在"摆正后"的坐标里工作。
async function rotatedFixture(orientation) {
    // 存储为 200×100（未摆正），产品色块在存储坐标 (20,10) 起 60×40
    const block = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#DC2626' } }).png().toBuffer();
    return sharp({ create: { width: 200, height: 100, channels: 3, background: '#FFFFFF' } })
        .composite([{ input: block, left: 20, top: 10 }])
        .jpeg({ quality: 95 })
        .withMetadata({ orientation })
        .toBuffer();
}

async function uprightRedBox(source) {
    const { data, info } = await sharp(source).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
    for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
            const i = (y * info.width + x) * 3;
            if (isRed(data[i], data[i + 1], data[i + 2])) {
                minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
        }
    }
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, image: { w: info.width, h: info.height } };
}

for (const orientation of [3, 6, 8]) {
    test(`detectProductRegion works in upright coordinates for EXIF orientation ${orientation}`, async () => {
        const source = await rotatedFixture(orientation);
        const expected = await uprightRedBox(source);
        const result = await detectProductRegion(source);
        assert.deepEqual(result.image, expected.image);
        for (const key of ['x', 'y', 'w', 'h']) {
            assert.ok(Math.abs(result.region[key] - expected[key]) <= 3, `${key}: ${JSON.stringify(result.region)} vs ${JSON.stringify(expected)}`);
        }
    });
}

test('render crops the upright product for a rotated photo', async () => {
    const source = await rotatedFixture(6);
    const expected = await uprightRedBox(source);
    const result = await renderSizeReference({
        source, region: expected, dimsMm: { heightMm: 150 }, variant: 'clean'
    });
    const product = await scan(result.buffer, isRed);
    // 裁到的就是红色产品本身：画面里红块高度 ≈ 产品框高度
    assert.ok(Math.abs(product.h - Math.round(result.scene.regionBox.h)) <= 3, `${product.h} vs ${result.scene.regionBox.h}`);
});

test('render rejects prototype-named variants and survives a garbage region', async () => {
    const source = await fixtureProduct();
    await assert.rejects(renderSizeReference({ source, region: {}, dimsMm: { heightMm: 100 }, variant: '__proto__' }), /未知/);
    const result = await renderSizeReference({ source, region: { x: 'a', y: null, w: NaN, h: undefined }, dimsMm: { heightMm: 100 }, variant: 'clean' });
    assert.equal(result.region.w, 600);
});
