// Similar-view fixture (WP12): prompts with disjoint bigrams, so only the pairs meant to group do.
// Every image of a group shares its pixels. `near` differs from `near-calm` by one word (J = 0.8421,
// d = 0.1026 with identical pixels): apart at 严格/标准, together at 宽松 in both hd and h.
const SIMILAR_FIXTURE = [
    { tag: 'amber', prompt: 'amber lighthouse on a cliff at dusk', count: 2 },
    { tag: 'violet', prompt: 'violet forest mushrooms glowing', count: 2 },
    { tag: 'copper', prompt: 'copper robot portrait studio light', count: 2 },
    { tag: 'teal', prompt: 'teal ocean waves crashing rocks', count: 2 },
    { tag: 'crimson', prompt: 'crimson desert dunes under stars', count: 2 },
    { tag: 'golden', prompt: 'golden wheat field with a red barn', count: 2 },
    { tag: 'silver', prompt: 'silver mountain lake reflection', count: 2 },
    { tag: 'emerald', prompt: 'emerald jungle ruins in mist', count: 2 },
    // 选中本组 check: member 0 is used twice (the cover), member 1 once (protected), 2 and 3 are unused.
    { tag: 'candy', prompt: 'pastel candy shop window display', count: 4 },
    { tag: 'near', prompt: 'a watercolor postcard of a quiet harbor town with fishing boats at sunrise', count: 1, pixels: 'harbor' },
    { tag: 'near-calm', prompt: 'a watercolor postcard of a calm harbor town with fishing boats at sunrise', count: 1, pixels: 'harbor' },
    { tag: 'single', prompt: 'monochrome chess pieces on a board', count: 1 }
];
const path = require('node:path');
const fs = require('node:fs/promises');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// The unified image menu, top to bottom (设为封面 / 移出此组 appear only inside a similar group).
const IMAGE_MENU_ITEMS = ['sendReferenceActiveBtn', 'sendReferenceNewBtn', 'workspaceImageBtn', 'copyImageBtn', 'copyPromptImageBtn', 'saveImageAsBtn', 'findSimilarImageBtn'];
const imageExtension = name => path.extname(String(name || '')).toLowerCase().replace(/^\.jpeg$/, '.jpg');
// Page expression over `buttons`: items whose row overflows or whose label is cut by the ellipsis
// (a hint at the end of the row must never push the label out).
const CLIPPED_MENU_ITEMS = `buttons.filter(button => [button, ...button.querySelectorAll('span')].some(node => node.scrollWidth > node.clientWidth + 1)).map(button => button.id)`;

