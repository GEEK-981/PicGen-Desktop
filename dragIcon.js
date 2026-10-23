// Drag image for native image drags (webContents.startDrag icon). One image → a rounded thumbnail card
// with a soft shadow; several → a fanned stack of up to three cards plus a count badge. Runs inside
// preview-decoder-worker.js (sharp), never on the main thread. Sizes are in DIP and scaled by `scale`
// so the OS drag image stays crisp on high-DPI displays.
const sharp = require('sharp');

const SINGLE_MAX = 96;      // longest side of a single card (DIP)
const STACK_CARD = 76;      // square stacked cards (DIP)
const STACK_CANVAS = 128;   // stack canvas side (DIP)
const MAX_CARDS = 3;
const BORDER = 2;
const RADIUS = 9;
const SHADOW_BLUR = 5;
const BADGE_COLOR = '#4f46e5';

function roundedRectSvg(width, height, radius, fill) {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${fill}"/></svg>`);
}

function badgeText(count) {
    return count > 99 ? '99+' : String(count);
}

// A white-bordered, rounded card of one image (cover-cropped to a square when `square`).
async function card(source, { width, height, square, scale }) {
    const border = Math.round(BORDER * scale);
    const radius = Math.round(RADIUS * scale);
    const resized = sharp(source, { failOn: 'none', limitInputPixels: 268402689 })
        .rotate()
        .resize(square
            ? { width: width - border * 2, height: height - border * 2, fit: 'cover' }
            : { width: width - border * 2, height: height - border * 2, fit: 'inside' })
        .flatten({ background: '#ffffff' });
    const { data: photo, info } = await resized.png().toBuffer({ resolveWithObject: true });
    const cardWidth = info.width + border * 2;
    const cardHeight = info.height + border * 2;
    const innerRadius = Math.max(0, radius - border);
    const rounded = await sharp(photo)
        .composite([{ input: roundedRectSvg(info.width, info.height, innerRadius, '#000'), blend: 'dest-in' }])
        .png().toBuffer();
    const buffer = await sharp(roundedRectSvg(cardWidth, cardHeight, radius, '#ffffff'))
        .composite([{ input: rounded, left: border, top: border }])
        .png().toBuffer();
    return { buffer, width: cardWidth, height: cardHeight };
}

// A card on a transparent padded canvas with a blurred drop shadow, optionally rotated.
async function shadowed(cardImage, { scale, angle = 0 }) {
    const pad = Math.round(SHADOW_BLUR * 2.5 * scale);
    const width = cardImage.width + pad * 2;
    const height = cardImage.height + pad * 2;
    const shadow = await sharp(roundedRectSvg(cardImage.width, cardImage.height, Math.round(RADIUS * scale), 'rgba(15,23,42,0.34)'))
        .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .blur(Math.max(0.3, SHADOW_BLUR * scale / 2))
        .png().toBuffer();
    let composed = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([
            { input: shadow, left: 0, top: Math.round(3 * scale) },
            { input: cardImage.buffer, left: pad, top: pad }
        ])
        .png().toBuffer();
    if (angle) composed = await sharp(composed).rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const meta = await sharp(composed).metadata();
    return { buffer: composed, width: meta.width, height: meta.height };
}

function badgeSvg(count, scale) {
    const text = badgeText(count);
    const height = Math.round(22 * scale);
    const width = Math.max(height, Math.round((10 + text.length * 8) * scale));
    const stroke = Math.round(2 * scale);
    const fontSize = Math.round(12 * scale);
    return {
        width,
        height,
        input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
            + `<rect x="${stroke / 2}" y="${stroke / 2}" width="${width - stroke}" height="${height - stroke}" rx="${(height - stroke) / 2}" fill="${BADGE_COLOR}" stroke="#ffffff" stroke-width="${stroke}"/>`
            + `<text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff">${text}</text>`
            + '</svg>')
    };
}

function centeredOn(canvas, image, dx = 0, dy = 0) {
    return {
        left: Math.round((canvas - image.width) / 2 + dx),
        top: Math.round((canvas - image.height) / 2 + dy)
    };
}

// sources: image paths (thumbnails preferred), front card first. count: how many files are dragged.
// → {buffer: PNG, width, height} in physical pixels (DIP × scale).
async function buildDragIcon({ sources, count, scale = 1 } = {}) {
    const list = (Array.isArray(sources) ? sources : []).filter(Boolean);
    if (!list.length) throw new Error('drag icon needs at least one source');
    const factor = Math.min(3, Math.max(1, Number(scale) || 1));
    const total = Math.max(list.length, Number(count) || 0);
    if (total <= 1) {
        const side = Math.round(SINGLE_MAX * factor);
        const front = await shadowed(await card(list[0], { width: side, height: side, square: false, scale: factor }), { scale: factor });
        return front;
    }
    const canvas = Math.round(STACK_CANVAS * factor);
    const side = Math.round(STACK_CARD * factor);
    const cards = list.slice(0, MAX_CARDS);
    // Back to front: a missing extra source reuses the front image so the stack always reads as a pile.
    const layers = [];
    const fan = [{ angle: -9, dx: -6, dy: 4 }, { angle: 7, dx: 6, dy: 2 }];
    const backCount = Math.min(2, total - 1);
    for (let index = backCount; index >= 1; index -= 1) {
        const source = cards[index] || cards[0];
        const { angle, dx, dy } = fan[index - 1];
        const image = await shadowed(await card(source, { width: side, height: side, square: true, scale: factor }), { scale: factor, angle });
        layers.push({ input: image.buffer, ...centeredOn(canvas, image, dx * factor, dy * factor) });
    }
    const front = await shadowed(await card(cards[0], { width: side, height: side, square: true, scale: factor }), { scale: factor });
    const frontPosition = centeredOn(canvas, front, -4 * factor, 6 * factor);
    layers.push({ input: front.buffer, ...frontPosition });
    const badge = badgeSvg(total, factor);
    // Top-right corner of the front card (its visible card sits inside the shadow padding).
    const pad = Math.round(SHADOW_BLUR * 2.5 * factor);
    const cardRight = frontPosition.left + front.width - pad;
    const cardTop = frontPosition.top + pad;
    layers.push({
        input: badge.input,
        left: Math.max(0, Math.min(canvas - badge.width, Math.round(cardRight - badge.width / 2 - 2 * factor))),
        top: Math.max(0, Math.round(cardTop - badge.height / 2))
    });
    const buffer = await sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite(layers)
        .png().toBuffer();
    return { buffer, width: canvas, height: canvas };
}

module.exports = { buildDragIcon, badgeText, SINGLE_MAX, STACK_CANVAS, MAX_CARDS };
