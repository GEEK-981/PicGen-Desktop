// 尺寸参照图的纯计算：单位换算、双单位文案、参照物选择、画面排版。
// 参照物和产品共用同一个 px/mm，底边对齐同一条地面线，比例才可信。

const UNIT_TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4 };
const MAX_MM = 50000;

// 8 档阶梯（产品最长边，mm）：<3cm、3–12cm、12–30cm、30–60cm、0.6–1m、1–2.2m、2.2–5m、>5m
const TIER_LIMITS_MM = [30, 120, 300, 600, 1000, 2200, 5000];
const RATIO_LIMIT = 4;

function toMm(value, unit = 'cm') {
    const factor = UNIT_TO_MM[unit];
    if (!factor) throw new Error(`不支持的单位：${unit}`);
    const number = typeof value === 'string' ? Number(value.trim()) : Number(value);
    if (!Number.isFinite(number)) throw new Error('尺寸必须是数字');
    if (number <= 0) throw new Error('尺寸必须大于 0');
    const mm = number * factor;
    if (mm > MAX_MM) throw new Error('尺寸不能超过 50 m');
    return mm;
}

function trimNumber(value, digits) {
    return String(Number(value.toFixed(digits)));
}

function formatLength(mm) {
    let metric;
    if (mm < 10) metric = `${trimNumber(mm, 1)} mm`;
    else if (mm < 1000) metric = `${trimNumber(mm / 10, 1)} cm`;
    else metric = `${trimNumber(mm / 1000, 2)} m`;
    let imperial;
    if (mm < 25.4) imperial = `${trimNumber(mm / 25.4, 2)} in`;
    else if (mm < 1000) imperial = `${trimNumber(mm / 25.4, 1)} in`;
    else imperial = `${trimNumber(mm / 304.8, 1)} ft`;
    return { metric, imperial, text: `${metric} / ${imperial}` };
}

function tierFor(mm) {
    const index = TIER_LIMITS_MM.findIndex(limit => mm < limit);
    return index === -1 ? TIER_LIMITS_MM.length : index;
}

function productLength(dims) {
    return Math.max(dims.heightMm || 0, dims.widthMm || 0, dims.depthMm || 0);
}

function anchorLength(anchor) {
    return Math.max(anchor.realHeightMm || 0, anchor.realWidthMm || 0);
}

function logRatio(dims, anchor) {
    return Math.abs(Math.log(anchorLength(anchor) / Math.max(productLength(dims), 0.1)));
}

function withinRatio(dims, anchor) {
    return logRatio(dims, anchor) <= Math.log(RATIO_LIMIT);
}

// 识别验收明确失败（recognitionPassed === false）的素材永远不选；未验收（null）允许。
function eligible(catalog) {
    return (catalog || []).filter(anchor => anchor && anchor.recognitionPassed !== false);
}

function nearest(dims, anchors) {
    return anchors.reduce((best, anchor) => (!best || logRatio(dims, anchor) < logRatio(dims, best) ? anchor : best), null);
}

function pickAnchor(dims, catalog, { anchorId = '', person = '' } = {}) {
    const pool = eligible(catalog);
    if (!pool.length) return null;
    if (anchorId) {
        const chosen = pool.find(anchor => anchor.id === anchorId);
        if (chosen) return chosen;
    }
    const tier = tierFor(productLength(dims));
    const inTier = pool.filter(anchor => anchor.tier === tier);
    const personMatch = person ? inTier.filter(anchor => anchor.person === person) : [];
    const defaults = personMatch.length ? personMatch : inTier.filter(anchor => anchor.isDefault);
    const tierPick = defaults.find(anchor => withinRatio(dims, anchor));
    if (tierPick) return tierPick;
    const inRange = pool.filter(anchor => withinRatio(dims, anchor));
    const preferred = inRange.filter(anchor => anchor.isDefault);
    return nearest(dims, preferred.length ? preferred : inRange) || nearest(dims, pool);
}

const FRIENDLY_RATIOS = [
    [1, 10], [1, 8], [1, 6], [1, 5], [1, 4], [1, 3], [1, 2], [2, 3], [3, 4], [4, 5],
    [1, 1], [5, 4], [4, 3], [3, 2], [2, 1], [5, 2], [3, 1], [4, 1], [5, 1], [6, 1], [8, 1], [10, 1]
];

