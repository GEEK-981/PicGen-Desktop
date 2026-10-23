const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog, shell, safeStorage, session, clipboard, utilityProcess, powerMonitor } = require('electron');
const fs = require('fs/promises');
const fsConstants = require('fs').constants;
const path = require('path');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const zlib = require('zlib');

const { EdgeDock } = require('./edgeDock');
const { PreviewCache } = require('./previewCache');
const { PreviewDecoder } = require('./previewDecoder');
const previewDecoder = new PreviewDecoder(createThumbnailAsync);
const { historyThumbnailKey } = require('./historyThumbnailKey');
const { createSimilarityService, SERVICE: SIMILARITY_SERVICE } = require('./similarityService');
const { createHistoryUsageStore } = require('./historyUsageStore');
const { createHistoryBinStore, createHistoryTrash, reconcileHistoryBin } = require('./historyTrash');
const { classifyDragEnd } = require('./historyUsage');

// v3.1 similarity: the whole engine (sharp decode, the DINOv2 session, the feature store and the
// clustering) runs in the "PicGen Similarity" utility process. Main only diffs records, relays and
// serves cached snapshots, so nothing here decodes pixels or loads onnxruntime. A utility process can
// be killed at any moment; a worker_threads terminate during session.run() takes the whole app down.
let similarityService = null;
let similaritySyncedRecords = null;
let similaritySavingCount = 0;
let similarityClosed = false;
let appReadyAt = 0;
function similarityModelPath() {
    if (process.env.PICGEN_SIMILARITY_MODEL) return path.resolve(process.env.PICGEN_SIMILARITY_MODEL);
    return app.isPackaged
        ? path.join(process.resourcesPath, 'models', 'dinov2-small-q8.onnx')
        : path.join(__dirname, 'models', 'dinov2-small-q8.onnx');
}
function getSimilarityService() {
    if (similarityService) return similarityService;
    const store = getStorePaths();
    similarityService = createSimilarityService({
        hostPath: path.join(__dirname, 'similarity-engine-host.js'),
        spawnHost: ({ hostPath }) => utilityProcess.fork(hostPath, [], { serviceName: 'PicGen Similarity', stdio: 'pipe' }),
        storeDir: path.join(store.root, 'similarity'),
        thumbnailsDir: store.thumbnails,
        // Read at every host start, so a changed output directory is picked up by the next host.
        scanDirs: () => historyScanDirectories(store),
        modelPath: similarityModelPath(),
        ortEnabled: process.env.PICGEN_SIMILARITY_ORT !== 'off',
        backfillAt: (appReadyAt || Date.now()) + SIMILARITY_SERVICE.backfillDelayMs,
        onPush: summary => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:similarity-updated', summary); },
        recordError: entry => errorLogStore?.record(entry)
    });
    // Asked for only after before-quit: serve from a closed service, which never starts a host.
    if (similarityClosed) {
        void similarityService.close();
        return similarityService;
    }
    try {
        similarityService.setLoad({ saving: similaritySavingCount, onBattery: powerMonitor.isOnBatteryPower() });
    } catch { /* battery state is a scheduling hint only */ }
    return similarityService;
}
// Synchronous and fire-and-forget: the service diffs the records and posts only the changes.
// historyIndexCache is replaced, never mutated in place, so the same array needs no second diff.
function syncSimilarityRecords(records) {
    if (!app.isReady() || similarityClosed || records === similaritySyncedRecords) return;
    try {
        getSimilarityService().syncRecords(records);
        similaritySyncedRecords = records;
    } catch (error) {
        console.warn('[similarity] record sync failed:', error.message);
    }
}
function setSimilarityLoad(partial) {
    if (!similarityService || similarityClosed) return;
    try { similarityService.setLoad(partial); } catch { /* a scheduling hint only */ }
}
function adjustSimilaritySaving(delta) {
    similaritySavingCount = Math.max(0, similaritySavingCount + delta);
    setSimilarityLoad({ saving: similaritySavingCount });
}
const { ErrorLogStore } = require('./errorLogStore');
const { defaultFailoverConfigFile } = require('./failoverConfig');
const { normalizeImage2ResultDimensions, createElectronImageCodec } = require('./imageOutputNormalizer');
const { readImageSizeFromBuffer, readImageSizeFromFile, HEAD_BYTES } = require('./imageHeaderSize');
const { ImageNormalizeWorker } = require('./imageNormalizeWorker');
const { SizeReferenceWorker } = require('./sizeReferenceWorker');
const { loadAnchorCatalog } = require('./sizeAnchors');
const { formatLength, toMm } = require('./sizeReferenceLayout');
const { OutputConfigStore } = require('./outputConfig');
const {
    createSerialTaskQueue,
    readJsonFile,
    writeJsonAtomic,
    writeFileExclusive,
    buildGeneratedImageFileName
} = require('./historyPersistence');

// Image2 output normalization sits on the save path. The Electron codec decodes,
// resizes and re-encodes synchronously on the main process — ~1.23 s for a
// 3264x2448 frame (toPNG alone is ~1.2 s of it), during which the window, the tray
// and every in-flight download are frozen. So the codec handed to the normalizer
// reads dimensions off the container header (~0.3 ms) and hands the resize to a
// worker thread, keeping the synchronous Electron codec only as the fallback for
// a format the header reader does not recognise or a worker that has died.
const electronImageCodec = createElectronImageCodec(nativeImage);
const imageNormalizeWorker = new ImageNormalizeWorker((source, options) => electronImageCodec.resize(source, options));

function createImageResultCodec() {
    return {
        getSize(buffer) {
            return readImageSizeFromBuffer(buffer) || electronImageCodec.getSize(buffer);
        },
        resize(buffer, options) {
            return imageNormalizeWorker.resize(buffer, options);
        }
    };
}

const COLLAPSED_BOUNDS = { width: 60, height: 60 };
const EXPANDED_BOUNDS = { width: 460, height: 800 };
const MIN_EXPANDED_BOUNDS = { width: 460, height: 600 };
const IMAGE_PREVIEW_SIZE = 1000;
const HISTORY_SCHEMA_VERSION = 4;
const HISTORY_THUMBNAIL_MAX_SIZE = 360;
const TRAY_ICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAHgSURBVFhHYxgFhICwpJoGv7h6gqC4egOpGKSPX0rVAGoU8UBeXp5DQEK9XUBc/bughPp/amCgectFRbUkoFbgBiAXAy2+js0QSrGAhNpzYKg4QK3CBCCfC0qo3cemmYr4Pc6QEBBXm45FA9UxMIS3Q61EAHC8UzHOCWFgVChArYYAUNxjUwjCYtoR/wWldLHKkYv5JdUCoFZDAFCgAEMh0FKliDP/VZNf/1eJv/dfSN4SVZ4SDMymUKshAJx30RRJmpWBLYdhKetmFHmKMDEOkLbrRHEAiI+uhmw89B0QsOT/w//I4NH/eQEwvZH/56FK/j9QBZODYmo5AGIw1MKHS/77SjT8PwCyEcxGmIWBaeKAgw3/fec/AjKQQwMHppYDEODI/wqgeMVBBBviGAh4OD8SxWwqhwACQyyFOAAiBokSujkAHjLA6ICI0dsBSHLIAEMdxQ6gFA8JB4DKfjo6QK0CXRGo9lNNfAp3gKhmIIo8RRjdAaC2GjaFIspuYJ+L6cZhyFGCQS1mqNUQwC8vL4BNIa0w1uY6sEG6H5ti6mO1+1ArUQGoE0KPdiHeprmguGoELR0BavpBrcINwCEhoXYcmwHkYoKdEmxASEzDAqg5A1xGkIlBPibZYvoBBgYAmSCQeay59S4AAAAASUVORK5CYII=';
const QUIT_ARG = '--picgen-quit';

if (app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
    app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'PicGenData'));
}

app.setName('PicGen');
Menu.setApplicationMenu(null);
if (process.platform === 'win32') {
    app.setAppUserModelId('com.picgen.desktop');
}

let mainWindow = null;
let serverRuntime = null;
let serverRuntimePromise = null;
let errorLogStore = null;
let outputConfigStore = null;
let unsubscribeErrorLog = null;
let isExpanded = false;
let lastExpandedSize = { ...EXPANDED_BOUNDS };
let tray = null;
let isQuitting = false;
let windowMoveState = null;
// 置顶（pin）总开关：true = 窗口保持最前 + 暂停贴边自动收起；false = 普通窗口，可被覆盖。
// 默认置顶，延续悬浮窗的定位。
let mainWindowPinned = true;
let edgeDock = null;
let edgeTabWindow = null;
let edgeDockTimer = null;
let dockInteractionBusy = false;
let dockNativeHolds = 0;
let nativeWindowMoving = false;
let applyingDockBounds = false;
let boundsAnimTimer = null;
let imagePreviewWindow = null;
// 进行中的原生图片拖拽数（desktop:start-image-drag 到 startDrag 返回）：期间不弹悬停预览。
// 用计数不用布尔：上一次拖拽的 finally 不能替仍在生成图标的下一次解除屏蔽。
let imageDragActive = 0;
// 当前悬停预览的锚点图块（渲染层页面坐标），见 cursorOnImagePreviewAnchor。
let imagePreviewAnchor = null;
// 置顶设置窗：独立 BrowserWindow，可超出主窗、覆盖其上，跟随触发按钮定位。
let prefsWindow = null;
let prefsWindowReady = false;
let pendingPrefsSnapshot = null;
let prefsAnchor = null;
let prefsContentHeight = 0;
// 移出即关的宽限定时器：触发按钮 mouseleave / 置顶窗 pointer-leave 各自安排 350ms
// 后关闭；期间指针进入另一侧（按钮 → 窗体接力，或反向）即取消，保证横移不误杀。
let prefsCloseTimer = null;
// 置顶窗里的原生下拉展开期间（选项列表可能画到窗外）不因指针位置收窗
let prefsSelectOpen = false;
// 本次打开时定下的弹出方向（按钮下方 / 上方）；内容高度变化时沿用，避免面板从指针下跳走
let prefsPlacement = null;
// 淡出动画定时器：hide 先让渲染层播放淡出（prefs:hide-anim），150ms 后真正收窗；
// 期间重新打开会取消收窗并重放入场淡入。
let prefsHideTimer = null;
let imagePreviewState = null;
let imagePreviewRequestId = 0;
let imagePreviewLastBounds = null;
let imagePreviewLoadPromise = null;
let hoverImageCache = null;
let thumbnailDecoderWindow = null;
let thumbnailDecoderReady = null;
let isBringingMainWindowToFront = false;
let historyIndexCache = null;
// lower(resolved path) → record, rebuilt by setHistoryIndexCache whenever historyIndexCache is
// assigned. The per-path keys are memoised (path.resolve is ~1.5 µs on Windows, so a cold rebuild of
// 5.8k records costs ~10 ms; a warm one ~0.5 ms).
let historyPathIndex = new Map();
const historyPathKeys = new Map();
let historyIndexLoadPromise = null;
const enqueueHistoryMutation = createSerialTaskQueue();
const enqueueThumbnailGeneration = createSerialTaskQueue();
const thumbnailJobs = new Map();
const launchWantsQuit = process.argv.includes(QUIT_ARG);
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
    app.quit();
}

function createAppIcon() {
    return nativeImage.createFromPath(path.join(__dirname, 'assets', 'picgen-icon.png'));
}

// 拖拽兜底图标：startDrag 遇到空图标会抛异常、导致整个拖拽失效。原图当图标在
// 某些格式/超大图上会 createFromPath 得到空图（这就是"有概率拖不动"的根因），
// 此时改用应用图标缩略作图标——文件本身照常拖出，仅图标退化。
let dragFallbackIconCache = null;
const DRAG_ICON_TIMEOUT_MS = 250;
const DRAG_MAX_FILES = 500;

// Renderer payload → unique existing regular files: a path, a list of paths, or {files}.
async function normalizeDragFiles(payload) {
    const raw = typeof payload === 'string' ? [payload]
        : Array.isArray(payload) ? payload
            : Array.isArray(payload?.files) ? payload.files : [];
    const seen = new Set();
    const files = [];
    for (const value of raw) {
        if (typeof value !== 'string' || !value) continue;
        const resolved = path.resolve(value);
        const key = resolved.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        try {
            if ((await fs.lstat(resolved)).isFile()) files.push(resolved);
        } catch { /* gone or unreadable: not dragged */ }
        if (files.length >= DRAG_MAX_FILES) break;
    }
    return files;
}

// The cached history thumbnail when there is one (cheap to decode), else the file itself.
async function dragIconSource(filePath) {
    try {
        const stat = await fs.stat(filePath);
        const thumbnail = path.join(getStorePaths().thumbnails, historyThumbnailKey(filePath, stat));
        await fs.access(thumbnail);
        return thumbnail;
    } catch {
        return filePath;
    }
}

// Drag image: a rounded card, or a fanned stack with a count badge for several files, composed in the
// sharp worker. Bounded wait so the drag always starts promptly; the fallback is the app icon.
async function buildImageDragIcon(files) {
    try {
        const sources = await Promise.all(files.slice(0, 3).map(dragIconSource));
        const scaleFactor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor || 1;
        let timer;
        const icon = await Promise.race([
            previewDecoder.dragIcon({ sources, count: files.length, scale: scaleFactor }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('drag icon timed out')), DRAG_ICON_TIMEOUT_MS); })
        ]).finally(() => clearTimeout(timer));
        const image = nativeImage.createFromBuffer(icon.buffer, { scaleFactor });
        if (!image.isEmpty()) return image;
    } catch (error) {
        console.warn('[Drag] icon fallback:', error.message);
    }
    return dragFallbackIcon();
}

async function startImageDrag(sender, payload) {
    const files = await normalizeDragFiles(payload);
    if (!files.length || sender.isDestroyed()) {
        if (!sender.isDestroyed()) sender.send('desktop:image-drag-ended', null);
        return;
    }
    const icon = await buildImageDragIcon(files);
    if (sender.isDestroyed()) return;
    const item = files.length > 1 ? { file: files[0], files, icon } : { file: files[0], icon };
    try {
        sender.startDrag(item);
    } catch (error) {
        // 兜底图标再试一次；仍失败才记日志放弃（不抛出，避免影响后续消息）。
        try { sender.startDrag({ ...item, icon: dragFallbackIcon() }); }
        catch (retryError) { console.error('[Drag] startDrag failed:', retryError.message); }
    }
    // Windows 上 startDrag 同步阻塞到拖拽结束（OLE DoDragDrop 模态循环）。
    // 结束后把光标落点回传渲染层：拖回本窗口时 Chromium 不会给拖拽源派发 drop
    // 事件，参考图"拖到垃圾桶删除"改由落点命中检测实现。
    let point = null;
    try {
        point = screen.getCursorScreenPoint();
        if (!sender.isDestroyed()) sender.send('desktop:image-drag-ended', point);
    } catch { /* 窗口已销毁等场景忽略 */ }
    // 拖出计数：落点在所有可见 PicGen 窗口之外才算拖到了其他应用（落在参考图区由渲染层计为参考使用）。
    if (point) {
        for (const filePath of files) {
            void finishImageDrag(filePath, point).catch(error => console.warn('[Drag] usage count failed:', error.message));
        }
    }
}

function dragFallbackIcon() {
    if (!dragFallbackIconCache || dragFallbackIconCache.isEmpty()) {
        const appIcon = createAppIcon();
        dragFallbackIconCache = appIcon.isEmpty()
            ? nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
            : appIcon.resize({ width: 64 });
    }
    return dragFallbackIconCache;
}

function getStorePaths() {
    const root = path.join(app.getPath('userData'), 'desktop-cache');
    return {
        root,
        images: path.join(root, 'images'),
        previews: path.join(root, 'previews'),
        thumbnails: path.join(root, 'thumbnails'),
        references: path.join(root, 'references'),
        recentFile: path.join(root, 'recent-images.json')
    };
}

async function ensureStore() {
    const store = getStorePaths();
    await fs.mkdir(store.images, { recursive: true });
    await fs.mkdir(store.previews, { recursive: true });
    await fs.mkdir(store.thumbnails, { recursive: true });
    await fs.mkdir(store.references, { recursive: true });
    return store;
}

