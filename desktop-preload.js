const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('picgenDesktop', {
    getServerUrl: () => ipcRenderer.invoke('desktop:get-server-url'),
    getVersion: () => ipcRenderer.invoke('desktop:get-version'),
    pinWindow: (pinned) => ipcRenderer.send('desktop:pin-window', pinned),
    setDockInteraction: (busy) => ipcRenderer.send('desktop:dock-interaction', busy),
    getWindowState: () => ipcRenderer.invoke('desktop:get-window-state'),
    setExpanded: (expanded) => ipcRenderer.send('desktop:set-expanded', expanded),
    showContextMenu: () => ipcRenderer.send('desktop:show-context-menu'),
    showImageContextMenu: (items) => ipcRenderer.invoke('desktop:show-image-context-menu', items),
    copyImageToClipboard: (payload) => ipcRenderer.invoke('desktop:copy-image-to-clipboard', payload),
    smokeImageMenu: (choice) => ipcRenderer.invoke('desktop:smoke-image-menu', choice),
    smokeClipboardImage: () => ipcRenderer.invoke('desktop:smoke-clipboard-image'),
    startWindowMove: (point) => ipcRenderer.send('desktop:start-window-move', point),
    moveWindow: (point) => ipcRenderer.send('desktop:move-window', point),
    endWindowMove: () => ipcRenderer.send('desktop:end-window-move'),
    onWindowState: (callback) => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('desktop:window-state', listener);
        return () => ipcRenderer.removeListener('desktop:window-state', listener);
    },
    close: () => ipcRenderer.send('desktop:close'),
    listRecentImages: (options) => ipcRenderer.invoke('desktop:list-recent-images', options),
    listHistoryImages: () => ipcRenderer.invoke('desktop:list-history-images'),
    getHistoryThumbnail: (payload) => ipcRenderer.invoke('desktop:get-history-thumbnail', payload),
    getSimilarityGroups: options => ipcRenderer.invoke('desktop:similarity-groups', options),
    onSimilarityUpdated: callback => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('desktop:similarity-updated', listener);
        return () => ipcRenderer.removeListener('desktop:similarity-updated', listener);
    },
    getSimilarNeighbors: (query) => ipcRenderer.invoke('desktop:similarity-neighbors', query),
    getSimilarNeighborsOfImage: (query) => ipcRenderer.invoke('desktop:similarity-neighbors-image', query),
    setSimilarityOverride: (change) => ipcRenderer.invoke('desktop:similarity-override', change),
    // Smoke-only channels: main registers them only when PICGEN_SMOKE=1.
    smokeSimilarityStatus: () => ipcRenderer.invoke('desktop:smoke-similarity-status'),
    smokeEventLoop: (op) => ipcRenderer.invoke('desktop:smoke-event-loop', typeof op === 'string' ? { op } : op),
    smokeDragOutcome: (payload) => ipcRenderer.invoke('desktop:smoke-drag-outcome', payload),
    smokeHistoryBinSweep: (options) => ipcRenderer.invoke('desktop:smoke-history-bin-sweep', options),
    smokeClipboardLog: () => ipcRenderer.invoke('desktop:smoke-clipboard-log'),
    saveGeneratedImage: (payload) => ipcRenderer.invoke('desktop:save-generated-image', payload),
    // Save As dialog: {filePath, fileName} copies the file as is, {base64, mimeType, fileName} writes pixels.
    saveImageAs: (payload) => ipcRenderer.invoke('desktop:save-image-as', payload),
    copyImage: (payload) => ipcRenderer.invoke('desktop:copy-image', payload),
    openOutputFolder: () => ipcRenderer.invoke('desktop:open-output-folder'),
    openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
    getOutputDirectory: () => ipcRenderer.invoke('desktop:get-output-directory'),
    chooseOutputDirectory: () => ipcRenderer.invoke('desktop:choose-output-directory'),
    resetOutputDirectory: () => ipcRenderer.invoke('desktop:reset-output-directory'),
    getGeneratedImagePrompt: (payload) => ipcRenderer.invoke('desktop:get-generated-image-prompt', payload),
    saveReferenceImage: (payload) => ipcRenderer.invoke('desktop:save-reference-image', payload),
    loadReferenceImage: (payload) => ipcRenderer.invoke('desktop:load-reference-image', payload),
    listSizeAnchors: () => ipcRenderer.invoke('desktop:size-ref-anchors'),
    prepareSizeReference: (payload) => ipcRenderer.invoke('desktop:size-ref-prepare', payload),
    renderSizeReference: (payload) => ipcRenderer.invoke('desktop:size-ref-render', payload),
    saveSizeReference: (payload) => ipcRenderer.invoke('desktop:size-ref-save', payload),
    releaseSizeReference: (payload) => ipcRenderer.invoke('desktop:size-ref-release', payload),
    loadCachedImage: (payload) => ipcRenderer.invoke('desktop:load-cached-image', payload),
    deleteReferenceImage: (payload) => ipcRenderer.invoke('desktop:delete-reference-image', payload),
    listErrorLogs: (options) => ipcRenderer.invoke('desktop:list-error-logs', options),
    countErrorLogs: () => ipcRenderer.invoke('desktop:count-error-logs'),
    clearErrorLogs: () => ipcRenderer.invoke('desktop:clear-error-logs'),
    reportRendererError: (payload) => ipcRenderer.invoke('desktop:record-renderer-error', payload),
    copyText: (text) => ipcRenderer.invoke('desktop:copy-text', text),
    onErrorLog: (callback) => {
        const listener = (_event, entry) => callback(entry);
        ipcRenderer.on('desktop:error-log-entry', listener);
        return () => ipcRenderer.removeListener('desktop:error-log-entry', listener);
    },
    getPathForFile: (file) => webUtils?.getPathForFile ? webUtils.getPathForFile(file) : '',
    startImageDrag: (filePath) => ipcRenderer.send('desktop:start-image-drag', filePath),
    onImageDragEnded: (callback) => {
        const listener = (_event, point) => callback(point);
        ipcRenderer.on('desktop:image-drag-ended', listener);
        return () => ipcRenderer.removeListener('desktop:image-drag-ended', listener);
    },
    // History usage counters (taken out of PicGen: drag-out / copy / save-as; in-app reference uses) and the in-app recycle bin.
    recordHistoryUsage: (payload) => ipcRenderer.invoke('desktop:record-history-usage', payload),
    onHistoryUsageUpdated: (callback) => {
        const listener = (_event, update) => callback(update);
        ipcRenderer.on('desktop:history-usage-updated', listener);
        return () => ipcRenderer.removeListener('desktop:history-usage-updated', listener);
    },
    trashHistoryImages: (payload) => ipcRenderer.invoke('desktop:trash-history-images', payload),
    onHistoryTrashProgress: (callback) => {
        const listener = (_event, progress) => callback(progress);
        ipcRenderer.on('desktop:history-trash-progress', listener);
        return () => ipcRenderer.removeListener('desktop:history-trash-progress', listener);
    },
    onHistoryChanged: (callback) => {
        const listener = (_event, change) => callback(change);
        ipcRenderer.on('desktop:history-changed', listener);
        return () => ipcRenderer.removeListener('desktop:history-changed', listener);
    },
    listHistoryBin: () => ipcRenderer.invoke('desktop:list-history-bin'),
    restoreHistoryBin: (payload) => ipcRenderer.invoke('desktop:restore-history-bin', payload),
    purgeHistoryBin: (payload) => ipcRenderer.invoke('desktop:purge-history-bin', payload),
    getHistoryBinCount: () => ipcRenderer.invoke('desktop:get-history-bin-count'),
    onHistoryBinChanged: (callback) => {
        const listener = (_event, change) => callback(change);
        ipcRenderer.on('desktop:history-bin-changed', listener);
        return () => ipcRenderer.removeListener('desktop:history-bin-changed', listener);
    },
    showImagePreview: (payload) => ipcRenderer.send('desktop:show-image-preview', payload),
    openPrefsWindow: (payload) => ipcRenderer.send('desktop:prefs-open', payload),
    hidePrefsWindow: () => ipcRenderer.send('desktop:prefs-hide'),
    schedulePrefsClose: () => ipcRenderer.send('desktop:prefs-schedule-close'),
    syncPrefsWindow: (snapshot) => ipcRenderer.send('desktop:prefs-sync', snapshot),
    onPrefsChange: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('desktop:prefs-change', listener);
        return () => ipcRenderer.removeListener('desktop:prefs-change', listener);
    },
    onPrefsClosed: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('desktop:prefs-closed', listener);
        return () => ipcRenderer.removeListener('desktop:prefs-closed', listener);
    },
    moveImagePreview: (point) => ipcRenderer.send('desktop:move-image-preview', point),
    hideImagePreview: () => ipcRenderer.send('desktop:hide-image-preview')
});
