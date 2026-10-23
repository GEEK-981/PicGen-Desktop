const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { buildDragIcon, badgeText, SINGLE_MAX, STACK_CANVAS } = require('../dragIcon');

async function fixture(dir, name, color, width, height) {
    const file = path.join(dir, name);
    await sharp({ create: { width, height, channels: 3, background: color } }).png().toFile(file);
    return file;
}

async function withFixtures(run) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-drag-icon-'));
    try {
        const files = [
            await fixture(dir, 'red.png', '#d9482b', 800, 600),
            await fixture(dir, 'green.png', '#2f7d3b', 600, 600),
            await fixture(dir, 'blue.png', '#3552c8', 512, 768)
        ];
        await run(files);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

async function pixel(buffer, x, y) {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const offset = (y * info.width + x) * info.channels;
    return [...data.subarray(offset, offset + 4)];
}

test('a single image becomes one rounded card that keeps its aspect ratio, with transparent corners', async () => {
    await withFixtures(async ([red]) => {
        const icon = await buildDragIcon({ sources: [red], count: 1, scale: 1 });
        const meta = await sharp(icon.buffer).metadata();
        assert.equal(meta.format, 'png');
        assert.equal(meta.hasAlpha, true);
        assert.deepEqual([meta.width, meta.height], [icon.width, icon.height]);
        assert.ok(icon.width > icon.height, 'a landscape image gives a landscape card');
        assert.ok(icon.width <= SINGLE_MAX + 40, 'card plus shadow padding stays small');
        assert.equal((await pixel(icon.buffer, 0, 0))[3], 0, 'the corner outside the card is transparent');
        const [r, g, b, a] = await pixel(icon.buffer, Math.floor(icon.width / 2), Math.floor(icon.height / 2));
        assert.equal(a, 255);
        assert.ok(r > 180 && g < 110 && b < 90, `the photo shows in the middle: ${[r, g, b]}`);
    });
});

test('several images become a fanned stack with a count badge, scaled for high-DPI displays', async () => {
    await withFixtures(async files => {
        const icon = await buildDragIcon({ sources: files, count: 12, scale: 1.5 });
        assert.equal(icon.width, Math.round(STACK_CANVAS * 1.5));
        assert.equal(icon.height, icon.width);
        assert.equal((await pixel(icon.buffer, 0, icon.height - 1))[3], 0, 'the stack sits on a transparent canvas');
        // The badge (indigo) is drawn near the top-right of the front card.
        const { data, info } = await sharp(icon.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let badgePixels = 0;
        for (let y = 0; y < info.height / 2; y += 1) {
            for (let x = Math.floor(info.width / 2); x < info.width; x += 1) {
                const o = (y * info.width + x) * 4;
                if (data[o + 3] > 200 && Math.abs(data[o] - 0x4f) < 12 && Math.abs(data[o + 1] - 0x46) < 12 && Math.abs(data[o + 2] - 0xe5) < 12) badgePixels += 1;
            }
        }
        assert.ok(badgePixels > 100, `a count badge is drawn (${badgePixels} badge pixels)`);
    });
});

test('a two-image drag still reads as a stack, and one source can stand in for a larger count', async () => {
    await withFixtures(async ([red, green]) => {
        const two = await buildDragIcon({ sources: [red, green], count: 2, scale: 1 });
        assert.equal(two.width, STACK_CANVAS);
        const many = await buildDragIcon({ sources: [red], count: 40, scale: 1 });
        assert.equal(many.width, STACK_CANVAS, 'a count above the source list still draws a stack');
    });
});

test('badge text caps at 99+ and a missing source is an error for the caller to fall back on', async () => {
    assert.equal(badgeText(7), '7');
    assert.equal(badgeText(99), '99');
    assert.equal(badgeText(100), '99+');
    await assert.rejects(buildDragIcon({ sources: [], count: 2 }), /at least one source/);
    await assert.rejects(buildDragIcon({ sources: [path.join(os.tmpdir(), 'picgen-missing-drag-icon.png')], count: 1 }));
});