function pathIsWithin(rootPath, candidatePath) {
    const root = path.resolve(rootPath).toLowerCase();
    const candidate = path.resolve(candidatePath).toLowerCase();
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function getOutputDirectoryState(options = {}) {
    const store = await ensureStore();
    const config = outputConfigStore ? await outputConfigStore.get() : { directory: '' };
    const configuredDirectory = String(config.directory || '').trim();
    const effectiveDirectory = configuredDirectory || store.images;
    if (options.ensureExists) await fs.mkdir(effectiveDirectory, { recursive: true });
    return {
        directory: configuredDirectory,
        effectiveDirectory,
        isDefault: !configuredDirectory,
        defaultDirectory: store.images
    };
}

function serializeHistoryRecord(record) {
    const { url: _url, thumbnailUrl: _thumbnailUrl, ...stored } = record || {};
    return stored;
}

function hydrateHistoryRecord(record) {
    if (!record?.filePath) return null;
    return {
        ...record,
        id: record.id || `file_${crypto.createHash('sha1').update(path.resolve(record.filePath).toLowerCase()).digest('hex').slice(0, 16)}`,
        fileName: record.fileName || path.basename(record.filePath),
        mimeType: record.mimeType || fileNameToMimeType(record.filePath),
        prompt: record.prompt || '',
        ratio: record.ratio || '',
        model: record.model || '',
        providerName: record.providerName || '',
        createdAt: Number(record.createdAt || 0),
        width: Number(record.width || 0),
        height: Number(record.height || 0),
        fileSize: Number(record.fileSize || 0),
        url: pathToFileURL(record.filePath).href
    };
}

async function normalizeHistoryRecord(record) {
    const filePath = String(record?.filePath || '');
    if (!filePath) return null;
    const stat = await fs.stat(filePath);
    // Prefer the container header (~0.3 ms) over a full decode (~120 ms on a
    // 12 MB PNG). The decode stays as the fallback for formats the header
    // reader does not recognise.
    const nativeSize = (!record.width || !record.height)
        ? (await readImageSizeFromFile(filePath)) || nativeImage.createFromPath(filePath).getSize()
        : { width: record.width, height: record.height };
    return {
        ...record,
        id: record.id || `file_${crypto.createHash('sha1').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 16)}`,
        filePath,
        fileName: record.fileName || path.basename(filePath),
        mimeType: record.mimeType || fileNameToMimeType(filePath),
        prompt: record.prompt || '',
        ratio: record.ratio || '',
        model: record.model || '',
        providerName: record.providerName || '',
        createdAt: Number(record.createdAt || 0) || stat.birthtimeMs || stat.mtimeMs,
        width: Number(record.width || nativeSize.width || 0),
        height: Number(record.height || nativeSize.height || 0),
        fileSize: stat.size,
        url: pathToFileURL(filePath).href
    };
}

// 重建索引时要扫哪些目录。历史条目未必都躺在应用默认目录里：可能是用户配置的输出目录
// （绝对路径，甚至指向另一个数据根），也可能是被系统改名出来的同级 images-*（如
// images-[PH2]）。只扫默认目录的话，重建会把这两类条目整批丢掉——图片还在盘上，
// 却从历史里消失。
async function historyScanDirectories(store) {
    const candidates = [store.images];
    try {
        const output = await getOutputDirectoryState();
        if (output?.effectiveDirectory) candidates.push(output.effectiveDirectory);
    } catch { /* 配置读不出来就只扫默认目录 */ }
    try {
        for (const entry of await fs.readdir(store.root, { withFileTypes: true })) {
            const name = entry.name.toLowerCase();
            if (entry.isDirectory() && name.startsWith('images') && name !== 'images') {
                candidates.push(path.join(store.root, entry.name));
            }
        }
    } catch { /* root 读不到就忽略 */ }

    const unique = new Map();
    for (const directory of candidates) {
        const resolved = path.resolve(directory);
        unique.set(resolved.toLowerCase(), resolved);
    }
    return [...unique.values()];
}

async function readImagePrefix(filePath, bytes) {
    const handle = await fs.open(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close().catch(() => {});
    }
}

// 只需要容器头部那一段：PNG 的 iTXt/XMP 插在 IHDR 之后、JPEG 的 APP1 紧跟 SOI，
// 两者都落在 HEAD_BYTES 之内；而一次历史恢复要面对上千张平均 5–10MB 的图，整文件读
// 等于白搬十几 GB。认不出容器时（WebP 的 XMP 追加在文件尾部）退回整文件读。
async function readDiscoveryBuffer(filePath) {
    const prefix = await readImagePrefix(filePath, HEAD_BYTES);
    const isPng = prefix.length >= PNG_SIGNATURE.length && prefix.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    const isJpeg = prefix[0] === 0xff && prefix[1] === JPEG_SOI;
    if (isPng || isJpeg) return prefix;
    return fs.readFile(filePath);
}

async function discoverHistoryImages(store, knownPaths) {
    const discovered = [];
    for (const directory of await historyScanDirectories(store)) {
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch { continue; }
        for (const entry of entries) {
            if (!entry.isFile() || !/\.(?:png|jpe?g|webp|gif)$/i.test(entry.name)) continue;
            const filePath = path.join(directory, entry.name);
            const pathKey = path.resolve(filePath).toLowerCase();
            if (knownPaths.has(pathKey)) continue;

            try {
                const buffer = await readDiscoveryBuffer(filePath);
                const metadata = readImageMetadataFromImage(buffer) || {};
                // The buffer is already in hand — read the size off it rather than
                // letting normalizeHistoryRecord open and decode the file a second time.
                const headerSize = readImageSizeFromBuffer(buffer) || {};
                const record = await normalizeHistoryRecord({
                    id: metadata.id || '',
                    filePath,
                    fileName: entry.name,
                    mimeType: metadata.mimeType || fileNameToMimeType(entry.name),
                    prompt: metadata.prompt || '',
                    ratio: metadata.ratio || '',
                    model: metadata.model || '',
                    providerName: metadata.providerName || '',
                    createdAt: metadata.createdAt || 0,
                    width: metadata.width || headerSize.width || 0,
                    height: metadata.height || headerSize.height || 0
                });
                if (record) {
                    discovered.push(record);
                    knownPaths.add(pathKey);
                }
            } catch {
                // Ignore invalid image files while rebuilding the history index.
            }
        }
    }
    return discovered;
}

// 索引文件读不出来时要能一眼看出「这不是能还原的备份」：上次索引被写成 5.7MB 全零
// （写缓存丢失的典型签名），这里照样 copyFile 出一份同名 backup —— 看着像有救，
// 实际什么都没有。坏文件改存 .corrupt-*、并在错误日志里留一条，好复盘。
function isCorruptHistoryPayload(raw) {
    if (!raw || !raw.trim()) return true;
    if (raw.includes('\u0000')) return true;
    try { JSON.parse(raw.replace(/^\uFEFF/, '')); return false; } catch { return true; }
}

async function backupHistoryIndex(store, schemaVersion) {
    const suffix = new Date().toISOString().replace(/[:.]/g, '-');
    try {
        const raw = await fs.readFile(store.recentFile, 'utf8');
        if (isCorruptHistoryPayload(raw)) {
            const corruptPath = path.join(store.root, `recent-images.corrupt-${suffix}.json`);
            await fs.writeFile(corruptPath, raw, { flag: 'wx' }).catch(() => {});
            return { path: corruptPath, corrupt: true };
        }
        const backupPath = path.join(store.root, `recent-images.backup-v${schemaVersion || 0}-${suffix}.json`);
        await fs.writeFile(backupPath, raw, { flag: 'wx' });
        return { path: backupPath, corrupt: false };
    } catch (error) {
        if (error.code === 'ENOENT') return { path: '', corrupt: false };
        throw error;
    }
}

function historyPathKey(filePath) {
    const source = String(filePath || '');
    let key = historyPathKeys.get(source);
    if (key === undefined) {
        key = path.resolve(source).toLowerCase();
        if (historyPathKeys.size >= 100000) historyPathKeys.clear();
        historyPathKeys.set(source, key);
    }
    return key;
}

function setHistoryIndexCache(records) {
    historyIndexCache = records;
    const index = new Map();
    for (const record of records || []) {
        if (record?.filePath) index.set(historyPathKey(record.filePath), record);
    }
    historyPathIndex = index;
    return historyIndexCache;
}

// The registered history record for a file path (case-insensitive, resolved), or null.
async function findHistoryRecordByPath(filePath) {
    if (!filePath) return null;
    await loadHistoryIndex();
    return historyPathIndex.get(historyPathKey(filePath)) || null;
}

async function loadHistoryIndex() {
    if (historyIndexCache) return historyIndexCache;
    if (historyIndexLoadPromise) return historyIndexLoadPromise;

    historyIndexLoadPromise = (async () => {
        const store = await ensureStore();
        // The usage counters and the in-app bin load beside the index. Neither blocks history when
        // unreadable: counters then show nothing, and bin operations refuse to run (they load it again).
        const [parsed, sidecars] = await Promise.all([
            readJsonFile(store.recentFile, { schemaVersion: 0, images: [] }),
            loadHistorySidecars()
        ]);
        const schemaVersion = Number(Array.isArray(parsed) ? 0 : parsed?.schemaVersion || 0);
        const rawRecords = Array.isArray(parsed) ? parsed : parsed?.images;
        const hydratedRecords = (Array.isArray(rawRecords) ? rawRecords : [])
            .map(hydrateHistoryRecord)
            .filter(Boolean);
        // Before knownPaths: a record whose file is in the in-app bin leaves history, and every binned
        // path counts as known, so orphan discovery never brings a deleted image back.
        const binOutcome = await reconcileHistoryBin({ records: hydratedRecords, entries: getHistoryBin().list(), fs });
        const records = binOutcome.records;
        const binChanged = binOutcome.changed;

        const knownPaths = new Set(records.map(record => path.resolve(record.filePath).toLowerCase()));
        for (const binnedPath of binOutcome.binnedPaths) knownPaths.add(binnedPath.toLowerCase());
        // Directory enumeration is cheap and recovers files left behind if the
        // process stopped after the image write but before the index commit. Skipped while the bin
        // cannot be read: binned files would otherwise come back as promptless orphans.
        const discovered = sidecars.binReady ? await discoverHistoryImages(store, knownPaths) : [];
        const mergedByPath = new Map();
        for (const record of [...records, ...discovered]) {
            mergedByPath.set(path.resolve(record.filePath).toLowerCase(), hydrateHistoryRecord(record));
        }
        const merged = [...mergedByPath.values()]
            .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));

        if (schemaVersion < HISTORY_SCHEMA_VERSION || discovered.length > 0 || binChanged) {
            const backup = await backupHistoryIndex(store, schemaVersion);
            await writeJsonAtomic(store.recentFile, {
                schemaVersion: HISTORY_SCHEMA_VERSION,
                images: merged.map(serializeHistoryRecord)
            });
            console.log(`[History] 索引升级到 v${HISTORY_SCHEMA_VERSION}，恢复孤立图片 ${discovered.length} 张`);
            if (binChanged) console.log(`[History] 移出已在回收站中的 ${binOutcome.removed.length} 张`);
            // 索引坏了不能只留在控制台：用户看不到 devtools，而「历史怎么少了一截」必须
            // 能在错误日志里复盘 —— 附上扫过的目录，好判断是不是又漏了某个存图目录。
            if (backup.corrupt) {
                const directories = await historyScanDirectories(store).catch(() => []);
                await errorLogStore?.record({
                    source: 'storage',
                    title: '历史索引损坏，已按磁盘重建',
                    message: `索引文件不可解析（原文件已另存 ${path.basename(backup.path)}）。扫描 ${directories.length} 个目录，恢复 ${discovered.length} 张孤立图片，当前共 ${merged.length} 条。`,
                    operation: 'load-history-index',
                    details: {
                        corruptFile: backup.path,
                        scannedDirectories: directories,
                        recovered: discovered.length,
                        total: merged.length
                    }
                }).catch(() => {});
            }
        }
        // Bin entries whose file is gone are dropped (lstat ENOENT only; an unreadable path stays binned).
        if (binOutcome.gone.length) await dropGoneBinEntries(binOutcome.gone);
        return setHistoryIndexCache(merged);
    })();

    try {
        return await historyIndexLoadPromise;
    } finally {
        historyIndexLoadPromise = null;
    }
}

// Usage counters are projected onto the copies handed out; historyIndexCache never holds them.
async function readHistoryImages() {
    const records = await loadHistoryIndex();
    syncSimilarityRecords(records);
    const usage = await readyHistoryUsageStore();
    return records.map(usage.project);
}

async function commitHistoryImages(records) {
    const store = await ensureStore();
    const hydrated = records.map(hydrateHistoryRecord).filter(Boolean);
    await writeJsonAtomic(store.recentFile, {
        schemaVersion: HISTORY_SCHEMA_VERSION,
        images: hydrated.map(serializeHistoryRecord)
    });
    setHistoryIndexCache(hydrated);
    syncSimilarityRecords(hydrated);
    return historyIndexCache;
}

async function readRecentImages(options = {}) {
    const records = await loadHistoryIndex();
    syncSimilarityRecords(records);
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 10));
    const usage = await readyHistoryUsageStore();
    return records.slice(0, limit).map(usage.project);
}

// ===== History usage counters and the in-app recycle bin (v3.1 §2.12, §2.13) =====
// Counters live in desktop-cache/history-usage.json, keyed by lower(fileName)|fileSize, and are
// projected onto records when they are read. Deleting from history only marks an image: the file stays
// where it is, the record moves from the index into the bin (desktop-cache/history-trash.json).
// Restore puts the record back; purge hard-deletes the file (fs.unlink, never the Windows Recycle Bin).
// loadHistoryIndex keeps every binned path out of history and out of orphan discovery.
// 'workspace'：在图片工作台打开（发送到图片工作台、局部编辑）；'mask-edit' 留给旧数据与测试。
// dragCount 记的是「带出 PicGen」：原生拖出、右键复制图片、另存为都记 'drag-out'，只在主进程记（countExternalUse）。
const REFERENCE_USE_SOURCES = new Set(['drop', 'menu', 'menu-new-sequence', 'drawer', 'mask-edit', 'workspace']);
const HISTORY_BIN_SWEEP_THROTTLE_MS = 5000;
let historyUsageStore = null;
let historyBin = null;
let historyTrash = null;
let lastHistoryBinSweepAt = 0;
const historyStorageWarnings = new Set();

function warnHistoryStorageOnce(topic, error) {
    if (historyStorageWarnings.has(topic)) return;
    historyStorageWarnings.add(topic);
    console.warn(`[History] ${topic}:`, error?.message || error);
}

function getHistoryUsageStore() {
    if (!historyUsageStore) {
        historyUsageStore = createHistoryUsageStore({ dir: getStorePaths().root, log: entry => errorLogStore?.record(entry) });
    }
    return historyUsageStore;
}

function getHistoryBin() {
    if (!historyBin) {
        historyBin = createHistoryBinStore({ dir: getStorePaths().root, log: entry => errorLogStore?.record(entry) });
    }
    return historyBin;
}

// Both loads are idempotent and retried by the next caller after an I/O error, so a failure here
// never sticks: every bin operation loads the bin again and refuses to run while it is unreadable.
// → {binReady}: false while the bin cannot be read (loadHistoryIndex then skips orphan discovery).
async function loadHistorySidecars() {
    const [, binReady] = await Promise.all([
        getHistoryUsageStore().load().catch(error => warnHistoryStorageOnce('usage counters unavailable', error)),
        getHistoryBin().load().then(() => true, error => {
            warnHistoryStorageOnce('history bin unavailable', error);
            return false;
        })
    ]);
    return { binReady };
}

async function readyHistoryUsageStore() {
    const store = getHistoryUsageStore();
    await store.load().catch(error => warnHistoryStorageOnce('usage counters unavailable', error));
    return store;
}

// History events go to every open window; the main window's renderer is the one that listens.
function broadcastToWindows(channel, payload) {
    for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        try { window.webContents.send(channel, payload); } catch { /* a closing window must not break the caller */ }
    }
}

// Absolute values, so a repeated or reordered push is harmless.
function broadcastHistoryUsage(record, result) {
    broadcastToWindows('desktop:history-usage-updated', { usageKey: result.usageKey, filePath: record.filePath, usage: result.usage });
}

// Smoke-only (PICGEN_SMOKE=1): PICGEN_SMOKE_PURGE_FAIL=<basename part> makes a purge refuse the files
// whose name carries it (the partial-failure path). Saved names start with a timestamp, so a smoke
// launched with the variable can only know the task id it will save under. Read on every call.
function unlinkHistoryFile(filePath) {
    const refused = process.env.PICGEN_SMOKE === '1' ? String(process.env.PICGEN_SMOKE_PURGE_FAIL || '').trim().toLowerCase() : '';
    if (refused && path.basename(filePath).toLowerCase().includes(refused)) {
        return Promise.reject(Object.assign(new Error(`EPERM: smoke purge refused ${path.basename(filePath)}`), { code: 'EPERM' }));
    }
    return fs.unlink(filePath);
}

// Best effort: a purged image's history thumbnail (same key getHistoryThumbnail uses). Hover previews
// are keyed by the unnormalized source path and stay until the cache is cleared.
function removePurgedHistoryCache({ filePath, stat }) {
    const thumbnail = path.join(getStorePaths().thumbnails, historyThumbnailKey(filePath, stat));
    fs.unlink(thumbnail).catch(() => {});
}

// The bin module queues its own steps on the history queue, so loadIndex and commit are the raw
// functions, and trash()/restore()/purge() are only ever called from IPC handlers (WP4 handoff).
function getHistoryTrash() {
    if (historyTrash) return historyTrash;
    historyTrash = createHistoryTrash({
        loadIndex: loadHistoryIndex,
        commit: commitHistoryImages,
        enqueue: enqueueHistoryMutation,
        usageStore: getHistoryUsageStore(),
        tombstones: getHistoryBin(),
        fs,
        unlink: unlinkHistoryFile,
        hydrate: record => {
            const hydrated = hydrateHistoryRecord(record);
            return hydrated ? getHistoryUsageStore().project(hydrated) : null;
        },
        log: entry => errorLogStore?.record(entry),
        onProgress: progress => broadcastToWindows('desktop:history-trash-progress', progress),
        onChanged: change => broadcastToWindows('desktop:history-changed', change),
        onBinChanged: change => broadcastToWindows('desktop:history-bin-changed', change),
        onPurged: removePurgedHistoryCache
    });
    return historyTrash;
}

async function listHistoryBin() {
    await readyHistoryUsageStore();
    return getHistoryTrash().list();
}

// Load-time: loadHistoryIndex can itself run inside the history queue, so this never enqueues.
// Never rejects: a failed save stays dirty and is retried by the next save (or the next pass).
function dropGoneBinEntries(entries) {
    const bin = getHistoryBin();
    if (!bin.remove(entries.map(entry => entry.path))) return Promise.resolve();
    lastHistoryBinSweepAt = Date.now(); // the first focus need not repeat this pass straight away
    broadcastToWindows('desktop:history-bin-changed', { total: bin.list().length });
    return bin.save().catch(error => warnHistoryStorageOnce('history bin cleanup failed', error));
}

