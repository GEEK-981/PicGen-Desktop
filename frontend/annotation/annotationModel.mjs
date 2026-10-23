// 参考图标注文档：纯数据逻辑（结构校验、编号、线宽、避色、位置描述）。
// 坐标一律用原图像素，编辑器显示多大都不影响导出和提示词。

export const ANNOTATION_VERSION = 1;
export const ANNOTATION_TYPES = ['rect', 'ellipse', 'arrow', 'pen', 'pin', 'text'];

// 默认洋红；图里同色相太多时按顺序换下一个，保证标注和画面区分得开。
export const ANNOTATION_COLORS = [
    { hex: '#FF00FF', hue: 300, name: '洋红' },
    { hex: '#00FFFF', hue: 180, name: '青色' },
    { hex: '#FFFF00', hue: 60, name: '黄色' },
    { hex: '#00FF00', hue: 120, name: '绿色' }
];

const HUE_TOLERANCE = 25;
const CLASH_SHARE = 0.08;
const LARGE_REGION_SHARE = 0.4;

export function adaptiveStroke(width, height) {
    const shortSide = Math.min(Number(width) || 0, Number(height) || 0);
    // 小图上 0.4% 只有 2px，编号徽标（半径 ≈ 4.2 × 线宽）小到模型认不出，所以下限给 4px
    return Math.max(4, Math.round(shortSide * 0.005));
}

function hueOf(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (max === 0 || delta / max < 0.35 || max < 90) return null; // 灰、暗、低饱和不参与撞色判断
    let hue;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    return hue < 0 ? hue + 360 : hue;
}

