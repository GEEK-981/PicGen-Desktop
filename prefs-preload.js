const { contextBridge, ipcRenderer } = require('electron');

// 置顶设置窗（prefs-window.html）的 IPC 桥：
// - 主进程推送面板快照（prefs:render），React 端按 schema 渲染；
// - 用户改动回传（prefs:change），由主窗控制器写回隐藏控件并走既有逻辑；
// - 内容高度变化上报（prefs:resize），主进程调整窗口尺寸；
// - ready 握手：加载完成后主进程再补发暂存的快照。
contextBridge.exposeInMainWorld('picgenPrefs', {
    ready: () => ipcRenderer.send('prefs:ready'),
    pointerEnter: () => ipcRenderer.send('prefs:pointer-enter'),
    pointerLeave: () => ipcRenderer.send('prefs:pointer-leave'),
    sendChange: (payload) => ipcRenderer.send('prefs:change', payload),
    requestClose: () => ipcRenderer.send('prefs:close-request'),
    selectOpen: (open) => ipcRenderer.send('prefs:select-open', !!open),
    resizeTo: (height) => ipcRenderer.send('prefs:resize', height),
    onRender: (callback) => {
        const listener = (_event, snapshot) => callback(snapshot);
        ipcRenderer.on('prefs:render', listener);
        return () => ipcRenderer.removeListener('prefs:render', listener);
    },
    // 窗口显示（重放入场淡入）与隐藏前奏（播放淡出，主进程 150ms 后真正收窗）。
    onShown: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('prefs:shown', listener);
        return () => ipcRenderer.removeListener('prefs:shown', listener);
    },
    onHideAnim: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('prefs:hide-anim', listener);
        return () => ipcRenderer.removeListener('prefs:hide-anim', listener);
    }
});
