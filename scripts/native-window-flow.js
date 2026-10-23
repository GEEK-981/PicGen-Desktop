const fs = require('node:fs/promises');
const { fileURLToPath } = require('node:url');

module.exports = async function nativeWindowFlow({ client, connectPreview, check, waitFor, screenshot, clickControl }) {
    await clickControl('generateNavBtn');
    await client.evaluate(`document.activeElement?.blur(); el.toast.hidden=true; true`);
    const initial = await client.evaluate('window.picgenDesktop.getWindowState()');
    // Exercise actual preload/main IPC and native window sizing in this isolated profile.
    await client.evaluate(`window.picgenDesktop.startWindowMove({x:0,y:0}); window.picgenDesktop.moveWindow({x:100000,y:0}); window.picgenDesktop.endWindowMove(); true`);
    await waitFor(() => client.evaluate(`window.picgenDesktop.getWindowState().then(s=>s.dock.edge==='right')`), 'right edge snap');
    await client.evaluate(`window.picgenDesktop.setExpanded(false); true`);
    const collapsed = await waitFor(() => client.evaluate(`window.picgenDesktop.getWindowState().then(s=>s.dock.hidden ? s : null)`), 'edge tab collapse');
    check(collapsed.bounds.width === 12 && collapsed.bounds.height === 72, 'Edge tab has wrong native bounds');
    // The edge tab is a separate native window; renderer capture remains the workspace.

    await client.evaluate(`window.picgenDesktop.setExpanded(true); window.picgenDesktop.pinWindow(true); true`);
    const restored = await waitFor(() => client.evaluate(`window.picgenDesktop.getWindowState().then(s=>s.expanded && s.dock.pinned ? s : null)`), 'edge reveal and pin');
    check(restored.bounds.width === initial.bounds.width && restored.bounds.height === initial.bounds.height, 'Edge reveal lost expanded size');
    await client.evaluate(`window.picgenDesktop.startWindowMove({x:0,y:0}); window.picgenDesktop.moveWindow({x:-120,y:0}); window.picgenDesktop.endWindowMove(); true`);
    await waitFor(() => client.evaluate(`window.picgenDesktop.getWindowState().then(s=>s.dock.edge===null)`), 'drag away cancels docking');
    await client.evaluate(`window.picgenDesktop.pinWindow(false); true`);

    const preview = await connectPreview();
    try {
        // 切视图会上"真实移动闸门"（showGenerationView）；本流程不发真实鼠标移动，直接开闸
        await client.evaluate('state.hoverPreviewNeedsMove = false; state.hoverPreviewMoveFrom = null; true');
        const sweep = await client.evaluate(`new Promise(resolve => {
            const original=openImageHoverPreview; let requests=0;
            openImageHoverPreview=(...args)=>{requests++; return original(...args);};
            for(let i=0;i<20;i++) { showImageHoverPreview(state.recentImages[0], {clientX:200,clientY:200,screenX:screenX+200,screenY:screenY+200}); hideImageHoverPreview(); }
            setTimeout(()=>{openImageHoverPreview=original;resolve(requests);},220);
        })`);
        check(sweep === 0, 'Quick hover sweep opened native previews');
        const before = Date.now();
        await client.evaluate(`showImageHoverPreview(state.recentImages[0], {clientX:200,clientY:200,screenX:screenX+200,screenY:screenY+200}); true`);
        const loaded = await waitFor(() => preview.evaluate(`(() => {
            const image=document.getElementById('previewImage');
            return image?.complete && image.naturalWidth>0 ? {src:image.src,width:image.naturalWidth,height:image.naturalHeight,dimensions:document.getElementById('previewDimensions').textContent} : null;
        })()`), 'native async image preview');
        const coldMs = Date.now() - before;
        check(loaded.src.endsWith('-hover.png') && Math.max(loaded.width, loaded.height) <= 1000, 'Native preview still decodes the original image');
        const file = fileURLToPath(loaded.src);
        const firstStat = await fs.stat(file);
        await client.evaluate(`hideImageHoverPreview(); true`);
        await preview.evaluate(`window.applyPreview({}).then(()=>true)`);
        const warmStart = Date.now();
        await client.evaluate(`showImageHoverPreview(state.recentImages[0], {clientX:200,clientY:200,screenX:screenX+200,screenY:screenY+200}); true`);
        await waitFor(() => preview.evaluate(`previewImage.complete && previewImage.naturalWidth>0`), 'cached native preview');
        const warmMs = Date.now() - warmStart;
        check((await fs.stat(file)).mtimeMs === firstStat.mtimeMs, 'Repeated hover regenerated cached image');
        const capture = await preview.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        await client.evaluate(`hideImageHoverPreview(); true`);
        return { edge: { snap: true, collapse: collapsed.bounds, restored: restored.bounds, pin: true, detach: true },
            preview: { quickSweepRequests: sweep, coldMs, warmMs, includesIntentDelayMs: 80, cacheReused: true, ...loaded }, screenshot: capture.data };
    } finally { preview.socket.terminate(); }
};