// Focus-time sweep: drops bin entries whose file is gone (deleted outside PicGen). Once per 5 s at
// most, and only when the bin has entries. Never touches history and never enqueues.
function scheduleHistoryBinSweep({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastHistoryBinSweepAt < HISTORY_BIN_SWEEP_THROTTLE_MS) return Promise.resolve(null);
    lastHistoryBinSweepAt = now;
    const bin = getHistoryBin();
    return bin.load()
        .then(() => (bin.list().length ? getHistoryTrash().sweep() : { dropped: [], total: 0 }))
        .catch(error => {
            errorLogStore?.record({
                source: 'storage',
                title: '整理回收站失败',
                message: error.message,
                error,
                operation: 'sweep-history-bin'
            }).catch(() => {});
            return { dropped: [], total: 0, error: error.message };
        });
}

// A native drag ended at `point` (screen DIP). Released outside every visible PicGen window counts as
// a drag-out to another app. Inside (or unknown) counts nothing here: a release on the reference band
// is counted by the renderer as a reference use, so one gesture adds at most one increment.
// 右键复制图片 / 另存为同样记 'drag-out'，见 countExternalUse。
async function finishImageDrag(filePath, point) {
    // 悬停预览窗 setIgnoreMouseEvents 穿透：落在它上面的文件其实给了下面的应用，应算拖出
    const windows = BrowserWindow.getAllWindows()
        .filter(window => !window.isDestroyed() && window.isVisible() && window !== imagePreviewWindow)
        .map(window => ({ bounds: window.getBounds() }));
    const outcome = classifyDragEnd({ point, windows });
    if (outcome !== 'outside') return { outcome, counted: false };
    const record = await findHistoryRecordByPath(filePath); // null for references/, previews/ and foreign files
    if (!record) return { outcome, counted: false, reason: 'not-history' };
    const result = await getHistoryUsageStore().record(record, 'drag-out', 'native-drag');
    if (result.changed) broadcastHistoryUsage(record, result);
    return { outcome, counted: result.changed, coalesced: result.coalesced, usageKey: result.usageKey, usage: result.usage };
}

// An in-app AI-input use (reference band drop, 发送到参考图, 发送到图片工作台 / 局部编辑). 'drag-out' (拖出/复制/另存)
// is main-only.
// Never throws for a bad kind or a foreign path, so those never reach the error log.
async function recordHistoryUsage(payload) {
    const request = payload && typeof payload === 'object' ? payload : {};
    if (request.kind !== 'reference' || !REFERENCE_USE_SOURCES.has(request.source)) return { ok: false, reason: 'bad-kind' };
    const record = typeof request.filePath === 'string' ? await findHistoryRecordByPath(request.filePath) : null;
    if (!record) return { ok: false, reason: 'not-history' };
    const result = await getHistoryUsageStore().record(record, 'reference', request.source);
    if (result.changed) broadcastHistoryUsage(record, result);
    return { ok: true, changed: result.changed, coalesced: result.coalesced, usageKey: result.usageKey, usage: result.usage };
}

// 右键「复制图片」「另存为…」把图带出 PicGen：和原生拖出一样记为 'drag-out'（source 'copy' / 'save-as'），只在主进程、
// 操作成功之后记；同一张图 750 ms 内的连续带出（连点两下、复制完马上拖出）只计一次。只计历史图：参考图缓存
// （${refId}.ext）、回收站和别处的文件都找不到记录。图已经复制或存好了，计数失败不能变成操作失败，所以不抛出。
async function countExternalUse(filePath, source) {
    try {
        const record = await findHistoryRecordByPath(filePath);
        if (!record) return { counted: false };
        const result = await getHistoryUsageStore().record(record, 'drag-out', source);
        if (result.changed) broadcastHistoryUsage(record, result);
        return { counted: result.changed, coalesced: result.coalesced, usageKey: result.usageKey, usage: result.usage };
    } catch (error) {
        warnHistoryStorageOnce('usage counter update failed', error);
        return { counted: false };
    }
}

// Smoke-only: the outcome half of a native drag, driven over CDP (a real OLE drag loop cannot be
// automated). Same push and same counting as the real drag handler.
async function smokeDragOutcome(payload, event) {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : '';
    const x = Number(payload?.point?.x);
    const y = Number(payload?.point?.y);
    if (!filePath || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new TypeError('smoke drag outcome needs {filePath, point:{x, y}}');
    }
    const point = { x, y };
    try { event?.sender?.send('desktop:image-drag-ended', point); } catch { /* window gone */ }
    return finishImageDrag(filePath, point);
}

function mimeToExtension(mimeType = '') {
    const clean = mimeType.split(';')[0].toLowerCase();
    if (clean === 'image/jpeg' || clean === 'image/jpg') return 'jpg';
    if (clean === 'image/webp') return 'webp';
    if (clean === 'image/gif') return 'gif';
    return 'png';
}

function fileNameToMimeType(fileName = '') {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    return 'image/png';
}

function safeName(text) {
    const source = String(text || 'image').trim();
    return source
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 42) || 'image';
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOI = 0xd8;
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';
const PICGEN_PROMPT_SCHEMA = 'picgen.prompt/v1';
const PICGEN_XMP_NAMESPACE = 'urn:picgen:metadata:1.0';

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let value = i;
        for (let j = 0; j < 8; j += 1) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[i] = value >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function xmlUnescape(text) {
    return String(text)
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');
}

function buildPromptMetadata(payload) {
    const prompt = String(payload?.prompt || '');
    if (!prompt.trim()) return null;

    return {
        schema: PICGEN_PROMPT_SCHEMA,
        id: payload?.id || '',
        prompt,
        ratio: payload?.ratio || '',
        model: payload?.model || '',
        providerName: payload?.providerName || '',
        mimeType: payload?.mimeType || '',
        width: Number(payload?.width || 0) || 0,
        height: Number(payload?.height || 0) || 0,
        createdAt: payload?.createdAt || Date.now()
    };
}

function metadataFromMetadataValue(value) {
    const raw = String(value || '');
    if (!raw.trim()) return null;

    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') return { prompt: parsed };
        if (parsed && typeof parsed === 'object') {
            return {
                ...parsed,
                prompt: typeof parsed.prompt === 'string'
                    ? parsed.prompt
                    : typeof parsed.text === 'string'
                        ? parsed.text
                        : typeof parsed.promptText === 'string'
                            ? parsed.promptText
                            : ''
            };
        }
    } catch {
        // Raw text is also a valid prompt payload.
    }

    return { prompt: raw };
}

function promptFromMetadataValue(value) {
    return metadataFromMetadataValue(value)?.prompt || '';
}

function createPromptXmpPacket(metadata) {
    return [
        '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="PicGen">',
        '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
        `    <rdf:Description xmlns:picgen="${PICGEN_XMP_NAMESPACE}">`,
        `      <picgen:payload>${xmlEscape(JSON.stringify(metadata))}</picgen:payload>`,
        '    </rdf:Description>',
        '  </rdf:RDF>',
        '</x:xmpmeta>'
    ].join('\n');
}

function extractPromptFromXmp(packet) {
    return extractMetadataFromXmp(packet)?.prompt || '';
}

function extractMetadataFromXmp(packet) {
    const match = String(packet || '').match(/<picgen:payload>([\s\S]*?)<\/picgen:payload>/i);
    if (!match) return null;
    return metadataFromMetadataValue(xmlUnescape(match[1]));
}

function createPngChunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(data.length, 0);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function createPngUtf8TextChunk(keyword, text) {
    const header = Buffer.from([0, 0, 0, 0]);
    return createPngChunk('iTXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        header,
        Buffer.from(text, 'utf8')
    ]));
}

function createPngXmpChunk(metadata) {
    const keyword = Buffer.from('XML:com.adobe.xmp', 'latin1');
    const itxtHeader = Buffer.from([0, 0, 0, 0]);
    return createPngChunk('iTXt', Buffer.concat([
        keyword,
        Buffer.from([0]),
        itxtHeader,
        Buffer.from(createPromptXmpPacket(metadata), 'utf8')
    ]));
}

function parsePngTextChunk(type, data) {
    if (type === 'tEXt') {
        const separator = data.indexOf(0);
        if (separator === -1) return null;
        return {
            keyword: data.toString('latin1', 0, separator),
            value: data.slice(separator + 1).toString('utf8')
        };
    }

    if (type === 'zTXt') {
        const separator = data.indexOf(0);
        if (separator === -1 || separator + 2 > data.length) return null;
        try {
            return {
                keyword: data.toString('latin1', 0, separator),
                value: zlib.inflateSync(data.slice(separator + 2)).toString('utf8')
            };
        } catch {
            return null;
        }
    }

    if (type === 'iTXt') {
        let cursor = 0;
        const keywordEnd = data.indexOf(0, cursor);
        if (keywordEnd === -1 || keywordEnd + 5 > data.length) return null;

        const keyword = data.toString('latin1', 0, keywordEnd);
        const compressionFlag = data[keywordEnd + 1];
        const compressionMethod = data[keywordEnd + 2];
        cursor = keywordEnd + 3;

        const languageEnd = data.indexOf(0, cursor);
        if (languageEnd === -1) return null;
        cursor = languageEnd + 1;

        const translatedEnd = data.indexOf(0, cursor);
        if (translatedEnd === -1) return null;
        cursor = translatedEnd + 1;

        try {
            const textBuffer = data.slice(cursor);
            if (compressionFlag !== 0 && compressionFlag !== 1) return null;
            if (compressionFlag === 1 && compressionMethod !== 0) return null;
            const value = compressionFlag === 1
                ? zlib.inflateSync(textBuffer).toString('utf8')
                : textBuffer.toString('utf8');
            return { keyword, value };
        } catch {
            return null;
        }
    }

    return null;
}

function isPicGenPngTextChunk(type, data) {
    const parsed = parsePngTextChunk(type, data);
    return parsed?.keyword === 'prompt'
        || parsed?.keyword === 'XML:com.adobe.xmp';
}

function embedPngPromptMetadata(buffer, metadata) {
    if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return buffer;

    const chunks = [
        createPngUtf8TextChunk('prompt', metadata.prompt),
        createPngXmpChunk(metadata)
    ];
    const output = [PNG_SIGNATURE];
    let offset = PNG_SIGNATURE.length;
    let inserted = false;

    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const end = dataStart + length + 4;
        if (end > buffer.length) throw new Error('Invalid PNG image');

        const data = buffer.slice(dataStart, dataStart + length);
        if (!isPicGenPngTextChunk(type, data)) {
            output.push(buffer.slice(offset, end));
        }

        if (type === 'IHDR' && !inserted) {
            output.push(...chunks);
            inserted = true;
        }

        offset = end;
        if (type === 'IEND') break;
    }

    return Buffer.concat(output);
}

function readPngPrompt(buffer) {
    return readPngMetadata(buffer)?.prompt || '';
}

function readPngMetadata(buffer) {
    if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return '';

    let fallback = null;
    let offset = PNG_SIGNATURE.length;
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const end = dataStart + length + 4;
        if (end > buffer.length) break;

        const parsed = parsePngTextChunk(type, buffer.slice(dataStart, dataStart + length));
        if (parsed?.keyword === 'prompt') {
            const prompt = promptFromMetadataValue(parsed.value);
            if (prompt) fallback = { prompt };
        }
        if (parsed?.keyword === 'XML:com.adobe.xmp') {
            const metadata = extractMetadataFromXmp(parsed.value);
            if (metadata?.prompt) return metadata;
        }
        offset = end;
        if (type === 'IEND') break;
    }

    return fallback;
}

function createJpegXmpSegment(metadata) {
    const payload = Buffer.concat([
        Buffer.from(XMP_HEADER, 'utf8'),
        Buffer.from(createPromptXmpPacket(metadata), 'utf8')
    ]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(payload.length + 2, 0);
    return Buffer.concat([Buffer.from([0xff, 0xe1]), length, payload]);
}

function isJpegNoLengthMarker(marker) {
    return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

function embedJpegPromptMetadata(buffer, metadata) {
    if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== JPEG_SOI) return buffer;

    const output = [buffer.subarray(0, 2), createJpegXmpSegment(metadata)];
    let offset = 2;

    while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) {
            output.push(buffer.slice(offset));
            break;
        }

        let markerOffset = offset;
        while (markerOffset < buffer.length && buffer[markerOffset] === 0xff) markerOffset += 1;
        if (markerOffset >= buffer.length) break;

        const marker = buffer[markerOffset];
        if (marker === 0xda) {
            output.push(buffer.slice(offset));
            break;
        }

        if (isJpegNoLengthMarker(marker)) {
            output.push(buffer.slice(offset, markerOffset + 1));
            offset = markerOffset + 1;
            continue;
        }

        if (markerOffset + 2 > buffer.length) break;
        const segmentLength = buffer.readUInt16BE(markerOffset + 1);
        const segmentEnd = markerOffset + 1 + segmentLength;
        if (segmentEnd > buffer.length) break;

        const segment = buffer.slice(offset, segmentEnd);
        const payload = buffer.slice(markerOffset + 3, segmentEnd);
        const isPicGenXmp = marker === 0xe1 && payload.subarray(0, Buffer.byteLength(XMP_HEADER)).toString('utf8') === XMP_HEADER;
        if (!isPicGenXmp) {
            output.push(segment);
        }

        offset = segmentEnd;
    }

    return Buffer.concat(output);
}

function readJpegPrompt(buffer) {
    return readJpegMetadata(buffer)?.prompt || '';
}

function readJpegMetadata(buffer) {
    if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== JPEG_SOI) return '';

    let offset = 2;
    while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) break;

        let markerOffset = offset;
        while (markerOffset < buffer.length && buffer[markerOffset] === 0xff) markerOffset += 1;
        if (markerOffset >= buffer.length) break;

        const marker = buffer[markerOffset];
        if (marker === 0xda) break;

        if (isJpegNoLengthMarker(marker)) {
            offset = markerOffset + 1;
            continue;
        }

        if (markerOffset + 2 > buffer.length) break;
        const segmentLength = buffer.readUInt16BE(markerOffset + 1);
        const segmentEnd = markerOffset + 1 + segmentLength;
        if (segmentEnd > buffer.length) break;

        const payload = buffer.slice(markerOffset + 3, segmentEnd);
        if (marker === 0xe1) {
            const header = Buffer.from(XMP_HEADER, 'utf8');
            if (payload.subarray(0, header.length).equals(header)) {
                const metadata = extractMetadataFromXmp(payload.slice(header.length).toString('utf8'));
                if (metadata?.prompt) return metadata;
            }
        }
        offset = segmentEnd;
    }

    return '';
}

function createWebpChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(data.length, 0);
    const padding = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
    return Buffer.concat([Buffer.from(type, 'ascii'), length, data, padding]);
}

function embedWebpPromptMetadata(buffer, metadata) {
    if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
        return buffer;
    }

    const output = [buffer.subarray(0, 12)];
    let offset = 12;
    while (offset + 8 <= buffer.length) {
        const type = buffer.toString('ascii', offset, offset + 4);
        const length = buffer.readUInt32LE(offset + 4);
        const end = offset + 8 + length + (length % 2);
        if (end > buffer.length) throw new Error('Invalid WebP image');
        if (type !== 'XMP ') {
            output.push(buffer.slice(offset, end));
        }
        offset = end;
    }

    output.push(createWebpChunk('XMP ', Buffer.from(createPromptXmpPacket(metadata), 'utf8')));
    const merged = Buffer.concat(output);
    merged.writeUInt32LE(merged.length - 8, 4);
    return merged;
}

function readWebpPrompt(buffer) {
    return readWebpMetadata(buffer)?.prompt || '';
}

function readWebpMetadata(buffer) {
    if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
        return null;
    }

    let offset = 12;
    while (offset + 8 <= buffer.length) {
        const type = buffer.toString('ascii', offset, offset + 4);
        const length = buffer.readUInt32LE(offset + 4);
        const end = offset + 8 + length + (length % 2);
        if (end > buffer.length) break;

        const payload = buffer.slice(offset + 8, offset + 8 + length);
        if (type === 'XMP ') {
            const metadata = extractMetadataFromXmp(payload.toString('utf8'));
            if (metadata?.prompt) return metadata;
        }
        offset = end;
    }

    return null;
}

function embedPromptMetadata(buffer, mimeType, payload) {
    const metadata = buildPromptMetadata(payload);
    if (!metadata) return buffer;

    const cleanMime = String(mimeType || '').split(';')[0].toLowerCase();
    if (cleanMime === 'image/png') return embedPngPromptMetadata(buffer, metadata);
    if (cleanMime === 'image/jpeg' || cleanMime === 'image/jpg') return embedJpegPromptMetadata(buffer, metadata);
    if (cleanMime === 'image/webp') return embedWebpPromptMetadata(buffer, metadata);
    return buffer;
}

function readPromptMetadataFromImage(buffer) {
    return readImageMetadataFromImage(buffer)?.prompt || '';
}

function readImageMetadataFromImage(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return readPngMetadata(buffer);
    if (buffer[0] === 0xff && buffer[1] === JPEG_SOI) return readJpegMetadata(buffer);
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return readWebpMetadata(buffer);
    return null;
}

async function backfillGeneratedImagePromptMetadata(record) {
    if (!record?.filePath || !String(record.prompt || '').trim()) return;

    try {
        const buffer = await fs.readFile(record.filePath);
        if (readPromptMetadataFromImage(buffer)) return;

        const fileBuffer = embedPromptMetadata(
            buffer,
            record.mimeType || fileNameToMimeType(record.fileName || record.filePath),
            record
        );
        if (fileBuffer !== buffer) {
            await fs.writeFile(record.filePath, fileBuffer);
        }
    } catch {
        // Metadata repair is best effort; missing or invalid images are handled by readRecentImages.
    }
}

// While an image is being saved the similarity host pauses its decode lanes (§2.10 scheduler).
async function saveGeneratedImage(payload) {
    adjustSimilaritySaving(1);
    try {
        return await writeGeneratedImage(payload);
    } finally {
        adjustSimilaritySaving(-1);
    }
}

