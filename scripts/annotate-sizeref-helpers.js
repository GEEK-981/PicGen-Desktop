// 标注 / 尺寸参照图冒烟共用的输入工具：真实 CDP 鼠标与键入，不直接改状态。
module.exports = function annotateHelpers({ client, clickSelector, waitFor }) {
    const ev = expression => client.evaluate(expression);
    const mouse = (type, point, extra = {}) => client.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', ...extra });

    async function rectOf(selector) {
        return waitFor(() => ev(`(() => {
            const node = document.querySelector(${JSON.stringify(selector)});
            if (!node) return null;
            const r = node.getBoundingClientRect();
            return r.width && r.height ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
        })()`), `rect of ${selector}`);
    }

    // from / to 是目标元素内的相对位置 [0..1, 0..1]
    async function drag(selector, from, to, steps = 6) {
        const rect = await rectOf(selector);
        const at = ([fx, fy]) => ({ x: rect.left + rect.width * fx, y: rect.top + rect.height * fy });
        const start = at(from); const end = at(to);
        await mouse('mouseMoved', start);
        await mouse('mousePressed', start, { clickCount: 1, buttons: 1 });
        for (let step = 1; step <= steps; step += 1) {
            await mouse('mouseMoved', { x: start.x + (end.x - start.x) * step / steps, y: start.y + (end.y - start.y) * step / steps }, { buttons: 1 });
        }
        await mouse('mouseReleased', end, { clickCount: 1 });
    }

    // 从屏幕点 start 按住 button（left / middle）拖动 dx, dy
    async function dragAt(start, dx, dy, button = 'left', steps = 6) {
        const buttons = button === 'middle' ? 4 : 1;
        await mouse('mouseMoved', start, { button: 'none' });
        await mouse('mousePressed', start, { button, clickCount: 1, buttons });
        for (let step = 1; step <= steps; step += 1) {
            await mouse('mouseMoved', { x: start.x + dx * step / steps, y: start.y + dy * step / steps }, { button, buttons });
        }
        await mouse('mouseReleased', { x: start.x + dx, y: start.y + dy }, { button, clickCount: 1 });
    }

    // 按像素位移拖动元素中心（拖尺寸框的角点）
    async function dragBy(selector, dx, dy, steps = 6) {
        const rect = await rectOf(selector);
        const start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        await mouse('mouseMoved', start);
        await mouse('mousePressed', start, { clickCount: 1, buttons: 1 });
        for (let step = 1; step <= steps; step += 1) {
            await mouse('mouseMoved', { x: start.x + dx * step / steps, y: start.y + dy * step / steps }, { buttons: 1 });
        }
        await mouse('mouseReleased', { x: start.x + dx, y: start.y + dy }, { clickCount: 1 });
    }

    async function type(selector, text) {
        await clickSelector(selector);
        await ev(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.select?.(); return true; })()`);
        await client.send('Input.insertText', { text });
    }

    async function key(keyName, code, modifiers = 0) {
        const base = { key: keyName, code, windowsVirtualKeyCode: { Delete: 46, Escape: 27, z: 90, y: 89 }[keyName] || 0, modifiers };
        await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
        await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }

    // 参考图卡右键（全局统一的图片菜单）→「发送到图片工作台」。照片堆收起时上传块压在最上面，悬停才会横向展开——用真实鼠标移入触发
    async function openStackAction(index) {
        const point = await waitFor(() => ev(`(() => {
            const group = document.querySelector('#referenceStack .reference-group');
            if (!group) return null;
            const r = group.getBoundingClientRect();
            return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        })()`), 'reference stack');
        await mouse('mouseMoved', point);
        await waitFor(() => ev(`!!document.querySelector('#referenceStack .reference-group.is-open')`), 'reference stack expanded');
        // 展开有 0.3s 的位移动画：等卡片位置连续两次不变再右键，否则会点在动画中途的旧位置上
        const selector = `#referenceStack [data-reference-id]:nth-of-type(${index + 2})`;
        let previous = '';
        await waitFor(async () => {
            const now = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return ''; const r = b.getBoundingClientRect(); return Math.round(r.left) + ',' + Math.round(r.top); })()`);
            const settled = now && now === previous;
            previous = now;
            if (!settled) await new Promise(resolve => setTimeout(resolve, 120));
            return settled;
        }, 'reference stack settled');
        // 右键偶尔落在展开动画收尾的空隙里：菜单没出来就重新量位置再右键（最多 3 次）
        for (let attempt = 1; ; attempt += 1) {
            const card = await ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
            await mouse('mouseMoved', card, { button: 'none' });
            await mouse('mousePressed', card, { button: 'right', clickCount: 1, buttons: 2 });
            await mouse('mouseReleased', card, { button: 'right', clickCount: 1 });
            const shown = await waitFor(() => ev(`!document.getElementById('imageContextMenu').hidden && state.imageContextTarget?.kind === 'reference'`), 'reference card image menu', 3000).catch(() => false);
            if (shown) break;
            if (attempt >= 3) throw new Error('Timed out: reference card image menu');
        }
        await clickSelector('#workspaceImageBtn');
    }

    // 在一个独立新序列里放 fixture 参考图；spec 由渲染进程 canvas 画出来
    async function freshSequence({ model = 'gpt-image-2', fixtures = [] } = {}) {
        return ev(`(async () => {
            window.picgenDesktop.setExpanded(true);
            saveCurrentSequenceFromForm();
            const current = getCurrentSequence();
            const sequence = createSequence({ providerId: current.providerId, model: 'gpt-image-2', ratio: current.ratio,
                imageSize: current.imageSize, advanced: current.advanced, count: '1', prompt: '' });
            state.sequences.push(sequence); normalizeSequenceNames();
            state.currentSequenceId = sequence.id;
            saveSequences(); renderSequenceTabs(); loadCurrentSequenceToForm(); showGenerationView();
            sequence.model = ${JSON.stringify(model)};
            const draw = ${JSON.stringify(fixtures)};
            const payloads = draw.map(spec => {
                const canvas = document.createElement('canvas');
                canvas.width = spec.w; canvas.height = spec.h;
                const g = canvas.getContext('2d');
                g.fillStyle = spec.background || '#FFFFFF'; g.fillRect(0, 0, spec.w, spec.h);
                if (spec.noise) {
                    for (let i = 0; i < 4000; i += 1) {
                        g.fillStyle = 'hsl(' + ((i * 47) % 360) + ',60%,50%)';
                        g.fillRect((i * 97) % spec.w, (i * 61) % spec.h, 18, 18);
                    }
                }
                for (const box of spec.boxes || []) { g.fillStyle = box.color; g.fillRect(box.x, box.y, box.w, box.h); }
                return { name: spec.name, mimeType: 'image/png', base64: canvas.toDataURL('image/png').split(',')[1] };
            });
            await addReferencePayloads(payloads);
            renderReferences();
            return { id: sequence.id, references: getCurrentSequence().references.length };
        })()`);
    }

    const listCount = () => ev(`document.querySelectorAll('.annotation-list li:not(.annotation-empty)').length`);

    return { ev, mouse, rectOf, drag, dragBy, dragAt, type, key, openStackAction, freshSequence, listCount };
};
