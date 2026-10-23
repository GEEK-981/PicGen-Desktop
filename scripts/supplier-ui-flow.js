// Uses real rendered controls in an isolated PicGen profile, with fixture keys.
// No provider network requests are made by these management checks.
// The supplier workspace is a React sub-root: a snap carousel of overview cards
// with collapsible per-group editor cards below. Values are written through the
// native prototype setter + input events so controlled inputs observe them.
module.exports = function supplierFlows({ client, clickControl, clickSelector, chooseOption, waitFor, localJson, saveProviderInUI, screenshot, check }) {
    const read = url => localJson(`${url}/api/suppliers`);
    const card = id => `.unified-supplier-card[data-supplier-id="${id}"]`;
    // The summary row is a container; its expand/collapse toggle is the main button
    // (the enable switch and chevron are separate controls beside it).
    const groupSummary = id => `.unified-group-card[data-group-id="${id}"] .unified-group-summary-main`;
    const rows = '#unifiedGroupModelsRows .unified-model-row';
    async function set(selector, value) {
        await client.evaluate(`(() => {
            const input = document.querySelector(${JSON.stringify(selector)});
            const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
    }
    // "Editors closed" means no group / new-group editor is open. The supplier
    // identity form is now always mounted (persistent) below the carousel, so its
    // presence is no longer a signal — only the group editor's is.
    const editorHidden = () => client.evaluate("!document.getElementById('unifiedGroupEditor')");
    // Appica toasts stack over the bottom of the settings panel and swallow the
    // elementFromPoint hit-test — a lingering "配置组已保存" toast sitting on 新增配置组
    // makes clickSelector report the button as unclickable until its 12s timeout.
    // Clear them before driving any control anchored to the bottom of the form.
    async function clearToasts() {
        await client.evaluate('window.PicGenAppica?.dismissToasts?.(); true');
    }
    // Collapse any open editor and wait for its form to unmount. The group-card
    // collapse animation keeps the old form mounted ~300ms, so opening a new
    // editor without this can briefly duplicate the scriptable ids.
    async function ensureEditorsClosed() {
        await client.evaluate("window.dispatchEvent(new CustomEvent('picgen:close-supplier-panel')); true");
        await waitFor(editorHidden, 'editors closed');
    }
    // Wait for the expand animation (grid-template-rows, ~280ms) to settle so
    // controls near the bottom of the form hold a stable position before a click.
    async function settleEditor() {
        let last = -1;
        await waitFor(async () => {
            const h = await client.evaluate("Math.round((document.querySelector('.unified-group-card.is-open .unified-group-card-body') || document.querySelector('.unified-editor-card'))?.getBoundingClientRect().height || 0)");
            const stable = h > 0 && h === last; last = h; return stable;
        }, 'editor animation settled');
    }
    // Set the default model through the native select (equivalent to a user
    // commit). The bridged-select click path is exercised in gui-smoke; here the
    // long expanded form makes menu-option scrolling flaky, so drive data flow.
    async function setActiveModel(value) {
        await set('#unifiedGroupActiveModelInput', value);
        await waitFor(() => client.evaluate(`document.getElementById('unifiedGroupActiveModelInput').value === ${JSON.stringify(value)}`), `active model ${value}`);
    }
    async function setRole(value) {
        await set('#unifiedGroupRoleSelect', value);
        await waitFor(() => client.evaluate(`document.getElementById('unifiedGroupRoleSelect').value === ${JSON.stringify(value)}`), `role ${value}`);
    }
    async function selectSupplier(id) {
        const index = await client.evaluate(`state.unifiedSuppliers.findIndex(s => s.id === ${JSON.stringify(id)})`);
        const already = await client.evaluate(`document.querySelector('.unified-supplier-card[data-selected]')?.dataset.supplierId === ${JSON.stringify(id)}`);
        if (!already) {
            if (await client.evaluate('state.unifiedSuppliers.length > 1')) await clickSelector(`.supplier-carousel-dot:nth-child(${index + 1})`);
            await waitFor(() => client.evaluate(`document.querySelector('.unified-supplier-card[data-selected]')?.dataset.supplierId === ${JSON.stringify(id)}`), 'supplier selected');
        }
    }
    async function openGroup(supplierId, groupId) {
        await selectSupplier(supplierId);
        const open = await client.evaluate(`!!document.querySelector('.unified-group-card[data-group-id="${groupId}"].is-open')`);
        if (!open) { await ensureEditorsClosed(); await clearToasts(); await clickSelector(groupSummary(groupId)); }
        await waitFor(() => client.evaluate('!!document.getElementById("unifiedGroupEditor")'), 'group editor open');
        await settleEditor();
    }
    // Identity (name / website / baseUrl / icon) is always shown for the selected
    // supplier — there's no pencil to open. Just select it and collapse any group
    // editor so we drive the persistent identity form's fields.
    async function openIdentity(supplierId) {
        await selectSupplier(supplierId);
        await ensureEditorsClosed();
        await waitFor(() => client.evaluate('!!document.querySelector(\'[data-editor="identity"] #unifiedSupplierNameInput\')'), 'identity form present');
    }
    async function openNewGroup(supplierId) {
        await selectSupplier(supplierId);
        await ensureEditorsClosed();
        await clearToasts();
        await clickSelector('.unified-supplier-footer button:not([id])');
        await waitFor(() => client.evaluate('!!document.getElementById("unifiedGroupEditor")'), 'new group editor open');
        await settleEditor();
    }
    async function save() {
        await clearToasts();
        await clickControl('unifiedDrawerSave');
        await waitFor(() => client.evaluate('(() => { const b = document.getElementById("unifiedDrawerSave"); return !b || !b.disabled; })()'), 'unified supplier save settled');
    }
    // The persistent identity form has its own save id (distinct from a group's
    // unifiedDrawerSave, which it now coexists with).
    async function saveIdentity() {
        await clearToasts();
        await clickControl('unifiedIdentitySave');
        await waitFor(() => client.evaluate('(() => { const b = document.getElementById("unifiedIdentitySave"); return !b || !b.disabled; })()'), 'identity save settled');
    }
    async function confirm() {
        await waitFor(() => client.evaluate('!document.getElementById("confirmOverlay").hidden'), 'delete confirmation');
        await clickControl('confirmOkBtn');
        await waitFor(() => client.evaluate('document.getElementById("confirmOverlay").hidden'), 'confirmation closed');
    }
    function stable(supplier) {
        return {id:supplier.id,name:supplier.name,baseUrl:supplier.baseUrl,groups:supplier.groups.map(g => ({
            id:g.id,name:g.name,role:g.role,apiKey:g.apiKey,models:g.models,activeModel:g.activeModel,
            enabled:g.enabled,modelPricing:g.modelPricing,modelRouting:g.modelRouting,prompt:g.promptOptimizerSystemPrompt
        }))};
    }
    async function edit(url, mock) {
        const retained = (await read(url)).map(stable);
        const image = await saveProviderInUI({name:'Supplier CRUD Fixture',url:mock.url},url);
        let supplier = (await read(url)).find(s => s.name === 'Supplier CRUD Fixture');
        check(supplier?.groups.length === 1, 'New supplier did not save with exactly one group');
        await openGroup(supplier.id, image.id);
        const firstName = await client.evaluate('document.querySelector(".unified-model-name").value');
        await set(`${rows}:nth-child(1) .unified-model-price`, '0.25');
        await clickControl('unifiedAddModelBtn');
        await clickControl('unifiedAddModelBtn');
        check(await client.evaluate('document.querySelectorAll("#unifiedGroupModelsRows .unified-model-row").length === 3'), 'Add model discarded blank draft rows');
        check(await client.evaluate('document.querySelector(".unified-model-price").value === "0.25"'), 'Adding a model discarded another price');
        await set(`${rows}:nth-child(2) .unified-model-name`, 'image-second');
        await set(`${rows}:nth-child(2) .unified-model-price`, '0');
        await set(`${rows}:nth-child(2) .unified-model-protocol`, 'openai-images');
        await set(`${rows}:nth-child(3) .unified-model-name`, 'image-third');
        await setActiveModel('image-second');
        await set(`${rows}:nth-child(2) .unified-model-name`, 'image-renamed');
        // React updates asynchronously; the default follows its row's rename.
        await waitFor(() => client.evaluate('document.getElementById("unifiedGroupActiveModelInput").value === "image-renamed"'), 'Default model follows rename');
        await set(`${rows}:nth-child(3) .unified-model-name`, 'image-renamed');
        await clickControl('unifiedDrawerSave');
        check(await client.evaluate('!!document.getElementById("unifiedGroupEditor")'), 'Duplicate model was silently accepted');
        check((await read(url)).find(s => s.id === supplier.id).groups[0].models.length === 1, 'Invalid draft modified saved data');
        await set(`${rows}:nth-child(3) .unified-model-name`, 'image-third');
        await waitFor(() => client.evaluate('el.toast.hidden'),'validation toast cleared');
        await screenshot('09-model-row-editor.png');
        await save();
        supplier = (await read(url)).find(s => s.id === supplier.id);
        check(supplier.groups[0].models.length === 3 && supplier.groups[0].activeModel === 'image-renamed', 'Model list/default save failed');
        check(supplier.groups[0].modelPricing['image-renamed'] === 0 && supplier.groups[0].modelPricing[firstName] === 0.25, 'Zero or existing price was lost');

        // Add a chat group via the "新增配置组" footer button.
        await openNewGroup(supplier.id);
        await setRole('chat');
        // Switching to chat role hides the concurrency field (the chat system
        // prompt now lives in the 提示词优化 settings tab, not the group editor).
        await waitFor(() => client.evaluate('!document.getElementById("unifiedGroupConcurrencyInput")'), 'Chat fields switch');
        await set('#unifiedGroupNameInput','Chat Fixture');
        await set('#unifiedGroupApiKeyInput','fixture-chat-key');
        await set(`${rows}:nth-child(1) .unified-model-name`,'vision-a');
        await clickControl('unifiedAddModelBtn');
        await set(`${rows}:nth-child(2) .unified-model-name`,'vision-b');
        await setActiveModel('vision-b');
        await save();
        supplier = (await read(url)).find(s => s.id === supplier.id);
        const chat = supplier.groups.find(g => g.role === 'chat');
        check(supplier.groups.length === 2 && chat?.apiKey === 'fixture-chat-key', 'Second credential group did not save independently');
        check(chat.activeModel === 'vision-b' && supplier.groups[0].apiKey !== chat.apiKey, 'Sibling keys/defaults mixed');
        await clickControl('reversePromptNavBtn');
        await waitFor(() => client.evaluate('!el.reversePromptPage.hidden && state.chatProvidersLoaded'),'reverse prompt providers loaded');
        await chooseOption('#reversePromptProviderSelect',chat.id);
        check(await client.evaluate('el.reversePromptModelSelect.value === "vision-b" && el.reversePromptModelSelect.options.length === 2'),'New chat group/default missing from reverse prompt page');
        await clickControl('apiSettingsBtn');

        await openIdentity(supplier.id);
        check(await client.evaluate('!document.getElementById("unifiedGroupEditor")'), 'Identity editing exposes an unrelated group draft');
        await set('#unifiedSupplierNameInput','Renamed CRUD Fixture');
        await set('#unifiedSupplierBaseUrlInput',`${mock.url}/v1`);
        await set('#unifiedSupplierWebsiteInput','https://crud.example');
        await saveIdentity();
        supplier = (await read(url)).find(s => s.id === supplier.id);
        check(supplier.groups.length === 2 && supplier.name === 'Renamed CRUD Fixture' && supplier.website === 'https://crud.example', 'Identity edit created a group or lost website');

        // Collapsing a group card (click its summary) discards the draft.
        await openGroup(supplier.id, chat.id);
        await set('#unifiedGroupNameInput','Cancelled change');
        await clickSelector(groupSummary(chat.id));
        await waitFor(editorHidden, 'group editor closed');
        check((await read(url)).find(s => s.id === supplier.id).groups.find(g => g.id === chat.id).name === 'Chat Fixture','Close saved a draft');
        // Enable is now a card-summary switch that persists immediately (no form
        // save) and must not disturb the group's credentials or default model.
        for (const enabled of [false,true]) {
            await selectSupplier(supplier.id);
            await ensureEditorsClosed();
            await clickControl(`unifiedGroupCardEnabled_${chat.id}`);
            await waitFor(async () => (await read(url)).find(s => s.id === supplier.id).groups.find(g => g.id === chat.id).enabled === enabled, 'enable toggle persisted');
            await waitFor(() => client.evaluate(`document.querySelector('#unifiedGroupCardEnabled_${chat.id}')?.classList.contains('is-on') === ${enabled}`), 'switch reflects state');
            const current = (await read(url)).find(s => s.id === supplier.id).groups.find(g => g.id === chat.id);
            check(current.enabled === enabled && current.apiKey === chat.apiKey && current.activeModel === 'vision-b', 'Enable toggle changed a credential or default model');
        }
        await openGroup(supplier.id, chat.id);
        await set('#unifiedGroupNameInput','Renamed Chat Fixture');
        await set('#unifiedGroupApiKeyInput','fixture-chat-rotated');
        await client.evaluate(`(() => {const original=window.fetch;window.fetch=(input,options)=>{
            if(String(input).endsWith('/groups/${chat.id}') && options?.method==='PUT') {
                window.fetch=original;return Promise.resolve(new Response(JSON.stringify({error:'Fixture save failed'}),{status:500,headers:{'Content-Type':'application/json'}}));
            } return original(input,options);
        };return true;})()`);
        await clickControl('unifiedDrawerSave');
        await waitFor(() => client.evaluate('!document.getElementById("unifiedDrawerSave").disabled && el.toast.textContent.includes("Fixture save failed")'),'save failure feedback');
        check(await client.evaluate('!!document.getElementById("unifiedGroupEditor") && document.getElementById("unifiedGroupApiKeyInput").value === "fixture-chat-rotated"'),'Failed save discarded credential draft');
        check((await read(url)).find(s => s.id === supplier.id).groups.find(g => g.id === chat.id).apiKey === chat.apiKey,'Failed save modified persisted key');
        // Retry with a double-click: the busy guard must collapse it into ONE write.
        await client.evaluate(`(() => { window.__picgenSaveWrites = 0; const original = window.fetch;
            window.__picgenRestoreFetch = () => { window.fetch = original; };
            window.fetch = (input, options) => { if (options && (options.method === 'PUT' || options.method === 'POST') && String(input).includes('/groups')) window.__picgenSaveWrites++; return original(input, options); };
            return true; })()`);
        await client.evaluate('(() => { const b = document.getElementById("unifiedDrawerSave"); b.click(); b.click(); return true; })()');
        await waitFor(() => client.evaluate('(() => { const b = document.getElementById("unifiedDrawerSave"); return !b || !b.disabled; })()'), 'double-click save settled');
        await client.evaluate('window.__picgenRestoreFetch(); true');
        const saveWrites = await client.evaluate('window.__picgenSaveWrites');
        check(saveWrites === 1, `Double-clicking save issued ${saveWrites} write requests (expected 1)`);
        supplier=(await read(url)).find(s => s.id === supplier.id);
        check(supplier.groups.length===2 && supplier.groups.find(g=>g.id===chat.id).apiKey==='fixture-chat-rotated','Retry duplicated a group or lost the new key');
        check(supplier.groups.find(g=>g.id===image.id).apiKey!== 'fixture-chat-rotated','Key rotation modified sibling group');

        // Delete-cancel keeps the editor; deleting a model row reselects a default.
        await openGroup(supplier.id, image.id);
        await clickControl('unifiedGroupDelete');
        await waitFor(() => client.evaluate('!document.getElementById("confirmOverlay").hidden'), 'cancel delete dialog');
        await clickControl('confirmCancelBtn');
        check(await client.evaluate('!!document.getElementById("unifiedGroupEditor")'), 'Cancelling deletion discarded the editor');
        const oldSelectId = await client.evaluate('document.querySelector("#unifiedGroupModelsRows .unified-model-row:nth-child(2) select").id');
        await clickSelector(`${rows}:nth-child(2) [title="删除模型"]`);
        check(await client.evaluate(`document.getElementById("unifiedGroupActiveModelInput").value === ${JSON.stringify(firstName)}`), 'Deleting default did not select a remaining model');
        check(await client.evaluate(`!document.getElementById(${JSON.stringify(oldSelectId+'ModernMenu')})`), 'Removed model left its dropdown attached');
        await save();
        await screenshot('09-supplier-management.png');
        supplier = (await read(url)).find(s => s.id === supplier.id);
        check(supplier.groups[0].models.length === 2 && supplier.groups[0].activeModel === firstName
            && !supplier.groups[0].models.includes('image-renamed'), 'Model deletion save did not persist');
        const expected = stable(supplier);
        return { id:supplier.id, imageId:image.id, chatId:chat.id, retained, expected, firstName };
    }
    async function afterRestart(url, flow) {
        const suppliers = await read(url);
        check(JSON.stringify(stable(suppliers.find(s => s.id === flow.id))) === JSON.stringify(flow.expected), 'Supplier/group/model edits did not survive restart');
        for (const expected of flow.retained) check(JSON.stringify(stable(suppliers.find(s => s.id === expected.id))) === JSON.stringify(expected), 'Editing changed a different supplier');
        await client.evaluate('el.apiSettingsBtn.click(); true');
        await client.evaluate('refreshUnifiedSuppliers().then(() => true)');
        await selectSupplier(flow.id);
        await clickSelector(`${card(flow.id)} [title="删除供应商"]`);
        await clickControl('confirmCancelBtn');
        check((await read(url)).some(s => s.id === flow.id), 'Cancel removed a supplier');
        for (const id of [flow.chatId, flow.imageId]) {
            await openGroup(flow.id, id);
            await clickControl('unifiedGroupDelete'); await confirm();
            await waitFor(async () => !(await read(url)).find(s => s.id === flow.id).groups.some(g => g.id === id), 'group removed');
            await waitFor(editorHidden, 'group deletion closed the editor');
        }
        check((await read(url)).find(s => s.id === flow.id).groups.length === 0,'Last group was not removed');
        // Add a group back via the footer button.
        await openNewGroup(flow.id);
        await set('#unifiedGroupNameInput','Re-added Group'); await set('#unifiedGroupApiKeyInput','fixture-new-key');
        await set(`${rows}:nth-child(1) .unified-model-name`,flow.firstName); await save();
        check((await read(url)).find(s => s.id === flow.id).groups.length === 1,'Cannot add a group after deleting the last group');
        const added=(await read(url)).find(s => s.id === flow.id).groups[0];
        await openGroup(flow.id, added.id);
        await setRole('chat');
        await save();
        const imageGroups=await localJson(`${url}/api/providers`);
        const chatGroups=await localJson(`${url}/api/chat-providers`);
        check(!imageGroups.some(g=>g.id===added.id) && chatGroups.some(g=>g.id===added.id && g.apiKey==='fixture-new-key'),'Changing group role lost its key or left it under the old role');
        await selectSupplier(flow.id);
        await clickSelector(`${card(flow.id)} [title="删除供应商"]`); await confirm();
        await waitFor(async () => !(await read(url)).some(s => s.id === flow.id),'supplier removed');
        return {addEditDelete:true,modelRows:true,independentKeys:true,keyRotation:true,failedSaveRetry:true,identityEdit:true,cancel:true,restart:true,reversePromptSelector:true,roleChange:true,deleteLastGroupAndAddAgain:true};
    }
    async function deletedAfterRestart(url, flow) {
        const suppliers=await read(url);
        check(!suppliers.some(s => s.id === flow.id),'Deleted supplier was resurrected');
        for(const expected of flow.retained) check(JSON.stringify(stable(suppliers.find(s => s.id === expected.id)))===JSON.stringify(expected),'Deleting changed a different supplier');
    }
    async function emptyState(url,mock) {
        await client.evaluate('window.picgenDesktop.setExpanded(true); true');
        await waitFor(() => client.evaluate('innerWidth>=450 && innerHeight>=590'),'expanded empty-state window');
        await client.evaluate('el.apiSettingsBtn.click(); true');
        await client.evaluate('refreshUnifiedSuppliers().then(() => true)');
        // Delete every supplier by focusing the selected card each round.
        for (let remaining = (await read(url)).length; remaining > 0; remaining--) {
            const victim = await client.evaluate('document.querySelector(".unified-supplier-card[data-selected]")?.dataset.supplierId || null');
            check(victim, 'No focused supplier card to delete');
            await clickSelector('.unified-supplier-card[data-selected] [title="删除供应商"]'); await confirm();
            await waitFor(async()=>!(await read(url)).some(s=>s.id===victim),'fixture supplier deleted');
            await waitFor(()=>client.evaluate(`!document.querySelector(${JSON.stringify(card(victim))})`),'deleted supplier card removed');
        }
        await waitFor(()=>client.evaluate('state.presets.length===0 && !!document.querySelector(".unified-supplier-empty")'),'empty supplier state');
        await saveProviderInUI({name:'Added from empty state',url:mock.url},url);
        check((await read(url)).length===1,'Adding from empty state created duplicate suppliers');
    }
    return {edit,afterRestart,deletedAfterRestart,emptyState};
};