async function writeGeneratedImage(payload) {
    const store = await ensureStore();
    const mimeType = payload.mimeType || 'image/png';
    const ext = mimeToExtension(mimeType);
    const id = payload.id || `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const requestedFileName = buildGeneratedImageFileName({
        id,
        prompt: payload.prompt,
        extension: ext,
        safeName
    });

    const sourceBuffer = Buffer.from(payload.base64, 'base64');
    // Most providers never report the size of what they returned, and the Image2
    // normalizer only fills it in when it had to resize. Read it off the container
    // header instead, so the embedded XMP and the history record both carry real
    // dimensions; otherwise normalizeHistoryRecord has to decode the whole file
    // again (~120 ms) to recover a number sitting in the first 24 bytes.
    const headerSize = readImageSizeFromBuffer(sourceBuffer) || {};
    const width = Number(payload.width || 0) || headerSize.width || 0;
    const height = Number(payload.height || 0) || headerSize.height || 0;
    const fileBuffer = embedPromptMetadata(sourceBuffer, mimeType, { ...payload, id, width, height });
    return enqueueHistoryMutation(async () => {
        const current = await loadHistoryIndex();
        const existing = current.find(item => item.id === id);
        if (existing) return { ...existing };

        const output = await getOutputDirectoryState();
        let filePath;
        try {
            filePath = await writeFileExclusive(output.effectiveDirectory, requestedFileName, fileBuffer);
        } catch (error) {
            if (output.isDefault) throw error;
            filePath = await writeFileExclusive(store.images, requestedFileName, fileBuffer);
            await errorLogStore?.record({
                source: 'storage',
                title: '自定义保存目录不可用',
                message: `${error.message}；图片已改存到应用默认目录`,
                error,
                operation: 'save-generated-image',
                details: {
                    configuredDirectory: output.effectiveDirectory,
                    fallbackDirectory: store.images,
                    savedFilePath: filePath
                }
            }).catch(() => {});
        }
        const record = {
            id,
            filePath,
            fileName: path.basename(filePath),
            mimeType,
            prompt: payload.prompt || '',
            ratio: payload.ratio || '1:1',
            model: payload.model || '',
            providerName: payload.providerName || '',
            createdAt: payload.createdAt || Date.now(),
            width,
            height,
            sourceWidth: Number(payload.sourceWidth || 0) || 0,
            sourceHeight: Number(payload.sourceHeight || 0) || 0,
            requestedWidth: Number(payload.requestedWidth || 0) || 0,
            requestedHeight: Number(payload.requestedHeight || 0) || 0,
            dimensionAdjusted: !!payload.dimensionAdjusted,
            fileSize: fileBuffer.length
        };
        const normalized = await normalizeHistoryRecord(record);
        const normalizedPath = path.resolve(normalized.filePath).toLowerCase();
        const next = [
            normalized,
            ...current.filter(item => item.id !== id
                && path.resolve(item.filePath).toLowerCase() !== normalizedPath)
        ];
        await commitHistoryImages(next);
        return { ...historyIndexCache[0] };
    });
}

async function saveReferenceImage(payload) {
    const source = payload || {};
    if (!source.base64) throw new Error('Missing reference image data');

    const store = await ensureStore();
    const mimeType = source.mimeType || 'image/png';
    const ext = mimeToExtension(mimeType);
    const id = source.id || `ref_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const fileName = `${safeName(id)}.${ext}`;
    const filePath = path.join(store.references, fileName);

    await fs.writeFile(filePath, Buffer.from(source.base64, 'base64'));

    return {
        id,
        name: source.name || fileName,
        mimeType,
        filePath
    };
}

async function resolveReferenceImagePath(filePath) {
    const sourcePath = String(filePath || '');
    if (!sourcePath) throw new Error('Missing reference image path');

    const store = await ensureStore();
    const resolvedSource = path.resolve(sourcePath);
    const referenceRoot = path.resolve(store.references);
    const referenceRootPrefix = `${referenceRoot}${path.sep}`.toLowerCase();
    const lowerSource = resolvedSource.toLowerCase();
    if (lowerSource !== referenceRoot.toLowerCase() && !lowerSource.startsWith(referenceRootPrefix)) {
        throw new Error('Reference image path is outside PicGen cache');
    }
    await fs.access(resolvedSource);
    return resolvedSource;
}

async function loadReferenceImage(payload) {
    const filePath = await resolveReferenceImagePath(payload?.filePath);
    const buffer = await fs.readFile(filePath);
    return {
        base64: buffer.toString('base64'),
        mimeType: payload?.mimeType || 'image/png'
    };
}

// 渲染层给的图片路径能不能读：参考图缓存和悬停预览缓存直接放行，其余必须是生成图目录、历史记录或回收站里的图。
// 读图（发送到参考图 / 图片工作台）、复制图片、另存为共用这一条规则。
async function resolveReadableImagePath(filePath) {
    const sourcePath = String(filePath || '').trim();
    if (!sourcePath) throw new Error('Missing cached image path');
    const store = await ensureStore();
    const resolved = path.resolve(sourcePath);
    if ([store.references, store.previews].some(root => pathIsWithin(root, resolved))) return resolved;
    return resolveGeneratedImagePath(resolved);
}

async function loadCachedImage(payload) {
    const resolved = await resolveReadableImagePath(payload?.filePath);
    const buffer = await fs.readFile(resolved);
    return {
        base64: buffer.toString('base64'),
        mimeType: payload?.mimeType || fileNameToMimeType(resolved)
    };
}

async function deleteReferenceImage(payload) {
    const filePath = await resolveReferenceImagePath(payload?.filePath);
    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return { success: true };
}

function createSecretCodec() {
    if (!safeStorage?.isEncryptionAvailable?.()) return null;
    return {
        encrypt(value) {
            const encrypted = safeStorage.encryptString(String(value || ''));
            return `enc:v1:${encrypted.toString('base64')}`;
        },
        decrypt(value) {
            const encoded = String(value || '').replace(/^enc:v1:/, '');
            return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
        }
    };
}

async function storeTaskResult(task, result) {
    const normalizedResult = await normalizeImage2ResultDimensions(task, result, createImageResultCodec());
    if (normalizedResult.dimensionAdjusted) {
        console.warn(
            `[ImageSize] ${task.model} 供应商返回 ${normalizedResult.sourceWidth}x${normalizedResult.sourceHeight}，`
            + `已校正为 ${normalizedResult.width}x${normalizedResult.height}`
        );
    } else if (normalizedResult.dimensionAdjustmentError) {
        console.warn(`[ImageSize] 输出尺寸校正失败: ${normalizedResult.dimensionAdjustmentError}`);
    }

    const saved = await saveGeneratedImage({
        id: task.id,
        base64: normalizedResult.base64,
        mimeType: normalizedResult.mimeType || 'image/png',
        prompt: task.prompt || '',
        ratio: task.ratio || '1:1',
        model: task.model || '',
        providerName: task.providerName || '',
        createdAt: task.completedAt || Date.now(),
        width: normalizedResult.width,
        height: normalizedResult.height,
        sourceWidth: normalizedResult.sourceWidth,
        sourceHeight: normalizedResult.sourceHeight,
        requestedWidth: normalizedResult.requestedWidth,
        requestedHeight: normalizedResult.requestedHeight,
        dimensionAdjusted: normalizedResult.dimensionAdjusted
    });
    return {
        ...saved,
        sourceWidth: normalizedResult.sourceWidth || saved.width,
        sourceHeight: normalizedResult.sourceHeight || saved.height,
        requestedWidth: normalizedResult.requestedWidth || saved.width,
        requestedHeight: normalizedResult.requestedHeight || saved.height,
        dimensionAdjusted: !!normalizedResult.dimensionAdjusted,
        thoughtText: normalizedResult.thoughtText || ''
    };
}

async function uniqueDestinationPath(directory, fileName) {
    const parsed = path.parse(fileName || `picgen-${Date.now()}.png`);
    const safeBase = safeName(parsed.name || 'picgen-image');
    const ext = parsed.ext || '.png';
    let candidate = path.join(directory, `${safeBase}${ext}`);
    let index = 1;

    while (true) {
        try {
            await fs.access(candidate);
            candidate = path.join(directory, `${safeBase}-${index}${ext}`);
            index += 1;
        } catch {
            return candidate;
        }
    }
}

async function openOutputFolder() {
    const output = await getOutputDirectoryState({ ensureExists: true });
    const errorMessage = await shell.openPath(output.effectiveDirectory);
    if (errorMessage) throw new Error(errorMessage);
    return { filePath: output.effectiveDirectory };
}

async function readOutputDirectoryConfig() {
    return getOutputDirectoryState();
}

async function chooseOutputDirectory() {
    const current = await getOutputDirectoryState({ ensureExists: true });
    const result = await showDockSafeOpenDialog({
        title: '选择默认保存目录',
        defaultPath: current.effectiveDirectory,
        properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths?.[0]) {
        return { cancelled: true, ...current };
    }

    const directory = path.resolve(result.filePaths[0]);
    await fs.mkdir(directory, { recursive: true });
    await fs.access(directory, fsConstants.W_OK);
    await outputConfigStore.update({ directory });
    return { cancelled: false, ...(await getOutputDirectoryState()) };
}

async function resetOutputDirectory() {
    await outputConfigStore.update({ directory: '' });
    return getOutputDirectoryState({ ensureExists: true });
}

// 图片的提示词：先读文件内嵌的 iTXt/XMP，读不到再按完整历史索引匹配路径或文件名（不只最新 10 条）。
// 任意路径都读：提示词输入框的拖入分屏会传 Explorer 里的外部文件。{base64}：只有像素的图，只读内嵌元数据。
async function getGeneratedImagePrompt(payload) {
    const filePath = String(payload?.filePath || '').trim();
    const fileName = String(payload?.fileName || '').trim();

    if (!filePath && payload?.base64) {
        const prompt = readPromptMetadataFromImage(Buffer.from(String(payload.base64), 'base64'));
        return { found: !!prompt, prompt, fileName };
    }

    if (filePath) {
        try {
            const prompt = readPromptMetadataFromImage(await fs.readFile(filePath));
            if (prompt) {
                return {
                    found: true,
                    prompt,
                    fileName: fileName || path.basename(filePath)
                };
            }
        } catch {
            // Fall back to the history index below.
        }
    }

    const normalizedName = fileName.toLowerCase();
    const record = await findHistoryRecordByPath(filePath)
        || (normalizedName ? (await loadHistoryIndex()).find(image =>
            String(image.fileName || path.basename(image.filePath)).toLowerCase() === normalizedName) : null);

    return {
        found: !!record,
        prompt: record?.prompt || '',
        fileName: record?.fileName || fileName
    };
}

function getInitialBounds() {
    const display = screen.getPrimaryDisplay();
    const workArea = display.workArea;
    return {
        x: workArea.x + workArea.width - COLLAPSED_BOUNDS.width - 24,
        y: workArea.y + Math.round(workArea.height * 0.3),
        width: COLLAPSED_BOUNDS.width,
        height: COLLAPSED_BOUNDS.height
    };
}

// 应用置顶状态到主窗口本身。置顶时用 'screen-saver' 级别（本应用悬浮预览用的同级），
// 比原来的 'floating' 更稳地压在其它应用之上；取消置顶则彻底解除 always-on-top，让位给其它窗口。
function applyMainWindowAlwaysOnTop() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindowPinned) mainWindow.setAlwaysOnTop(true, 'screen-saver');
    else mainWindow.setAlwaysOnTop(false);
}

// 置顶按钮的真正落点：切换 always-on-top，并把贴边自动收起的暂停与之联动。
// edgeDock.pin() 会广播窗口状态，渲染层据此刷新按钮的 aria-pressed 与图标。
function setMainWindowPinned(pinned) {
    mainWindowPinned = !!pinned;
    applyMainWindowAlwaysOnTop();
    if (edgeDock) edgeDock.pin(mainWindowPinned);
    else sendWindowState();
    if (mainWindowPinned) bringMainWindowToFront({ focus: false });
}

function bringMainWindowToFront(options = {}) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (isBringingMainWindowToFront) return;

    isBringingMainWindowToFront = true;
    try {
        const shouldFocus = options.focus !== false;
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.setSkipTaskbar(false);

        // Windows can occasionally leave frameless always-on-top windows visible
        // but behind the Alt+Tab target. Toggling the level refreshes the z-order.
        // Re-assert the current pin state rather than hard-coding always-on-top, so
        // an unpinned window is brought forward once without becoming topmost again.
        mainWindow.setAlwaysOnTop(false);
        applyMainWindowAlwaysOnTop();
        if (typeof mainWindow.moveTop === 'function') {
            mainWindow.moveTop();
        }
        if (shouldFocus) {
            mainWindow.focus();
        }
    } finally {
        isBringingMainWindowToFront = false;
    }
}

function setExpanded(expanded, options = {}) {
    if (!mainWindow) return;

    if (edgeDock?.hidden && expanded) {
        edgeDock.reveal();
        bringMainWindowToFront({ focus: options.focus ?? true });
        return;
    }
    if (edgeDock?.edge && !expanded) { edgeDock.hide(); return; }
    edgeDock?.resetTimer();
    const current = mainWindow.getBounds();
    if (isExpanded && !expanded) {
        lastExpandedSize = { width: current.width, height: current.height };
    }
    isExpanded = expanded;
    if (!expanded) { hideImagePreview(); hidePrefsWindow(true); }
    const display = screen.getDisplayMatching(current);
    const workArea = display.workArea;
    const size = expanded
        ? {
            width: Math.min(workArea.width, Math.max(MIN_EXPANDED_BOUNDS.width, lastExpandedSize.width)),
            height: Math.min(workArea.height, Math.max(MIN_EXPANDED_BOUNDS.height, lastExpandedSize.height))
        }
        : COLLAPSED_BOUNDS;
    const rightEdge = current.x + current.width;
    const nextX = Math.min(
        Math.max(workArea.x, rightEdge - size.width),
        workArea.x + workArea.width - size.width
    );
    const nextY = Math.min(
        Math.max(workArea.y, current.y),
        workArea.y + workArea.height - size.height
    );

    // Keep the frameless transparent window resizable for its entire lifetime.
    // Toggling resizability on Windows can drop Chromium's edge hit-test region.
    // Relax the constraints for the whole animation so intermediate frames fit.
    mainWindow.setMinimumSize(1, 1);
    mainWindow.setMaximumSize(workArea.width, workArea.height);

    const applyFinalConstraints = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (isExpanded) {
            mainWindow.setMinimumSize(
                Math.min(MIN_EXPANDED_BOUNDS.width, workArea.width),
                Math.min(MIN_EXPANDED_BOUNDS.height, workArea.height)
            );
        } else {
            mainWindow.setMinimumSize(COLLAPSED_BOUNDS.width, COLLAPSED_BOUNDS.height);
            mainWindow.setMaximumSize(COLLAPSED_BOUNDS.width, COLLAPSED_BOUNDS.height);
        }
    };

    // Swap the renderer content to the target state up front so the panel is
    // revealed (expand) / hidden (collapse) as the native window tweens.
    bringMainWindowToFront({ focus: options.focus ?? expanded });
    sendWindowState();
    animateBounds(mainWindow, { x: nextX, y: nextY, width: size.width, height: size.height }, applyFinalConstraints);
    if (expanded && !imagePreviewWindow) ensureImagePreviewLoaded(createImagePreviewWindow()).catch(() => {});
}

// Collapse/expand no longer tweens native bounds. Tweening meant ~15 setBounds
// per transition on a transparent frameless window, and because the renderer
// content is width:100% the whole React page reflowed at every intermediate
// size — that per-frame reflow was the stutter. We now snap the native size in
// a single setBounds and let the renderer play a GPU-composited CSS transform
// (see `desktopPanelIn` in refinements.css) for a smooth grow/fade instead.
function animateBounds(win, to, onDone) {
    if (boundsAnimTimer) { clearInterval(boundsAnimTimer); boundsAnimTimer = null; }
    if (!win || win.isDestroyed()) { onDone && onDone(); return; }
    win.setBounds(to);
    onDone && onDone();
}

function windowState() {
    return { expanded: isExpanded, resizable: !!mainWindow?.isResizable(),
        bounds: (edgeDock?.hidden && edgeTabWindow ? edgeTabBounds() : mainWindow?.getBounds()) || null, dock: edgeDock?.state() || { edge: null, hidden: false, pinned: false } };
}

function sendWindowState() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:window-state', windowState());
}

function edgeTabBounds() {
    const bounds = edgeTabWindow.getBounds();
    return { ...bounds, x: edgeDock?.edge === 'right' ? bounds.x + bounds.width - 12 : bounds.x, width: 12 };
}

function createEdgeTabWindow() {
    if (edgeTabWindow && !edgeTabWindow.isDestroyed()) return edgeTabWindow;
    edgeTabWindow = new BrowserWindow({ width: 12, height: 72, frame: false, transparent: true, thickFrame: false,
        resizable: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, show: false,
        webPreferences: { preload: path.join(__dirname, 'desktop-preload.js'), contextIsolation: true, nodeIntegration: false } });
    edgeTabWindow.setAlwaysOnTop(true, 'floating');
    edgeTabWindow.loadFile(path.join(__dirname, 'edge-tab.html')).then(() => {
        if (edgeTabWindow && !edgeTabWindow.isDestroyed()) return edgeTabWindow.webContents.executeJavaScript(`document.body.dataset.edge = ${JSON.stringify(edgeDock?.edge || 'left')}`);
    }).catch(error => console.error('[EdgeDock]', error.message));
    edgeTabWindow.on('closed', () => { edgeTabWindow = null; });
    return edgeTabWindow;
}

