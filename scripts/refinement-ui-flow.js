module.exports = async function refinementFlow({ client, check, clickControl, waitFor, screenshot, serverUrl, chatProvider, imageProvider, localJson }) {
    // 局部编辑现在在图片工作台里完成：右键进入蒙版模式 → 真实鼠标涂抹 → 发送
    await clickControl('generateNavBtn');
    await client.evaluate(`(async () => {
        await refreshRecentImages({full:true});
        window.refinementTarget = state.currentSequenceId;
        window.originalModel = getCurrentSequence().model;
        getCurrentSequence().model=''; getCurrentSequence().prompt=''; setPromptEditorValue('');
        state.imageContextTarget = state.recentImages[0]; await openWorkspaceFromContextImage('mask'); return true;
    })()`);
    await waitFor(()=>client.evaluate(`!document.getElementById('workspacePage').hidden && !!document.querySelector('.ws-canvas canvas')`),'Workspace opened for local edit');
    await new Promise(resolve => setTimeout(resolve, 350));
    const box = await client.evaluate(`(() => { const r = document.querySelector('.ws-canvas').getBoundingClientRect(); return { x: r.left + r.width * 0.45, y: r.top + r.height * 0.45, w: r.width * 0.1 }; })()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + box.w, y: box.y + box.w / 2, button: 'left', buttons: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + box.w, y: box.y + box.w / 2, button: 'left', clickCount: 1 });
    await clickControl('wsSendBtn');
    await waitFor(()=>client.evaluate(`!!document.querySelector('.ws-sheet')`),'Workspace send sheet');
    await clickControl('wsConfirmSend');
    await waitFor(()=>client.evaluate(`state.activeView==='generation'`),'Back to generation after send');
    await client.evaluate(`window.maskTestPending=state.pendingMaskEdits.get(refinementTarget); true`);
    check(await client.evaluate(`document.getElementById('workspacePage').hidden && state.pendingMaskEdits.has(refinementTarget) && !document.getElementById('pendingMaskPanel').hidden && getCurrentSequence().references[0]?.id === maskTestPending.sourceRefId`), 'Mask transfer from the workspace failed or has no preview');
    await screenshot('26-mask-transferred-without-prompt.png');
    await client.evaluate(`addSequence(); true`);
    check(await client.evaluate(`document.getElementById('pendingMaskPanel').hidden`), 'Mask leaked to another sequence');
    await client.evaluate(`switchSequence(refinementTarget); getCurrentSequence().model=originalModel; loadCurrentSequenceToForm(); true`);
    check(await client.evaluate(`!document.getElementById('pendingMaskPanel').hidden`), 'Mask was lost on sequence switch');
    await clickControl('cancelMaskEditBtn');
    check(await client.evaluate(`!state.pendingMaskEdits.has(refinementTarget)`), 'Mask cancel did not clear pending state');

    await localJson(`${serverUrl}/api/providers/failover`, {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({enabled:false,strategy:'fixed',selectedProviderId:imageProvider.id})});
    await client.evaluate(`(async()=>{
        state.routingStrategy='fixed';state.fixedProviderId=${JSON.stringify(imageProvider.id)};
        const sequence=getCurrentSequence(); sequence.model='gpt-image-2'; sequence.providerId=${JSON.stringify(imageProvider.id)};
        loadCurrentSequenceToForm(); setPromptEditorValue('修改已涂抹的区域');
        state.pendingMaskEdits.set(sequence.id,maskTestPending); renderPendingMaskEdit();
        const originalFetch=window.fetch;
        window.fetch=(url,options)=>String(url).endsWith('/api/tasks/batch') ? Promise.resolve(new Response(JSON.stringify({error:'fixture rejection'}),{status:400,headers:{'Content-Type':'application/json'}})) : originalFetch(url,options);
        try { await generateImages(); } finally { window.fetch=originalFetch; }
        return true;
    })()`);
    check(await client.evaluate(`state.pendingMaskEdits.has(refinementTarget)`), 'Rejected mask request lost the mask');
    await client.evaluate(`generateImages().then(()=>true)`);
    await waitFor(()=>client.evaluate(`state.recentImages.some(image=>image.prompt==='修改已涂抹的区域')`),'Masked result saved',30000);
    check(await client.evaluate(`!state.pendingMaskEdits.has(refinementTarget)`),'Accepted mask request did not clear pending state');
    const tasks=await localJson(`${serverUrl}/api/tasks`);
    check(tasks.some(task=>task.operation==='mask-edit' && task.status==='completed'),'Mask task did not complete end to end');

    // 展示模式现在由「手动开关」决定（state.recentViewMode + #recentViewToggleBtn，
    // 持久化在 localStorage），不再随窗口高度自动切换 —— 旧断言写的「高窗=网格 /
    // 矮窗=轮播」已经和实现脱节。这里改为按真实开关验证两种模式，两种高度都拍图。
    await client.evaluate(`showGenerationView(); const p=document.getElementById('promptInput'); if(p){p.textContent='';p.dispatchEvent(new Event('input',{bubbles:true}));} true`);
    if (await client.evaluate(`state.recentViewMode!=='grid10'`)) await clickControl('recentViewToggleBtn');
    for (const [height, carousel] of [[1400,false],[640,true]]) {
        if (carousel) await clickControl('recentViewToggleBtn');
        await client.send('Emulation.setDeviceMetricsOverride', {width:460,height,deviceScaleFactor:1,mobile:false});
        await client.evaluate(`renderRecentImages(); true`);
        const shown = await client.evaluate(`Math.min(${carousel?20:10},state.recentImages.length)`);
        check(await client.evaluate(`el.recentImages.querySelectorAll('.recent-item').length===${shown}`), 'Recent image count does not respond to the display mode');
        if (carousel) check(await client.evaluate(`(() => {
            const ri=el.recentImages, vp=ri.querySelector('.recent-carousel-viewport');
            const tops=new Set([...ri.querySelectorAll('.recent-item')].map(node=>Math.round(node.getBoundingClientRect().top)));
            return ri.classList.contains('carousel-mode') && ri.querySelectorAll('.recent-carousel-nav').length===2
                && ri.querySelectorAll('.recent-carousel-dot').length>=1 && !!vp && getComputedStyle(vp).overflowX==='auto' && tops.size===1;
        })()`), 'Carousel mode did not build the Appica paged track');
        else check(await client.evaluate(`!el.recentImages.classList.contains('carousel-mode') && !el.recentImages.querySelector('.recent-carousel-nav')`), 'Grid mode should not build carousel controls');
        await client.evaluate(`document.getElementById('mainContentScroll').scrollTop=0; true`);
        await screenshot(`27-generation-height-${height}.png`);
        await client.evaluate(`el.toast.hidden=true; document.getElementById('recentSection').scrollIntoView({block:'end'}); true`);
        await waitFor(()=>client.evaluate(`document.getElementById('recentSection').getBoundingClientRect().bottom <= innerHeight + 1`),'Recent strip scrolled into view');
        await screenshot(`27-recent-height-${height}.png`);
    }
    if (await client.evaluate(`state.recentViewMode!=='grid10'`)) await clickControl('recentViewToggleBtn');
    await client.send('Emulation.clearDeviceMetricsOverride');
    // The masked result just saved is analysed in the background first; once nothing is pending, a
    // second get must not decode, regroup or bump the revision.
    await waitFor(()=>client.evaluate(`window.picgenDesktop.getSimilarityGroups({foreground:true}).then(s=>s.pending===0 && s.stage!=='provisional')`),'Similarity analysis settled',60000);
    const cache = await client.evaluate(`(async()=>{
        const a=await window.picgenDesktop.getSimilarityGroups({foreground:true});
        const start=performance.now(); const b=await window.picgenDesktop.getSimilarityGroups({foreground:true});
        return {ms:performance.now()-start,groups:b.groups.length,mode:b.mode,revision:b.revision,
            unchanged:a.stats.decoded===b.stats.decoded && a.stats.groupRuns===b.stats.groupRuns && a.revision===b.revision};
    })()`);
    check(cache.unchanged,'Opening similarity repeated decode/grouping work');

    // 就地覆盖：优化结果边流边写进 #promptInput，不再另开结果面板。
    // 顺带装一个出站请求观察器：优化必须把参考图一起发出去。旧实现把「名字里含
    // deepseek 的模型」一律判成不能读图并静默丢弃参考图，这条断言专门钉死那种回退。
    await client.evaluate(`(async()=>{
        await ensureChatProvidersLoaded(true); state.currentChatPresetId=${JSON.stringify(chatProvider.id)};
        const sequence=getCurrentSequence();
        // 提示词里带一个真正的 @{名称} 提及，才能同时验证「提及没被换成序号」。
        sequence.prompt='原始提示词，@{smoke} 放左上';
        // 挂一张真参考图，才能验证「优化会把它一起发出去」。用最小合法 PNG，
        // 不依赖任何外部文件。
        sequence.references=[{ id:'ref_smoke_optimize', name:'smoke.png', alias:'smoke', mimeType:'image/png',
            base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', filePath:'' }];
        setPromptEditorValue(sequence.prompt,sequence.references); promptUndoReset(sequence.prompt,sequence.id);
        window.__optimizeRefAudit=[];
        const original=window.PicGenAppica.fetchPromptStream;
        window.PicGenAppica.fetchPromptStream=(url,payload,stream)=>{
            window.__optimizeRefAudit.push({
                sent:(payload.referenceImages||[]).length,
                declared:payload.referenceImageCount,
                mimeTypes:payload.referenceMimeTypes,
                // 优化必须用带名字的解析：@{smoke} 保持原样，而不是变成「参考图1」。
                prompt:payload.prompt,
                names:payload.referenceNames,
                // 生成区已设的画幅比例也要随行发出，供模型改掉冲突描写。
                ratio:payload.ratio
            });
            return original(url,payload,stream);
        };
        window.optimizeRun=optimizeCurrentPrompt(); return true;
    })()`);
    await waitFor(()=>client.evaluate(`getPromptEditorValue().startsWith('流式输出')`),'Optimization streams into the prompt editor');
    check(await client.evaluate(`el.promptInput.getAttribute('contenteditable')==='false' && el.optimizePromptLabel.textContent==='停止'`), 'Streaming optimization is neither read-only nor stoppable');
    // 图标不能因为按钮被命令式切 disabled 就消失 —— `Action` 每次渲染都新建
    // {__html: markup} 对象字面量，React 按对象身份比较后无条件重写 innerHTML，
    // 把 lucide 换好的 <svg> 打回不可见的裸 <i>。运行中应当是 Appica Spinner。
    check(await client.evaluate(`(()=>{ const host=el.optimizePromptIcon;
        return !!host && host.querySelectorAll('[data-slot="spinner"]').length===1
            && host.querySelectorAll('svg').length>=1
            && el.optimizePromptBtn.querySelectorAll('i[data-lucide]').length===0; })()`),
        'Optimize button lost its icon (or did not switch to a spinner) while streaming');
    await screenshot('28-prompt-inplace-streaming.png');
    // 「只有编辑器里能看到优化结果」这条得抓死。旧实现把结果同时写进 #optimizationStream，
    // 谁再给它加个可见宿主（面板 / 弹窗 / 预览）都会在这里被抓住；只扫叶子节点并跳过
    // 隐藏元素与编辑器的祖先，避免把包装 div 和 tab 上的隐藏文本算成泄漏。
    check(await client.evaluate(`(()=>{
        const editor=el.promptInput;
        const stray=[...document.querySelectorAll('body *')].filter(node=>{
            if(node===editor||editor.contains(node)||node.contains(editor)) return false;
            if(node.children.length) return false;
            if(node.hidden||node.closest('[hidden]')||node.getAttribute('aria-hidden')==='true') return false;
            const style=getComputedStyle(node);
            if(style.display==='none'||style.visibility==='hidden'||style.opacity==='0') return false;
            return node.textContent.includes('流式输出');
        }).map(node=>node.id||node.className||node.tagName);
        return JSON.stringify(stray);
    })()`)==='[]', 'Optimization output is visible on a second surface');
    check(await client.evaluate(`(()=>{
        if (!state.promptOptimizeRun) return true; // 时序敏感：已经跑完就跳过
        const event=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});
        el.promptInput.dispatchEvent(event);
        return state.promptOptimizeRun!==null && getPromptEditorValue().startsWith('流式输出');
    })()`), 'Ctrl+Z disturbed the in-flight streaming overwrite');
    // 中途切序列：输出只属于原序列，别的序列既不写脏也不该被锁住。
    await client.evaluate(`addSequence(); true`);
    check(await client.evaluate(`!getCurrentSequence().prompt && el.promptInput.getAttribute('contenteditable')==='true'`), 'Streaming optimization leaked into another sequence');
    await client.evaluate(`switchSequence(refinementTarget); optimizeRun.then(()=>true)`);
    check(await client.evaluate(`getPromptEditorValue()==='流式输出：构图、光线与材质。' && getCurrentSequence().prompt==='流式输出：构图、光线与材质。'`), 'Optimization result was not applied in place');
    check(await client.evaluate(`el.promptInput.getAttribute('contenteditable')==='true' && el.optimizePromptLabel.textContent==='优化' && !document.getElementById('optimizationStream')`), 'Editor was not restored after optimization');
    // 收尾后图标要变回魔杖（且仍是真 svg，不是被 innerHTML 冲回去的裸 <i>）。
    check(await client.evaluate(`(()=>{ const host=el.optimizePromptIcon;
        return !!host && host.querySelectorAll('[data-slot="spinner"]').length===0
            && host.querySelectorAll('svg').length===1
            && el.optimizePromptBtn.querySelectorAll('i[data-lucide]').length===0; })()`),
        'Optimize button did not return to its idle icon after streaming');
    // 参考图必须随优化请求一起发出。原序列这里挂着 fixture 参考图，因此 sent 应等于
    // declared 且大于 0 —— 任何「按模型名悄悄丢图」的回归都会让 sent 变 0。
    const refAudit = await client.evaluate(`JSON.stringify(window.__optimizeRefAudit||[])`);
    const refCalls = JSON.parse(refAudit);
    check(refCalls.length === 1, `Optimize issued ${refCalls.length} requests instead of one`);
    check(refCalls[0].declared > 0 && refCalls[0].sent === refCalls[0].declared,
        `Optimize dropped reference images (declared ${refCalls[0]?.declared}, sent ${refCalls[0]?.sent})`);
    check(Array.isArray(refCalls[0].mimeTypes) && refCalls[0].mimeTypes.length === refCalls[0].declared,
        'Optimize did not forward the reference image mime types');
    // 提及必须保持 @{名称} 原样发出。旧解析把 @{smoke} 换成「参考图1」，模型既不知道
    // 是哪张图（图片不带名字），也就只能编「@第一张参考图文件名」这种占位符。
    check(typeof refCalls[0].prompt === 'string' && refCalls[0].prompt.includes('@{smoke}'),
        `Optimize did not preserve the @{name} mention (got: ${String(refCalls[0].prompt).slice(0, 80)})`);
    check(!/参考图\d/.test(refCalls[0].prompt),
        'Optimize replaced reference mentions with ordinals instead of names');
    check(Array.isArray(refCalls[0].names) && refCalls[0].names[0] === 'smoke',
        'Optimize did not send the reference names for the model to match against its images');
    // 画幅比例必须随行发出，内容与生成区实际设置的一致（模型要靠它改掉提示词里
    // 冲突的「画幅 3:4」这类写法，传错或漏传都会让输出与实际画幅打架）。
    const ratioExpectation = await client.evaluate(`describeSequenceRatio(getCurrentSequence().ratio)`);
    check(Boolean(ratioExpectation) && refCalls[0].ratio === ratioExpectation,
        `Optimize did not forward the aspect ratio (sent ${JSON.stringify(refCalls[0]?.ratio)}, expected ${JSON.stringify(ratioExpectation)})`);
    // 整段流只算一步撤销：一次 Ctrl+Z 直接回到优化前的原文。
    check(await client.evaluate(`(()=>{ const event=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}); el.promptInput.dispatchEvent(event); return event.defaultPrevented; })()`), 'Ctrl+Z is not handled by the prompt editor');
    // 撤销要回到含 @提及 的原文：编辑器把 @{smoke} 渲染成参考图 token，序列化后
    // 仍是 @{smoke}，所以整串（含提及）应逐字还原。
    check(await client.evaluate(`getPromptEditorValue()==='原始提示词，@{smoke} 放左上' && getCurrentSequence().prompt==='原始提示词，@{smoke} 放左上'`), 'Ctrl+Z did not restore the pre-optimization prompt');
    // 切走再切回来不能把历史冲掉：loadCurrentSequenceToForm 会整段重建编辑器，
    // 若它无条件重设撤销基线，刚敲的那一步就没了（也正是上面那条断言曾经的死因）。
    await client.evaluate(`setPromptEditorValue('第二稿'); true`);
    await client.evaluate(`addSequence(); true`);
    await client.evaluate(`switchSequence(refinementTarget); true`);
    check(await client.evaluate(`(()=>{ const event=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}); el.promptInput.dispatchEvent(event); return getPromptEditorValue()==='原始提示词，@{smoke} 放左上'; })()`), 'Sequence switch discarded the undo history');
    await client.evaluate(`getCurrentSequence().references=[]; getCurrentSequence().prompt=''; setPromptEditorValue(''); true`);

    await clickControl('reversePromptNavBtn');
    await client.evaluate(`(async()=>{
        const data=await window.picgenDesktop.loadCachedImage(state.recentImages[0]);
        state.reversePromptImage={...data,name:'fixture.png'};
        el.reversePromptProviderSelect.value=${JSON.stringify(chatProvider.id)};
        el.reversePromptProviderSelect.dispatchEvent(new Event('change',{bubbles:true}));
        updateReversePromptActionState(); window.reverseRun=runReversePrompt(); return true;
    })()`);
    await waitFor(()=>client.evaluate(`!!document.querySelector('#reversePromptStream [data-slot="text-animate"]')`),'Reverse prompt streams');
    await screenshot('29-reverse-streaming.png');
    await client.evaluate(`reverseRun.then(()=>true)`);
    check(await client.evaluate(`el.reversePromptResultInput.value==='流式输出：构图、光线与材质。' && !el.reversePromptCopyBtn.disabled && !el.reversePromptCreateSequenceBtn.disabled`),'Reverse stream completion/actions missing');
    await clickControl('reversePromptCreateSequenceBtn');
    check(await client.evaluate(`getCurrentSequence().prompt==='流式输出：构图、光线与材质。'`),'Reverse prompt new-sequence action failed');

    // 没有配优化供应商时，点「优化」不能把人甩到反推页去 —— 优化曾经寄居在反推页，
    // 老代码就是 `await openReversePrompt()`。现在应当留在生成区、就地打开设置的
    // 优化分页。判据用 activeView：老行为会把它改成 'reverse-prompt'。
    await client.evaluate(`(async()=>{
        showGenerationView();
        await ensureChatProvidersLoaded();
        const original=getChatPresetById;
        window.getChatPresetById=()=>null;
        try { await optimizeCurrentPrompt(); } finally { window.getChatPresetById=original; }
        return true;
    })()`);
    // openSettings() 会把 activeView 置为 'settings'，老代码的 openReversePrompt() 置为
    // 'reverse-prompt' 且顺带 hideSettingsPage() —— 两者在这里正好互斥。
    check(await client.evaluate(`state.activeView==='settings' && state.settingsMode==='optimize' && !document.getElementById('settingsOverlay').hidden`), 'Missing optimize provider redirected to the reverse-prompt page');
    // 复原到 image 分页再关。openSettings() 会记住上次的 settingsMode，且只在
    // mode==='image' 时才刷新供应商列表 —— 留着 'optimize' 会让后面的供应商流程
    // 打不开配置卡（这是测试的前置条件，不是产品缺陷：真人会点「API 提供商」分页）。
    await client.evaluate(`setSettingsMode('image'); closeSettings(); true`);

    return { maskTransferWithoutPromptOrProvider:true, maskSequenceIsolation:true, maskCancel:true, maskRejectedRequestRetained:true, maskGeneratedAndSaved:true, responsiveRecentStrip:true,
        similarityReopen:cache, streamingOptimization:true, inPlaceOverwrite:true, promptUndoRedo:true, streamingReverse:true, appicaTypewriter:true,
        optimizeSendsReferenceImages:true, optimizeBusyIcon:true };
};