function hueDistance(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

// pixels: 缩略图的 RGB/RGBA 字节（建议 64×64），channels = 3 或 4。
export function pickAnnotationColor(pixels, channels = 4) {
    const total = Math.floor((pixels?.length || 0) / channels);
    if (!total) return ANNOTATION_COLORS[0].hex;
    const clashes = ANNOTATION_COLORS.map(() => 0);
    for (let i = 0; i < total; i++) {
        const offset = i * channels;
        const hue = hueOf(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
        if (hue === null) continue;
        ANNOTATION_COLORS.forEach((color, index) => {
            if (hueDistance(hue, color.hue) <= HUE_TOLERANCE) clashes[index] += 1;
        });
    }
    const clear = ANNOTATION_COLORS.findIndex((_, index) => clashes[index] / total <= CLASH_SHARE);
    if (clear >= 0) return ANNOTATION_COLORS[clear].hex;
    let best = 0;
    clashes.forEach((count, index) => { if (count < clashes[best]) best = index; });
    return ANNOTATION_COLORS[best].hex;
}

export function colorName(hex) {
    const upper = String(hex || '').toUpperCase();
    return ANNOTATION_COLORS.find(color => color.hex === upper)?.name || '彩色';
}

export function circledNumber(n) {
    const value = Math.max(1, Math.floor(Number(n) || 1));
    return value <= 20 ? String.fromCharCode(0x2460 + value - 1) : `(${value})`;
}

export function renumberPins(items = []) {
    let next = 1;
    return items.map(item => (item.pin == null ? { ...item } : { ...item, pin: next++ }));
}

export function nextPinNumber(items = []) {
    return items.reduce((max, item) => (item.pin == null ? max : Math.max(max, item.pin)), 0) + 1;
}

export function itemBounds(item) {
    if (Array.isArray(item.points) && item.points.length >= 2) {
        const xs = item.points.filter((_, index) => index % 2 === 0);
        const ys = item.points.filter((_, index) => index % 2 === 1);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    return { x: item.x || 0, y: item.y || 0, w: item.w || 0, h: item.h || 0 };
}

const GRID_LABELS = [
    ['左上', '上方', '右上'],
    ['左侧', '中间', '右侧'],
    ['左下', '下方', '右下']
];

export function pointLabel(x, y, size) {
    const col = Math.min(2, Math.max(0, Math.floor((x / Math.max(1, size.w)) * 3)));
    const row = Math.min(2, Math.max(0, Math.floor((y / Math.max(1, size.h)) * 3)));
    return GRID_LABELS[row][col];
}

export function positionLabel(item, size) {
    const b = itemBounds(item);
    return pointLabel(b.x + b.w / 2, b.y + b.h / 2, size);
}

export function isLargeRegion(item, size) {
    if (!['rect', 'ellipse'].includes(item.type)) return false;
    const area = Math.max(1, size.w * size.h);
    return (Math.abs(item.w || 0) * Math.abs(item.h || 0)) / area > LARGE_REGION_SHARE;
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeItem(raw, size) {
    if (!raw || !ANNOTATION_TYPES.includes(raw.type)) return null;
    const item = {
        id: String(raw.id || `a_${Math.random().toString(36).slice(2, 9)}`),
        type: raw.type
    };
    if (raw.type === 'arrow' || raw.type === 'pen') {
        const points = Array.isArray(raw.points) ? raw.points.map(Number) : [];
        if (points.length < 4 || points.length % 2 !== 0 || points.some(value => !Number.isFinite(value))) return null;
        item.points = points;
    } else {
        item.x = Math.min(size.w, Math.max(0, finite(raw.x)));
        item.y = Math.min(size.h, Math.max(0, finite(raw.y)));
        if (raw.type !== 'pin') {
            item.w = Math.max(0, finite(raw.w));
            item.h = Math.max(0, finite(raw.h));
        }
    }
    if (raw.type === 'text') item.text = String(raw.text || '').slice(0, 200);
    if (raw.pin != null && Number.isFinite(Number(raw.pin))) item.pin = Math.max(1, Math.floor(Number(raw.pin)));
    item.instruction = String(raw.instruction || '').trim().slice(0, 400);
    return item;
}

export function createDoc({ sourceRefId = '', sourceSize, color } = {}) {
    const size = { w: Math.max(1, finite(sourceSize?.w, 1)), h: Math.max(1, finite(sourceSize?.h, 1)) };
    return {
        version: ANNOTATION_VERSION,
        sourceRefId: String(sourceRefId || ''),
        sourceSize: size,
        style: { color: color || ANNOTATION_COLORS[0].hex, stroke: adaptiveStroke(size.w, size.h) },
        items: []
    };
}

export function normalizeDoc(raw = {}) {
    const doc = createDoc({ sourceRefId: raw.sourceRefId, sourceSize: raw.sourceSize, color: raw.style?.color });
    if (raw.style?.stroke != null) doc.style.stroke = Math.max(1, Math.min(64, Math.round(finite(raw.style.stroke, doc.style.stroke))));
    doc.items = (Array.isArray(raw.items) ? raw.items : [])
        .map(item => normalizeItem(item, doc.sourceSize))
        .filter(Boolean)
        .slice(0, 200);
    return doc;
}

// 编辑器用：整体平移一个标注（选择工具拖动后落盘）。
export function translateItem(item, dx, dy) {
    if (Array.isArray(item.points)) {
        return { ...item, points: item.points.map((value, index) => value + (index % 2 === 0 ? dx : dy)) };
    }
    return { ...item, x: (item.x || 0) + dx, y: (item.y || 0) + dy };
}

// 编号徽标放在哪：框/圈贴左上角，箭头和涂画放起点，标记点就是它自己的位置。
export function badgeAnchor(item) {
    if (Array.isArray(item.points) && item.points.length >= 2) return { x: item.points[0], y: item.points[1] };
    return { x: item.x || 0, y: item.y || 0 };
}

// 画框时从任意方向拖出来的矩形 → 左上角 + 正宽高。
export function normalizeRect(x1, y1, x2, y2) {
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

// 除文字外，所有形状都自动带编号：图上只留编号，具体要求写在列表里。
export function addItem(items, item) {
    const next = item.type === 'text' ? { ...item } : { ...item, pin: nextPinNumber(items) };
    return [...items, next];
}

export function removeItem(items, id) {
    return renumberPins(items.filter(item => item.id !== id));
}

export function annotationWarnings(doc) {
    const warnings = [];
    const pins = doc.items.filter(item => item.pin != null).length;
    if (pins > 6) warnings.push(`已有 ${pins} 处编号，超过 6 处时模型容易漏改，建议分两次改`);
    if (doc.items.some(item => isLargeRegion(item, doc.sourceSize))) warnings.push('有框超过画面 40%，改动可能扩散到框外，建议框小一点');
    const empty = doc.items.filter(item => item.pin != null && !String(item.instruction || '').trim()).length;
    if (empty) warnings.push(`${empty} 处编号还没写修改要求，这些编号不会写进提示词`);
    return warnings;
}
