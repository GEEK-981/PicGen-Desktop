// 图片工作台的纯数据逻辑：画框、图片摆放、尺寸对比物体、模型分类与输出模板。
// 坐标一律是"画框像素"（画框长边 2048），显示缩放只在画布组件里处理。

export const FRAME_LONG_SIDE = 2048;
export const RATIOS = ['original', '1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'];
const DEFAULT_RATIO = '4:3';

// 'original' = 跟随图片本身的宽高比、不留边（局部修改用：结果就是那张照片，而不是带白边的画框）
// 画框宽高取 16 的倍数：OpenAI Image2 的自定义尺寸必须是 16 的倍数（局部修改按画框像素出图）
const snap16 = value => Math.max(16, Math.round(value / 16) * 16);

export function frameForRatio(ratio, natural) {
    if (ratio === 'original' && natural?.w > 0 && natural?.h > 0) {
        const k = Math.min(1, FRAME_LONG_SIDE / Math.max(natural.w, natural.h));
        return { ratio: 'original', w: snap16(natural.w * k), h: snap16(natural.h * k) };
    }
    const valid = RATIOS.includes(ratio) && ratio !== 'original' ? ratio : DEFAULT_RATIO;
    const [a, b] = valid.split(':').map(Number);
    const w = a >= b ? FRAME_LONG_SIDE : snap16(FRAME_LONG_SIDE * a / b);
    const h = a >= b ? snap16(FRAME_LONG_SIDE * b / a) : FRAME_LONG_SIDE;
    return { ratio: valid, w, h };
}

// 把图片等比放进画框，四周留 margin（占画框短边的比例）
export function fitIntoFrame(natural, frame, margin = 0.08) {
    const maxW = frame.w * (1 - 2 * margin);
    const maxH = frame.h * (1 - 2 * margin);
    const k = Math.min(maxW / natural.w, maxH / natural.h);
    const w = natural.w * k;
    const h = natural.h * k;
    return { x: (frame.w - w) / 2, y: (frame.h - h) / 2, w, h };
}

let seq = 0;
export const newId = prefix => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export function createWorkspaceDoc({ ratio = DEFAULT_RATIO, image } = {}) {
    const frame = frameForRatio(ratio, image ? { w: image.naturalW, h: image.naturalH } : null);
    const doc = { version: 2, frame, images: [], anchors: [], annotations: [], mask: { strokes: 0 } };
    return image ? addImage(doc, image) : doc;
}

// 画布上什么都没有（图片、对比物体、标注）：「清空」不可用
export const isBlankDoc = doc => !doc.images.length && !doc.anchors.length && !doc.annotations.length;
// 空画布：与导航入口首次打开时一样（4:3 画框、无图、无标注样式）
export const blankWorkspaceDoc = () => createWorkspaceDoc({ ratio: DEFAULT_RATIO });

// 产品在照片里的实际范围（去掉近白背景后的比例框，0..1）；放入对比物体时以它为参照
const FULL = { x: 0, y: 0, w: 1, h: 1 };
export function contentBoxOf(image) {
    const c = image.content || FULL;
    return { x: image.x + image.w * c.x, y: image.y + image.h * c.y, w: image.w * c.w, h: image.h * c.h };
}

export function addImage(doc, image) {
    const box = fitIntoFrame({ w: image.naturalW, h: image.naturalH }, doc.frame, doc.frame.ratio === 'original' && doc.images.length === 0 ? 0 : 0.08);
    const item = {
        id: image.id || newId('img'),
        refId: image.refId || '',
        name: image.name || '图片',
        naturalW: image.naturalW,
        naturalH: image.naturalH,
        ...box,
        rotation: 0,
        content: image.content || FULL
    };
    return { ...doc, images: [...doc.images, item] };
}

// 尺寸对比物体可以任意拖动、缩放，不锁定比例：用户自己摆出想要的大小关系。
// 放入时给一个初始大小（与产品等高，但不超过画框的 45% 高 / 60% 宽），保持物体真实宽高比；
// 默认放在产品左侧、底边对齐，左边放不下就放右边，最后收进画框。给了 cx/cy（拖进画布的松手处）就以它为中心
export function placeAnchor(doc, anchor, { cx, cy } = {}) {
    const aspect = anchor.realWidthMm > 0 && anchor.realHeightMm > 0 ? anchor.realWidthMm / anchor.realHeightMm : 1;
    const ref = doc.images[0] ? contentBoxOf(doc.images[0]) : null;
    let h = Math.min(ref ? ref.h : doc.frame.h * 0.45, doc.frame.h * 0.45);
    let w = h * aspect;
    if (w > doc.frame.w * 0.6) { w = doc.frame.w * 0.6; h = w / aspect; }
    const gap = doc.frame.w * 0.03;
    let x = Number.isFinite(cx) ? cx - w / 2 : (doc.frame.w - w) / 2;
    if (!Number.isFinite(cx) && ref) {
        // 产品左右两侧的空位：放得下就放（左优先）；都放不下就缩进较宽的一侧（最多缩到 35%），再不行才允许重叠
        const left = ref.x - gap;
        const right = doc.frame.w - (ref.x + ref.w) - gap;
        const room = Math.max(left, right);
        if (left < w && right < w && room >= w * 0.35) { h *= room / w; w = room; }
        x = left >= w ? ref.x - gap - w : right >= w ? ref.x + ref.w + gap : x;
    }
    const base = Number.isFinite(cy) ? cy + h / 2 : ref ? ref.y + ref.h : doc.frame.h * 0.9;
    const item = {
        id: newId('anc'),
        anchorId: anchor.id,
        renderable: !!anchor.renderable,
        x: Math.min(Math.max(0, x), Math.max(0, doc.frame.w - w)),
        y: Math.min(Math.max(0, base - h), Math.max(0, doc.frame.h - h)),
        w,
        h,
        rotation: 0
    };
    return { ...doc, anchors: [...doc.anchors, item] };
}

