// 标注文档 → 中文提示词片段。片段里用 @{别名} 引用参考图，
// 交给 rendererUtils.resolvePromptMentions 在提交时解析成「参考图N」，
// 这样删除或调整参考图顺序后引用不会错位。
import { circledNumber, colorName, pointLabel, positionLabel } from './annotationModel.mjs';

const SHAPE_WORDS = {
    rect: '框',
    ellipse: '圈',
    arrow: '箭头',
    pen: '涂画',
    pin: '标记点',
    text: '文字'
};

// 用户输入里的 @{...} 会被当成参考图引用，换成全角括号避免误解析。
function safeText(value) {
    return String(value || '').replace(/[{}]/g, char => (char === '{' ? '｛' : '｝')).replace(/\s+/g, ' ').trim();
}

function describeShape(item, size) {
    const word = SHAPE_WORDS[item.type] || '标记';
    if (item.type === 'arrow' && item.points?.length >= 4) {
        const [x1, y1] = item.points;
        const x2 = item.points[item.points.length - 2];
        const y2 = item.points[item.points.length - 1];
        const from = pointLabel(x1, y1, size);
        const to = pointLabel(x2, y2, size);
        return from === to ? `${word}（${from}）` : `${word}（从${from}指向${to}）`;
    }
    return `${word}（${positionLabel(item, size)}）`;
}

function describeContent(item) {
    const parts = [];
    if (item.type === 'text' && safeText(item.text)) parts.push(`图中标注文字「${safeText(item.text)}」`);
    if (safeText(item.instruction)) parts.push(safeText(item.instruction));
    return parts.join('，');
}

export function buildAnnotationPrompt(doc, { annotatedAlias, sourceAlias } = {}) {
    const size = doc?.sourceSize || { w: 1, h: 1 };
    const items = Array.isArray(doc?.items) ? doc.items : [];
    const pinned = items
        .filter(item => item.pin != null && describeContent(item))
        .sort((a, b) => a.pin - b.pin);
    const others = items.filter(item => item.pin == null && describeContent(item));
    if (!pinned.length && !others.length) return '';

    const lines = pinned.map((item, index) => `${circledNumber(index + 1)}${describeShape(item, size)}：${describeContent(item)}`);
    if (others.length) {
        lines.push(`其他标记：${others.map(item => `${describeShape(item, size)}：${describeContent(item)}`).join('；')}`);
    }

    const color = colorName(doc?.style?.color);
    const annotated = `@{${safeText(annotatedAlias) || '标注图'}}`;
    const noMarks = '输出图中不得出现任何标注、编号、框线或箭头。';
    if (sourceAlias) {
        const source = `@{${safeText(sourceAlias)}}`;
        return `${annotated}为${source}的标注副本（标注颜色为${color}）。请按编号修改${source}：${lines.join('；')}。仅执行以上修改，其余内容与${source}保持一致；${noMarks}`;
    }
    return `按${annotated}上的标注修改这张图（标注颜色为${color}）：${lines.join('；')}。仅执行以上修改，其余内容保持不变；${noMarks}`;
}

