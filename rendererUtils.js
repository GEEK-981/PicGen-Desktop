(function exposeRendererUtils(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PicGenRendererUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRendererUtils() {
    function referenceAlias(reference, index = 0) {
        const raw = String(reference?.alias || reference?.name || `参考图${index + 1}`)
            .replace(/\.[a-z0-9]{2,5}$/i, '')
            .replace(/[@{}\r\n]/g, ' ')
            .trim();
        return (raw || `参考图${index + 1}`).slice(0, 28);
    }

    function referenceMentionLookup(references = []) {
        const aliases = new Map();
        references.forEach((reference, index) => {
            const entry = { reference, index };
            aliases.set(String(reference?.name || '').replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase(), entry);
        });
        references.forEach((reference, index) => aliases.set(referenceAlias(reference, index).toLowerCase(), { reference, index }));
        return aliases;
    }

    // 空 @：被引用的参考图删掉后留下的占位，等用户点它重新挑一张。
    // 段里同时带 text（= 原文 @{}），只拼 text 的旧序列化路径也会原样保留它。
    const EMPTY_REFERENCE_MENTION = '@{}';

    function promptSegments(prompt, references = []) {
        const source = String(prompt || '');
        const aliases = referenceMentionLookup(references);
        const segments = [];
        const mentionPattern = /@\{([^}]*)\}/g;
        let cursor = 0;
        let match;

        const appendText = value => {
            if (!value) return;
            const last = segments[segments.length - 1];
            if (last?.type === 'text') last.text += value;
            else segments.push({ type: 'text', text: value });
        };

        while ((match = mentionPattern.exec(source))) {
            appendText(source.slice(cursor, match.index));
            const entry = aliases.get(match[1].trim().toLowerCase());
            if (!match[1].trim()) {
                segments.push({ type: 'empty-reference', mention: EMPTY_REFERENCE_MENTION, text: EMPTY_REFERENCE_MENTION });
            } else if (entry) {
                segments.push({
                    type: 'reference',
                    mention: match[0],
                    alias: referenceAlias(entry.reference, entry.index),
                    reference: entry.reference,
                    index: entry.index
                });
            } else {
                appendText(match[0]);
            }
            cursor = match.index + match[0].length;
        }
        appendText(source.slice(cursor));
        return segments;
    }

    // 生图路径：模型按顺序收图，所以要的是「参考图N」这种与位置绑定的说法。
    // 空 @ 不指向任何图，两条解析路径都把它去掉（调用方会先拦下含空 @ 的提交）。
    function resolvePromptMentions(prompt, references = []) {
        return promptSegments(prompt, references).map(segment => (
            segment.type === 'reference' ? `参考图${segment.index + 1}`
                : segment.type === 'empty-reference' ? '' : segment.text
        )).join('');
    }

    function countEmptyReferenceMentions(prompt) {
        return promptSegments(prompt).filter(segment => segment.type === 'empty-reference').length;
    }

    // 删参考图：指向它的 @提及 变成空 @，其余原文不动（别名重算由调用方随后做）。
    function promptWithReferenceRemoved(prompt, references = [], referenceId = '') {
        return promptSegments(prompt, references).map(segment => (
            segment.type === 'reference'
                ? (segment.reference?.id === referenceId ? EMPTY_REFERENCE_MENTION : segment.mention)
                : segment.text
        )).join('');
    }

    // 优化路径：把 @提及 还原成 @{真实名称}，而不是「参考图N」。
    // 优化器要输出一条用户之后还能用的提示词：写成「参考图1」的话，模型既不知道这是哪张
    // 图（图片本身不带名字），也就只能编「@第一张参考图文件名」这种占位符；写成 @{大张}
    // 则与编辑器里的提及语法一致，用户把结果粘回提示词框时能直接变成参考图 token。
    function resolvePromptMentionsWithNames(prompt, references = []) {
        return promptSegments(prompt, references).map(segment => (
            segment.type === 'reference' ? `@{${segment.alias}}`
                : segment.type === 'empty-reference' ? '' : segment.text
        )).join('');
    }

    function canvasPoint(clientX, clientY, rect, canvasWidth, canvasHeight) {
        const width = Math.max(1, Number(rect?.width) || 0);
        const height = Math.max(1, Number(rect?.height) || 0);
        return {
            x: (Number(clientX) - Number(rect?.left || 0)) * (Number(canvasWidth) / width),
            y: (Number(clientY) - Number(rect?.top || 0)) * (Number(canvasHeight) / height)
        };
    }

    // 全局提示词：开启且非空时以空行接在任务提示词末尾；已经以它结尾就不再重复。
    function appendGlobalPrompt(prompt, globalPrompt, enabled = true) {
        const base = String(prompt || '').trim();
        const extra = String(globalPrompt || '').trim();
        if (!enabled || !extra || !base) return base;
        if (base === extra || base.endsWith(`
${extra}`) || base.endsWith(` ${extra}`)) return base;
        return `${base}

${extra}`;
    }

    return {
        EMPTY_REFERENCE_MENTION, referenceAlias, promptSegments, resolvePromptMentions, resolvePromptMentionsWithNames,
        countEmptyReferenceMentions, promptWithReferenceRemoved, canvasPoint, appendGlobalPrompt
    };
});
