module.exports = async function appicaFlow({ client, check, clickControl, clickSelector, waitFor, screenshot }) {
    check(await client.evaluate(`document.documentElement.dataset.frontend === 'appica-react' && window.PicGenAppica?.version === '1.1.0'`), 'Appica frontend missing');
    const buttons = await client.evaluate(`document.querySelectorAll('[data-slot="button"]').length`);
    check(buttons > 50, 'Appica components were not mounted');
    async function key(key, code = key, modifiers = 0) {
        await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
        await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
    }
    // Keyboard on a bridged select: the similar view's 相似程度 (history sort is an Appica menu now).
    await clickControl('historyBtn');
    await clickControl('historySimilarBtn');
    await clickSelector('.modern-select[data-select-id="historySimilarPreset"] .modern-select-trigger');
    await waitFor(() => client.evaluate(`!!document.getElementById('historySimilarPresetModernMenu')`), 'Appica select open');
    await key('End');
    await key('Enter');
    await waitFor(() => client.evaluate(`el.historySimilarPreset.value === 'loose'`), 'keyboard selection updates native value');
    await waitFor(() => client.evaluate(`document.activeElement?.classList.contains('appica-select-trigger')`), 'Select restores focus');
    await clickSelector('.modern-select[data-select-id="historySimilarPreset"] .modern-select-trigger');
    await waitFor(() => client.evaluate(`(() => { const popup=document.getElementById('historySimilarPresetModernMenu'); return popup && Number(getComputedStyle(popup).opacity)>.99; })()`), 'Select transition completed');
    await screenshot('17-appica-select.png');
    await key('Escape');
    await waitFor(() => client.evaluate(`document.querySelector('[data-select-id="historySimilarPreset"] [aria-expanded="false"]') !== null`), 'Escape closes select');
    await client.evaluate(`el.historySimilarPreset.value='standard'; el.historySimilarPreset.dispatchEvent(new Event('change',{bubbles:true})); true`);
    await clickControl('historyGridBtn');

    await clickControl('generateNavBtn');
    await client.evaluate(`window.appicaConfirmResult='pending'; window.PicGenAppica.confirm('取消后不会改变当前序列。', { title:'键盘操作验证', danger:true }).then(value => window.appicaConfirmResult=value); true`);
    await waitFor(() => client.evaluate(`!!document.getElementById('confirmCancelBtn')`), 'Appica dialog');
    await waitFor(() => client.evaluate(`(() => { const dialog=document.querySelector('.picgen-confirm'); return dialog && Number(getComputedStyle(dialog).opacity) > .99; })()`), 'Dialog transition');
    await screenshot('18-appica-dialog.png');
    await key('Escape');
    await waitFor(() => client.evaluate(`window.appicaConfirmResult === false`), 'Escape cancels dialog');
    await waitFor(() => client.evaluate(`!document.querySelector('.picgen-confirm')`), 'Dialog exit completed');

    await client.evaluate(`document.querySelector('#sequenceTabs [role="tab"]').focus(); true`);
    await key('ArrowRight');
    await waitFor(() => client.evaluate(`state.currentSequenceId === state.sequences[1].id`), 'Appica tab keyboard navigation');
    await client.evaluate(`el.toast.hidden=true; showGenerationView(); document.getElementById('mainContentScroll').scrollTop=0; true`);
    await screenshot('19-appica-generation.png');
    const layoutMeasurements = [];
    for (const width of [380, 460, 1000]) {
        await client.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
        await clickControl('generateNavBtn');
        const generation = await client.evaluate(`(() => {
            const workspace=document.querySelector('.workspace').getBoundingClientRect();
            const surface=document.querySelector('.main-surface').getBoundingClientRect();
            const ratio=document.querySelector('[data-select-id="ratioSelect"] [data-slot="select-trigger"]');
            const model=document.querySelector('[data-select-id="modelSelect"] [data-slot="select-trigger"]');
            return { width:innerWidth, left:workspace.left-surface.left, right:surface.right-workspace.right,
                sidebar:document.querySelector('.sidebar').getBoundingClientRect().width,
                sameSelect:!!ratio && ratio.className===model.className && ratio.offsetHeight===model.offsetHeight,
                help:document.querySelectorAll('.main-help-icon').length };
        })()`);
        check(generation.left <= 12 && generation.right <= 24 && generation.sidebar === 44, 'Generation wasted horizontal space');
        check(generation.sameSelect && generation.help === 0, 'Ratio select/help cleanup failed');
        await client.evaluate(`document.getElementById('mainContentScroll').scrollTop=0; true`);
        await screenshot(`21-compact-generation-${width}.png`);
        await clickControl('historyBtn');
        check(await client.evaluate(`(() => { const toolbar=document.querySelector('.history-toolbar'); const toggle=document.querySelector('.history-layout-toggle'); const rect=toggle.getBoundingClientRect(); return toolbar.scrollWidth<=toolbar.clientWidth+1 && rect.right<=innerWidth && rect.left>=0; })()`), 'History toolbar overflow');
        const headerHeight = await client.evaluate(`document.querySelector('.history-header').offsetHeight + document.querySelector('.history-toolbar').offsetHeight`);
        check(headerHeight <= 125, 'History header consumes too much space');
        await screenshot(`20-appica-history-${width}.png`);
        await clickControl('apiSettingsBtn');
        await clickControl('imageSettingsTab');
        // 供应商信息卡与配置组卡共用 .unified-group-card（前者多带 data-editor="identity"），
        // 只用类名会命中排在前面的信息卡、永远打不开配置组编辑器。用 data-group-id 锁定真配置组。
        await clickSelector('.unified-group-card[data-group-id] .unified-group-summary-main');
        await waitFor(() => client.evaluate('!!document.getElementById("unifiedGroupEditor")'), 'group editor open');
        await client.evaluate(`(() => {
            const write = (input, value) => { if (!input) return;
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true })); };
            write(document.querySelector('#unifiedGroupModelsRows input'), 'long-model-name-'.repeat(20));
            write(document.getElementById('unifiedGroupApiKeyInput'), 'long-key-'.repeat(60));
            return true;
        })()`);
        const supplier = await client.evaluate(`(() => {
            const panel=document.getElementById('imageSettingsPanel');
            const overflow=[...document.querySelectorAll('#unifiedInlineEditor input, #unifiedInlineEditor .appica-select-trigger')].filter(node => {
                const rect=node.getBoundingClientRect(); return rect.width>1 && (rect.left<0 || rect.right>innerWidth);
            }).map(node=>node.id || node.className);
            return { panelWidth:panel.clientWidth, contentWidth:panel.scrollWidth, overflow };
        })()`);
        check(supplier.overflow.length === 0 && supplier.contentWidth <= supplier.panelWidth + 1, 'Supplier fields overflow');
        await client.evaluate(`document.getElementById('unifiedInlineEditor').scrollIntoView({block:'start'}); true`);
        await screenshot(`22-compact-supplier-${width}.png`);
        await clickSelector('.unified-group-card[data-group-id].is-open .unified-group-summary-main');
        await clickControl('concurrencySettingsTab');
        check(await client.evaluate(`Math.max(...[...document.querySelectorAll('.strategy-choice')].map(node=>node.offsetHeight))<=92`), 'Oversized strategy controls');
        await client.evaluate(`document.querySelector('#concurrencySettingsPanel .settings-scroll-panel').scrollTop=0; true`);
        await screenshot(`23-compact-strategy-${width}.png`);
        layoutMeasurements.push({ ...generation, historyHeaderHeight: headerHeight, supplier });
    }
    await client.send('Emulation.clearDeviceMetricsOverride');
    await clickControl('apiSettingsBtn');
    await clickControl('imageSettingsTab');
    return { package: '@appica/ui-react@1.1.0', buttons, selectKeyboard: true, selectFocus: true, dialogEscape: true, sequenceKeyboard: true, viewportWidths: [380, 460, 1000], layoutMeasurements };
};
