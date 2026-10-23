// 尺寸参照图 → 给生图模型的提示词片段。AI 版参照图不带文字，
// 所以参照物是什么、多大、比例多少都要在这里写清楚。
const { formatLength, ratioFraction } = require('./sizeReferenceLayout');

function safeText(value) {
    return String(value || '').replace(/[{}]/g, char => (char === '{' ? '｛' : '｝')).trim();
}

// 实测（2026-09-25）：模型会把能暴露尺寸的物体放到远景，让任何大小都"说得通"。
// 强制至少一个常见物体与产品同地面、同深度，比例才有对照。
const SAME_DEPTH = '画面中的其他常见物体（如家具、长椅、汽车、门、文具）至少有一个要与产品放在同一地面、同一深度，并按真实比例表现大小，不要把它们推到远处。';

function buildSizeReferencePrompt({ alias, dimsMm, anchor }) {
    const dims = [
        dimsMm.heightMm ? `高 ${formatLength(dimsMm.heightMm).metric}` : '',
        dimsMm.widthMm ? `宽 ${formatLength(dimsMm.widthMm).metric}` : '',
        dimsMm.depthMm ? `深 ${formatLength(dimsMm.depthMm).metric}` : ''
    ].filter(Boolean).join('、');
    const measure = anchor.measure || (anchor.person ? '身高' : '高度');
    // measureMm 是参照物上被比较的那段尺寸（手长不含腕部、轿车只算车高），没有就用素材总高。
    const fraction = ratioFraction(dimsMm.heightMm, anchor.measureMm || anchor.realHeightMm);
    const ratio = fraction.equal
        ? `产品高度与${anchor.short}${measure}大致相当`
        : `产品高度约为${anchor.short}${measure}的 ${fraction.text}`;
    const description = anchor.description || anchor.short;
    // 点名参照物本身：只说"灰色剪影"时模型不一定明白那只手/那个人不能画进结果
    const omit = anchor.omit || anchor.short;
    const omitPhrase = anchor.omitPhrase || `这个${anchor.short}`;
    return `@{${safeText(alias) || '尺寸参照'}}为尺寸参照图：左侧灰色剪影是${description}，右侧是产品实拍图，两者按真实比例并排、底部对齐同一地面。产品${dims}，${ratio}。生成时严格保持这个比例，不要放大或缩小产品。参照图里的${omit}只用来表示大小，不要在输出图中生成${omitPhrase}，也不要出现灰色剪影或灰色背景。${SAME_DEPTH}`;
}

module.exports = { buildSizeReferencePrompt };