function setupEdgeDock() {
    edgeDock = new EdgeDock({
        bounds: () => edgeDock?.hidden && edgeTabWindow ? edgeTabBounds() : mainWindow.getBounds(),
        expanded: () => isExpanded,
        area: bounds => screen.getDisplayMatching(bounds).workArea,
        pointer: () => screen.getCursorScreenPoint(),
        // 置顶设置窗开着时不自动收起：面板可能伸出主窗之外，指针停在上面不算"离开"
        busy: () => dockInteractionBusy || dockNativeHolds > 0 || mainWindow.isMinimized() || !mainWindow.isVisible()
            || !!(prefsWindow && !prefsWindow.isDestroyed() && prefsWindow.isVisible()),
        expandedBounds: bounds => ({ ...bounds, ...(isExpanded ? {} : lastExpandedSize) }),
        changed: () => {
            sendWindowState();
            clearInterval(edgeDockTimer);
            edgeDockTimer = edgeDock.edge ? setInterval(() => {
                if (mainWindow && !mainWindow.isDestroyed()) edgeDock.tick(Date.now());
            }, 100) : null;
        },
        place: (bounds, state) => {
            applyingDockBounds = true;
            try {
                if (isExpanded && !state.expanded) {
                    const current = mainWindow.getBounds();
                    lastExpandedSize = { width: current.width, height: current.height };
                    hideImagePreview();
                }
                isExpanded = state.expanded;
                if (state.hidden) {
                    const tab = createEdgeTabWindow();
                    // Windows enforces a 32px HWND minimum. Shape the independent
                    // tab to 12px so both its visible and clickable region stay narrow.
                    const width = 32;
                    tab.setBounds({ ...bounds, width, x: bounds.x - (edgeDock.edge === 'right' ? width - 12 : 0) }, false);
                    const actual = tab.getBounds();
                    const offset = edgeDock.edge === 'right' ? actual.width - 12 : 0;
                    if (typeof tab.setShape === 'function') tab.setShape([{ x: offset, y: 0, width: 12, height: bounds.height }]);
                    tab.webContents.executeJavaScript(`document.body.dataset.edge = ${JSON.stringify(edgeDock.edge)}`).catch(() => {});
                    // Keep a taskbar entry so restore also opens the docked workspace.
                    mainWindow.minimize();
                    tab.showInactive();
                    return;
                }
                if (edgeTabWindow && !edgeTabWindow.isDestroyed()) edgeTabWindow.hide();
                if (mainWindow.isMinimized()) mainWindow.restore();
                const area = screen.getDisplayMatching(bounds).workArea;
                mainWindow.setMinimumSize(1, 1);
                mainWindow.setMaximumSize(area.width, area.height);
                mainWindow.setBounds(bounds, false);
                if (state.expanded) {
                    mainWindow.setMinimumSize(Math.min(MIN_EXPANDED_BOUNDS.width, area.width), Math.min(MIN_EXPANDED_BOUNDS.height, area.height));
                    lastExpandedSize = { width: bounds.width, height: bounds.height };
                    if (!imagePreviewWindow) ensureImagePreviewLoaded(createImagePreviewWindow()).catch(() => {});
                } else {
                    mainWindow.setMinimumSize(bounds.width, bounds.height);
                    mainWindow.setMaximumSize(bounds.width, bounds.height);
                }
                // Hover reveal never steals keyboard focus from another application.
                mainWindow.showInactive();
            } finally { applyingDockBounds = false; }
        }
    });
    mainWindow.on('will-move', () => {
        if (applyingDockBounds || windowMoveState) return;
        if (!nativeWindowMoving) { nativeWindowMoving = true; edgeDock.beginMove(); }
    });
    mainWindow.on('moved', () => {
        if (!nativeWindowMoving || applyingDockBounds) return;
        nativeWindowMoving = false;
        edgeDock.settle();
    });
    screen.on('display-metrics-changed', () => edgeDock.reflow());
    screen.on('display-removed', () => edgeDock.reflow());
}

async function showDockSafeSaveDialog(options) {
    dockNativeHolds++;
    try { return await dialog.showSaveDialog(mainWindow, options); }
    finally { dockNativeHolds--; edgeDock?.resetTimer(); }
}

// Smoke-only (PICGEN_SMOKE=1)：PICGEN_SMOKE_CLIPBOARD=dry 时不碰系统剪贴板（冒烟跑在用户自己的机器上，
// 写进去会覆盖用户的剪贴板和 Win+V 历史），只记下写了什么，由 desktop:smoke-clipboard-log 读出。每次调用时读取。
const smokeClipboardLog = [];
function writeClipboard(kind, value) {
    if (process.env.PICGEN_SMOKE === '1' && process.env.PICGEN_SMOKE_CLIPBOARD === 'dry') {
        smokeClipboardLog.push(kind === 'image' ? { kind, ...value.getSize() } : { kind, text: value });
        smokeClipboardLog.splice(0, Math.max(0, smokeClipboardLog.length - 20));
        return;
    }
    if (kind === 'image') clipboard.writeImage(value); else clipboard.writeText(value);
}

// 复制图片到系统剪贴板（右键「复制图片」）。解码在 sharp worker（任何格式、按 EXIF 转正），主线程只包成 nativeImage。
// nativeImage 解不了 WebP；writeImage 遇到空图会静默保留旧剪贴板内容 —— 所以写之前必须查 isEmpty。
const COPY_IMAGE_TIMEOUT_MS = 10000;
async function decodeClipboardImage(source) {
    let timer;
    try {
        const bitmap = await Promise.race([
            previewDecoder.bitmap(source),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('decode timed out')), COPY_IMAGE_TIMEOUT_MS); })
        ]).finally(() => clearTimeout(timer));
        return nativeImage.createFromBitmap(bitmap.buffer, { width: bitmap.width, height: bitmap.height });
    } catch (error) {
        console.warn('[Clipboard] worker decode failed:', error.message);
        // 超时说明图太大或 worker 正忙：别在主线程再同步解一遍（会把整个主进程冻住）
        if (error.message === 'decode timed out') throw new Error('图片太大，复制超时');
        // 兜底只认 PNG/JPEG；WebP/GIF 会得到空图，由调用方报错
        return typeof source === 'string' ? nativeImage.createFromPath(source) : nativeImage.createFromBuffer(source);
    }
}

// {filePath}（校验同读图）或 {base64, mimeType}。写入成功之后才计数：只有历史图计一次带出（'copy'）。
async function copyImageToClipboard(payload) {
    const filePath = payload?.filePath ? await resolveReadableImagePath(payload.filePath) : '';
    const source = filePath || Buffer.from(String(payload?.base64 || ''), 'base64');
    if (!filePath && !source.length) throw new Error('没有可复制的图片');
    const image = await decodeClipboardImage(source);
    if (image.isEmpty()) throw new Error('无法读取这张图片');
    writeClipboard('image', image);
    const { width, height } = image.getSize();
    return { copied: true, width, height, ...(filePath ? await countExternalUse(filePath, 'copy') : { counted: false }) };
}

// 另存为（右键「另存为…」、详情抽屉、图片工作台「另存为」共用）：系统另存为对话框，位置和文件名都由用户选；
// 默认打开上次选择的目录（见 saveAsStartDirectory），文件名用原名，重名时提议 名字-1（见 freeSaveAsPath），默认动作不覆盖。
// 用户仍可能自己选中原图（选中原图 = 什么都没存，按 sameFile 处理）；存进输出目录的副本会在下次重建索引时被当成一条同 id 的历史记录。
// - {filePath, fileName}：原样复制（格式、EXIF、内嵌提示词都保留），参考图缓存也能存；成功后历史图计一次带出（'save-as'）。
// - {base64, mimeType, fileName}：工作台合成图、只有像素的图。不计数（工作台打开时已经计过 'workspace'）。
// 扩展名按文件头定：用户在对话框里改了扩展名会补回真实扩展名，PNG 字节不会落进 .jpg。
// Smoke-only (PICGEN_SMOKE=1): PICGEN_SMOKE_SAVE_AS_DIR 跳过对话框，直接存进该目录
const SAVE_AS_FORMATS = {
    png: { name: 'PNG 图片', extensions: ['png'] },
    jpg: { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
    webp: { name: 'WebP 图片', extensions: ['webp'] },
    gif: { name: 'GIF 图片', extensions: ['gif'] },
    bmp: { name: 'BMP 图片', extensions: ['bmp'] },
    avif: { name: 'AVIF 图片', extensions: ['avif'] }
};
let lastSaveAsDirectory = '';

// 对话框从哪儿开始 = 上次选择的目录：先用 PicGen 自己记下的（output-config.json，重启后也记得）；
// 没记过或那个文件夹不在了（U 盘拔了、被删）返回 ''——只给文件名，由 Windows 打开本程序上次在打开/保存
// 对话框里选过的文件夹（旧版「保存到自选目录」选过的也算；Windows 不记 %TEMP% 下的文件夹）。
// 不能兜底成固定文件夹，那会盖掉 Windows 的这份记忆。
// 断开的网络共享上 fs.stat 要卡 ~47s：限时 1.5s，本次运行内不再试它（下次另存到别处就换掉了）。
const SAVE_AS_FOLDER_CHECK_MS = 1500;
let unreachableSaveAsDirectory = '';
async function saveAsStartDirectory() {
    const remembered = lastSaveAsDirectory || (outputConfigStore ? (await outputConfigStore.get()).saveAsDirectory : '');
    if (!remembered || remembered === unreachableSaveAsDirectory) return '';
    let timer;
    const reachable = await Promise.race([
        fs.stat(remembered).then(stat => stat.isDirectory(), () => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), SAVE_AS_FOLDER_CHECK_MS); })
    ]).finally(() => clearTimeout(timer));
    if (!reachable) unreachableSaveAsDirectory = remembered;
    return reachable ? remembered : '';
}

// 默认文件名在该文件夹里已存在（原图自己、上次存过的同名副本）：提议 名字-1.ext、名字-2.ext…，
// 默认动作永远不是覆盖。不用 uniqueDestinationPath：它的 safeName 会改名、截断，这里要保持原名。
async function freeSaveAsPath(directory, fileName) {
    const { name, ext } = path.parse(fileName);
    for (let index = 0; index < 1000; index += 1) {
        const candidate = path.join(directory, index ? `${name}-${index}${ext}` : fileName);
        try { await fs.access(candidate); } catch { return candidate; }
    }
    return path.join(directory, fileName);
}

function rememberSaveAsDirectory(directory) {
    unreachableSaveAsDirectory = '';
    // 同一个文件夹不重复写配置文件（写得越少，写坏整份配置的机会越小）
    if (directory === lastSaveAsDirectory) return;
    lastSaveAsDirectory = directory;
    // 记不住只影响下次对话框从哪儿开始，不算另存失败
    outputConfigStore?.update({ saveAsDirectory: directory })
        .catch(error => console.warn('[SaveAs] remember folder failed:', error.message));
}

// 按文件头认格式（扩展名可能和内容对不上）→ 'png' | 'jpg' | 'webp' | 'gif' | 'bmp' | 'avif'，认不出为 ''
function sniffImageExtension(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
    if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png';
    if (buffer[0] === 0xff && buffer[1] === JPEG_SOI) return 'jpg';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'gif';
    if (buffer.toString('ascii', 0, 2) === 'BM') return 'bmp';
    if (buffer.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(buffer.toString('ascii', 8, 12))) return 'avif';
    return '';
}

// 另存的副本原样复制。只有历史图文件里缺内嵌提示词、而主进程自己的记录里有提示词时才补写（不信渲染层传来的）。
async function writeSavedCopy(source, target) {
    const record = await findHistoryRecordByPath(source);
    if (String(record?.prompt || '').trim()) {
        const buffer = await fs.readFile(source);
        if (!readPromptMetadataFromImage(buffer)) {
            const embedded = embedPromptMetadata(buffer, record.mimeType || fileNameToMimeType(source), record);
            if (embedded !== buffer) return fs.writeFile(target, embedded);
        }
    }
    return fs.copyFile(source, target);
}

async function saveImageAs(payload) {
    const source = payload?.filePath ? await resolveReadableImagePath(payload.filePath) : '';
    const buffer = source ? null : Buffer.from(String(payload?.base64 || ''), 'base64');
    if (!source && !buffer.length) throw new Error('没有可保存的图片');
    // 文件头认不出（TIFF、HEIC 等参考图上传）：沿用源文件自己的扩展名，别把原字节存成 .png
    const sourceExt = source ? path.extname(source).slice(1).toLowerCase() : '';
    const ext = source
        ? sniffImageExtension(await readImagePrefix(source, 12)) || sourceExt || mimeToExtension(fileNameToMimeType(source))
        : sniffImageExtension(buffer) || mimeToExtension(String(payload?.mimeType || ''));
    const format = SAVE_AS_FORMATS[ext] || { name: `${ext.toUpperCase()} 图片`, extensions: [ext] };
    const baseName = path.parse(path.basename(String(payload?.fileName || '') || source)).name
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/[. ]+$/, '').trim() || 'picgen-image';
    const fileName = `${baseName}.${ext}`;
    const smokeDir = process.env.PICGEN_SMOKE === '1' ? String(process.env.PICGEN_SMOKE_SAVE_AS_DIR || '') : '';
    let filePath;
    if (smokeDir) {
        filePath = await uniqueDestinationPath(smokeDir, fileName);
    } else {
        const directory = await saveAsStartDirectory();
        const result = await showDockSafeSaveDialog({
            title: '另存为',
            defaultPath: directory ? await freeSaveAsPath(directory, fileName) : fileName,
            filters: [{ name: format.name, extensions: format.extensions }]
        });
        if (result.canceled || !result.filePath) return { cancelled: true };
        const typed = path.extname(result.filePath).slice(1).toLowerCase();
        filePath = format.extensions.includes(typed) ? result.filePath : `${result.filePath}.${ext}`;
    }
    // 选中的就是原图自己：什么都没存（copyFile 同一路径在 Windows 上还会报错），不算另存、不计数
    if (source && path.resolve(filePath).toLowerCase() === source.toLowerCase()) {
        return { cancelled: false, saved: false, sameFile: true, filePath, fileName: path.basename(filePath), counted: false };
    }
    if (source) await writeSavedCopy(source, filePath);
    else await fs.writeFile(filePath, buffer);
    if (!smokeDir) rememberSaveAsDirectory(path.dirname(filePath));
    return {
        cancelled: false,
        saved: true,
        filePath,
        fileName: path.basename(filePath),
        ...(source ? await countExternalUse(source, 'save-as') : { counted: false })
    };
}

async function showDockSafeOpenDialog(options) {
    dockNativeHolds++;
    try { return await dialog.showOpenDialog(mainWindow, options); }
    finally { dockNativeHolds--; edgeDock?.resetTimer(); }
}

function createTray() {
    const icon = createAppIcon();
    tray = new Tray(icon);
    tray.setToolTip('PicGen');
    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: '展开 PicGen',
            click: () => setExpanded(true, { focus: true })
        },
        {
            label: '回到浮窗',
            click: () => setExpanded(false, { focus: false })
        },
        { type: 'separator' },
        {
            label: '退出',
            click: quitApp
        }
    ]));
    tray.on('click', () => setExpanded(true, { focus: true }));
}

function quitApp() {
    isQuitting = true;
    app.quit();
}

function showDesktopContextMenu() {
    if (!mainWindow) return;
    Menu.buildFromTemplate([
        {
            label: '展开 PicGen',
            click: () => setExpanded(true, { focus: true })
        },
        {
            label: '回到浮窗',
            click: () => setExpanded(false, { focus: false })
        },
        { type: 'separator' },
        {
            label: '退出',
            click: quitApp
        }
    ]).popup({ window: mainWindow });
}

// Image right-click menu: a native menu, so it opens at the cursor and may extend past the window.
// The renderer sends the items ({id, label, enabled} | {type:'separator'}) and gets back the chosen id
// (null when dismissed). Under PICGEN_SMOKE nothing pops up: the smoke queues the choice beforehand.
const smokeImageMenu = { enabled: process.env.PICGEN_SMOKE === '1', choices: [], last: null };

function showImageContextMenu(event, items) {
    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const entries = (Array.isArray(items) ? items : []).slice(0, 40).map(item => item?.type === 'separator'
        ? { type: 'separator' }
        : { id: String(item?.id || ''), label: String(item?.label || '').slice(0, 80), enabled: item?.enabled !== false })
        .filter(item => item.type === 'separator' || (item.id && item.label));
    if (smokeImageMenu.enabled) {
        smokeImageMenu.last = entries;
        return Promise.resolve(smokeImageMenu.choices.length ? smokeImageMenu.choices.shift() : null);
    }
    if (!owner || owner.isDestroyed() || !entries.some(item => item.id)) return Promise.resolve(null);
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            dockNativeHolds = Math.max(0, dockNativeHolds - 1);
            edgeDock?.resetTimer();
            resolve(value);
        };
        // Held while the menu is up: the docked window must not slide away under it.
        dockNativeHolds++;
        const menu = Menu.buildFromTemplate(entries.map(item => item.type === 'separator'
            ? { type: 'separator' }
            : { label: item.label, enabled: item.enabled, click: () => finish(item.id) }));
        // `callback` runs when the menu closes, which can be just before the click: give the click a tick.
        menu.popup({ window: owner, callback: () => setTimeout(() => finish(null), 0) });
    });
}

function readMovePoint(point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
}

function clampWindowPosition(x, y, width, height) {
    const display = screen.getDisplayMatching({ x, y, width, height });
    const workArea = display.workArea;
    return {
        x: Math.min(Math.max(Math.round(x), workArea.x), workArea.x + workArea.width - width),
        y: Math.min(Math.max(Math.round(y), workArea.y), workArea.y + workArea.height - height)
    };
}

