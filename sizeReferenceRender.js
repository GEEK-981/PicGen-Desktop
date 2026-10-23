'use strict';

// 尺寸参照图的栅格化：参照物剪影 + 产品原图（不抠图）+ 尺寸线，全部交给 sharp。
// 排版几何来自 sizeReferenceLayout.layoutScene；这里只负责把几何画出来。
// 在 size-reference-worker.js 里运行，主进程不做任何像素工作。

const sharp = require('sharp');
const { pickAnchor, layoutScene } = require('./sizeReferenceLayout');
const { buildSizeReferencePrompt } = require('./sizeReferencePrompt');
const { loadAnchorCatalog, listAnchors, publicAnchor } = require('./sizeAnchors');

const FONT = 'Microsoft YaHei, Segoe UI, Arial, sans-serif';

const VARIANTS = {
    // 电商尺寸图：浅底、浅灰剪影、尺寸线和双单位标注
    chart: { canvas: { w: 2048, h: 1536 }, background: '#F5F5F4', anchor: '#9AA0A6', labels: true, multiply: true, format: 'png' },
    // AI 参照图：中灰底、深灰剪影，不带任何文字或线，避免模型把标注画进结果
    clean: { canvas: { w: 2048, h: 1536 }, background: '#C4C4C4', anchor: '#5F6368', labels: false, format: 'png' },
    // 对话框实时预览：chart 的缩小版
    preview: { canvas: { w: 1024, h: 768 }, background: '#F5F5F4', anchor: '#9AA0A6', labels: true, multiply: true, format: 'jpeg' }
};

function escapeXml(value) {
    return String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
}

function orientedSize(meta) {
    // EXIF 方向 5–8 表示旋转 90°，rotate() 之后宽高互换
    return (meta.orientation || 1) >= 5 ? { w: meta.height, h: meta.width } : { w: meta.width, h: meta.height };
}

async function detectProductRegion(source) {
    const image = orientedSize(await sharp(source, { failOn: 'none' }).metadata());
    const whole = { image, region: { x: 0, y: 0, w: image.w, h: image.h } };
    try {
        // 先摆正成原始像素再 trim：同一管线里 rotate() + trim() 时，trimOffset 仍是未摆正的坐标
        const upright = await sharp(source, { failOn: 'none' })
            .rotate()
            .flatten({ background: '#FFFFFF' })
            .raw()
            .toBuffer({ resolveWithObject: true });
        const { info } = await sharp(upright.data, { raw: upright.info })
            .trim({ threshold: 24 })
            .toBuffer({ resolveWithObject: true });
        const x = -(info.trimOffsetLeft || 0);
        const y = -(info.trimOffsetTop || 0);
        // 裁掉的面积太少说明背景不是纯色，交给用户手动框
        if (info.width * info.height > image.w * image.h * 0.97) return whole;
        return { image, region: { x, y, w: info.width, h: info.height } };
    } catch {
        // 纯色图 sharp 会报错；整张图就是范围
        return whole;
    }
}

function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clampRegion(region, image) {
    const x = Math.min(Math.max(0, Math.round(finiteOr(region.x, 0))), image.w - 1);
    const y = Math.min(Math.max(0, Math.round(finiteOr(region.y, 0))), image.h - 1);
    const w = Math.max(1, Math.min(Math.round(finiteOr(region.w, 0) || image.w), image.w - x));
    const h = Math.max(1, Math.min(Math.round(finiteOr(region.h, 0) || image.h), image.h - y));
    return { x, y, w, h };
}

