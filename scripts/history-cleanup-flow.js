// Usage counting, multi-select delete and the in-app recycle bin end to end (v3.1 WP12; usage design §8 steps 1–7),
// driven over CDP by scripts/packaged-smoke.js inside its isolated profile (profileDir). Deleting only
// marks an image (its file stays in place); purging hard-deletes it, and only files inside profileDir are
// ever purged. PICGEN_SMOKE_PURGE_FAIL must be set to REFUSE_TOKEN for this launch, so a purge refuses
// exactly the one file whose name carries it.
const fs = require('node:fs/promises');
const path = require('node:path');

const REFUSE_TOKEN = 'cleanflow-refuse';
const PROMPT = 'origami paper cranes on a blue linen table';
// Oldest first. a gets a drag-out, b a reference drop: both are protected. c and d are unused; d's file
// name carries REFUSE_TOKEN. PURGE_ID is saved apart from the others, marked and purged for good.
const IDS = ['cleanflow-a', 'cleanflow-b', 'cleanflow-c', `${REFUSE_TOKEN}-d`];
const PURGE_ID = 'cleanflow-purge';

module.exports = function historyCleanupFlow({ client, check, clickControl, clickSelector, waitFor, screenshot, profileDir }) {
    const frames = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))';
    check(profileDir && path.isAbsolute(profileDir), 'The cleanup flow needs the isolated profile directory');
    const inProfile = filePath => {
        const relative = path.relative(path.resolve(profileDir), path.resolve(filePath));
        return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
    };

    async function atPanelSize(action, width = 460) {
        await client.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
        // Earlier toasts would cover the selection bar; a dialog gets its open animation.
        await client.evaluate('window.PicGenAppica?.dismissToasts?.(); new Promise(resolve => setTimeout(resolve, 450))');
        try { return await action(); } finally { await client.send('Emulation.clearDeviceMetricsOverride'); }
    }

    const exists = filePath => fs.access(filePath).then(() => true, () => false);
    const binPaths = async () => (await client.evaluate('window.picgenDesktop.listHistoryBin()')).items.map(item => path.resolve(item.filePath)).sort();
    const historyIdOf = filePath => client.evaluate(`window.picgenDesktop.listHistoryImages().then(items => items.find(item => item.filePath === ${JSON.stringify(filePath)})?.id || '')`);
    // Every purge in the smoke names its paths, and every path must lie inside the isolated profile.
    async function purge(paths) {
        check(paths.length > 0 && paths.every(inProfile), 'The smoke may only purge files inside its isolated profile');
        return client.evaluate(`window.picgenDesktop.purgeHistoryBin({ paths: ${JSON.stringify(paths)} })`);
    }
    const usageOf = key => client.evaluate(`window.picgenDesktop.listHistoryImages().then(items => {
        const image = items.find(item => historyImageKey(item) === ${JSON.stringify(key)});
        return image ? { dragCount: image.dragCount || 0, referenceCount: image.referenceCount || 0, prompt: image.prompt || '', filePath: image.filePath } : null;
    })`);
    const localUsage = key => client.evaluate(`(() => {
        const image = state.recentImages.find(item => historyImageKey(item) === ${JSON.stringify(key)});
        return image ? { dragCount: image.dragCount || 0, referenceCount: image.referenceCount || 0 } : null;
    })()`);

    // A real Ctrl+click on each image tile (multi-select toggle without opening the detail drawer).
    async function toggleCheck(key) {
        await clickSelector(`#historyImages .history-item[data-history-id="${key}"] .history-thumb`, { modifiers: 2 });
    }
    const selectionBar = () => client.evaluate(`({ selected: [...state.historySelectedIds].sort(), meta: el.historySelectionMeta.textContent,
        trashLabel: el.historyTrashBtn.textContent.trim(), switchShown: !el.historyTrashProtectedToggle.hidden,
        switchText: el.historyTrashProtectedText.textContent, include: el.historyTrashIncludeProtected.checked })`);

    async function trashAndConfirm(expectedCount) {
        await clickControl('historyTrashBtn');
        await waitFor(() => client.evaluate(`document.getElementById('confirmOverlay')?.hidden === false && !!document.getElementById('confirmOkBtn')`), 'Trash confirm dialog');
        const message = await client.evaluate(`document.getElementById('confirmMessage')?.textContent || ''`);
        check(message.startsWith(`将 ${expectedCount} 张图片`), `Unexpected confirm text: ${message}`);
        await clickControl('confirmOkBtn');
        return waitFor(() => client.evaluate(`!state.historyTrashBusy && !el.historyTrashResult.hidden ? {
            text: el.historyTrashResultText.textContent, retry: !el.historyTrashRetryBtn.hidden,
            selected: [...state.historySelectedIds].sort() } : null`), 'Trash result strip', 30000).then(result => ({ ...result, message }));
    }

    async function run() {
        check((await binPaths()).length === 0, 'The in-app bin is not empty before the cleanup flow');
        // 1. Four images with the same prompt and pixels.
        const saved = await client.evaluate(`(async () => {
            window.picgenDesktop.setExpanded(true);
            if (typeof closeSettings === 'function') closeSettings();
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 160;
            const context = canvas.getContext('2d');
            context.fillStyle = '#1d4ed8'; context.fillRect(0, 0, 160, 160);
            context.fillStyle = '#fef3c7'; context.beginPath(); context.moveTo(20, 130); context.lineTo(80, 25); context.lineTo(140, 130); context.fill();
            context.fillStyle = '#f97316'; context.fillRect(60, 90, 40, 40);
            const base64 = canvas.toDataURL('image/png').split(',')[1];
            const now = Date.now();
            const ids = ${JSON.stringify(IDS)};
            const records = [];
            for (let i = 0; i < ids.length; i++) {
                const record = await window.picgenDesktop.saveGeneratedImage({ id: ids[i], base64, mimeType: 'image/png', prompt: ${JSON.stringify(PROMPT)},
                    ratio: '1:1', model: 'cleanup-fixture', providerName: 'Cleanup fixture', createdAt: now - (ids.length - i) * 1000 });
                records.push({ key: historyImageKey(record), filePath: record.filePath, fileName: record.fileName });
            }
            await refreshRecentImages({ full: true });
            return records;
        })()`);
        check(saved.length === 4 && saved.every(record => record.key && record.filePath && inProfile(record.filePath)), 'Cleanup fixture was not saved');
        check(path.basename(saved[3].filePath).toLowerCase().includes(REFUSE_TOKEN) && saved.slice(0, 3).every(record => !path.basename(record.filePath).toLowerCase().includes(REFUSE_TOKEN)),
            'Only the last fixture file may carry the refuse token');
        const [a, b, c, d] = saved;

        // 1b. History search syntax in the real renderer: words in any order, ratio, a phrase, an exclusion.
        const searchHits = await client.evaluate(`(() => {
            const keys = ${JSON.stringify(saved.map(record => record.key))};
            const count = query => {
                el.historySearchInput.value = query;
                return getFilteredHistoryImages().filter(image => keys.includes(historyImageKey(image))).length;
            };
            const result = {
                api: !!window.PicGenHistorySearch,
                words: count('linen ORIGAMI'),
                ratio: count('cranes １：１'),
                phrase: count('"paper cranes"'),
                badPhrase: count('"cranes paper"'),
                excluded: count('origami -cleanup-fixture')
            };
            el.historySearchInput.value = '';
            return result;
        })()`);
        check(searchHits.api && searchHits.words === 4 && searchHits.ratio === 4 && searchHits.phrase === 4
            && searchHits.badPhrase === 0 && searchHits.excluded === 0, `History search syntax: ${JSON.stringify(searchHits)}`);

        // 1c. 以图搜图 with pasted bytes of the same drawing (never saved): the fixtures come back through the
        //     real host, then the same through the UI entry point, and nothing joins the history.
        const drawing = `(() => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 160;
            const context = canvas.getContext('2d');
            context.fillStyle = '#1d4ed8'; context.fillRect(0, 0, 160, 160);
            context.fillStyle = '#fef3c7'; context.beginPath(); context.moveTo(20, 130); context.lineTo(80, 25); context.lineTo(140, 130); context.fill();
            context.fillStyle = '#f97316'; context.fillRect(60, 90, 40, 40);
            return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        })()`;
        const historyBefore = await client.evaluate('state.recentImages.length');
        const byImage = await waitFor(() => client.evaluate(`(async () => {
            const blob = await ${drawing};
            const result = await window.picgenDesktop.getSimilarNeighborsOfImage({ bytes: await blob.arrayBuffer(), mimeType: 'image/png', limit: 20 });
            const keys = ${JSON.stringify(saved.map(record => record.key))};
            const hits = (result.items || []).filter(item => keys.includes(item.key));
            return hits.length === keys.length ? { mode: result.mode, top: hits[0].similarity, error: result.error || '' } : null;
        })()`), 'Image search finds the four fixtures', 90000);
        check(byImage.top >= 90 && !byImage.error, `Image search scored the identical drawing ${byImage.top} (${byImage.mode})`);
        // 包含相同元素 in the real utility process: the idle crop pass covers the library (it decodes every
        // original once more, at 448 px), then the subject query finds the fixtures through their crops.
        const byElement = await waitFor(() => client.evaluate(`(async () => {
            const blob = await ${drawing};
            const result = await window.picgenDesktop.getSimilarNeighborsOfImage({ bytes: await blob.arrayBuffer(), mimeType: 'image/png', limit: 20, match: 'element' });
            if (result.error) return { error: result.error };
            const keys = ${JSON.stringify(saved.map(record => record.key))};
            const hits = (result.items || []).filter(item => keys.includes(item.key));
            return result.element && result.cropped === result.indexed && hits.length === keys.length
                ? { top: hits[0].similarity, cropped: result.cropped, indexed: result.indexed } : null;
        })()`), 'Element search after the crop pass', 180000);
        check(!byElement.error && byElement.top >= 90, `Element search: ${JSON.stringify(byElement)}`);
        await clickControl('historyBtn');
        await client.evaluate(`(async () => {
            const blob = await ${drawing};
            openFindSimilarByImageFile(new File([blob], 'query.png', { type: 'image/png' }));
            return true;
        })()`);
        const imageView = await waitFor(() => client.evaluate(`(() => {
            const find = state.similarFind;
            if (!find?.external || find.loading || !find.dom) return null;
            return { title: find.dom.title.textContent, items: find.dom.grid.children.length, note: find.dom.note.hidden ? '' : find.dom.note.textContent,
                togglesHidden: find.dom.samePrompt.hidden && find.dom.visual.hidden, blobThumb: find.dom.thumb.src.startsWith('blob:'),
                match: find.match, elementPressed: find.dom.element?.getAttribute('aria-pressed') };
        })()`), 'Image search results view', 30000);
        check(imageView.items >= 4 && /^与此图相似 · \d+ 张$/.test(imageView.title) && imageView.togglesHidden && imageView.blobThumb
            && imageView.match === 'element' && imageView.elementPressed === 'true', `Image search view: ${JSON.stringify(imageView)}`);
        await atPanelSize(() => screenshot('29-image-search.png'));
        await clickSelector('.similar-find-head [data-match="whole"]');
        await waitFor(() => client.evaluate(`state.similarFind?.match === 'whole' && !state.similarFind.loading
            && state.similarFind.dom.whole.getAttribute('aria-pressed') === 'true'`), '整图相似 toggle', 30000);
        await client.evaluate('closeFindSimilar(); true');

        // 1d. The filter panel with real clicks: 筛选 opens it, 其他 (the fixtures' vendor) and 未用过 narrow the
        //     list, the chips show both, the sort menu switches to 文件名, 清除全部 resets everything.
        await client.evaluate(`(() => { setHistoryFiltersExpanded(false); clearHistoryFilters(); el.historySearchInput.value = 'origami'; applyHistoryFilters(); return true; })()`);
        await clickControl('historyFilterToggle');
        await waitFor(() => client.evaluate(`!!document.getElementById('historyFilterPanelBody')`), 'Filter panel open');
        await clickSelector('#historyVendorFilter [data-value="other"]');
        await clickSelector('#historyUsageFilter [data-value="unused"]');
        const filtered = await waitFor(() => client.evaluate(`(() => {
            const chips = [...document.querySelectorAll('#historyFilterChips [data-chip]')].map(chip => chip.dataset.chip);
            return chips.length === 2 ? { chips, vendors: state.historyFilters.vendors, usage: state.historyFilters.usage,
                badge: document.querySelector('#historyFilterToggle .history-filter-badge')?.textContent || '', shown: getFilteredHistoryImages().length } : null;
        })()`), 'Filter chips');
        check(filtered.chips.join() === 'vendor:other,usage:unused' && filtered.badge === '2' && filtered.shown >= 1,
            `Filter panel: ${JSON.stringify(filtered)}`);
        await atPanelSize(() => screenshot('29-filter-panel.png'));
        await atPanelSize(() => screenshot('29-filter-panel-720.png'), 720);
        await atPanelSize(() => screenshot('29-filter-panel-1100.png'), 1100);
        // 自定义 opens the calendar range picker; a picked range becomes one chip.
        await clickSelector('#historyDatePreset [data-value="custom"]');
        await waitFor(() => client.evaluate(`!!document.querySelector('[data-slot="calendar"], .rdp-root, [role="grid"]')`), 'Calendar open', 8000);
        await atPanelSize(() => screenshot('29-filter-calendar.png'));
        await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
        const dateChip = await client.evaluate(`(() => {
            setHistoryFilters({ ...state.historyFilters, date: { preset: 'custom', from: '2020-01-01', to: '2099-12-31' } });
            return [...document.querySelectorAll('#historyFilterChips [data-chip]')].map(chip => chip.textContent.trim());
        })()`);
        check(dateChip.some(text => text.startsWith('1/1 – 12/31')), `Custom date chip: ${JSON.stringify(dateChip)}`);
        // Vendor marks, with a few in-memory model names (restored right after the screenshot).
        await client.evaluate(`(() => {
            window.__vendorFixture = state.recentImages.slice(0, 3).map(image => [image, image.model]);
            const names = ['gemini-3.1-flash-image', 'gpt-image-2', 'doubao-seedream-5-0-pro-260628'];
            window.__vendorFixture.forEach(([image], i) => { image.model = names[i]; });
            setHistoryFilters({ ...state.historyFilters, vendors: ['gemini', 'gpt', 'seedream', 'other'], date: { preset: '', from: '', to: '' } });
            return true;
        })()`);
        await atPanelSize(() => screenshot('29-filter-vendors.png'));
        await client.evaluate(`(() => {
            window.__vendorFixture.forEach(([image, model]) => { image.model = model; });
            setHistoryFilters({ ...state.historyFilters, vendors: ['other'] });
            return true;
        })()`);
        await clickControl('historyFilterToggle');
        await waitFor(() => client.evaluate(`!document.getElementById('historyFilterPanelBody') && !!document.getElementById('historyFilterChips')`), 'Panel collapses, chips stay');
        await atPanelSize(() => screenshot('29-filter-chips.png'));
        await clickControl('historySortButton');
        await clickSelector('[data-sort="name"]');
        await waitFor(() => client.evaluate(`state.historySort === 'name'`), 'Sort menu picks 文件名');
        await client.evaluate(`setHistorySort('newest'); true`);
        await clickControl('historyClearFiltersBtn');
        check(await client.evaluate(`!document.getElementById('historyFilterChips') && !el.historySearchInput.value && PicGenHistoryFilters.activeCount(state.historyFilters) === 0`),
            '清除全部 did not reset the search and filters');
        // The date/name sort means nothing where similarity orders the list: hidden in the similar view.
        await clickControl('historySimilarBtn');
        await waitFor(() => client.evaluate(`!document.getElementById('historySortButton')`), 'Sort hidden in the similar view');
        await clickControl('historyGridBtn');
        await waitFor(() => client.evaluate(`!!document.getElementById('historySortButton')`), 'Sort back in the grid');

        // The eye beside the pin turns hover previews off (remembered) and back on.
        await clickControl('hoverPreviewToggleBtn');
        const hoverOff = await client.evaluate(`(() => {
            const item = document.querySelector('#historyImages .history-item');
            const rect = item.getBoundingClientRect();
            item.dispatchEvent(new MouseEvent('mouseenter', { clientX: rect.left + 20, clientY: rect.top + 20, screenX: 100, screenY: 100 }));
            return { enabled: state.hoverPreviewEnabled, pressed: document.getElementById('hoverPreviewToggleBtn').getAttribute('aria-pressed'),
                stored: localStorage.getItem('picgen.hoverPreview'), previewing: !!state.hoverPreviewImage };
        })()`);
        check(!hoverOff.enabled && hoverOff.pressed === 'false' && hoverOff.stored === 'off' && !hoverOff.previewing, `Hover preview off: ${JSON.stringify(hoverOff)}`);
        await clickControl('hoverPreviewToggleBtn');
        check(await client.evaluate(`state.hoverPreviewEnabled && localStorage.getItem('picgen.hoverPreview') === 'on'`), 'Hover preview back on');
        check(await client.evaluate('state.similarFind === null') && await client.evaluate('state.recentImages.length') === historyBefore,
            'Image search changed the history');

        // 2. A native drag released outside every PicGen window: dragCount +1, nothing else.
        const outside = await client.evaluate(`(() => {
            rememberDraggedRecentImage(state.recentImages.find(item => historyImageKey(item) === ${JSON.stringify(a.key)}));
            return window.picgenDesktop.smokeDragOutcome({ filePath: ${JSON.stringify(a.filePath)}, point: { x: -32000, y: -32000 } });
        })()`);
        check(outside?.outcome === 'outside' && outside.counted === true, 'A drag-out outside the window was not counted');
        await waitFor(async () => {
            const [remote, local] = [await usageOf(a.key), await localUsage(a.key)];
            return remote?.dragCount === 1 && remote.referenceCount === 0 && local?.dragCount === 1;
        }, 'Drag-out counter');

        // 3. The same gesture released on the reference band: referenceCount +1, dragCount +0, one reference.
        await client.evaluate(`(() => {
            showGenerationView();
            const sequence = getCurrentSequence();
            sequence.model = 'gpt-image-2'; sequence.references = []; loadCurrentSequenceToForm();
            return true;
        })()`);
        const drop = await waitFor(() => client.evaluate(`(async () => {
            await ${frames};
            const rail = el.referenceRail;
            const rect = rail && !rail.hidden ? rail.getBoundingClientRect() : null;
            if (!rect || !rect.width || !rect.height) return null;
            const point = { x: Math.round(window.screenX + rect.left + rect.width / 2), y: Math.round(window.screenY + rect.top + rect.height / 2) };
            return referenceDropHitFromPoint(point) ? { point, references: getCurrentSequence().references.length } : null;
        })()`), 'Reference band on screen');
        const inside = await client.evaluate(`(() => {
            rememberDraggedRecentImage(state.recentImages.find(item => historyImageKey(item) === ${JSON.stringify(b.key)}));
            return window.picgenDesktop.smokeDragOutcome({ filePath: ${JSON.stringify(b.filePath)}, point: ${JSON.stringify(drop.point)} });
        })()`);
        check(inside?.outcome === 'inside' && !inside.counted, 'A release on the reference band was counted as a drag-out');
        await waitFor(async () => {
            const [remote, local] = [await usageOf(b.key), await localUsage(b.key)];
            return remote?.referenceCount === 1 && local?.referenceCount === 1;
        }, 'Reference drop counter');
        await new Promise(resolve => setTimeout(resolve, 800));
        const afterDrop = { usage: await usageOf(b.key), references: await client.evaluate('getCurrentSequence().references.length') };
        check(afterDrop.usage.dragCount === 0 && afterDrop.usage.referenceCount === 1, 'The reference drop was counted twice or as a drag-out');
        check(afterDrop.references === drop.references + 1, 'The reference drop did not add exactly one reference');

        // 4. Multi-select delete in the grid: a (protected), c and d are checked; the switch shows for a and
        //    turns it on and off; d is unchecked again. The confirmed delete marks exactly c (a is kept by
        //    default): its file stays where it is.
        await clickControl('historyBtn');
        await clickControl('historyGridBtn');
        await client.evaluate('clearHistorySelection()');
        for (const record of [a, c, d]) await toggleCheck(record.key);
        let bar = await waitFor(async () => { const value = await selectionBar(); return value.selected.length === 3 ? value : null; }, 'Multi-selection');
        check(bar.selected.join() === [a.key, c.key, d.key].sort().join(), `Ctrl+click selected ${bar.selected.join()}`);
        check(bar.switchShown && bar.switchText === '同时删除拖用过的 (1)' && !bar.include, 'The protected switch is wrong');
        check(bar.meta === '已选择 3 张（含 1 张拖用过，默认保留）' && bar.trashLabel === '移到回收站 (2)', `Unexpected selection bar: ${bar.meta} / ${bar.trashLabel}`);
        await clickControl('historyTrashProtectedToggle');
        bar = await selectionBar();
        check(bar.include && bar.trashLabel === '移到回收站 (3)' && bar.meta === '已选择 3 张（含 1 张拖用过，将一并删除）', 'The protected switch did not include a');
        await clickControl('historyTrashProtectedToggle');
        await toggleCheck(d.key);
        bar = await selectionBar();
        check(bar.selected.join() === [a.key, c.key].sort().join() && !bar.include && bar.trashLabel === '移到回收站 (1)', 'Unchecking d did not update the selection');
        check(await client.evaluate('el.historyDetailDrawer.hidden'), 'A Ctrl+click opened the detail drawer');
        await atPanelSize(() => screenshot('30-selection-trash.png'));
        const first = await trashAndConfirm(1);
        check(first.message.includes('保留：拖用过的 1 张。'), 'The confirm text does not name what is kept');
        check(first.text.startsWith('已移到回收站 1 张。') && !first.retry, `Unexpected trash result: ${first.text}`);
        check(first.selected.join() === a.key, 'The kept protected image did not stay selected');
        check((await binPaths()).join() === path.resolve(c.filePath), 'The in-app bin did not receive exactly the selected image');
        check(await exists(c.filePath), 'Marking moved or deleted the file');
        const listed = await client.evaluate(`window.picgenDesktop.listHistoryImages().then(items => items.map(item => historyImageKey(item)))`);
        check(!listed.includes(c.key) && [a, b, d].every(record => listed.includes(record.key)), 'History does not match the trash');
        check(!(await client.evaluate(`state.recentImages.some(item => historyImageKey(item) === ${JSON.stringify(c.key)})`)), 'The trashed record is still shown');
        await atPanelSize(() => screenshot('31-trash-result.png'));
        await clickControl('historyTrashDismissBtn');
        check(await client.evaluate('el.historyTrashResult.hidden'), 'Dismissing the result did not hide it');
        await client.evaluate('clearHistorySelection()');

        // 5. d is marked too; purging it is refused (PICGEN_SMOKE_PURGE_FAIL), so file and entry stay.
        const dId = await historyIdOf(d.filePath);
        check(dId, 'd is not in history');
        const markedD = await client.evaluate(`window.picgenDesktop.trashHistoryImages({ requestId: 'cleanflow-mark-d', reason: 'selection',
            items: [{ id: ${JSON.stringify(dId)}, filePath: ${JSON.stringify(d.filePath)} }] })`);
        check(markedD.trashed.length === 1 && await exists(d.filePath), 'd was not marked in place');
        const refused = await purge([d.filePath]);
        check(refused.deleted.length === 0 && refused.failed.length === 1 && await exists(d.filePath), 'The refused purge deleted the file');
        check((await binPaths()).join() === [c.filePath, d.filePath].map(filePath => path.resolve(filePath)).sort().join(), 'A refused purge dropped its bin entry');

        // 5b. A bin tile opens the unified image menu (not the native one) without touching the bin selection;
        //     查找相似 is disabled with its reason at the end of the row until the image is restored. Esc closes it.
        await client.evaluate('openHistoryRecycleBin(); true');
        const binMenu = await waitFor(() => client.evaluate(`(() => {
            if (state.activeView !== 'bin') return null;
            const tile = [...document.querySelectorAll('#historyBinImages .history-bin-item')]
                .find(node => node.dataset.binPath.replace(/\\//g, '\\\\').toLowerCase() === ${JSON.stringify(path.resolve(c.filePath).toLowerCase())});
            const rect = tile?.getBoundingClientRect();
            if (!rect?.width || !rect.height) return null;
            tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10 }));
            if (el.imageContextMenu.hidden) return null;
            return { kind: state.imageContextTarget?.kind, findDisabled: el.findSimilarImageBtn.disabled, hint: el.findSimilarImageBtn.dataset.hint || '',
                enabled: ['sendReferenceActiveBtn', 'sendReferenceNewBtn', 'workspaceImageBtn', 'copyImageBtn', 'copyPromptImageBtn', 'saveImageAsBtn'].every(id => !el[id].disabled),
                selected: state.historyBin.selected.size };
        })()`), 'Bin tile image menu');
        check(binMenu.kind === 'bin' && binMenu.findDisabled && binMenu.hint === '还原后可用' && binMenu.enabled, `The bin tile menu is wrong: ${JSON.stringify(binMenu)}`);
        check(binMenu.selected === 0, 'Right-clicking a bin tile changed the bin selection');
        await screenshot('31b-bin-image-menu.png');
        for (const type of ['rawKeyDown', 'keyUp']) await client.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await waitFor(() => client.evaluate('el.imageContextMenu.hidden && state.imageContextTarget === null'), 'Esc closes the image menu');
        await clickControl('historyBtn');

        // 6. Restore everything: c and d come back into history with their prompt, the bin is empty.
        const restored = await client.evaluate('window.picgenDesktop.restoreHistoryBin()');
        check(restored.restored.length === 2 && restored.missing.length === 0 && restored.failed.length === 0, 'Restore did not bring both images back');
        const revived = await waitFor(async () => {
            const remote = await usageOf(c.key);
            const local = await client.evaluate(`state.recentImages.find(item => historyImageKey(item) === ${JSON.stringify(c.key)})?.prompt || ''`);
            return remote?.prompt === PROMPT && local === PROMPT ? remote : null;
        }, 'Bin restore', 20000);
        check((await usageOf(d.key)) !== null, 'd did not come back into history');
        check((await binPaths()).length === 0, 'The in-app bin is not empty after the restore');

        // 7. A separate image is marked by drag (no confirmation, protected or not) and purged for good.
        const doomed = await client.evaluate(`(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 64;
            const context = canvas.getContext('2d');
            context.fillStyle = '#10b981'; context.fillRect(0, 0, 64, 64);
            const record = await window.picgenDesktop.saveGeneratedImage({ id: ${JSON.stringify(PURGE_ID)}, base64: canvas.toDataURL('image/png').split(',')[1],
                mimeType: 'image/png', prompt: 'cleanup purge fixture', ratio: '1:1', model: 'cleanup-fixture', providerName: 'Cleanup fixture', createdAt: Date.now() });
            return { id: record.id, filePath: record.filePath };
        })()`);
        check(doomed?.id && inProfile(doomed.filePath), 'The purge fixture was not saved inside the profile');
        const dragMarked = await client.evaluate(`window.picgenDesktop.trashHistoryImages({ requestId: 'cleanflow-mark-purge', reason: 'drag',
            includeProtected: true, confirmProtected: [${JSON.stringify(doomed.id)}], items: [${JSON.stringify(doomed)}] })`);
        check(dragMarked.trashed.length === 1 && await exists(doomed.filePath), 'The drag mark did not keep the file in place');
        const purged = await purge([doomed.filePath]);
        check(purged.deleted.length === 1 && purged.failed.length === 0 && !(await exists(doomed.filePath)), 'The purge did not delete the file');
        check((await binPaths()).length === 0 && (await historyIdOf(doomed.filePath)) === '', 'The purged image is still listed');
        await clickControl('historyGridBtn');
        return { keys: saved.map(record => record.key), protectedKeys: [a.key, b.key], trashed: c.key, refused: d.key,
            revivedPrompt: revived.prompt === PROMPT, dropReferences: afterDrop.references - drop.references, confirm: first.message,
            purgeRefused: refused.failed.length, purgedPath: doomed.filePath };
    }

    // 8. After a restart the counters and the restored records persist, and the purged file stays gone.
    async function afterRestart(result) {
        const [a, b, c, d] = result.keys;
        // The first listing after a restart can wait on main's startup work; poll it in short slices so a
        // slow start is measured and reported instead of tripping the 20 s CDP timeout.
        const started = Date.now();
        await waitFor(() => client.evaluate(`Promise.race([window.picgenDesktop.listHistoryImages().then(items => items.length > 0),
            new Promise(resolve => setTimeout(() => resolve(false), 4000))])`), 'History listing after the cleanup restart', 120000);
        const firstListingMs = Date.now() - started;
        const usage = { a: await usageOf(a), b: await usageOf(b), c: await usageOf(c), d: await usageOf(d) };
        check(usage.a?.dragCount === 1 && usage.a.referenceCount === 0, 'The drag-out counter did not survive restart');
        check(usage.b?.referenceCount === 1 && usage.b.dragCount === 0, 'The reference counter did not survive restart');
        check(usage.c?.prompt === PROMPT && usage.d, 'The restored records did not survive restart');
        check((await binPaths()).length === 0, 'The in-app bin is not empty after the restart');
        check(!(await exists(result.purgedPath)) && (await historyIdOf(result.purgedPath)) === '', 'The purged image came back after the restart');
        return { ...usage, firstListingMs };
    }

    return { run, afterRestart, REFUSE_TOKEN };
};

module.exports.REFUSE_TOKEN = REFUSE_TOKEN;