function startWindowMove(point) {
    if (!mainWindow) return;
    const startPoint = readMovePoint(point);
    if (!startPoint) return;
    const wasHiddenAtEdge = edgeDock?.hidden;
    edgeDock?.beginMove();
    if (wasHiddenAtEdge) {
        applyingDockBounds = true;
        try { edgeTabWindow?.hide(); if (mainWindow.isMinimized()) mainWindow.restore(); }
        finally { applyingDockBounds = false; }
        setExpanded(false, { focus: false });
    }
    windowMoveState = {
        startPoint,
        startBounds: mainWindow.getBounds()
    };
}

function moveWindow(point) {
    if (!mainWindow || !windowMoveState) return;
    const currentPoint = readMovePoint(point);
    if (!currentPoint) return;

    const { startPoint, startBounds } = windowMoveState;
    const next = clampWindowPosition(
        startBounds.x + currentPoint.x - startPoint.x,
        startBounds.y + currentPoint.y - startPoint.y,
        startBounds.width,
        startBounds.height
    );
    mainWindow.setPosition(next.x, next.y, false);
}

function endWindowMove() {
    if (!windowMoveState) return;
    windowMoveState = null;
    edgeDock?.settle();
}

function createImagePreviewWindow() {
    previewDecoder.start();
    if (imagePreviewWindow && !imagePreviewWindow.isDestroyed()) return imagePreviewWindow;

    imagePreviewWindow = new BrowserWindow({
        width: 1,
        height: 1,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    imagePreviewWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    imagePreviewWindow.setIgnoreMouseEvents(true, { forward: true });
    imagePreviewLoadPromise = imagePreviewWindow.loadFile(path.join(__dirname, 'image-preview.html')).catch(error => {
        imagePreviewLoadPromise = null;
        console.error('[ImagePreview] load failed:', error.message);
        throw error;
    });
    imagePreviewWindow.on('closed', () => {
        imagePreviewWindow = null;
        imagePreviewState = null;
        imagePreviewLastBounds = null;
        imagePreviewLoadPromise = null;
    });
    return imagePreviewWindow;
}

function raiseImagePreviewWindow(previewWindow = imagePreviewWindow) {
    if (!previewWindow || previewWindow.isDestroyed()) return;
    try {
        previewWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        previewWindow.moveTop();
    } catch {
        // Some platforms can reject moveTop before a window is visible.
        previewWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    }
}

function ensureImagePreviewLoaded(previewWindow) {
    if (!previewWindow || previewWindow.isDestroyed()) {
        return Promise.reject(new Error('Preview window is unavailable'));
    }
    if (!imagePreviewLoadPromise) {
        imagePreviewLoadPromise = previewWindow.loadFile(path.join(__dirname, 'image-preview.html')).catch(error => {
            imagePreviewLoadPromise = null;
            console.error('[ImagePreview] reload failed:', error.message);
            throw error;
        });
    }
    return imagePreviewLoadPromise;
}

function isCurrentImagePreviewRequest(requestId, previewWindow, sourceId) {
    return requestId === imagePreviewRequestId
        && imagePreviewWindow === previewWindow
        && !previewWindow.isDestroyed()
        && imagePreviewState?.sourceId === sourceId;
}

async function updateImagePreviewContent(previewWindow, preview) {
    const message = {
        type: 'preview:update',
        src: preview.src,
        dimensions: preview.dimensions,
        model: preview.model,
        providerName: preview.providerName
    };
    await previewWindow.webContents.executeJavaScript(
        `window.applyPreview(${JSON.stringify(message)})`,
        true
    );
}

function getFixedPreviewSize(imageSize, point, scale = 1) {
    const display = screen.getDisplayNearestPoint(point);
    const workArea = display.workArea;
    const margin = 12;
    const naturalWidth = Math.max(1, Math.round(imageSize.width || 1));
    const naturalHeight = Math.max(1, Math.round(imageSize.height || 1));
    // scale：入口级缩放（参考图卡的锚定预览用 0.5——悬浮在提示词上方，全尺寸太具压迫感）。
    const cap = Math.round(IMAGE_PREVIEW_SIZE * scale);
    const width = Math.min(cap, Math.max(1, workArea.width - margin * 2));
    const height = Math.min(cap, Math.max(1, workArea.height - margin * 2));

    return {
        width,
        height,
        naturalWidth,
        naturalHeight
    };
}

function imagePreviewBounds(point, previewSize, placement) {
    const display = screen.getDisplayNearestPoint(point);
    const workArea = display.workArea;
    const margin = 12;
    // 锚定上方模式（参考图卡预览）：预览窗底边中点对齐锚点（卡顶部中央），
    // 不做光标偏移、不跟随移动。锚点上方空间不足时按比例缩小预览整体装进去——
    // 绝不向下夹取压到参考图条带上（弹窗尽可能不覆盖参考图）。
    if (placement === 'above') {
        let width = previewSize.width;
        let height = previewSize.height;
        // 无条件装进锚点上方的可用空间：预览必须完全高于参考图容器，任何情况下
        // 都不允许向下压到条带上（此前空间过小时的向下夹取正是遮挡的来源）。
        const availableHeight = Math.max(60, point.y - (workArea.y + margin));
        if (height > availableHeight) {
            const ratio = availableHeight / height;
            width = Math.max(80, Math.round(width * ratio));
            height = Math.round(availableHeight);
        }
        const x = Math.round(point.x - width / 2);
        // 适配后 height ≤ 锚点上方可用空间，y 必然落在工作区内，且底边恒在锚点上方。
        const y = Math.round(point.y - height);
        return {
            x: Math.min(Math.max(x, workArea.x + margin), workArea.x + workArea.width - width - margin),
            y,
            width,
            height
        };
    }
    const offset = 16;
    let x = Math.round(point.x + offset);
    let y = Math.round(point.y - previewSize.height - offset);

    if (x + previewSize.width > workArea.x + workArea.width - margin) {
        x = Math.round(point.x - previewSize.width - offset);
    }
    if (y < workArea.y + margin) {
        y = Math.round(point.y + offset);
    }
    if (y + previewSize.height > workArea.y + workArea.height - margin) {
        y = workArea.y + workArea.height - previewSize.height - margin;
    }

    return {
        x: Math.min(Math.max(x, workArea.x + margin), workArea.x + workArea.width - previewSize.width - margin),
        y: Math.min(Math.max(y, workArea.y + margin), workArea.y + workArea.height - previewSize.height - margin),
        width: previewSize.width,
        height: previewSize.height
    };
}

function readPreviewPoint(payload) {
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
}

async function resolveCachedImagePath(filePath) {
    const sourcePath = String(filePath || '');
    if (!sourcePath) throw new Error('Missing image path');

    const resolvedSource = path.resolve(sourcePath);
    await resolveGeneratedImagePath(resolvedSource);
    await fs.access(resolvedSource);
    return resolvedSource;
}

async function resolveGeneratedImagePath(filePath) {
    const sourcePath = String(filePath || '').trim();
    if (!sourcePath) throw new Error('Missing image path');

    const resolvedSource = path.resolve(sourcePath);
    const store = await ensureStore();
    if (pathIsWithin(store.images, resolvedSource)) {
        await fs.access(resolvedSource);
        return resolvedSource;
    }

    // Binned images are still shown (thumbnails, previews) in the in-app recycle bin.
    if (!await findHistoryRecordByPath(resolvedSource) && !getHistoryBin().has(resolvedSource)) {
        throw new Error('Image path is outside PicGen generated image history');
    }
    await fs.access(resolvedSource);
    return resolvedSource;
}

async function createThumbnailAsync(source, size) {
    try {
        const image = await nativeImage.createThumbnailFromPath(source, size);
        if (!image.isEmpty()) return image;
    } catch { /* Some Windows installations/codecs cannot supply shell thumbnails. */ }
    if (!thumbnailDecoderWindow || thumbnailDecoderWindow.isDestroyed()) {
        thumbnailDecoderWindow = new BrowserWindow({ show: false, width: 32, height: 32, skipTaskbar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
        thumbnailDecoderReady = thumbnailDecoderWindow.loadFile(path.join(__dirname, 'thumbnail-worker.html'));
        thumbnailDecoderWindow.on('closed', () => { thumbnailDecoderWindow = null; thumbnailDecoderReady = null; });
    }
    const decoder = thumbnailDecoderWindow;
    await thumbnailDecoderReady;
    const result = await decoder.webContents.executeJavaScript(`window.createThumbnail(${JSON.stringify({ src: pathToFileURL(source).href, ...size })})`);
    // Only the bounded thumbnail crosses back; never decode the full original here.
    const thumbnail = nativeImage.createFromDataURL(result);
    if (thumbnail.isEmpty()) throw new Error('图片预览无法解码');
    return thumbnail;
}

async function getHistoryThumbnail(payload) {
    const sourcePath = await resolveCachedImagePath(payload?.filePath);
    const store = await ensureStore();
    const stat = await fs.stat(sourcePath);
    // Shared with the similarity host, which reuses opaque thumbnails as a decode source.
    const key = historyThumbnailKey(sourcePath, stat);
    const thumbnailPath = path.join(store.thumbnails, key);

    try {
        await fs.access(thumbnailPath);
        return { filePath: thumbnailPath, url: pathToFileURL(thumbnailPath).href };
    } catch {
        // Generate below.
    }

    if (!thumbnailJobs.has(key)) {
        const job = enqueueThumbnailGeneration(async () => {
            try {
                await fs.access(thumbnailPath);
                return thumbnailPath;
            } catch {
                return writeFileExclusive(store.thumbnails, key, await createHistoryThumbnailJpeg(sourcePath));
            }
        }).finally(() => thumbnailJobs.delete(key));
        thumbnailJobs.set(key, job);
    }

    const filePath = await thumbnailJobs.get(key);
    return { filePath, url: pathToFileURL(filePath).href };
}

// Sharp first, in the preview-decoder worker, so a cold PNG never blocks main (createThumbnailFromPath
// was measured at 0.2–1.7 s on main). Transparency is flattened on white. The shell-thumbnail /
// hidden-window path stays as the fallback for anything sharp cannot decode.
async function createHistoryThumbnailJpeg(sourcePath) {
    try {
        return await previewDecoder.thumbnailJpeg(sourcePath, HISTORY_THUMBNAIL_MAX_SIZE);
    } catch {
        // Fall back below.
    }
    const image = await createThumbnailAsync(sourcePath, { width: HISTORY_THUMBNAIL_MAX_SIZE, height: HISTORY_THUMBNAIL_MAX_SIZE });
    if (image.isEmpty()) throw new Error('历史图片无法读取');
    const natural = image.getSize();
    const scale = Math.min(1, HISTORY_THUMBNAIL_MAX_SIZE / Math.max(natural.width, natural.height));
    const width = Math.max(1, Math.round(natural.width * scale));
    const height = Math.max(1, Math.round(natural.height * scale));
    return image.resize({ width, height, quality: 'best' }).toJPEG(78);
}

async function readPreviewImage(payload) {
    if (payload?.filePath) {
        const store = await ensureStore();
        const source = path.resolve(String(payload.filePath));
        if (pathIsWithin(store.references, source)) return resolveReferenceImagePath(source);
        return resolveCachedImagePath(source);
    }
    if (payload?.base64) return writePreviewImageCache(payload.base64, payload.mimeType);
    const parsed = typeof payload?.dataUrl === 'string' && payload.dataUrl.match(/^data:(image\/[^;]+);base64,(.*)$/);
    if (parsed) return writePreviewImageCache(parsed[2], parsed[1]);
    throw new Error('Missing preview image source');
}

async function writePreviewImageCache(base64, mimeType = 'image/png') {
    const store = await ensureStore();
    const buffer = Buffer.from(base64, 'base64');
    const hash = crypto.createHash('sha1').update(buffer).digest('hex');
    const ext = mimeToExtension(mimeType);
    const filePath = path.join(store.previews, `${hash}.${ext}`);
    try {
        await fs.access(filePath);
    } catch {
        await fs.writeFile(filePath, buffer);
    }
    return filePath;
}

// ===== 置顶设置窗（生成偏好面板的独立 BrowserWindow）=====
// 面板内容由主窗渲染层序列化成快照推入，本窗只做镜像渲染；改动经 prefs:change
// 回流主窗写回隐藏控件，走既有 change 处理链。窗口置顶（screen-saver 级），
// 可超出主窗边界，彻底摆脱主窗高度对面板的裁剪。
const PREFS_WINDOW_WIDTH = 380;

function createPrefsWindow() {
    if (prefsWindow && !prefsWindow.isDestroyed()) return prefsWindow;
    prefsWindowReady = false;
    prefsWindow = new BrowserWindow({
        width: PREFS_WINDOW_WIDTH,
        height: 360,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'prefs-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    prefsWindow.setAlwaysOnTop(true, 'screen-saver', 2);
    prefsWindow.on('blur', () => {
        // 点击窗外（含主窗）即收起；主窗渲染层据 closed 通知维护触发按钮状态，
        // 并用时间戳实现"点触发按钮=关闭而非立刻重开"的手感。
        // 失焦时指针仍在面板上（原生下拉弹出、别的窗口抢了焦点）不收，改为"移出即关"。
        if (prefsPointerInside()) { schedulePrefsClose(); return; }
        hidePrefsWindow(true);
    });
    prefsWindow.on('closed', () => { prefsWindow = null; prefsWindowReady = false; });
    prefsWindow.loadFile(path.join(__dirname, 'prefs-window.html')).catch(error => {
        console.error('[PrefsWindow] load failed:', error.message);
    });
    return prefsWindow;
}

function positionPrefsWindow() {
    if (!prefsWindow || prefsWindow.isDestroyed() || !prefsAnchor) return;
    const anchor = prefsAnchor;
    const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
    const workArea = display.workArea;
    const margin = 10;
    const gap = 6;
    const height = Math.min(Math.max(prefsContentHeight || 360, 120), workArea.height - margin * 2);
    // 优先弹在触发按钮下方并与其左缘对齐；下方放不下时翻到上方。
    let x = Math.round(anchor.x);
    const below = Math.round(anchor.y + anchor.height + gap);
    const above = Math.round(anchor.y - gap - height);
    const fitsBelow = below + height <= workArea.y + workArea.height - margin;
    // 指针在卡片上时不翻面（内容变高也只在工作区内夹紧），避免面板从指针下跳走；
    // 其余时候（含刚打开、真实高度还没报上来）照常按能否放下决定方向
    if (!prefsPlacement || !prefsPointerInside({ anchor: false })) prefsPlacement = fitsBelow ? 'below' : 'above';
    let y = prefsPlacement === 'below' ? below : above;
    x = Math.min(Math.max(x, workArea.x + margin), workArea.x + workArea.width - PREFS_WINDOW_WIDTH - margin);
    y = Math.min(Math.max(y, workArea.y + margin), workArea.y + workArea.height - height - margin);
    prefsWindow.setBounds({ x, y, width: PREFS_WINDOW_WIDTH, height }, false);
}

function sendPrefsSnapshot(snapshot) {
    pendingPrefsSnapshot = snapshot;
    if (prefsWindow && !prefsWindow.isDestroyed() && prefsWindowReady) {
        prefsWindow.webContents.send('prefs:render', snapshot);
    }
}

function cancelPrefsCloseTimer() {
    clearTimeout(prefsCloseTimer);
    prefsCloseTimer = null;
}

// 指针是否在面板卡片（去掉窗口四周 16px 透明阴影边——Windows 上透明像素不接收鼠标）或触发按钮上
const PREFS_SHADOW_MARGIN = 16;
function prefsPointerInside({ anchor = true } = {}) {
    const p = screen.getCursorScreenPoint();
    const inside = (r, inset = 0) => r && p.x >= r.x + inset && p.x < r.x + r.width - inset && p.y >= r.y + inset && p.y < r.y + r.height - inset;
    const card = prefsWindow && !prefsWindow.isDestroyed() && prefsWindow.isVisible() ? prefsWindow.getBounds() : null;
    return !!(inside(card, PREFS_SHADOW_MARGIN) || (anchor && inside(prefsAnchor)));
}

// 移出即关：350ms 宽限后按真实指针位置判断——渲染层的 mouseenter 可能漏发（穿过透明阴影边、
// 窗口刚显示在静止指针下），不能只靠它取消。指针仍在面板/按钮上或原生下拉展开时继续观察。
function schedulePrefsClose() {
    cancelPrefsCloseTimer();
    const check = () => {
        if (prefsSelectOpen || prefsPointerInside()) { prefsCloseTimer = setTimeout(check, 200); return; }
        prefsCloseTimer = null;
        hidePrefsWindow(true);
    };
    prefsCloseTimer = setTimeout(check, 350);
}

function hidePrefsWindow(notifyRenderer) {
    cancelPrefsCloseTimer();
    prefsSelectOpen = false;
    if (!prefsWindow || prefsWindow.isDestroyed() || !prefsWindow.isVisible()) return;
    if (prefsHideTimer) return; // 淡出已在进行
    // 主窗状态立即同步（按钮 aria 等），视觉上再淡出 150ms 后收窗。
    if (notifyRenderer && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop:prefs-closed');
    }
    prefsWindow.webContents.send('prefs:hide-anim');
    prefsHideTimer = setTimeout(() => {
        prefsHideTimer = null;
        if (prefsWindow && !prefsWindow.isDestroyed()) prefsWindow.hide();
    }, 150);
}

async function showImagePreview(payload) {
    if (imageDragActive > 0) return;
    const point = readPreviewPoint(payload);
    if (!point) return;
    const requestId = ++imagePreviewRequestId;
    imagePreviewAnchor = readPreviewAnchor(payload);

    try {
        const source = await readPreviewImage(payload);
        if (requestId !== imagePreviewRequestId) return;
        if (!hoverImageCache) hoverImageCache = new PreviewCache({ directory: (await ensureStore()).previews,
            createThumbnail: (source, size) => previewDecoder.decode(source, size) });
        const natural = { width: Number(payload.width) || 0, height: Number(payload.height) || 0 };
        const thumbnail = await hoverImageCache.get(source, () => requestId === imagePreviewRequestId, natural);
        if (!thumbnail || requestId !== imagePreviewRequestId) return;
        const previewSource = { filePath: source, src: pathToFileURL(thumbnail).href };
        const previewSize = getFixedPreviewSize(natural, point, payload.placement === 'above' ? 0.5 : 1);
        const bounds = imagePreviewBounds(point, previewSize, payload.placement);
        const previewWindow = createImagePreviewWindow();
        const modelLabel = String(payload?.model || (payload?.filePath ? '未知模型' : '参考图')).trim() || '未知模型';
        const providerLabel = String(payload?.providerName || (payload?.filePath ? '未知供应商' : '本地上传')).trim() || '未知供应商';
        const sourceId = previewSource.filePath || previewSource.src.slice(0, 80);

        imagePreviewState = {
            sourceId,
            width: previewSize.width,
            height: previewSize.height,
            naturalWidth: previewSize.naturalWidth,
            naturalHeight: previewSize.naturalHeight
        };

        setImagePreviewBounds(previewWindow, bounds);
        await ensureImagePreviewLoaded(previewWindow);
        if (!isCurrentImagePreviewRequest(requestId, previewWindow, sourceId)) return;

        await updateImagePreviewContent(previewWindow, {
            src: previewSource.src,
            dimensions: natural.width && natural.height ? `${natural.width} x ${natural.height}` : '-',
            model: modelLabel,
            providerName: providerLabel
        });
        if (isCurrentImagePreviewRequest(requestId, previewWindow, sourceId)) {
            // 真实光标不在发起预览的那张图上就不弹：拖图出窗、窗内落下后图条重建/遮罩收起时，
            // 渲染层会在陈旧的指针位置补发悬停；拖拽进行中同理。
            if (imageDragActive > 0 || !cursorOnImagePreviewAnchor(4)) { hideImagePreview(); return; }
            previewWindow.showInactive();
            raiseImagePreviewWindow(previewWindow);
            watchImagePreviewCursor();
        }
    } catch (error) {
        if (requestId === imagePreviewRequestId) {
            console.error('[ImagePreview] show failed:', error.message);
            hideImagePreview();
        }
    }
}

function moveImagePreview(pointPayload) {
    const point = readPreviewPoint(pointPayload);
    if (!point || !imagePreviewWindow || imagePreviewWindow.isDestroyed() || !imagePreviewState) return;
    const bounds = imagePreviewBounds(point, imagePreviewState);
    setImagePreviewBounds(imagePreviewWindow, bounds);
}

function setImagePreviewBounds(previewWindow, bounds) {
    if (!previewWindow || previewWindow.isDestroyed() || !bounds) return;
    const previous = imagePreviewLastBounds;
    if (previous
        && previous.x === bounds.x
        && previous.y === bounds.y
        && previous.width === bounds.width
        && previous.height === bounds.height) return;
    previewWindow.setBounds(bounds, false);
    imagePreviewLastBounds = { ...bounds };
}

function cursorInsideMainWindow() {
    // Smoke-only: native-interaction-smoke drives the preview without moving the real cursor.
    if (process.env.PICGEN_SMOKE_PREVIEW_ANY_CURSOR === '1') return true;
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return false;
    const p = screen.getCursorScreenPoint();
    const b = mainWindow.getBounds();
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

// 渲染层带来发起预览那张图在页面里的矩形（CSS px）。按主窗内容区原点换算成屏幕 DIP，
// 只在真实光标确实停在这张图上时显示——按窗口判断挡不住窗内落下后的补发悬停，按图块判断与时序无关。
function readPreviewAnchor(payload) {
    const a = payload?.anchor;
    const rect = { x: Number(a?.x), y: Number(a?.y), width: Number(a?.width), height: Number(a?.height) };
    return Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0 ? rect : null;
}

function cursorOnImagePreviewAnchor(pad) {
    if (process.env.PICGEN_SMOKE_PREVIEW_ANY_CURSOR === '1') return true;
    if (!cursorInsideMainWindow()) return false;
    const rect = imagePreviewAnchor;
    if (!rect) return true; // 未带锚点的调用方（冒烟脚本直接调用）：退回按窗口判断
    const p = screen.getCursorScreenPoint();
    // 主窗横跨缩放不同的两块屏时，光标与内容区原点的 DIP 换算不在同一基准：退回按窗口判断
    const cursorDisplay = screen.getDisplayNearestPoint(p);
    const windowDisplay = screen.getDisplayMatching(mainWindow.getBounds());
    if (cursorDisplay.id !== windowDisplay.id && cursorDisplay.scaleFactor !== windowDisplay.scaleFactor) return true;
    const origin = mainWindow.getContentBounds();
    const zoom = mainWindow.webContents.getZoomFactor?.() || 1;
    const left = origin.x + rect.x * zoom;
    const top = origin.y + rect.y * zoom;
    return p.x >= left - pad && p.x < left + rect.width * zoom + pad
        && p.y >= top - pad && p.y < top + rect.height * zoom + pad;
}

// 预览显示期间按真实光标位置兜底：光标离开发起预览的图块（留 24px 余量，跨过图块间缝时
// 新图块的请求会先把锚点换掉）或离开 PicGen 窗口就收起。
// 渲染层的 mouseleave 会漏（原生拖拽把光标带出窗口、窗口失焦等），不能只靠它关闭。
let imagePreviewWatchTimer = null;
function watchImagePreviewCursor() {
    clearInterval(imagePreviewWatchTimer);
    imagePreviewWatchTimer = setInterval(() => {
        const visible = imagePreviewWindow && !imagePreviewWindow.isDestroyed() && imagePreviewWindow.isVisible();
        if (!visible) { clearInterval(imagePreviewWatchTimer); imagePreviewWatchTimer = null; return; }
        if (!cursorOnImagePreviewAnchor(24)) hideImagePreview();
    }, 250);
}

function hideImagePreview() {
    clearInterval(imagePreviewWatchTimer);
    imagePreviewWatchTimer = null;
    imagePreviewAnchor = null;
    imagePreviewRequestId += 1;
    imagePreviewState = null;
    imagePreviewLastBounds = null;
    if (imagePreviewWindow && !imagePreviewWindow.isDestroyed()) {
        imagePreviewWindow.hide();
    }
}

function setupTaskbarTasks() {
    if (process.platform !== 'win32') return;

    const appPath = app.getAppPath();
    const argumentsText = app.isPackaged
        ? QUIT_ARG
        : `"${appPath}" ${QUIT_ARG}`;

    app.setUserTasks([
        {
            program: process.execPath,
            arguments: argumentsText,
            iconPath: process.execPath,
            iconIndex: 0,
            title: '退出 PicGen',
            description: '退出 PicGen 桌面浮窗'
        }
    ]);
}

// The Node layer (node-fetch) never reads system proxy settings, but Chromium
// does. Keep both layers on the same mode so the switch means one thing.
async function applyChromiumProxy(config = {}) {
    const bypass = config.bypassList || 'localhost,127.0.0.1,::1';
    const sessions = [session.defaultSession, mainWindow?.webContents?.session]
        .filter((item, index, all) => item && all.indexOf(item) === index);

    for (const target of sessions) {
        if (config.mode === 'direct') {
            await target.setProxy({ mode: 'direct' });
        } else if (config.mode === 'custom' && config.customProxy) {
            await target.setProxy({ proxyRules: config.customProxy, proxyBypassRules: bypass });
        } else {
            await target.setProxy({ mode: 'system' });
        }
    }
    console.log(`[Proxy] Chromium 已切换为 ${config.mode} 模式`);
}

async function ensureServerRuntime() {
    if (serverRuntime) return serverRuntime;
    if (serverRuntimePromise) return serverRuntimePromise;

    serverRuntimePromise = (async () => {
        try {
            const { startServer } = require('./server');
            const runtime = await startServer({
                port: 0,
                host: '127.0.0.1',
                providerStoreFile: path.join(app.getPath('userData'), 'api-providers.json'),
                chatProviderStoreFile: path.join(app.getPath('userData'), 'chat-providers.json'),
                unifiedProviderStoreFile: path.join(app.getPath('userData'), 'providers.json'),
                secretCodec: createSecretCodec(),
                resultStore: storeTaskResult,
                failoverConfigFile: path.join(app.getPath('userData'), 'failover-config.json'),
                legacyFailoverConfigFile: defaultFailoverConfigFile(),
                proxyConfigFile: path.join(app.getPath('userData'), 'proxy-config.json'),
                onProxyConfig: applyChromiumProxy,
                errorLogStore
            });
            serverRuntime = runtime;
            await applyChromiumProxy(await runtime.proxyConfigStore.get());
            return runtime;
        } catch (error) {
            serverRuntimePromise = null;
            await errorLogStore?.record({
                source: 'system',
                title: '本地服务启动失败',
                message: error.message,
                error,
                operation: 'start-local-server'
            }).catch(() => {});
            throw error;
        }
    })();

    return serverRuntimePromise;
}

async function createWindow() {
    outputConfigStore = new OutputConfigStore({
        filePath: path.join(app.getPath('userData'), 'output-config.json')
    });
    await outputConfigStore.load();
    errorLogStore = new ErrorLogStore({
        filePath: path.join(app.getPath('userData'), 'logs', 'recent-errors.json')
    });
    errorLogStore.load().catch(error => {
        console.error('[ErrorLog] startup load failed:', error.message);
    });
    unsubscribeErrorLog = errorLogStore.onEntry(entry => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('desktop:error-log-entry', entry);
        }
    });

    // Warm the local API after the error-log store is ready, while Chromium
    // creates the first document. The renderer still awaits the same promise
    // through getServerUrl(), but no longer pays the server startup cost after
    // its first paint.
    void ensureServerRuntime().catch(error => {
        console.error('[Server] warmup failed:', error.message);
    });

    mainWindow = new BrowserWindow({
        ...getInitialBounds(),
        frame: false,
        transparent: true,
        resizable: true,
        thickFrame: true,
        minWidth: COLLAPSED_BOUNDS.width,
        minHeight: COLLAPSED_BOUNDS.height,
        maxWidth: COLLAPSED_BOUNDS.width,
        maxHeight: COLLAPSED_BOUNDS.height,
        alwaysOnTop: true,
        skipTaskbar: false,
        show: false,
        icon: createAppIcon(),
        webPreferences: {
            preload: path.join(__dirname, 'desktop-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    applyMainWindowAlwaysOnTop();
    setupEdgeDock();
    edgeDock.pinned = mainWindowPinned; // 初始窗口状态与默认置顶保持一致
    mainWindow.once('ready-to-show', () => bringMainWindowToFront({ focus: false }));
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        if (isQuitting || details.reason === 'clean-exit') return;
        errorLogStore.record({
            source: 'renderer',
            title: '渲染进程异常退出',
            message: `渲染进程已退出：${details.reason || 'unknown'}`,
            code: String(details.exitCode ?? ''),
            operation: 'render-process-gone',
            details
        }).catch(() => {});
    });
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (errorCode === -3) return;
        errorLogStore.record({
            source: 'renderer',
            title: '页面加载失败',
            message: errorDescription || `页面加载失败 (${errorCode})`,
            code: String(errorCode),
            operation: 'did-fail-load',
            details: { validatedURL, isMainFrame }
        }).catch(() => {});
    });
    mainWindow.webContents.on('context-menu', (event, params) => {
        if (params.isEditable) return;
        event.preventDefault();
        showDesktopContextMenu();
    });
    mainWindow.on('close', (event) => {
        if (isQuitting) return;
        event.preventDefault();
        setExpanded(false, { focus: false });
    });
    mainWindow.on('focus', () => {
        bringMainWindowToFront({ focus: false });
        // Bin entries whose file was deleted outside PicGen leave the bin (throttled, bin entries only).
        void scheduleHistoryBinSweep();
    });
    mainWindow.on('restore', () => {
        if (applyingDockBounds) return;
        setExpanded(true, { focus: true });
    });
    mainWindow.on('resize', () => {
        if (!isExpanded || applyingDockBounds || mainWindow.isDestroyed()) return;
        const bounds = mainWindow.getBounds();
        lastExpandedSize = { width: bounds.width, height: bounds.height };
    });
    mainWindow.on('unresponsive', () => {
        errorLogStore.record({
            source: 'renderer',
            title: '界面无响应',
            message: 'PicGen 渲染界面暂时无响应',
            operation: 'unresponsive'
        }).catch(() => {});
    });

    try {
        await mainWindow.loadFile(path.join(__dirname, 'desktop.html'));
    } catch (error) {
        await errorLogStore.record({
            source: 'system',
            title: '启动页面失败',
            message: error.message,
            error,
            operation: 'load-desktop-page'
        }).catch(() => {});
        throw error;
    }
}

// Every similarity request sees the current history: the index is loaded and handed to the service
// first (the same array is not diffed twice).
async function readySimilarityService() {
    syncSimilarityRecords(await loadHistoryIndex());
    return getSimilarityService();
}

// 以图搜图: {filePath} (a dropped file) or {bytes, mimeType} (a pasted image, written to a temp file the
// host can decode and removed afterwards). The image is only read; nothing about it is stored.
const IMAGE_SEARCH_MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_SEARCH_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.tif', '.tiff']);
const IMAGE_SEARCH_MIME_EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/tiff': '.tif' };
const IMAGE_SEARCH_TEMP_MAX_AGE_MS = 10 * 60 * 1000;

// Query files left by a crash or a failed write: anything older than 10 min goes.
async function sweepImageSearchTemp(dir) {
    const names = await fs.readdir(dir).catch(() => []);
    const cutoff = Date.now() - IMAGE_SEARCH_TEMP_MAX_AGE_MS;
    await Promise.all(names.filter(name => name.startsWith('query-')).map(async name => {
        const file = path.join(dir, name);
        const stat = await fs.stat(file).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true }).catch(() => {});
    }));
}

async function searchSimilarByImage(input) {
    const query = input && typeof input === 'object' ? input : {};
    const limit = Number.isFinite(Number(query.limit)) ? Math.max(1, Math.min(200, Math.floor(Number(query.limit)))) : undefined;
    let filePath = '';
    let tempPath = '';
    let tempBytes = null;
    if (typeof query.filePath === 'string' && query.filePath) {
        filePath = path.resolve(query.filePath);
        if (!IMAGE_SEARCH_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('只支持 PNG、JPG、WebP、GIF、AVIF、TIFF 图片');
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) throw new Error('不是图片文件');
        if (stat.size > IMAGE_SEARCH_MAX_BYTES) throw new Error('图片超过 50 MB');
    } else if (query.bytes) {
        const bytes = Buffer.from(query.bytes instanceof ArrayBuffer ? new Uint8Array(query.bytes) : query.bytes);
        const extension = IMAGE_SEARCH_MIME_EXTENSIONS[String(query.mimeType || '').toLowerCase()];
        if (!extension) throw new Error('只支持 PNG、JPG、WebP、GIF、AVIF、TIFF 图片');
        if (!bytes.length || bytes.length > IMAGE_SEARCH_MAX_BYTES) throw new Error('图片为空或超过 50 MB');
        const dir = path.join(getStorePaths().root, 'image-search');
        await fs.mkdir(dir, { recursive: true });
        void sweepImageSearchTemp(dir);
        tempPath = path.join(dir, `query-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extension}`);
        filePath = tempPath;
        tempBytes = bytes;
    } else {
        throw new Error('没有收到要搜索的图片');
    }
    try {
        if (tempPath) await fs.writeFile(tempPath, tempBytes);
        const match = query.match === 'element' ? 'element' : 'whole';
        return await (await readySimilarityService()).neighborsOfImage({ path: filePath, limit, match });
    } finally {
        if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => {});
    }
}

// Smoke-only (PICGEN_SMOKE=1): what the similarity host is running. Poll until `ready` and a
// featureVersion are reported; before that, mode is the mode the service asked for.
async function smokeSimilarityStatus() {
    const status = (await readySimilarityService()).status();
    let metric = null;
    if (status.hostPid) metric = app.getAppMetrics().find(item => item.pid === status.hostPid) || null;
    const megabytes = kilobytes => (Number(kilobytes) > 0 ? Math.round(Number(kilobytes) / 102.4) / 10 : null);
    return {
        mode: status.mode,
        modeReason: status.modeReason,
        ortVersion: status.ortVersion,
        featureVersion: status.featureVersion,
        hostPid: status.hostPid,
        hostRssMb: megabytes(metric?.memory?.workingSetSize),
        hostPeakRssMb: megabytes(metric?.memory?.peakWorkingSetSize),
        stage: status.stage,
        pending: status.pending,
        analyzed: status.analyzed,
        total: status.total,
        state: status.state,
        ready: status.ready,
        error: status.error
    };
}

// Smoke-only: main-process event-loop delay between 'start' and 'stop', in ms. The histogram records
// the whole interval between timer ticks, so an idle loop reads ≈ the resolution (10 ms), and ≈ 15.6 ms
// on Windows, where the default timer granularity is 15.625 ms; `min` shows that floor. Gates must use
// the excess* fields (each raw value minus `min`): only they measure how long the loop was blocked.
let smokeEventLoopHistogram = null;
function smokeEventLoop(input) {
    const op = typeof input === 'string' ? input : input?.op;
    const toMs = nanoseconds => (Number.isFinite(nanoseconds) ? Math.round(nanoseconds / 1e4) / 100 : 0);
    if (op === 'start') {
        const { monitorEventLoopDelay } = require('perf_hooks');
        smokeEventLoopHistogram?.disable();
        smokeEventLoopHistogram = monitorEventLoopDelay({ resolution: 10 });
        smokeEventLoopHistogram.enable();
        return { started: true };
    }
    if (op === 'stop') {
        const histogram = smokeEventLoopHistogram;
        smokeEventLoopHistogram = null;
        if (!histogram) throw new Error('smoke event-loop monitor was not started');
        histogram.disable();
        const samples = histogram.count;
        const floor = samples ? histogram.min : 0;
        const excess = nanoseconds => (samples ? toMs(Math.max(0, nanoseconds - floor)) : 0);
        return {
            max: samples ? toMs(histogram.max) : 0,
            p99: samples ? toMs(histogram.percentile(99)) : 0,
            mean: samples ? toMs(histogram.mean) : 0,
            min: samples ? toMs(floor) : 0,
            excessMaxMs: excess(histogram.max),
            excessP99Ms: excess(histogram.percentile(99)),
            excessMeanMs: excess(histogram.mean),
            samples,
            resolutionMs: 10
        };
    }
    throw new Error(`unknown smoke event-loop op: ${op}`);
}

function loggedIpcHandler({ source = 'system', title, operation }, handler) {
    return async (event, payload) => {
        try {
            return await handler(payload, event);
        } catch (error) {
            await errorLogStore?.record({
                source,
                title,
                message: error.message,
                error,
                code: error.code || '',
                operation
            }).catch(() => {});
            throw error;
        }
    };
}

ipcMain.handle('desktop:get-server-url', async () => (await ensureServerRuntime()).url);
ipcMain.handle('desktop:get-version', () => app.getVersion());
ipcMain.handle('desktop:open-external', async (_event, url) => {
    // 只放行 http/https，避免通过 shell 打开本地文件或危险协议。
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return { success: false };
    try { await shell.openExternal(target); return { success: true }; }
    catch (error) { return { success: false, message: error.message }; }
});
ipcMain.handle('desktop:get-window-state', windowState);
ipcMain.on('desktop:pin-window', (_event, pinned) => setMainWindowPinned(pinned));
ipcMain.on('desktop:dock-interaction', (_event, busy) => { dockInteractionBusy = busy === true; });
ipcMain.handle('desktop:list-recent-images', loggedIpcHandler({ source: 'storage', title: '读取最近图片失败', operation: 'list-recent-images' }, readRecentImages));
ipcMain.handle('desktop:list-history-images', loggedIpcHandler({ source: 'storage', title: '读取历史图片失败', operation: 'list-history-images' }, readHistoryImages));
ipcMain.handle('desktop:get-history-thumbnail', loggedIpcHandler({ source: 'storage', title: '读取历史缩略图失败', operation: 'get-history-thumbnail' }, getHistoryThumbnail));
ipcMain.handle('desktop:similarity-groups', loggedIpcHandler({ source: 'system', title: '读取相似图片失败', operation: 'similarity-groups' },
    async options => (await readySimilarityService()).get(options && typeof options === 'object' ? options : {})));
ipcMain.handle('desktop:similarity-neighbors', loggedIpcHandler({ source: 'system', title: '查找相似图片失败', operation: 'similarity-neighbors' },
    async query => (await readySimilarityService()).neighbors(query && typeof query === 'object' ? query : {})));
ipcMain.handle('desktop:similarity-neighbors-image', loggedIpcHandler({ source: 'system', title: '以图搜图失败', operation: 'similarity-neighbors-image' },
    searchSimilarByImage));
ipcMain.handle('desktop:similarity-override', loggedIpcHandler({ source: 'system', title: '调整相似分组失败', operation: 'similarity-override' },
    async change => (await readySimilarityService()).override(change && typeof change === 'object' ? change : {})));
ipcMain.handle('desktop:record-history-usage', loggedIpcHandler({ source: 'storage', title: '记录图片使用失败', operation: 'record-history-usage' }, recordHistoryUsage));
ipcMain.handle('desktop:trash-history-images', loggedIpcHandler({ source: 'storage', title: '移到回收站失败', operation: 'trash-history-images' },
    payload => getHistoryTrash().trash(payload)));
ipcMain.handle('desktop:list-history-bin', loggedIpcHandler({ source: 'storage', title: '读取回收站失败', operation: 'list-history-bin' }, listHistoryBin));
ipcMain.handle('desktop:restore-history-bin', loggedIpcHandler({ source: 'storage', title: '还原图片失败', operation: 'restore-history-bin' },
    payload => getHistoryTrash().restore(payload)));
ipcMain.handle('desktop:purge-history-bin', loggedIpcHandler({ source: 'storage', title: '彻底删除图片失败', operation: 'purge-history-bin' },
    payload => getHistoryTrash().purge(payload)));
ipcMain.handle('desktop:get-history-bin-count', loggedIpcHandler({ source: 'storage', title: '读取回收站失败', operation: 'get-history-bin-count' },
    () => getHistoryTrash().count()));
if (process.env.PICGEN_SMOKE === '1') {
    ipcMain.handle('desktop:smoke-similarity-status', () => smokeSimilarityStatus());
    ipcMain.handle('desktop:smoke-event-loop', (_event, input) => smokeEventLoop(input));
    ipcMain.handle('desktop:smoke-drag-outcome', (event, payload) => smokeDragOutcome(payload, event));
    // The focus sweep, unthrottled by default for a deterministic stage; {force: false} runs it
    // exactly as the focus handler does (throttle included).
    ipcMain.handle('desktop:smoke-history-bin-sweep', (_event, options) => scheduleHistoryBinSweep({ force: options?.force !== false }));
    // 只读：PICGEN_SMOKE_CLIPBOARD=dry 时本该写进剪贴板的内容（最近 20 条）。只在 dry 模式下注册：
    // 冒烟脚本复制之前先调一次，调得通就说明这次启动不会写用户的系统剪贴板
    if (process.env.PICGEN_SMOKE_CLIPBOARD === 'dry') ipcMain.handle('desktop:smoke-clipboard-log', () => smokeClipboardLog.slice());
}
ipcMain.handle('desktop:save-generated-image', loggedIpcHandler({ source: 'storage', title: '保存生成图片失败', operation: 'save-generated-image' }, saveGeneratedImage));
ipcMain.handle('desktop:save-image-as', loggedIpcHandler({ source: 'storage', title: '另存图片失败', operation: 'save-image-as' }, saveImageAs));
ipcMain.handle('desktop:copy-image', loggedIpcHandler({ source: 'storage', title: '复制图片失败', operation: 'copy-image' }, copyImageToClipboard));
ipcMain.handle('desktop:open-output-folder', loggedIpcHandler({ source: 'storage', title: '打开输出目录失败', operation: 'open-output-folder' }, openOutputFolder));
ipcMain.handle('desktop:get-output-directory', loggedIpcHandler({ source: 'storage', title: '读取保存目录失败', operation: 'get-output-directory' }, readOutputDirectoryConfig));
ipcMain.handle('desktop:choose-output-directory', loggedIpcHandler({ source: 'storage', title: '选择保存目录失败', operation: 'choose-output-directory' }, chooseOutputDirectory));
ipcMain.handle('desktop:reset-output-directory', loggedIpcHandler({ source: 'storage', title: '恢复默认保存目录失败', operation: 'reset-output-directory' }, resetOutputDirectory));
ipcMain.handle('desktop:get-generated-image-prompt', loggedIpcHandler({ source: 'storage', title: '读取图片提示词失败', operation: 'get-generated-image-prompt' }, getGeneratedImagePrompt));
ipcMain.handle('desktop:save-reference-image', loggedIpcHandler({ source: 'storage', title: '缓存参考图失败', operation: 'save-reference-image' }, saveReferenceImage));
ipcMain.handle('desktop:load-reference-image', loggedIpcHandler({ source: 'storage', title: '读取参考图失败', operation: 'load-reference-image' }, loadReferenceImage));
ipcMain.handle('desktop:load-cached-image', loggedIpcHandler({ source: 'storage', title: '读取缓存图片失败', operation: 'load-cached-image' }, loadCachedImage));
ipcMain.handle('desktop:delete-reference-image', loggedIpcHandler({ source: 'storage', title: '删除参考图缓存失败', operation: 'delete-reference-image' }, deleteReferenceImage));

// 尺寸参照图：像素工作全部在 size-reference-worker 里；这里只转发和落盘。
const sizeReferenceWorker = new SizeReferenceWorker();

// 对话框传原始输入 {height,width,depth,unit}，换算和校验统一走 toMm，错误文案直接回显给用户。
function sizeReferenceDims(dims = {}) {
    const unit = dims.unit || 'cm';
    const read = value => (String(value ?? '').trim() ? toMm(value, unit) : 0);
    const dimsMm = { heightMm: read(dims.height) };
    if (!dimsMm.heightMm) throw new Error('请填写产品高度');
    const widthMm = read(dims.width);
    const depthMm = read(dims.depth);
    if (widthMm) dimsMm.widthMm = widthMm;
    if (depthMm) dimsMm.depthMm = depthMm;
    return dimsMm;
}

function sizeReferenceSpec(payload) {
    const spec = payload?.spec || {};
    return {
        region: spec.region,
        dimsMm: sizeReferenceDims(spec.dims),
        anchorId: String(spec.anchorId || ''),
        person: String(spec.person || ''),
        alias: String(spec.alias || ''),
        variant: spec.variant
    };
}

async function renderSizeReferenceForRenderer(payload) {
    const key = String(payload?.key || '');
    if (!key) throw new Error('缺少产品图片');
    const result = await sizeReferenceWorker.render(key, sizeReferenceSpec(payload));
    return {
        base64: result.buffer.toString('base64'),
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
        anchor: result.anchor,
        region: result.region,
        warnings: result.warnings,
        prompt: result.prompt
    };
}

async function saveSizeReferenceChart(payload) {
    const spec = sizeReferenceSpec(payload);
    const result = await sizeReferenceWorker.render(String(payload?.key || ''), { ...spec, variant: 'chart' });
    const dims = [
        spec.dimsMm.heightMm ? `高 ${formatLength(spec.dimsMm.heightMm).metric}` : '',
        spec.dimsMm.widthMm ? `宽 ${formatLength(spec.dimsMm.widthMm).metric}` : '',
        spec.dimsMm.depthMm ? `深 ${formatLength(spec.dimsMm.depthMm).metric}` : ''
    ].filter(Boolean).join('、');
    return saveGeneratedImage({
        base64: result.buffer.toString('base64'),
        mimeType: result.mimeType,
        prompt: `尺寸参照图：产品${dims}；参照物：${result.anchor.label || result.anchor.short}`,
        ratio: '4:3',
        model: 'PicGen 尺寸参照图',
        providerName: 'PicGen',
        width: result.width,
        height: result.height
    });
}

ipcMain.handle('desktop:size-ref-anchors', () => loadAnchorCatalog());
ipcMain.handle('desktop:size-ref-prepare', loggedIpcHandler({ source: 'storage', title: '读取尺寸参照产品图失败', operation: 'size-ref-prepare' }, payload => {
    if (!payload?.base64) throw new Error('缺少产品图片');
    return sizeReferenceWorker.prepare(Buffer.from(payload.base64, 'base64'));
}));
// 预览随输入实时重绘，填错尺寸是常态：不进错误日志，失败原因由对话框直接显示。
ipcMain.handle('desktop:size-ref-render', (_event, payload) => renderSizeReferenceForRenderer(payload));
ipcMain.handle('desktop:size-ref-save', loggedIpcHandler({ source: 'storage', title: '保存尺寸参照图失败', operation: 'size-ref-save' }, saveSizeReferenceChart));
ipcMain.handle('desktop:size-ref-release', (_event, payload) => sizeReferenceWorker.release(String(payload?.key || '')));
ipcMain.handle('desktop:list-error-logs', (_event, options) => errorLogStore?.list(options || {}) || []);
ipcMain.handle('desktop:count-error-logs', () => errorLogStore?.count() || 0);
ipcMain.handle('desktop:clear-error-logs', () => errorLogStore?.clear() || { success: true, removed: 0 });
ipcMain.handle('desktop:record-renderer-error', (_event, payload) => errorLogStore?.record({
    ...(payload && typeof payload === 'object' ? payload : {}),
    source: 'renderer'
}) || null);
ipcMain.handle('desktop:copy-text', (_event, text) => {
    writeClipboard('text', String(text || ''));
    return { success: true };
});
ipcMain.on('desktop:set-expanded', (_event, expanded) => setExpanded(!!expanded, { focus: !!expanded }));
ipcMain.on('desktop:close', () => setExpanded(false, { focus: false }));
ipcMain.on('desktop:show-context-menu', showDesktopContextMenu);
ipcMain.handle('desktop:show-image-context-menu', showImageContextMenu);
ipcMain.handle('desktop:copy-image-to-clipboard', loggedIpcHandler({ source: 'storage', title: '复制图片失败', operation: 'copy-image-to-clipboard' }, copyImageToClipboard));
if (process.env.PICGEN_SMOKE === '1') {
    ipcMain.handle('desktop:smoke-image-menu', (_event, choice) => {
        if (choice !== undefined && choice !== null) smokeImageMenu.choices.push(String(choice));
        return { last: smokeImageMenu.last, queued: smokeImageMenu.choices.length };
    });
    ipcMain.handle('desktop:smoke-clipboard-image', () => {
        const image = clipboard.readImage();
        return image.isEmpty() ? null : image.getSize();
    });
}
ipcMain.on('desktop:start-window-move', (_event, point) => startWindowMove(point));
ipcMain.on('desktop:move-window', (_event, point) => moveWindow(point));
ipcMain.on('desktop:end-window-move', endWindowMove);
ipcMain.on('desktop:start-image-drag', (event, payload) => {
    // 原生拖拽期间（含 startDrag 之前生成拖拽图标的空档）一律不弹悬停预览
    imageDragActive += 1;
    hideImagePreview();
    void startImageDrag(event.sender, payload).finally(() => { imageDragActive -= 1; });
});
ipcMain.on('desktop:show-image-preview', (_event, payload) => {
    showImagePreview(payload);
});
// ===== 置顶设置窗 IPC =====
ipcMain.on('desktop:prefs-schedule-close', () => schedulePrefsClose());
ipcMain.on('prefs:pointer-enter', () => cancelPrefsCloseTimer());
ipcMain.on('prefs:pointer-leave', () => schedulePrefsClose());
ipcMain.on('desktop:prefs-open', (_event, payload) => {
    cancelPrefsCloseTimer();
    // 打断进行中的淡出收窗（快速重开/横移切换）。
    clearTimeout(prefsHideTimer);
    prefsHideTimer = null;
    if (payload?.anchor) prefsAnchor = payload.anchor;
    prefsPlacement = null;
    prefsSelectOpen = false;
    if (Number(payload?.height)) prefsContentHeight = Number(payload.height);
    if (payload?.snapshot) pendingPrefsSnapshot = payload.snapshot;
    const win = createPrefsWindow();
    positionPrefsWindow();
    if (prefsWindowReady && pendingPrefsSnapshot) win.webContents.send('prefs:render', pendingPrefsSnapshot);
    win.show();
    win.focus();
    if (prefsWindowReady) win.webContents.send('prefs:shown');
});
ipcMain.on('desktop:prefs-sync', (_event, snapshot) => sendPrefsSnapshot(snapshot));
ipcMain.on('desktop:prefs-hide', () => hidePrefsWindow(false));
ipcMain.on('prefs:ready', () => {
    prefsWindowReady = true;
    if (prefsWindow && !prefsWindow.isDestroyed() && pendingPrefsSnapshot) {
        prefsWindow.webContents.send('prefs:render', pendingPrefsSnapshot);
    }
});
ipcMain.on('prefs:change', (_event, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:prefs-change', payload);
});
ipcMain.on('prefs:close-request', () => hidePrefsWindow(true));
ipcMain.on('prefs:select-open', (_event, open) => { prefsSelectOpen = open === true; });
ipcMain.on('prefs:resize', (_event, height) => {
    const next = Number(height);
    if (!Number.isFinite(next) || next < 40) return;
    prefsContentHeight = Math.round(next);
    if (prefsWindow && !prefsWindow.isDestroyed() && prefsWindow.isVisible()) positionPrefsWindow();
});
ipcMain.on('desktop:move-image-preview', (_event, point) => moveImagePreview(point));
ipcMain.on('desktop:hide-image-preview', hideImagePreview);

app.whenReady().then(async () => {
    if (!hasSingleInstanceLock || launchWantsQuit) {
        isQuitting = true;
        app.quit();
        return;
    }

    appReadyAt = Date.now();
    powerMonitor.on('on-battery', () => setSimilarityLoad({ onBattery: true }));
    powerMonitor.on('on-ac', () => setSimilarityLoad({ onBattery: false }));
    setupTaskbarTasks();
    await createWindow();
    createTray();
});

app.on('second-instance', (_event, argv) => {
    if (argv.includes(QUIT_ARG)) {
        isQuitting = true;
        app.quit();
        return;
    }

    setExpanded(true, { focus: true });
});

app.on('activate', () => {
    if (mainWindow) {
        setExpanded(true, { focus: true });
    }
});

app.on('window-all-closed', async () => {
    if (serverRuntime) {
        serverRuntime.close();
        serverRuntime = null;
    }
    app.quit();
});

app.on('before-quit', event => {
    clearInterval(edgeDockTimer);
    isQuitting = true;
    if (unsubscribeErrorLog) {
        unsubscribeErrorLog();
        unsubscribeErrorLog = null;
    }
    if (serverRuntime) {
        serverRuntime.close();
        serverRuntime = null;
    }
    // The similarity host flushes its manifest and exits; the quit waits for it at most 2 s, once.
    // Rows are written before the manifest, so a host killed with the app loses nothing but ≤ 5 s
    // of manifest updates.
    const closingSimilarity = !similarityClosed;
    similarityClosed = true;
    if (similarityService && closingSimilarity) {
        event.preventDefault();
        const service = similarityService;
        Promise.race([service.close(), new Promise(resolve => setTimeout(resolve, 2000))])
            .catch(error => console.warn('[similarity] close failed:', error.message))
            .finally(() => app.quit());
    }
});