function anchorMarkup(anchor, box, style) {
    const inner = anchor.svg
        .replace(/^[\s\S]*?<svg[^>]*>/, '')
        .replace(/<\/svg>\s*$/, '')
        .replace(/#000000/gi, style.anchor)
        .replace(/#FFFFFF/gi, style.background);
    return `<svg x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" viewBox="0 0 ${anchor.realWidthMm} ${anchor.realHeightMm}" preserveAspectRatio="none">${inner}</svg>`;
}

function labelMarkup(scene, anchor, unit) {
    const stroke = scene.canvas.w / 680;
    const tick = unit * 0.9;
    const parts = [];
    const left = Math.min(scene.anchorBox.x, scene.regionBox.x) - unit * 2;
    const right = scene.regionBox.x + scene.regionBox.w + unit * 2;
    parts.push(`<line x1="${left}" y1="${scene.baselineY}" x2="${right}" y2="${scene.baselineY}" stroke="#D1D5DB" stroke-width="${stroke}"/>`);
    for (const line of scene.lines) {
        const vertical = line.kind === 'height';
        const [metric, imperial] = line.label.split(' / ');
        const tickPath = vertical
            ? `M${line.x1 - tick} ${line.y1}H${line.x1 + tick}M${line.x2 - tick} ${line.y2}H${line.x2 + tick}`
            : `M${line.x1} ${line.y1 - tick}V${line.y1 + tick}M${line.x2} ${line.y2 - tick}V${line.y2 + tick}`;
        parts.push(`<line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}" stroke="#6B7280" stroke-width="${stroke}"/>`);
        parts.push(`<path d="${tickPath}" stroke="#6B7280" stroke-width="${stroke}" fill="none"/>`);
        if (vertical) {
            const tx = line.x1 + unit * 0.8;
            const ty = (line.y1 + line.y2) / 2;
            parts.push(`<text x="${tx}" y="${ty}" font-family="${FONT}" font-size="${unit * 1.5}" font-weight="700" fill="#1F2937">${escapeXml(metric)}</text>`);
            parts.push(`<text x="${tx}" y="${ty + unit * 1.5}" font-family="${FONT}" font-size="${unit * 1.1}" fill="#6B7280">${escapeXml(imperial)}</text>`);
        } else {
            const tx = (line.x1 + line.x2) / 2;
            const ty = line.y1 + unit * 2;
            parts.push(`<text x="${tx}" y="${ty}" text-anchor="middle" font-family="${FONT}" font-size="${unit * 1.5}" font-weight="700" fill="#1F2937">${escapeXml(metric)} <tspan font-size="${unit * 1.1}" font-weight="400" fill="#6B7280">/ ${escapeXml(imperial)}</tspan></text>`);
        }
    }
    const captionX = scene.anchorBox.x + scene.anchorBox.w / 2;
    parts.push(`<text x="${captionX}" y="${scene.baselineY + unit * 1.8}" text-anchor="middle" font-family="${FONT}" font-size="${unit * 1.05}" fill="#6B7280">${escapeXml(anchor.label || anchor.short || '')}</text>`);
    return parts.join('');
}

async function renderSizeReference({
    source, region, dimsMm = {}, anchorId = '', person = '', variant = 'chart', alias = ''
}) {
    const style = Object.hasOwn(VARIANTS, variant) ? VARIANTS[variant] : null;
    if (!style) throw new Error(`未知的尺寸参照图类型：${variant}`);
    if (!(Number(dimsMm.heightMm) > 0)) throw new Error('请填写产品高度');
    if (!source) throw new Error('缺少产品图片');

    const anchor = pickAnchor(dimsMm, loadAnchorCatalog(), { anchorId, person });
    if (!anchor) throw new Error('没有可用的参照物素材');

    // 只读头部拿摆正后的尺寸；裁剪时 rotate() 在 extract 之前生效，不用先整张编码一遍
    const image = orientedSize(await sharp(source, { failOn: 'none' }).metadata());
    const box = clampRegion(region || {}, image);
    const scene = layoutScene({ image, region: box, dimsMm, anchor, canvas: style.canvas });
    const { w: cw, h: ch } = scene.canvas;
    const unit = cw / 80;

    const productW = Math.max(1, Math.round(scene.regionBox.w));
    const productH = Math.max(1, Math.round(scene.regionBox.h));
    const product = await sharp(source, { failOn: 'none' })
        .rotate()
        .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
        .resize({ width: productW, height: productH, fit: 'fill', kernel: 'lanczos3' })
        .toBuffer();

    const base = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}"><rect width="${cw}" height="${ch}" fill="${style.background}"/>${anchorMarkup(anchor, scene.anchorBox, style)}</svg>`;
    const layers = [{
        input: product,
        left: Math.round(scene.regionBox.x),
        // 底边钉在地面线上，取整误差不让产品悬空或下沉
        top: Math.round(scene.baselineY) - productH,
        // 浅底版用正片叠底：白底产品照不再留一块白框，产品本身只暗约 4%。
        // AI 版保持原色，不改产品的颜色。
        ...(style.multiply ? { blend: 'multiply' } : {})
    }];
    if (style.labels) {
        layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}">${labelMarkup(scene, anchor, unit)}</svg>`), left: 0, top: 0 });
    }

    let pipeline = sharp(Buffer.from(base)).composite(layers);
    pipeline = style.format === 'jpeg'
        ? pipeline.jpeg({ quality: 82 })
        : pipeline.png({ compressionLevel: 6, effort: 1 });
    const buffer = await pipeline.toBuffer();

    return {
        buffer,
        mimeType: style.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        width: cw,
        height: ch,
        anchor: publicAnchor(anchor),
        region: box,
        scene,
        warnings: scene.warnings,
        prompt: buildSizeReferencePrompt({ alias, dimsMm, anchor })
    };
}

module.exports = {
    VARIANTS,
    loadAnchorCatalog,
    listAnchors,
    detectProductRegion,
    renderSizeReference
};
