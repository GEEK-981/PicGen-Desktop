// 图片工作台端到端冒烟：真实鼠标/键盘驱动。覆盖标注、撤销、尺寸对比素材（自由摆放）、中键拖动画布、涂抹、
// 按模型种类匹配的发送面板、发送后的参考图/提示词/模型/待修改状态、原位继续编辑、导航入口、清空与撤销、
// 统一右键菜单「发送到图片工作台」、输出到参考图、另存为、移除原图取消修改，以及重启后继续编辑。
// 只用本地 fixture 图，不发上游请求。
module.exports = function workspaceFlow({ client, check, clickSelector, waitFor, screenshot }) {
    const h = require('./annotate-sizeref-helpers')({ client, clickSelector, waitFor });
    const { ev, drag, dragAt, type, openStackAction, freshSequence } = h;
    const wsDoc = expr => ev(`(() => { const d = window.PicGenWorkspaceDebug.doc(); return ${expr}; })()`);
    const workspaceReady = label => waitFor(() => ev(`!document.getElementById('workspacePage').hidden && !!document.querySelector('.ws-canvas canvas') && !!window.PicGenWorkspaceDebug`), label);
    const listCount = () => ev(`document.querySelectorAll('.ws-list li:not(.ws-list-empty)').length`);
    const settle = () => new Promise(resolve => setTimeout(resolve, 350));
    // 上一次发送的 toast 会压住底部的发送按钮（elementFromPoint 命中测试失败）
    const clearToasts = () => ev('window.PicGenAppica?.dismissToasts?.(); true');
    const toClient = point => ev(`window.PicGenWorkspaceDebug.toClient(${JSON.stringify(point)})`);
    // 冒烟档案里只配了一个模型：临时（仅内存）加上 GPT / Nano Banana 两种，验证按种类切换；结束时还原
    const EXTRA_MODELS = ['gpt-image-2', 'gemini-3-pro-image-preview'];

    async function run() {
        const result = {};
        const seq = await freshSequence({ model: 'gpt-image-2', fixtures: [{ name: 'product.png', w: 900, h: 600, boxes: [{ color: '#DC2626', x: 250, y: 100, w: 400, h: 450 }] }] });
        const addedModels = await ev(`(() => { const p = state.presets.find(x => x.enabled !== false); const add = ${JSON.stringify(EXTRA_MODELS)}.filter(m => !p.models.includes(m));
            p.models.push(...add); renderModelSelect(getCurrentSequence()); return { id: p.id, add }; })()`);
        await openStackAction(0);
        await workspaceReady('workspace from reference card');
        check(!(await ev(`!!document.querySelector('#referenceStack .reference-group-action')`)), 'Old reference-card dot buttons are still rendered');
        await settle();

        // ── 标注：框 + 箭头，撤销/重做保住已写的要求 ──
        await drag('.ws-canvas', [0.46, 0.4], [0.6, 0.55]);
        await waitFor(async () => (await listCount()) === 1, 'rect');
        await type('.ws-list li:nth-child(1) input', '把这块换成金属质感');
        await clickSelector('.ws-tools [data-tool="arrow"]');
        await drag('.ws-canvas', [0.2, 0.8], [0.4, 0.7]);
        await waitFor(async () => (await listCount()) === 2, 'arrow');
        await clickSelector('.ws-header [aria-label="撤销"]');
        await waitFor(async () => (await listCount()) === 1, 'undo');
        check(await ev(`document.querySelector('.ws-list li:nth-child(1) input').value === '把这块换成金属质感'`), 'Undo dropped a typed instruction');
        await clickSelector('.ws-header [aria-label="重做"]');
        await waitFor(async () => (await listCount()) === 2, 'redo');
        await screenshot('40-workspace-annotate.png');

        // ── 比例：不再填尺寸、不锁定；点选长椅 → 放在产品旁、底边对齐、在画框内 ──
        await clickSelector('.ws-modes [data-mode="scale"]');
        check(!(await ev(`!!document.querySelector('#wsHeight, #wsApplySize, .ws-lock')`)), 'Scale lock UI is still shown');
        await clickSelector('.ws-anchor[data-anchor="bench"]');
        await waitFor(() => wsDoc('d.anchors.length === 1'), 'bench placed');
        const placed = await wsDoc(`(() => { const img = d.images[0], c = img.content || { x: 0, y: 0, w: 1, h: 1 }, a = d.anchors[0];
            const p = { x: img.x + img.w * c.x, y: img.y + img.h * c.y, w: img.w * c.w, h: img.h * c.h };
            return { a, inside: a.x >= 0 && a.y >= 0 && a.x + a.w <= d.frame.w + 1e-6 && a.y + a.h <= d.frame.h + 1e-6,
                beside: a.x + a.w <= p.x + 1e-6 || a.x >= p.x + p.w - 1e-6, bottoms: Math.abs(a.y + a.h - (p.y + p.h)) < 1e-6, aspect: Math.abs(a.w / a.h - 1600 / 850) < 1e-6 }; })()`);
        check(placed.inside && placed.beside && placed.bottoms && placed.aspect, `Anchor placement wrong: ${JSON.stringify(placed)}`);
        // 左键拖动长椅：上下左右都能动（不再锁在地面线上）
        const benchCenter = await toClient({ x: placed.a.x + placed.a.w / 2, y: placed.a.y + placed.a.h / 2 });
        await dragAt(benchCenter, 24, -30);
        await waitFor(() => wsDoc(`d.anchors[0].y < ${placed.a.y - 5} && Math.abs(d.anchors[0].x - ${placed.a.x}) > 5`), 'bench dragged freely');
        // 中键拖动画布：视图平移，画布内容不动
        const docBefore = await wsDoc('JSON.stringify([d.images, d.anchors, d.annotations])');
        const originBefore = await toClient({ x: 0, y: 0 });
        await dragAt({ x: originBefore.x + 20, y: originBefore.y + 20 }, 40, 25, 'middle');
        const originAfter = await toClient({ x: 0, y: 0 });
        check(Math.abs(originAfter.x - originBefore.x - 40) < 2 && Math.abs(originAfter.y - originBefore.y - 25) < 2, `Middle drag did not pan: ${JSON.stringify({ originBefore, originAfter })}`);
        check((await wsDoc('JSON.stringify([d.images, d.anchors, d.annotations])')) === docBefore, 'Middle drag moved canvas content');
        await clickSelector('.ws-fit:last-of-type');
        await screenshot('41-workspace-scale.png');

        // ── 涂抹 ──
        await clickSelector('.ws-modes [data-mode="mask"]');
        await drag('.ws-canvas', [0.55, 0.45], [0.62, 0.5], 8);
        check(await ev('window.PicGenWorkspaceDebug.hasMask()'), 'Mask paint did not land');
        await screenshot('42-workspace-mask.png');

        // ── 发送面板：按模型种类匹配 ──
        await clickSelector('#wsSendBtn');
        await waitFor(() => ev(`!!document.querySelector('.ws-sheet')`), 'send sheet');
        const roles = () => ev(`[...document.querySelectorAll('.ws-thumbs figure')].map(f => f.dataset.role).join(',')`);
        check(await ev(`['nanobanana', 'gpt', 'other'].every(f => !!document.querySelector('#wsSendModel [data-family="' + f + '"]'))`), 'Model families missing from the picker');
        await clickSelector('#wsSendModel [data-family="nanobanana"]');
        await waitFor(async () => (await roles()) === 'layout,original,annotated', 'nano banana thumbnails');
        check(await ev(`document.querySelector('#wsSendPrompt').textContent.includes('红色半透明涂抹')`), 'Nano Banana prompt lacks the painted-area wording');
        check(!(await ev(`/alpha|RGBA|蒙版/.test(document.querySelector('.ws-sheet').textContent)`)), 'Send sheet leaks technical terms');
        await clickSelector('#wsSendModel [data-family="gpt"]');
        await waitFor(async () => (await roles()) === 'layout,original,annotated,mask', 'gpt thumbnails');
        check(await ev(`document.querySelector('#wsSendModelSelect').textContent.includes('gpt-image-2')`), 'GPT family did not pick its model');
        await screenshot('43-workspace-send.png');
        // 先把序列换成别的模型：发送必须用工作台里选的 GPT，而不是序列原来的模型
        await ev(`(() => { const s = getCurrentSequence(); s.model = 'gemini-3-pro-image-preview'; el.modelSelect.value = s.model; return true; })()`);
        await clickSelector('#wsConfirmSend');
        await waitFor(() => ev(`state.activeView === 'generation'`), 'back to generation');
        const sent = await ev(`(() => { const s = getCurrentSequence(); const pending = state.pendingMaskEdits.get(s.id);
            return { id: s.id, model: s.model, formModel: el.modelSelect.value, n: s.references.length, first: s.references[0]?.name, sourceOk: pending?.sourceRefId === s.references[0]?.id,
                guide: pending?.maskImage?.guideIncluded, panel: !document.getElementById('pendingMaskPanel').hidden,
                hasDoc: !!s.references[0]?.workspace?.doc, prompt: resolvePromptMentions(s) }; })()`);
        check(sent.id === seq.id && sent.model === 'gpt-image-2' && sent.formModel === 'gpt-image-2' && sent.n === 4 && sent.first === '原图.png' && sent.sourceOk
            && sent.guide === false && sent.panel && sent.hasDoc, `Send result wrong: ${JSON.stringify({ ...sent, prompt: undefined })}`);
        check(sent.prompt.includes('把灰色的长椅换成真实的长椅') && sent.prompt.includes('把这块换成金属质感') && sent.prompt.includes('只修改参考图1')
            && !sent.prompt.includes('@{'), `Sent prompt wrong: ${sent.prompt}`);
        result.send = { refs: sent.n };

        // ── 在参考图卡片上继续编辑：画布原样恢复 ──
        await openStackAction(0);
        await workspaceReady('re-edit');
        await waitFor(() => wsDoc('d.annotations.length === 2 && d.anchors.length === 1'), 're-edit restores the canvas');
        result.reedit = true;

        // ── 导航入口：回到同一个画布 ──
        await ev('showGenerationView(); true');
        await clickSelector('#workspaceNavBtn');
        await workspaceReady('nav entry');
        check(await wsDoc('d.anchors.length === 1'), 'Nav entry lost the current canvas');

        // ── 清空：一步可撤销、不弹确认；撤销带回画布、涂抹和场景文字，重做再次清空 ──
        const clearBtn = '.ws-header [aria-label="清空工作台"]';
        const blankDoc = 'd.images.length === 0 && d.anchors.length === 0 && d.annotations.length === 0';
        const fullDoc = 'd.images.length === 1 && d.anchors.length === 1 && d.annotations.length === 2';
        await clickSelector('.ws-modes [data-mode="mask"]');
        await drag('.ws-canvas', [0.5, 0.5], [0.56, 0.54], 6);
        await waitFor(() => ev('window.PicGenWorkspaceDebug.hasMask()'), 'mask painted before clearing');
        await clickSelector('.ws-modes [data-mode="scale"]');
        await type('#wsScene', '木质书桌');
        await waitFor(() => ev(`document.getElementById('wsScene').value === '木质书桌'`), 'scene typed before clearing');
        await clickSelector(clearBtn);
        await waitFor(() => wsDoc(blankDoc), 'workspace cleared');
        const cleared = await ev(`(() => { const empty = document.querySelector('.ws-empty'); const header = document.querySelector('.ws-header');
            const title = document.querySelector('.ws-title'); const anchors = [...document.querySelectorAll('.ws-anchor')];
            return { empty: !!empty && empty.getBoundingClientRect().height > 0 && empty.textContent.includes('发送到图片工作台'),
                canvas: !!document.querySelector('.ws-canvas'), mask: window.PicGenWorkspaceDebug.hasMask(),
                disabled: document.querySelector(${JSON.stringify(clearBtn)}).disabled, confirm: document.getElementById('confirmOverlay')?.hidden === false,
                notice: document.querySelector('.ws-notice')?.textContent || '', scene: document.getElementById('wsScene').value,
                anchors: anchors.length > 0 && anchors.every(b => b.disabled && b.draggable === false),
                headerFits: header.scrollWidth <= header.clientWidth + 1 && title.querySelector('h2').scrollWidth <= title.clientWidth + 1,
                width: innerWidth }; })()`);
        check(cleared.empty && !cleared.canvas && !cleared.mask && cleared.disabled && !cleared.confirm && cleared.notice.includes('撤销')
            && cleared.scene === '' && cleared.anchors && cleared.headerFits, `Clear result wrong: ${JSON.stringify(cleared)}`);
        await screenshot('44-workspace-cleared.png');
        await clickSelector('.ws-header [aria-label="撤销"]');
        await workspaceReady('canvas remounted after undoing the clear');
        await waitFor(() => wsDoc(fullDoc), 'undo restores the cleared canvas');
        const undone = await ev(`(() => ({ mask: window.PicGenWorkspaceDebug.hasMask(), scene: document.getElementById('wsScene').value,
            enabled: !document.querySelector(${JSON.stringify(clearBtn)}).disabled, notice: document.querySelector('.ws-notice')?.textContent || '' }))()`);
        check(undone.mask && undone.scene === '木质书桌' && undone.enabled && !undone.notice.includes('已清空'), `Undoing the clear lost something: ${JSON.stringify(undone)}`);
        await clickSelector('.ws-header [aria-label="重做"]');
        await waitFor(() => wsDoc(blankDoc), 'redo clears again');
        check(!(await ev('window.PicGenWorkspaceDebug.hasMask()')) && (await ev(`document.getElementById('wsScene').value`)) === '', 'Redoing the clear left the mask or scene behind');
        await clickSelector('.ws-header [aria-label="撤销"]');
        await workspaceReady('canvas back after the second undo');
        await waitFor(() => wsDoc(fullDoc), 'second undo restores the canvas');
        await clickSelector('.ws-modes [data-mode="annotate"]');
        result.clear = { width: cleared.width };

        // ── 右键入口 + 输出到参考图 + 另存为 + 移除待修改的原图会取消修改 ──
        await clickSelector('#historyBtn');
        await waitFor(() => ev(`document.querySelectorAll('#historyImages .history-item').length > 0`), 'history');
        await ev(`(() => { const item = document.querySelector('#historyImages .history-item'); item.scrollIntoView(); const r = item.getBoundingClientRect();
            item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 })); return true; })()`);
        check(await ev(`!!document.getElementById('workspaceImageBtn') && !document.getElementById('annotateImageBtn') && !document.getElementById('scaleImageBtn')
            && !document.getElementById('localEditImageBtn') && !document.getElementById('referenceContextMenu')`), 'Context menu items not merged into 发送到图片工作台');
        await clickSelector('#workspaceImageBtn');
        await workspaceReady('workspace from context menu');
        // 再次发送替换当前画布（一张图，没有对比物体和标注），并且总是从「标注」开始
        await waitFor(() => wsDoc('d.images.length === 1 && d.anchors.length === 0 && d.annotations.length === 0'), 'context menu replaced the canvas');
        await waitFor(() => ev(`!!document.querySelector('.ws-modes [data-mode="annotate"][data-pressed]')`), 'context menu opens in 标注');
        await settle();
        await drag('.ws-canvas', [0.4, 0.4], [0.55, 0.55]);
        await waitFor(async () => (await listCount()) === 1, 'rect in context session');
        const refsBefore = await ev('getCurrentSequence().references.length');
        await clearToasts();
        await clickSelector('.ws-export');
        check(await ev(`!!document.querySelector('.ws-menu [data-export="reference"]') && !!document.querySelector('.ws-menu [data-export="save-as"]') && !/历史|电商/.test(document.querySelector('.ws-menu').textContent)`),
            'Output menu is not 输出到参考图 / 另存为');
        await clickSelector('.ws-menu [data-export="reference"]');
        await waitFor(() => ev(`getCurrentSequence().references.length === ${refsBefore + 1} && /^工作台-.*\\.png$/.test(getCurrentSequence().references.at(-1).name)`), 'output to references');
        await clickSelector('.ws-export');
        await clickSelector('.ws-menu [data-export="save-as"]');
        await waitFor(() => ev(`document.querySelector('.ws-notice')?.textContent.includes('已保存')`), 'saved as file');
        // 这次也涂抹并发送：原图排到第一，再把它移除 → 待修改状态应被取消（第一次发送的文档不受影响）
        await clickSelector('.ws-modes [data-mode="mask"]');
        await drag('.ws-canvas', [0.45, 0.45], [0.5, 0.5], 6);
        await clearToasts();
        await clickSelector('#wsSendBtn');
        await waitFor(() => ev(`!!document.querySelector('.ws-sheet')`), 'second send sheet');
        await clickSelector('#wsConfirmSend');
        await waitFor(() => ev(`state.activeView === 'generation' && state.pendingMaskEdits.has(getCurrentSequence().id)`), 'second send');
        check(await ev(`getCurrentSequence().references.some(r => r.workspace?.doc?.anchors?.length === 1)`), 'Second send lost the first workspace document');
        await ev(`(() => { const s = getCurrentSequence(); removeSequenceReference(s.id, s.references[0].id); return true; })()`);
        check(await ev(`!state.pendingMaskEdits.has(getCurrentSequence().id)`), 'Removing the source image kept a stale local edit');
        // 切到一个空的新序列再交给后面的流程：refinement 流程会清空"当前序列"的参考图，不能是这个要在重启后校验的序列
        await freshSequence({ fixtures: [] });
        await ev(`(() => { const p = state.presets.find(x => x.id === ${JSON.stringify(addedModels.id)}); const add = ${JSON.stringify(addedModels.add)};
            if (p) p.models = p.models.filter(m => !add.includes(m)); renderModelSelect(getCurrentSequence()); return true; })()`);
        await ev('showGenerationView(); true');
        check(client.errors.length === 0, 'Renderer exception during workspace flow');
        return { ...result, sequenceId: seq.id, savedHistory: 0 };
    }

    // 重启后：第一次发送时保存在参考图上的工作台文档仍在，能恢复画布
    async function afterRestart(runResult) {
        await ev(`window.picgenDesktop.setExpanded(true); true`);
        await waitFor(() => ev(`innerWidth >= 450 && !document.body.classList.contains('collapsed')`), 'expanded after restart');
        await ev(`(() => { saveCurrentSequenceFromForm(); state.currentSequenceId = ${JSON.stringify(runResult.sequenceId)};
            renderSequenceTabs(); loadCurrentSequenceToForm(); showGenerationView(); return true; })()`);
        await waitFor(() => ev(`(async () => { await hydrateSequenceReferences([getCurrentSequence()]); return getCurrentSequence().references.length > 0; })()`), 'restored sequence');
        const index = await ev(`getCurrentSequence().references.findIndex(r => r.workspace?.doc?.anchors?.length === 1)`);
        check(index >= 0, 'Workspace document did not survive restart');
        await openStackAction(index);
        await workspaceReady('re-edit after restart');
        await waitFor(() => wsDoc('d.annotations.length === 2 && d.anchors.length === 1'), 'canvas restored after restart');
        await ev('showGenerationView(); true');
        return true;
    }

    return { run, afterRestart };
};
