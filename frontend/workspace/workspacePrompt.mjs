// 工作台"发送到生成"的提示词：版面（比例）+ 标注编号 + 修改区域，按模型模板措辞。
// 只描述"要怎么改"，不出现蒙版、透明度之类的技术词。
import { buildAnnotationPrompt } from '../annotation/annotationPrompt.mjs';
import { pointLabel } from '../annotation/annotationModel.mjs';

function safe(value) {
    return String(value || '').replace(/[{}]/g, char => (char === '{' ? '｛' : '｝')).trim();
}
const ref = alias => `@{${safe(alias)}}`;

function unique(list) {
    return [...new Set(list)];
}

function layoutPart({ doc, anchorMeta, aliases, scene }) {
    const where = safe(scene).replace(/[。；;.]+$/, '') || '真实场景';
    const renderable = unique(doc.anchors.filter(a => a.renderable).map(a => anchorMeta[a.anchorId]?.short).filter(Boolean));
    const scaleOnly = unique(doc.anchors.filter(a => !a.renderable).map(a => anchorMeta[a.anchorId]).filter(Boolean)
        .map(meta => meta.omitPhrase || `这个${meta.short}`));
    const parts = [`以${ref(aliases.layout)}为底图编辑：保持其中产品和各物体的位置和大小完全不变，把灰色背景换成${where}`];
    if (renderable.length) parts.push(`把灰色的${renderable.join('、')}换成真实的${renderable.join('、')}（不要带品牌标志或文字）`);
    if (scaleOnly.length) parts.push(`灰色人形等剪影只用来表示大小，删除它们并用背景补齐，不要生成${scaleOnly.join('、')}`);
    let text = `${parts.join('；')}。`;
    if (aliases.original) text += `产品外观以${ref(aliases.original)}为准。`;
    return text;
}

function maskPart({ template, aliases, maskBounds, doc, maskInstruction }) {
    const what = safe(maskInstruction).replace(/[。；;.]+$/, '');
    const size = { w: doc.frame.w, h: doc.frame.h };
    const where = maskBounds ? pointLabel(maskBounds.x + maskBounds.w / 2, maskBounds.y + maskBounds.h / 2, size) : '';
    if (template === 'openai') {
        return what
            ? `只修改${ref(aliases.original)}${where}的指定区域：${what}。其余部分保持完全不变。`
            : `只修改${ref(aliases.original)}${where}的指定区域，其余部分保持完全不变。`;
    }
    return `${ref(aliases.annotated)}中红色半透明涂抹的区域（${where}）需要修改${what ? `：${what}。` : '，'}其余部分与${ref(aliases.original)}保持完全一致；输出中不要出现红色涂抹。`;
}

export function buildWorkspacePrompt({ doc, anchorMeta = {}, aliases = {}, template = 'marked', hasLayout = false, hasMask = false, maskBounds = null, maskInstruction = '', scene = '' }) {
    const parts = [];
    if (hasLayout) parts.push(layoutPart({ doc, anchorMeta, aliases, scene }));
    if (doc.annotations?.length) {
        const annotation = buildAnnotationPrompt(
            { sourceSize: { w: doc.frame.w, h: doc.frame.h }, style: doc.annotationStyle || {}, items: doc.annotations },
            { annotatedAlias: aliases.annotated, sourceAlias: aliases.original }
        );
        if (annotation) parts.push(annotation);
    }
    if (hasMask) parts.push(maskPart({ template, aliases, maskBounds, doc, maskInstruction }));
    return parts.join('\n');
}