// 产品 ÷ 参照物 → "2/3"、"3 倍"、"1.5 倍"；相差 8% 以内算"相当"。
function ratioFraction(productMm, anchorMm) {
    const ratio = productMm / anchorMm;
    if (Math.abs(Math.log(ratio)) <= Math.log(1.08)) return { equal: true, text: '1 倍' };
    if (ratio < 0.1) return { equal: false, text: `1/${Math.round(1 / ratio)}` };
    if (ratio > 10) return { equal: false, text: `${Math.round(ratio)} 倍` };
    const [n, d] = FRIENDLY_RATIOS.reduce((best, candidate) => (
        Math.abs(Math.log(ratio / (candidate[0] / candidate[1]))) < Math.abs(Math.log(ratio / (best[0] / best[1]))) ? candidate : best
    ));
    if (n === d) return { equal: true, text: '1 倍' };
    if (n < d) return { equal: false, text: `${n}/${d}` };
    return { equal: false, text: `${trimNumber(n / d, 2)} 倍` };
}

function ratioPhrase(productMm, anchorMm) {
    const fraction = ratioFraction(productMm, anchorMm);
    return fraction.equal ? '大致相当' : `约 ${fraction.text}`;
}

// image：产品照片像素尺寸；region：照片中产品实际范围（像素，用户可校准）；
// dimsMm.heightMm 对应 region 高度，dimsMm.widthMm 对应 region 宽度。
function layoutScene({ image, region, dimsMm, anchor, canvas = { w: 2048, h: 1536 } }) {
    const cw = canvas.w;
    const ch = canvas.h;
    const baselineY = ch * 0.84;
    const topMargin = ch * 0.1;
    const gap = cw * 0.06;
    const labelRoom = cw * 0.12;
    const edge = cw * 0.04;
    const productHeightMm = dimsMm.heightMm;
    const regionWidthMm = region.w * (productHeightMm / region.h);

    const pxPerMm = Math.min(
        (baselineY - topMargin) / Math.max(anchor.realHeightMm, productHeightMm),
        (cw - 2 * edge - gap - labelRoom) / (anchor.realWidthMm + regionWidthMm)
    );
    const anchorW = anchor.realWidthMm * pxPerMm;
    const anchorH = anchor.realHeightMm * pxPerMm;
    const regionH = productHeightMm * pxPerMm;
    const regionW = regionWidthMm * pxPerMm;
    const groupW = anchorW + gap + regionW + labelRoom;
    const startX = (cw - groupW) / 2;

    const anchorBox = { x: startX, y: baselineY - anchorH, w: anchorW, h: anchorH };
    const regionBox = { x: startX + anchorW + gap, y: baselineY - regionH, w: regionW, h: regionH };
    const scale = regionH / region.h;
    const placedImage = {
        x: regionBox.x - region.x * scale,
        y: regionBox.y - region.y * scale,
        w: image.w * scale,
        h: image.h * scale,
        scale
    };

    const lineOffset = cw * 0.025;
    const lines = [{
        kind: 'height',
        x1: regionBox.x + regionBox.w + lineOffset,
        y1: baselineY,
        x2: regionBox.x + regionBox.w + lineOffset,
        y2: regionBox.y,
        label: formatLength(productHeightMm).text
    }];
    if (dimsMm.widthMm) {
        lines.push({
            kind: 'width',
            x1: regionBox.x,
            y1: baselineY + ch * 0.05,
            x2: regionBox.x + regionBox.w,
            y2: baselineY + ch * 0.05,
            label: formatLength(dimsMm.widthMm).text
        });
    }

    const warnings = [];
    if (dimsMm.widthMm) {
        const entered = dimsMm.widthMm / productHeightMm;
        const photo = region.w / region.h;
        if (Math.abs(Math.log(entered / photo)) > Math.log(1.25)) {
            warnings.push({
                code: 'aspect-mismatch',
                message: `填写的宽高比（${trimNumber(entered, 2)}）和照片里产品范围的宽高比（${trimNumber(photo, 2)}）相差较大，请检查尺寸或校准产品范围框`
            });
        }
    }

    return { canvas: { w: cw, h: ch }, pxPerMm, baselineY, anchorBox, regionBox, image: placedImage, lines, warnings };
}

module.exports = {
    UNIT_TO_MM,
    TIER_LIMITS_MM,
    toMm,
    formatLength,
    tierFor,
    pickAnchor,
    ratioFraction,
    ratioPhrase,
    layoutScene
};