export function updateImage(doc, imageId, patch) {
    return { ...doc, images: doc.images.map(item => (item.id === imageId ? { ...item, ...patch } : item)) };
}

export function updateAnchor(doc, anchorId, patch) {
    return { ...doc, anchors: doc.anchors.map(item => (item.id === anchorId ? { ...item, ...patch } : item)) };
}

export function removeItem(doc, id) {
    return {
        ...doc,
        images: doc.images.filter(item => item.id !== id),
        anchors: doc.anchors.filter(item => item.id !== id),
        annotations: doc.annotations.filter(item => item.id !== id)
    };
}

// 生成模型按种类挑选（不跟随序列的默认模型）。种类决定输出模板：只有 GPT 有独立蒙版参数，
// 其余都把修改区域画进标注图。规则用前缀/分隔符锚定，避免 gpt-image-mini 之类的子串误判
export const MODEL_FAMILIES = [
    { id: 'nanobanana', label: 'Nano Banana' },
    { id: 'gpt', label: 'GPT' },
    { id: 'grok', label: 'Grok' },
    { id: 'seedream', label: 'Seedream' },
    { id: 'other', label: '其他' }
];
const OPENAI_IMAGE = /(^|[\/_-])(gpt-image|dall-e|chatgpt-image)/i;
const NOT_OPENAI = /gemini|banana|seedream|grok|flux|imagen|qwen/i;
export function modelFamily(model) {
    const name = String(model || '').trim();
    if (!name) return 'other';
    if (OPENAI_IMAGE.test(name) && !NOT_OPENAI.test(name)) return 'gpt';
    if (/banana/i.test(name) || /(^|[\/_-])(gemini|imagen)/i.test(name)) return 'nanobanana';
    if (/(^|[\/_-])grok/i.test(name)) return 'grok';
    if (/seedream|(^|[\/_-])doubao/i.test(name)) return 'seedream';
    return 'other';
}
export function groupModelsByFamily(models = []) {
    const groups = Object.fromEntries(MODEL_FAMILIES.map(f => [f.id, []]));
    for (const model of models) if (model) groups[modelFamily(model)].push(model);
    return MODEL_FAMILIES.filter(f => groups[f.id].length).map(f => ({ ...f, models: groups[f.id] }));
}

export function templateForModel(model) {
    return modelFamily(model) === 'gpt' ? 'openai' : 'marked';
}

// 组装要发出的参考图（界面上只显示通俗名称，不出现格式细节）
export function planOutputs({ hasImages, hasAnnotations, hasMask, hasLayout, template }) {
    const references = [];
    const thumbnails = [];
    if (hasLayout) {
        references.push({ role: 'layout' });
        thumbnails.push({ role: 'layout', label: '比例版面', sub: '按摆放的大小关系' });
    }
    if (hasImages) {
        references.push({ role: 'original' });
        thumbnails.push({ role: 'original', label: '原图', sub: '保留细节' });
    }
    const painted = hasMask && template !== 'openai';
    if (hasAnnotations || painted) {
        references.push({ role: 'annotated' });
        thumbnails.push({
            role: 'annotated',
            label: '标注图',
            sub: hasAnnotations && painted ? '含编号和涂抹区域' : hasAnnotations ? '编号标记' : '涂抹区域'
        });
    }
    if (hasMask && template === 'openai') thumbnails.push({ role: 'mask', label: '修改区域', sub: '涂抹部分' });
    return { references, thumbnails, mask: !hasMask ? 'none' : template === 'openai' ? 'separate' : 'painted' };
}

// 换画框比例：所有内容整体平移到新画框中心，大小不变（涂抹画布由界面按同样的偏移重画）
export function frameShift(from, to) {
    return { dx: (to.w - from.w) / 2, dy: (to.h - from.h) / 2 };
}
export function setFrameRatio(doc, ratio) {
    const first = doc.images[0];
    const frame = frameForRatio(ratio, first ? { w: first.naturalW, h: first.naturalH } : null);
    const { dx, dy } = frameShift(doc.frame, frame);
    const shift = item => ({ ...item, x: item.x + dx, y: item.y + dy });
    const shiftAnnotation = item => (Array.isArray(item.points)
        ? { ...item, points: item.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) }
        : shift(item));
    return {
        ...doc,
        frame,
        images: doc.images.map(shift),
        anchors: doc.anchors.map(shift),
        annotations: doc.annotations.map(shiftAnnotation)
    };
}