// saveAsDir (optional): PICGEN_SMOKE_SAVE_AS_DIR of this launch, to find the 另存为 copy on disk.
module.exports = function uxFlow({ client, check, clickControl, clickSelector, waitFor, screenshot, saveAsDir = '' }) {
    async function atPanelSize(action) {
        await client.send('Emulation.setDeviceMetricsOverride', { width: 460, height: 800, deviceScaleFactor: 1, mobile: false });
        // Earlier toasts would cover the selection bar; a dialog gets its open animation.
        await client.evaluate('window.PicGenAppica?.dismissToasts?.(); new Promise(resolve => setTimeout(resolve, 450))');
        try { return await action(); } finally { await client.send('Emulation.clearDeviceMetricsOverride'); }
    }

    // Saves the fixture through the real save path (history index, similarity engine) and returns its keys.
    async function seedSimilarFixture() {
        const saved = await client.evaluate(`(async () => {
            const fixture = ${JSON.stringify(SIMILAR_FIXTURE)};
            const pixels = seed => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 192;
                const context = canvas.getContext('2d');
                let hash = 0;
                for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
                const hue = hash % 360;
                context.fillStyle = 'hsl(' + hue + ', 65%, 55%)';
                context.fillRect(0, 0, 192, 192);
                for (let i = 0; i < 7; i++) {
                    context.fillStyle = 'hsl(' + ((hue + 47 * (i + 1)) % 360) + ', 80%, ' + (25 + i * 8) + '%)';
                    const x = (hash >>> (i * 3)) % 150, y = (hash >>> (i * 2 + 5)) % 150;
                    if (i % 2) context.fillRect(x, y, 30 + i * 6, 18 + i * 4);
                    else { context.beginPath(); context.arc(x + 20, y + 20, 14 + i * 4, 0, Math.PI * 2); context.fill(); }
                }
                return canvas.toDataURL('image/png').split(',')[1];
            };
            const now = Date.now();
            const keys = {};
            let offset = 0;
            for (const entry of fixture) {
                const base64 = pixels(entry.pixels || entry.tag);
                keys[entry.tag] = [];
                for (let i = 0; i < entry.count; i++) {
                    const record = await window.picgenDesktop.saveGeneratedImage({ id: 'uxfix-' + entry.tag + '-' + i, base64, mimeType: 'image/png',
                        prompt: entry.prompt, ratio: '1:1', model: 'ux-fixture', providerName: 'UX fixture', createdAt: now - (offset++) * 1000 });
                    keys[entry.tag].push({ key: historyImageKey(record), filePath: record.filePath });
                }
            }
            await refreshRecentImages({ full: true });
            return keys;
        })()`);
        const count = SIMILAR_FIXTURE.reduce((sum, entry) => sum + entry.count, 0);
        check(Object.values(saved).flat().length === count, 'Similar fixture was not saved');
        // Cover by usage, then a protected member: a drag-out plus a reference use (different kinds, so no
        // 750 ms coalescing), and one reference use for the second member.
        const [cover, used] = saved.candy;
        const outcome = await client.evaluate(`window.picgenDesktop.smokeDragOutcome({ filePath: ${JSON.stringify(cover.filePath)}, point: { x: -32000, y: -32000 } })`);
        check(outcome?.counted === true, 'Smoke drag-out outside the window was not counted');
        for (const target of [cover, used]) {
            const result = await client.evaluate(`window.picgenDesktop.recordHistoryUsage({ filePath: ${JSON.stringify(target.filePath)}, kind: 'reference', source: 'drawer' })`);
            check(result?.ok && result.changed, 'Reference use was not recorded');
        }
        await waitFor(() => client.evaluate(`(() => {
            const byKey = key => state.recentImages.find(image => historyImageKey(image) === key);
            const cover = byKey(${JSON.stringify(cover.key)}), used = byKey(${JSON.stringify(used.key)});
            return cover?.dragCount === 1 && cover.referenceCount === 1 && used?.referenceCount === 1 && !used.dragCount;
        })()`), 'Fixture usage counters');
        return { keys: saved, count, cover: cover.key, protected: used.key };
    }

    async function run() {
        await client.evaluate(`(async () => {
            window.picgenDesktop.setExpanded(true);
            await refreshRecentImages({ full: true });
            showGenerationView();
            const sequence = getCurrentSequence(); sequence.model = 'gpt-image-2';
            sequence.references = []; sequence.prompt = ''; loadCurrentSequenceToForm();
            return true;
        })()`);
        await waitFor(() => client.evaluate('!document.body.classList.contains("collapsed")'), 'expanded UX window');
        const activeId = await client.evaluate('state.currentSequenceId');
        // The image menu is native (it opens at the cursor, past the window): under PICGEN_SMOKE main pops
        // nothing and answers with the choice queued here, recording the items it was given.
        async function rightClick(index, choice) {
            await clickControl('historyBtn');
            await waitFor(() => client.evaluate('state.activeView === "history" && state.recentImages.length >= 2'), 'UX history');
            await client.evaluate(`window.picgenDesktop.smokeImageMenu(${JSON.stringify(choice)})`);
            return client.evaluate(`(() => {
                const item = document.querySelectorAll('#historyImages .history-item')[${index}];
                item.scrollIntoView(); const rect = item.getBoundingClientRect();
                item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10 })); return item.dataset.historyId;
            })()`);
        }
        async function menu(index, choice) {
            const key = await rightClick(index, choice);
            await waitFor(() => client.evaluate('!state.sendingReference && state.activeView === "generation"'), 'reference insertion');
            return key;
        }
        // 复制图片: first in the native menu, and the picture lands on the clipboard.
        await rightClick(0, 'copy');
        const copied = await waitFor(() => client.evaluate('window.picgenDesktop.smokeClipboardImage()'), 'Image copied to the clipboard');
        check(copied.width > 0 && copied.height > 0, `Clipboard image: ${JSON.stringify(copied)}`);
        const nativeMenu = await client.evaluate('window.picgenDesktop.smokeImageMenu()');
        check(nativeMenu.last?.[0]?.id === 'copy' && nativeMenu.last.some(item => item.id === 'find-similar'), `Native image menu: ${JSON.stringify(nativeMenu.last)}`);
        check(await client.evaluate('el.imageContextMenu.hidden'), 'The in-page fallback menu opened next to the native one');
        const usageOf = key => client.evaluate(`window.picgenDesktop.listHistoryImages().then(items => {
            const image = items.find(item => historyImageKey(item) === ${JSON.stringify(key)});
            return image ? { dragCount: image.dragCount || 0, referenceCount: image.referenceCount || 0 } : null;
        })`);
        const firstKey = await menu(0, 'reference-active');
        const firstUsedAt = Date.now();
        check(await client.evaluate(`state.currentSequenceId === ${JSON.stringify(activeId)} && getCurrentSequence().references.length === 1`), 'Active sequence reference missing');
        const secondKey = await menu(1, 'reference-active');
        check(await client.evaluate('getCurrentSequence().references.length === 2'), 'Second reference missing');
        const ids = await client.evaluate(`(() => {
            const sequence = getCurrentSequence();
            sequence.references[0].name = 'subject.png'; sequence.references[1].name = 'style.png';
            sequence.references.forEach(ref => { ref.alias = ''; });
            setPromptEditorValue('@{subject} follows @{style}', sequence.references); renderReferences(); saveCurrentSequenceFromForm();
            return sequence.references.map(ref => ref.id);
        })()`);
        // 参考图拖拽排序随 2.3.4 照片堆改版移除（.reference-chip 条带已不存在，拖参考图
        // 现在是"拖出去给别的软件 / 拖到垃圾桶删除"的原生拖拽）。这里改为校验照片堆 DOM
        // 与 @ 提及的按序解析契约——顺序仍以 sequence.references 的数组顺序为准。
        check(await client.evaluate(`(() => {
            const items = [...document.querySelectorAll('#referenceStack .reference-item-image')];
            return items.length === 2 && items.map(item => item.dataset.referenceId).join() === ${JSON.stringify(ids.join())};
        })()`), 'Reference stack missing or out of order');
        check(await client.evaluate(`resolvePromptMentions(getCurrentSequence()) === '参考图1 follows 参考图2'`), 'Reference mentions lost their identity');
        await screenshot('11-reference-stack.png');
        // Two uses of the same image within 750 ms coalesce into one; these are two separate gestures.
        await pause(Math.max(0, 900 - (Date.now() - firstUsedAt)));
        check(await menu(0, 'reference-new') === firstKey, 'History order changed between the reference sends');
        check(await client.evaluate(`state.currentSequenceId !== ${JSON.stringify(activeId)} && getCurrentSequence().references.length === 1 && state.sequences.find(s => s.id === ${JSON.stringify(activeId)}).references.length === 2`), 'New sequence altered existing references');
        // 发送到参考图 counts one reference use per send: image 0 twice, image 1 once, badges in history.
        const usage = await waitFor(async () => {
            const [first, second] = [await usageOf(firstKey), await usageOf(secondKey)];
            const local = await client.evaluate(`(() => {
                const byKey = key => state.recentImages.find(image => historyImageKey(image) === key);
                const badge = key => document.querySelector('#historyImages .history-item[data-history-id="' + CSS.escape(key) + '"] .history-usage-badge');
                return byKey(${JSON.stringify(firstKey)})?.referenceCount === 2 && byKey(${JSON.stringify(secondKey)})?.referenceCount === 1
                    && badge(${JSON.stringify(firstKey)})?.textContent === '2' && badge(${JSON.stringify(secondKey)})?.textContent === '1';
            })()`);
            return local && first?.referenceCount === 2 && second?.referenceCount === 1 && !first.dragCount && !second.dragCount ? { first, second } : null;
        }, 'Reference-use counters and usage badges');
        await clickControl('historyBtn');
        const badgeShot = await atPanelSize(async () => {
            const state = await client.evaluate(`(async () => {
                el.historyImages.scrollTop = 0;
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const badge = document.querySelector('#historyImages .history-item[data-history-id="' + CSS.escape(${JSON.stringify(firstKey)}) + '"] .history-usage-badge');
                const rect = badge?.getBoundingClientRect();
                return { title: badge?.title || '', visible: !!rect && rect.width > 0 && rect.height > 0,
                    label: badge?.closest('.history-item')?.getAttribute('aria-label') || '', images: document.querySelectorAll('#historyImages img').length,
                    items: document.querySelectorAll('#historyImages .history-item').length };
            })()`);
            await screenshot('10b-usage-badge.png');
            return state;
        });
        check(badgeShot.visible && badgeShot.title.startsWith('用作参考图 2 次') && badgeShot.label.endsWith('，已使用 2 次'), 'Usage badge missing its tooltip or label');
        check(badgeShot.images === badgeShot.items, 'A usage badge added an <img> to the history grid');
        const unifiedMenu = await unifiedMenuStage(secondKey, usageOf);
        const fixture = await seedSimilarFixture();
        const similarity = await similarStage({ fixture });
        await client.evaluate(`window.picgenDesktop.reportRendererError({ source:'generation', title:'Mock failure', message:'Request outcome uncertain', code:'OUTCOME_UNCERTAIN', httpStatus:504, operation:'ux-local-fixture' })`);
        await clickControl('errorLogsBtn');
        await waitFor(() => client.evaluate('el.errorLogsList.textContent.includes("生成结果尚未确认")'), 'Friendly error');
        check(await client.evaluate('el.errorLogsList.textContent.includes("计费")'), 'Missing uncertain billing advice');
        await clickSelector('.error-log-summary');
        check(await client.evaluate('el.errorLogsList.textContent.includes("OUTCOME_UNCERTAIN")'), 'Technical error details missing');
        await screenshot('13-friendly-errors.png');
        await clickControl('apiSettingsBtn');
        await clickControl('concurrencySettingsTab');
        await waitFor(() => client.evaluate('!el.concurrencySettingsPanel.hidden'), 'Routing settings');
        for (const mode of ['priority', 'balanced', 'price', 'speed', 'fixed', 'order']) {
            await clickSelector(`[name="providerStrategy"][value="${mode}"]`);
            check(await client.evaluate(`el.providerCapacityPanel.hidden === ${!['priority', 'balanced'].includes(mode)}`), 'Irrelevant capacity fields visible');
            if (['price', 'speed'].includes(mode)) {
                await waitFor(() => client.evaluate('el.routingRanking.querySelectorAll("tbody tr").length > 0'), 'Top five ranking');
                check(await client.evaluate('el.routingRanking.querySelectorAll("tbody tr").length <= 5 && el.routingRanking.textContent.includes("耗时")'), 'Ranking missing price or speed');
                await screenshot(`14-${mode}-ranking.png`);
            }
        }
        await clickSelector('[name="providerStrategy"][value="priority"]');
        const editedId = await client.evaluate(`(() => { el.providerPriorityInput.value = '7'; el.providerConcurrencyInput.value = '2'; el.providerPriorityInput.dispatchEvent(new Event('change', {bubbles:true})); el.providerConcurrencyInput.dispatchEvent(new Event('change', {bubbles:true})); return el.strategyProviderSelect.value; })()`);
        await waitFor(() => client.evaluate(`getPresetById(${JSON.stringify(editedId)})?.priority === 7`), 'Priority persisted');
        await screenshot('15-priority-settings.png');
        await client.evaluate(`el.toast.hidden = true; true`);
        // Exercise the same desktop surfaces at a wider viewport without changing saved window bounds.
        await client.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 850, deviceScaleFactor: 1, mobile: false });
        await screenshot('16-wide-priority.png');
        await client.send('Emulation.clearDeviceMetricsOverride');
        await clickControl('imageSettingsTab');
        return { activeId, ids, editedId, contextActions: true, referenceStack: true, referenceMentions: true,
            usage: { firstKey, secondKey, ...usage }, unifiedMenu, fixture: { count: fixture.count, cover: fixture.cover, protected: fixture.protected },
            similarity, friendlyErrors: true, rankings: true };
    }

    // 统一图片右键菜单：复制图片 / 另存为都算一次"带出"（dragCount，主进程在成功后计），复制提示词不计；
    // 参考图卡片弹同一个菜单，「活动序列」禁用并在行尾写原因。只动 key（secondKey 已被计为已用，后面的保护数量
    // 不受影响）。冒烟启动带 PICGEN_SMOKE_CLIPBOARD=dry：复制只进 smokeClipboardLog，不碰用户的系统剪贴板。
    async function unifiedMenuStage(key, usageOf) {
        // Main registers the log only in dry mode: if it answers, no copy below can reach the user's clipboard.
        check(Array.isArray(await client.evaluate('window.picgenDesktop.smokeClipboardLog?.().catch(() => null)')), 'Smoke clipboard is not dry: 复制 would reach the real clipboard');
        // A toast from the previous step must not cover the menu (el.toast keeps its text for the checks below).
        const openMenu = () => client.evaluate(`(() => {
            if (state.activeView !== 'history') return false;
            window.PicGenAppica?.dismissToasts?.();
            const item = document.querySelector('#historyImages .history-item[data-history-id="' + CSS.escape(${JSON.stringify(key)}) + '"]');
            if (!item) return false;
            item.scrollIntoView({ block: 'center' }); const rect = item.getBoundingClientRect();
            item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10 }));
            return !el.imageContextMenu.hidden && state.imageContextTarget?.kind === 'history' && historyImageKey(state.imageContextTarget.record) === ${JSON.stringify(key)};
        })()`);
        const toast = () => client.evaluate('el.toast.textContent');
        const record = await client.evaluate(`(() => { const image = state.recentImages.find(item => historyImageKey(item) === ${JSON.stringify(key)});
            return image ? { filePath: image.filePath, fileName: image.fileName || '', prompt: String(image.prompt || '').trim(), width: Number(image.width) || 0, height: Number(image.height) || 0 } : null; })()`);
        check(record?.filePath, 'The menu stage image is not in history');
        const before = await usageOf(key);
        check(before && before.dragCount === 0 && before.referenceCount === 1, 'The menu stage image does not start with one reference use');
        await clickControl('historyBtn');

        // Seven items and two separators, all enabled for a history image, inside the 460×800 window.
        const layout = await atPanelSize(async () => {
            await waitFor(openMenu, 'Unified image menu');
            const measured = await client.evaluate(`(() => {
                const menu = el.imageContextMenu, rect = menu.getBoundingClientRect();
                const buttons = [...menu.querySelectorAll('button')].filter(button => !button.hidden);
                return { items: buttons.map(button => button.id), disabled: buttons.filter(button => button.disabled).map(button => button.id),
                    separators: menu.querySelectorAll('.image-context-separator').length,
                    clipped: ${CLIPPED_MENU_ITEMS},
                    inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, height: Math.round(rect.height) };
            })()`);
            await screenshot('10c-unified-image-menu.png');
            return measured;
        });
        await client.evaluate('hideImageContextMenu(); true');
        check(layout.items.join() === IMAGE_MENU_ITEMS.join() && layout.separators === 2, `Unified image menu items are wrong: ${layout.items.join()}`);
        check(layout.disabled.length === 0, `History image menu has disabled items: ${layout.disabled.join()}`);
        check(layout.inside && layout.clipped.length === 0, 'Unified image menu overflows the 460×800 window or clips an item');

        // 复制图片: counted once, the clipboard log holds the decoded bitmap at the record's size.
        await waitFor(openMenu, 'Image menu for 复制图片');
        await clickControl('copyImageBtn');
        const copied = await waitFor(async () => {
            const usage = await usageOf(key);
            return usage?.dragCount === 1 && await toast() === '已复制图片' ? usage : null;
        }, '复制图片 copied and counted');
        const imageEntry = (await client.evaluate('window.picgenDesktop.smokeClipboardLog()')).at(-1);
        check(imageEntry?.kind === 'image' && imageEntry.width > 0 && imageEntry.height > 0, '复制图片 did not reach the smoke clipboard log');
        check(!record.width || (imageEntry.width === record.width && imageEntry.height === record.height),
            `复制图片 copied ${imageEntry.width}×${imageEntry.height}, the image is ${record.width}×${record.height}`);
        check(copied.referenceCount === 1, '复制图片 changed the reference count');

        // 另存为 (a separate gesture: two uses within 750 ms coalesce): the dialog is skipped in the smoke,
        // the copy keeps the extension, and it is counted as a second take-out.
        await pause(900);
        await waitFor(openMenu, 'Image menu for 另存为');
        await clickControl('saveImageAsBtn');
        const savedName = await waitFor(async () => {
            const text = await toast();
            return /^已另存为 /.test(text) ? text.replace(/^已另存为 /, '') : null;
        }, '另存为 saved');
        check(imageExtension(savedName) === imageExtension(record.filePath), `另存为 changed the extension: ${savedName}`);
        if (saveAsDir) check(await fs.access(path.join(saveAsDir, savedName)).then(() => true, () => false), `另存为 did not write ${savedName}`);
        const saved = await waitFor(async () => {
            const usage = await usageOf(key);
            return usage?.dragCount === 2 ? usage : null;
        }, '另存为 counted');
        const badgeTitle = await waitFor(() => client.evaluate(`(() => {
            const badge = document.querySelector('#historyImages .history-item[data-history-id="' + CSS.escape(${JSON.stringify(key)}) + '"] .history-usage-badge');
            return badge?.querySelector('b')?.textContent === '3' ? badge.title : null;
        })()`), 'Usage badge after 复制 / 另存');
        check(badgeTitle.startsWith('拖出/复制/另存 2 次 · 用作参考图 1 次'), `Usage badge tooltip is wrong: ${badgeTitle}`);

        // 复制提示词: the record's prompt goes to the clipboard as text; nothing is counted, no sequence is made.
        const sequences = await client.evaluate('state.sequences.length');
        await waitFor(openMenu, 'Image menu for 复制提示词');
        await clickControl('copyPromptImageBtn');
        const promptToast = await waitFor(async () => {
            const text = await toast();
            return ['已复制提示词', '这张图片没有记录提示词'].includes(text) ? text : null;
        }, '复制提示词 finished');
        const textEntry = (await client.evaluate('window.picgenDesktop.smokeClipboardLog()')).at(-1);
        if (record.prompt) check(promptToast === '已复制提示词' && textEntry?.kind === 'text' && textEntry.text === record.prompt, '复制提示词 did not copy the record prompt');
        check(await client.evaluate('state.sequences.length') === sequences && await client.evaluate(`state.activeView === 'history'`), '复制提示词 created a sequence or switched the view');
        check((await usageOf(key)).dragCount === 2, '复制提示词 was counted');

        // A reference card opens the same menu: 活动序列 is disabled with its reason at the end of the row;
        // 新建序列 copies the card (same name, own cache file, no workspace) and counts nothing.
        await client.evaluate('showGenerationView(); true');
        const card = await waitFor(() => client.evaluate(`(() => {
            window.PicGenAppica?.dismissToasts?.();
            const sequence = getCurrentSequence();
            const reference = sequence.references[0];
            const node = reference && document.querySelector('#referenceStack [data-reference-id="' + CSS.escape(reference.id) + '"]');
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
            if (el.imageContextMenu.hidden || state.imageContextTarget?.kind !== 'reference') return null;
            const active = el.sendReferenceActiveBtn;
            const buttons = [...el.imageContextMenu.querySelectorAll('button')].filter(button => !button.hidden);
            return { sequenceId: sequence.id, sequences: state.sequences.length, id: reference.id, name: reference.name, filePath: reference.filePath || '',
                activeDisabled: active.disabled, hint: active.dataset.hint || '', items: buttons.map(button => button.id),
                clipped: ${CLIPPED_MENU_ITEMS} };
        })()`), 'Reference card image menu');
        check(card.activeDisabled && card.hint === '已在本序列', 'Reference card menu does not disable 活动序列 with its reason');
        check(card.items.join() === IMAGE_MENU_ITEMS.join() && card.clipped.length === 0, 'Reference card menu is not the full unified menu');
        await screenshot('10d-reference-card-menu.png');
        await clickControl('sendReferenceNewBtn');
        const sent = await waitFor(() => client.evaluate(`!state.sendingReference && state.sequences.length === ${card.sequences + 1} && state.currentSequenceId !== ${JSON.stringify(card.sequenceId)} ? (() => {
            const references = getCurrentSequence().references;
            return { count: references.length, name: references[0]?.name, id: references[0]?.id, filePath: references[0]?.filePath || '', workspace: 'workspace' in (references[0] || {}),
                source: state.sequences.find(s => s.id === ${JSON.stringify(card.sequenceId)}).references.length };
        })() : null`), 'Reference card sent to a new sequence');
        check(sent.count === 1 && sent.name === card.name && sent.id !== card.id && !sent.workspace && sent.source === 1, 'The new sequence did not get one copy of the card');
        check(!sent.filePath || sent.filePath !== card.filePath, 'The copied card shares the source card cache file');
        // Back on the history page, where the stage started: the similar stage uses its toolbar next.
        await clickControl('historyBtn');
        await waitFor(() => client.evaluate('state.activeView === "history"'), 'History after the image menu stage');
        return { items: layout.items.length, menuHeight: layout.height, copied: imageEntry, saved: savedName, dragCount: saved.dragCount,
            prompt: promptToast, referenceCard: { hint: card.hint, copiedTo: sent.count } };
    }
    // v3.1 similar view (WP11, WP12): the IPC contract, then the controller-owned DOM at 460×800.
    // Exported on its own so an isolated probe over a larger library can run exactly these checks; `fixture`
    // (from seedSimilarFixture) adds the exact expectations for the synthetic library. No check is skipped:
    // a library that cannot exercise one fails it.
    async function similarStage({ fixture = null } = {}) {
        const frames = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))';
        const snapshot = await waitFor(() => client.evaluate(`window.picgenDesktop.getSimilarityGroups({ foreground: true, preset: 'standard' })
            .then(snapshot => snapshot && snapshot.stage === 'final' ? snapshot : null)`), 'Similarity analysis final', 120000);
        check(snapshot.version === 3 && ['hd', 'h'].includes(snapshot.mode), 'Similarity snapshot has no v3 mode');
        check(snapshot.groups.every(group => Array.isArray(group.members) && group.members.length >= 2), 'Similarity group with fewer than 2 members');
        const grouped = snapshot.groups.reduce((sum, group) => sum + group.members.length, 0);
        check(grouped + snapshot.singles.length + snapshot.missing === snapshot.total, 'Similarity snapshot does not account for every record');
        check(snapshot.total === await client.evaluate('state.recentImages.length'), 'Similarity total differs from history');
        check(snapshot.groups.length >= 2 && snapshot.singles.length >= 1, `The similar library needs 2+ groups and 1+ single (got ${snapshot.groups.length} / ${snapshot.singles.length})`);
        if (fixture) {
            const groupOf = key => snapshot.groups.find(group => group.members.includes(key));
            for (const [tag, entries] of Object.entries(fixture.keys)) {
                if (entries.length < 2) continue;
                const group = groupOf(entries[0].key);
                check(group && entries.every(entry => group.members.includes(entry.key)), `Fixture group ${tag} was not grouped`);
            }
            // The near pair (d = 0.1026) is apart at 标准 in hd (0.09) and together in h (0.125).
            for (const tag of snapshot.mode === 'hd' ? ['near', 'near-calm', 'single'] : ['single']) check(snapshot.singles.includes(fixture.keys[tag][0].key), `Fixture image ${tag} is not a single at 标准`);
        }

        await clickControl('historySimilarBtn');
        await waitFor(() => client.evaluate(`state.similarSnapshot?.stage === 'final' && state.similarGroups.some(group => group.members.length >= 2)
            && document.querySelectorAll('#historyImages .similar-group').length > 0`), 'Similar image groups', 60000);
        check(await client.evaluate('state.similarGroups.every(group => !!group.id && group.members.length >= 2)'), 'Similar view shows a group with fewer than 2 images');
        check(await client.evaluate(`state.similarGroups.reduce((sum, group) => sum + group.members.length, 0) + state.similarSingles.length + state.similarMissing
            === getFilteredHistoryImages().length`), 'Similar view does not account for every filtered image');
        check(await client.evaluate('!el.historySimilarToolbar.hidden && !!el.historySimilarStatus.textContent && !el.historyImages.hasAttribute("aria-live")'), 'Similar toolbar or status missing');
        const basic = await client.evaluate(`state.similarSnapshot.mode === 'h'`);
        check(!basic || await client.evaluate(`el.historySimilarStatus.textContent.includes('基础模式') && el.historySimilarStatus.title.startsWith('视觉模型未加载')`), 'Basic mode is not shown in the status line');

        // Layout at 460×800: rows never overlap, every title is reachable, the strip cells are ~68 px.
        const layout = await atPanelSize(async () => {
            const measured = await client.evaluate(`(async () => {
                await ${frames};
                const host = el.historyImages;
                const rows = [...host.querySelectorAll('.similar-group')].slice(0, 50);
                const rects = rows.map(row => row.getBoundingClientRect());
                let overlaps = 0;
                for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
                    const a = rects[i], b = rects[j];
                    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps++;
                }
                let titleMisses = 0;
                for (const row of rows) {
                    const title = row.querySelector('.similar-group-title');
                    title.scrollIntoView({ block: 'center' });
                    await ${frames};
                    const rect = title.getBoundingClientRect();
                    if (!title.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))) titleMisses++;
                }
                host.scrollTop = 0;
                await ${frames};
                const heights = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
                const cell = rows[0].querySelector('.similar-strip > *').getBoundingClientRect();
                return { rows: rows.length, overlaps, titleMisses, heights: Math.round(heights), scrollHeight: host.scrollHeight, clientHeight: host.clientHeight,
                    rowHeight: Math.round(rects[0].height), cell: [Math.round(cell.width), Math.round(cell.height)], viewport: [innerWidth, innerHeight] };
            })()`);
            await screenshot('12-similar-history.png');
            return measured;
        });
        check(layout.rows >= 2 && layout.overlaps === 0, 'Similar group rows overlap');
        check(layout.titleMisses === 0, 'A similar group title is covered');
        check(layout.scrollHeight >= layout.heights, 'Similar list is shorter than its rows');

        // An open group stays open, with scrollTop within ±1 px, across 3 forced revisions. The list must
        // actually scroll, or the check proves nothing.
        await clickSelector('#historyImages .similar-group summary');
        await waitFor(() => client.evaluate(`!!document.querySelector('#historyImages .similar-group[open] .similar-group-content .history-item')`), 'Similar group opened');
        const openState = await client.evaluate(`(async () => {
            const host = el.historyImages;
            const row = host.querySelector('.similar-group[open]');
            const id = row.dataset.groupId;
            host.scrollTop = Math.max(0, Math.min(row.offsetTop + 40, host.scrollHeight - host.clientHeight));
            await ${frames};
            const before = host.scrollTop;
            const real = state.similarSnapshot;
            for (let i = 1; i <= 3; i++) {
                applySimilaritySnapshot({ ...real, revision: real.revision + 1000 + i });
                await ${frames};
            }
            const after = host.scrollTop;
            const same = state.similarRows.get(id) === row && row.open && row.isConnected;
            applySimilaritySnapshot(real);
            await ${frames};
            const actions = [...row.querySelectorAll('.similar-group-actions [data-action]')].map(button => button.dataset.action + (button.hidden ? ':hidden' : ''));
            return { id, same, before, after, members: row.querySelectorAll('.similar-group-content .history-item').length, actions };
        })()`);
        check(openState.before > 0, 'The similar list does not scroll, so scroll preservation was not tested');
        check(openState.same && Math.abs(openState.after - openState.before) <= 1, 'Open similar group lost its state or scroll across revisions');
        check(openState.actions.join() === 'select,find,collapse', 'Open group action row is wrong');

        const groupSelect = await groupSelectCancelStage(fixture);

        // Singles are hidden until the switch is on.
        const singles = await client.evaluate(`(() => ({ on: state.showSingles, count: state.similarSingles.length,
            complete: state.similarRendered >= state.similarOrder.length,
            rendered: el.historyImages.querySelectorAll('.similar-singles-grid .history-item').length,
            gridHidden: el.historyImages.querySelector('.similar-singles-grid').hidden }))()`);
        check(singles.count >= 1, 'The similar view shows no singles');
        if (!singles.on) check(singles.rendered === 0 && singles.gridHidden, 'Singles are shown while the switch is off');
        await clickControl('historySimilarSingles');
        const shownSingles = await waitFor(() => client.evaluate(`state.showSingles === ${!singles.on}
            ? el.historyImages.querySelectorAll('.similar-singles-grid .history-item').length : null`).then(value => value === null ? null : { value }), 'Singles switch');
        if (!singles.on) {
            check(singles.complete, 'The singles footer was not reached with every group row rendered');
            check(shownSingles.value === Math.min(singles.count, 60), 'Singles did not render after the switch was turned on');
        }
        await clickControl('historySimilarSingles');

        // 查找相似 from a group returns a same-prompt sibling; ✕ brings back the same rows at the same scroll.
        const target = await client.evaluate(`(() => {
            // The lowest rendered row, so the list is scrolled when 查找相似 parks it.
            for (const group of state.similarGroups.filter(group => state.similarRows.has(group.id)).reverse()) {
                const cover = group.members.find(member => historyImageKey(member) === group.cover) || group.members[0];
                const sibling = cover.prompt && group.members.find(member => member !== cover && member.prompt === cover.prompt);
                if (sibling) return { groupId: group.id, cover: historyImageKey(cover), sibling: historyImageKey(sibling) };
            }
            return null;
        })()`);
        check(target, 'No rendered group has a same-prompt sibling to find');
        await client.evaluate(`(() => { const row = state.similarRows.get(${JSON.stringify(target.groupId)}); if (row && !row.open) { row.open = true; renderSimilarGroupBody(row); } row?.scrollIntoView({ block: 'start' }); window.__uxFindRow = row; return true; })()`);
        await clickSelector(`#historyImages .similar-group[data-group-id="${target.groupId}"] [data-action="find"]`);
        const find = await waitFor(() => client.evaluate(`state.similarFind && !state.similarFind.loading ? {
            key: state.similarFind.key, analyzed: state.similarFind.result.analyzed, count: state.similarFind.dom.grid.children.length,
            title: state.similarFind.dom.title.textContent, parkedScrollTop: state.similarParked?.scrollTop ?? null,
            sibling: state.similarFind.result.items.find(item => item.key === ${JSON.stringify(target.sibling)}) || null,
            siblingShown: !!document.querySelector('#historyImages .similar-find-grid .history-item[data-history-id="' + CSS.escape(${JSON.stringify(target.sibling)}) + '"]') } : null`), 'Find similar results', 20000);
        check(find.key === target.cover && find.sibling?.samePrompt && find.siblingShown, 'Find similar did not return the same-prompt sibling');
        check(find.parkedScrollTop > 0, 'The similar list was not scrolled before 查找相似, so the restore was not tested');
        await atPanelSize(() => screenshot('12b-find-similar.png'));
        await clickSelector('#historyImages .similar-find-close');
        await waitFor(() => client.evaluate(`!state.similarFind && !!document.querySelector('#historyImages .similar-group') && !el.historySimilarToolbar.hidden`), 'Find similar closed');
        const restored = await client.evaluate(`(async () => {
            await ${frames};
            const row = state.similarRows.get(${JSON.stringify(target.groupId)});
            return { scrollTop: el.historyImages.scrollTop, sameRow: !!row && row === window.__uxFindRow && row.isConnected && row.open,
                results: el.historyImages.querySelectorAll('.similar-find-view').length };
        })()`);
        check(restored.sameRow && restored.results === 0, 'Closing 查找相似 rebuilt the similar rows');
        check(Math.abs(restored.scrollTop - find.parkedScrollTop) <= 1, `Closing 查找相似 lost the scroll position (${find.parkedScrollTop} → ${restored.scrollTop})`);
        find.restoredScrollTop = restored.scrollTop;

        // Presets are cuts of one dendrogram: switching re-cuts without decoding anything again, and the
        // fixture's near-prompt pair joins only at 宽松, so the group count must differ.
        const presets = {};
        const decoded = await client.evaluate('state.similarSnapshot.stats?.decoded ?? null');
        for (const preset of ['strict', 'loose', 'standard']) {
            await client.evaluate(`(() => { const select = el.historySimilarPreset; select.value = ${JSON.stringify(preset)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            const cut = await waitFor(() => client.evaluate(`state.similarSnapshot?.preset === ${JSON.stringify(preset)} && state.similarSnapshot.stage === 'final'
                ? { groups: state.similarGroups.length, decoded: state.similarSnapshot.stats?.decoded ?? null } : null`), `Similar preset ${preset}`);
            check(cut.decoded === decoded, `Switching to the ${preset} preset decoded images again`);
            presets[preset] = cut.groups;
        }
        check(presets.strict !== presets.loose, `严格 and 宽松 give the same group count (${presets.strict})`);
        check(presets.strict <= presets.standard && presets.loose >= presets.standard, 'Preset group counts are not monotonic');
        if (fixture) {
            // Every other fixture group is identical at all three cuts; only the near pair moves.
            check(presets.loose === presets.strict + 1, 'The near-prompt pair did not join between 严格 and 宽松');
            check(presets[snapshot.mode === 'hd' ? 'standard' : 'strict'] === presets.strict && presets.loose === (snapshot.mode === 'hd' ? presets.standard + 1 : presets.standard), 'The near-prompt pair joined at the wrong cut');
        }
        await clickControl('historyGridBtn');
        return { mode: snapshot.mode, featureVersion: snapshot.featureVersion, groups: snapshot.groups.length, singles: snapshot.singles.length,
            missing: snapshot.missing, total: snapshot.total, layout, openState, groupSelect, find, presets };
    }

    // 选中本组 selects the group's visible members; the used ones stay out of 移到回收站 by default, and
    // 取消 in the in-app confirm dialog removes nothing.
    async function groupSelectCancelStage(fixture) {
        const frames = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))';
        const choice = await client.evaluate(`(() => {
            const used = image => (Number(image?.dragCount) || 0) + (Number(image?.referenceCount) || 0) > 0;
            const plans = state.similarGroups.filter(group => !group.provisional && state.similarRows.has(group.id)).map(group => ({
                id: group.id, cover: group.cover, keys: group.members.map(historyImageKey),
                usedKeys: group.members.filter(used).map(historyImageKey) })).filter(plan => plan.keys.length > plan.usedKeys.length);
            const wanted = ${JSON.stringify(fixture?.cover || null)};
            return plans.find(plan => wanted ? plan.keys.includes(wanted) : plan.usedKeys.length > 0) || (wanted ? null : plans[0]) || null;
        })()`);
        check(choice, 'No finished group has an unused member');
        if (fixture) {
            check(choice.cover === fixture.cover, 'The most-used member is not the fixture group cover');
            check([...choice.usedKeys].sort().join() === [fixture.cover, fixture.protected].sort().join(), 'Fixture group usage mismatch');
        }
        const trashable = choice.keys.length - choice.usedKeys.length;
        const before = await client.evaluate('window.picgenDesktop.listHistoryImages().then(items => items.length)');
        await client.evaluate('clearHistorySelection()');
        await client.evaluate(`(() => { const row = state.similarRows.get(${JSON.stringify(choice.id)}); if (!row.open) { row.open = true; renderSimilarGroupBody(row); } row.scrollIntoView({ block: 'start' }); return true; })()`);
        await clickSelector(`#historyImages .similar-group[data-group-id="${choice.id}"] [data-action="select"]`);
        const bar = await waitFor(() => client.evaluate(`state.historySelectedIds.size ? {
            selected: [...state.historySelectedIds].sort(), meta: el.historySelectionMeta.textContent, trashLabel: el.historyTrashBtn.textContent.trim(),
            switchShown: !el.historyTrashProtectedToggle.hidden, switchText: el.historyTrashProtectedText.textContent } : null`), 'Group selection');
        check(bar.selected.join() === [...choice.keys].sort().join(), `选中本组 selected ${bar.selected.join()} instead of ${[...choice.keys].sort().join()}`);
        check(bar.switchShown && bar.switchText === `同时删除拖用过的 (${choice.usedKeys.length})`, 'The protected switch is wrong');
        check(bar.meta === `已选择 ${choice.keys.length} 张（含 ${choice.usedKeys.length} 张拖用过，默认保留）` && bar.trashLabel === `移到回收站 (${trashable})`, 'Group selection bar text is wrong');
        await atPanelSize(async () => {
            await client.evaluate(`(async () => { state.similarRows.get(${JSON.stringify(choice.id)}).scrollIntoView({ block: 'start' }); await ${frames}; return true; })()`);
            await screenshot('12c-group-selected.png');
        });
        await clickControl('historyTrashBtn');
        await waitFor(() => client.evaluate(`!!document.querySelector('#confirmOkBtn') && document.getElementById('confirmOverlay')?.hidden === false`), 'Trash confirm dialog');
        const dialog = await client.evaluate(`({ title: document.getElementById('confirmTitle')?.textContent || '', message: document.getElementById('confirmMessage')?.textContent || '',
            ok: document.getElementById('confirmOkBtn')?.textContent || '' })`);
        check(dialog.title === '移到回收站' && dialog.ok === '移到回收站' && dialog.message.startsWith(`将 ${trashable} 张图片`)
            && dialog.message.includes(`保留：拖用过的 ${choice.usedKeys.length} 张。`), 'Trash confirm dialog text is wrong');
        await atPanelSize(() => screenshot('12d-trash-confirm.png'));
        await clickControl('confirmCancelBtn');
        await waitFor(() => client.evaluate(`document.getElementById('confirmOverlay')?.hidden !== false`), 'Trash confirm closed');
        const after = await client.evaluate(`window.picgenDesktop.listHistoryImages().then(items => ({ count: items.length, local: state.recentImages.length,
            kept: ${JSON.stringify(choice.keys)}.every(key => items.some(item => historyImageKey(item) === key)) }))`);
        check(after.count === before && after.local === before && after.kept, '取消 in the trash dialog removed images');
        await clickControl('historyClearSelectionBtn');
        check(await client.evaluate('state.historySelectedIds.size === 0'), '清除 did not clear the group selection');
        return { groupId: choice.id, selected: bar.selected.length, kept: choice.usedKeys.length, meta: bar.meta, cancelled: true };
    }
    async function afterRestart(result) {
        check(await client.evaluate(`(() => { const sequence = state.sequences.find(s => s.id === ${JSON.stringify(result.activeId)}); return sequence?.references[0]?.id === ${JSON.stringify(result.ids[0])} && resolvePromptMentions(sequence) === '参考图1 follows 参考图2'; })()`), 'Reference ordering did not survive restart');
        // Usage counters live in the sidecar and are projected onto every history listing.
        const usage = await client.evaluate(`window.picgenDesktop.listHistoryImages().then(items => {
            const find = key => items.find(item => historyImageKey(item) === key) || {};
            const pick = key => ({ dragCount: find(key).dragCount || 0, referenceCount: find(key).referenceCount || 0 });
            return { first: pick(${JSON.stringify(result.usage.firstKey)}), second: pick(${JSON.stringify(result.usage.secondKey)}),
                cover: pick(${JSON.stringify(result.fixture.cover)}), protected: pick(${JSON.stringify(result.fixture.protected)}) };
        })`);
        check(usage.first.referenceCount === 2 && usage.second.referenceCount === 1, 'Reference-use counters did not survive restart');
        // 复制图片 + 另存为 on the second image: two take-outs, kept in the same sidecar.
        check(usage.second.dragCount === 2 && !usage.first.dragCount, '复制 / 另存 counters did not survive restart');
        check(usage.cover.dragCount === 1 && usage.cover.referenceCount === 1 && usage.protected.referenceCount === 1, 'Fixture usage counters did not survive restart');
        return true;
    }
    return { run, afterRestart, similarStage };
};
