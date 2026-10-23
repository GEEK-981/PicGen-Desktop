const DESKTOP_SEQUENCES_KEY = 'picgen_desktop_sequences';
const DESKTOP_CURRENT_SEQUENCE_KEY = 'picgen_desktop_current_sequence';
const DESKTOP_LEGACY_DRAFT_KEY = 'picgen_desktop_sequence_draft';
const DESKTOP_ACTIVE_PROVIDER_KEY = 'picgen_desktop_active_provider_id';
const DESKTOP_ACTIVE_CHAT_PROVIDER_KEY = 'picgen_desktop_active_chat_provider_id';
const DESKTOP_ACTIVE_CHAT_MODEL_KEY = 'picgen_desktop_active_chat_model';
const AUTO_PROVIDER_VALUE = '__auto__';
const DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT = [
    '你是专业的 AI 生图提示词优化助手，精通主流图像生成模型的提示词工程。',
    '将用户输入改写为一条更利于图像模型理解的提示词，严格忠于原始意图，不新增与原意冲突的主体、风格或限制。',
    '在与原意相关时按需补充以下要素，不要生硬堆砌：主体与用途（照片／海报／图标／插画等）；构图（取景、主体位置、画幅比例）；光线与色彩（光源方向、氛围、主色调）；材质与媒介（表面质感、绘制或摄影风格，需要真实感时明确"照片级写实"）；关键细节与艺术风格。',
    '用具体可见的描述代替笼统的情绪词；若画面内需出现文字，用引号给出确切文案并说明位置，同时声明不出现多余文字；必要时补充排除项（如无水印、无多余元素）。',
    '用户消息里每张参考图前都有一行【参考图 N：名称】标签，名称就是该图在用户提示词中的引用名。',
    '引用参考图时必须写成 @{名称} 的形式（花括号不可省略，例如 @{大张}、@{花石道}），名称抄标签里的原文，一个字都不要改写、翻译或编造。',
    '严禁输出 @第一张参考图文件名、@第二张参考图文件名 之类的占位说法，也严禁用"参考图1""图一"这种序号指代——它们对不上任何真实图片。',
    '若用户提示词里已经出现 @{名称} 形式的引用，必须原样保留这些引用，并保持它们与各自描述的位置关系。',
    '输出为一条可直接使用的完整提示词，按此结构组织、用分号或换行分隔各要素，不要写标题或编号：',
    '1. 主体与用途；2. 构图与主体位置（涉及多张参考图时，逐张写明哪个 @{名称} 放在哪个位置）；3. 光线与色彩；4. 材质、媒介与风格；5. 关键细节；6. 排除项。',
    '用户消息末尾会给出本次生图的画幅比例参数。这是硬约束：若提示词里出现与之冲突的画幅、比例或朝向描述（例如参数是 1:1 而原文写「画幅 3:4」「竖幅」），必须以该参数为准改写，不要保留互相矛盾的说法。',
    '只返回优化后的提示词正文，语言与用户输入保持一致，不要解释，不要使用 Markdown 标记。'
].join('\n');

const legacyApiStorageKeys = [
    'picgen_desktop_presets',
    'picgen_desktop_current_preset',
    'picgen_desktop_presets_version',
    'picgen_config',
    'picgen_api_mode',
    'picgen_api_presets',
    'picgen_current_preset',
    'chatPresetId'
];

const state = {
    serverUrl: '',
    ws: null,
    reconnectTimer: null,
    presets: [],
    providerHealth: new Map(),
    providerHealthTimer: null,
    providerHealthLoadPromise: null,
    currentPresetId: null,
    chatPresets: [],
    chatProvidersLoaded: false,
    unifiedSuppliers: [],
    unifiedSupplierIndex: 0,
    unifiedSupplierFocusId: '',
    chatProvidersLoadPromise: null,
    currentChatPresetId: null,
    settingsMode: 'image',
    promptOptimizeEnabled: true,
    promptOptimizeSystemPrompt: '',
    // 提示词编辑器的 Ctrl+Z 撤销栈：按序列分桶（切序列不串味），存序列化后的文本快照。
    promptHistory: new Map(),
    // 正在进行的「就地覆盖」优化流（null＝空闲）。存在时按钮即“停止”。
    promptOptimizeRun: null,
    promptOptimizeStarting: false,
    promptOptimizeStartTicket: null,
    // 上一次「停止」手势的时间。停止与优化共用一颗按钮，停止后立刻再点会重新开跑，
    // 而用户「停一下没反应就再点一下」的余手正好落在这个窗口里 —— 越点越跑。
    promptOptimizeStoppedAt: 0,
    outputDirectoryConfig: null,
    routingStrategy: 'order',
    automaticRoutingStrategy: 'order',
    strategyProviderId: null,
    fixedProviderId: null,
    sequences: [],
    currentSequenceId: null,
    hydratedSequenceIds: new Set(),
    sequenceHydrationPromises: new Map(),
    savedImageTaskIds: new Set(),
    queueTasks: [],
    queueTasksById: new Map(),
    queueChanges: new Map(),
    queueRevision: 0,
    queueSnapshotsInFlight: 0,
    queueRenderFrame: 0,
    queueLoadPromise: null,
    reversePromptImage: null,
    reversePromptBusy: false,
    recentImages: [],
    historyLoaded: false,
    historyLoadPromise: null,
    historyDirty: false,
    historyRenderFrame: 0,
    historyRevision: 0,
    historyChanges: new Map(),
    savingImageTasks: new Map(),
    activeView: 'generation',
    settingsReturnView: 'generation',
    historyLayout: 'grid',
    historySelectedIds: new Set(),
    historyActiveImageId: null,
    historyDetailTab: 'details',
    // The drawer opens compact (summary + icon actions); 展开 shows the tabs. Remembered per viewer.
    historyDetailExpanded: false,
    historyRenderedCount: 0,
    historyThumbnailObserver: null,
    // What #historyImages currently holds: 'items' (grid/list), 'similar' (group rows) or 'find'.
    historyHostMode: 'items',
    // Similar view (v3.1). The snapshot is per preset; groups/singles are its projection over the
    // filtered history, recomputed locally on every filter change (no IPC).
    similarSnapshot: null,
    similarGroups: [],
    similarSingles: [],
    similarMissing: 0,
    similarGrouped: 0,
    similarVisibleTotal: 0,
    similarPreset: 'standard',
    similarSort: 'recent',
    showSingles: false,
    similarOrder: [],
    similarRendered: 0,
    similarSinglesRendered: 0,
    similarRows: new Map(),
    similarOpenIds: new Set(),
    similarDeferred: [],
    similarDom: null,
    similarPagerObserver: null,
    similarFetchSeq: 0,
    similarFetching: false,
    similarRefetch: false,
    similarStale: false,
    similarError: '',
    similarFind: null,
    // {scrollTop} while find-similar results cover a parked (hidden, intact) similar list.
    similarParked: null,
    imageContextGroupId: null,
    historyTrashIncludeProtected: false,
    // Synchronous guard: one trash request at a time (double clicks, 重试 while busy).
    historyTrashBusy: false,
    historyTrashProgress: null,
    // The last result's failed items, for 重试, plus the request context they came from.
    historyTrashRetry: null,
    historyTrashResultTimer: null,
    // id → revision of a local removal; refreshRecentImages drops these from a snapshot that was in flight.
    historyRemovals: new Map(),
    // In-app recycle bin: items as listed by main, selection by file path, total for the sidebar badge.
    historyBin: { items: [], loaded: false, selected: new Set(), busy: false, total: 0 },
    historyTrashUndo: null,
    errorLogs: [],
    errorLogUnreadCount: 0,
    expandedErrorLogIds: new Set(),
    mentionItems: [],
    pendingMaskEdits: new Map(),
    mentionIndex: 0,
    mentionRange: null,
    // 点空 @ 打开的选图菜单要替换的那个占位 token（openEmptyMentionPicker）。
    mentionTargetToken: null,
    imageContextTarget: null,
    hoverPreviewImage: null,
    hoverPreviewNative: false,
    hoverPreviewPoint: null,
    hoverPreviewPositionFrame: 0,
    hoverPreviewTimer: 0,
    // 发起当前悬停预览的图块元素：主进程据它的矩形核对真实光标确实停在这张图上。
    hoverPreviewAnchor: null,
    // 悬停预览的三道闸：原生拖拽进行中 / 按键按在图片上（准备拖拽）/ 拖拽结束后还没真实移动过。
    imageDragPreviewGuard: false,
    imagePointerPressed: false,
    hoverPreviewNeedsMove: false,
    hoverPreviewMoveFrom: null,
    draggedRecentImage: null,
    draggedReferenceCard: null,
    addingHistoryReference: false,
    referenceDragClearTimer: null,
    nativePrefsOpen: null,
    promptDropZone: null,
    recentDragClearTimer: null,
    toastTimer: null,
    concurrencySettingsRequestId: 0,
    routingSaveRequestId: 0,
    proxySaveRequestId: 0,
    referenceRatioPrevious: null,
    referenceRatioPickerBusy: false
};

const el = {};
const ux = window.PicGenUX;
const imageApiProfiles = window.PicGenImageApiProfiles;
if (!imageApiProfiles) throw new Error('Image API capability profiles failed to load');
const rendererUtils = window.PicGenRendererUtils;
if (!rendererUtils) throw new Error('Renderer utilities failed to load');

const OPENAI_LEGACY_IMAGE_SIZE_OPTIONS = imageApiProfiles.getImageApiProfile('gpt-image-1').dimensionOptions;
const PROMPT_BLOCK_TAGS = new Set(['DIV', 'P', 'LI']);
const HISTORY_RENDER_BATCH_SIZE = 60;

document.addEventListener('DOMContentLoaded', init);
if (typeof window.addEventListener === 'function') {
    window.addEventListener('picgen:open-error-logs', () => openErrorLogs());
}

async function init() {
    cacheElements();
    el.mainSurface.appendChild(el.settingsOverlay);
    initModernSelects();
    refreshLucideIcons();
    bindWindowEvents();
    bindFormEvents();
    loadPromptOptimizeSettings();

    state.serverUrl = await window.picgenDesktop.getServerUrl();
    prepareApiStorage();
    const [providers, routingConfig] = await Promise.all([
        loadProviders(),
        loadProviderRoutingConfig()
    ]);
    state.presets = providers;
    applyProviderRoutingConfig(routingConfig, { render: false });
    const storedProviderId = localStorage.getItem(DESKTOP_ACTIVE_PROVIDER_KEY);
    const fixedProviderId = state.routingStrategy === 'fixed'
        ? getPresetById(state.fixedProviderId)?.id
        : null;
    state.currentPresetId = fixedProviderId
        || getPresetById(storedProviderId)?.id
        || state.presets[0]?.id
        || null;
    state.currentChatPresetId = localStorage.getItem(DESKTOP_ACTIVE_CHAT_PROVIDER_KEY) || null;
    setActiveProvider(state.currentPresetId);
    state.sequences = loadSequences();
    state.currentSequenceId = pickCurrentSequenceId();
    normalizeSequenceNames();
    normalizeSequenceProviders();
    state.currentSequenceId = pickCurrentSequenceId();

    renderProviderSelect();
    renderSequenceTabs();
    loadCurrentSequenceToForm();
    connectWebSocket();
    try { state.recentViewMode = localStorage.getItem('picgen.recentViewMode') === 'carousel20' ? 'carousel20' : 'grid10'; } catch { state.recentViewMode = 'grid10'; }
    updateRecentViewToggle();
    scheduleAfterFirstPaint(async () => {
        await Promise.allSettled([
            refreshRecentImages({ full: false }),
            refreshErrorLogCount()
        ]);
    });
}

function scheduleAfterFirstPaint(task) {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            Promise.resolve().then(task).catch(error => {
                console.warn('[Startup] deferred task failed:', error.message);
            });
        });
    });
}

function cacheElements() {
    for (const id of ['sendReferenceActiveBtn', 'sendReferenceNewBtn', 'historySimilarBtn', 'routingRanking', 'providerCapacityPanel', 'providerPriorityField']) el[id] = document.getElementById(id);
    for (const id of ['workspaceImageBtn', 'copyImageBtn', 'copyPromptImageBtn', 'saveImageAsBtn']) el[id] = document.getElementById(id);
    for (const id of ['historySimilarToolbar', 'historySimilarPreset', 'historySimilarSort', 'historySimilarSingles', 'historySimilarStatus',
        'historySimilarProgress', 'historyFindSimilarBtn', 'findSimilarImageBtn', 'setCoverImageBtn', 'detachImageBtn']) el[id] = document.getElementById(id);
    for (const id of ['historyTrashBtn', 'historyTrashProtectedToggle', 'historyTrashIncludeProtected', 'historyTrashProtectedText',
        'historyTrashResult', 'historyTrashResultText', 'historyTrashOpenBinBtn', 'historyTrashRetryBtn', 'historyTrashDismissBtn']) el[id] = document.getElementById(id);
    el.body = document.body;
    el.collapsedLauncher = document.getElementById('collapsedLauncher');
    el.desktopPanel = document.getElementById('desktopPanel');
    el.mainSurface = document.querySelector('.main-surface');
    el.generateNavBtn = document.getElementById('generateNavBtn');
    el.queueBtn = document.getElementById('queueBtn');
    el.reversePromptNavBtn = document.getElementById('reversePromptNavBtn');
    el.historyBtn = document.getElementById('historyBtn');
    el.errorLogsBtn = document.getElementById('errorLogsBtn');
    el.errorLogBadge = document.getElementById('errorLogBadge');
    el.apiSettingsBtn = document.getElementById('apiSettingsBtn');
    el.closeBtn = document.getElementById('closeBtn');
    el.tabsBar = document.querySelector('.tabs-bar');
    el.mainContentScroll = document.getElementById('mainContentScroll');
    el.generatorWorkspace = document.getElementById('generatorWorkspace');
    el.recentSection = document.getElementById('recentSection');
    el.recentImages = document.getElementById('recentImages');
    el.recentViewToggleBtn = document.getElementById('recentViewToggleBtn');
    el.recentImages.addEventListener('mouseleave', hideImageHoverPreview);
    document.getElementById('historyImages')?.addEventListener('mouseleave', hideImageHoverPreview);
    el.openRecentFolderBtn = document.getElementById('openRecentFolderBtn');
    el.historyPage = document.getElementById('historyPage');
    el.historyCount = document.getElementById('historyCount');
    el.historySearchInput = document.getElementById('historySearchInput');
    el.historySearchClearBtn = document.getElementById('historySearchClearBtn');
    el.historyImageSearchBtn = document.getElementById('historyImageSearchBtn');
    el.historyImageSearchInput = document.getElementById('historyImageSearchInput');
    el.historyDragTrash = document.getElementById('historyDragTrash');
    el.historyTrashUndoBtn = document.getElementById('historyTrashUndoBtn');
    el.historyBinBtn = document.getElementById('historyBinBtn');
    el.historyBinBadge = document.getElementById('historyBinBadge');
    el.historyBinPage = document.getElementById('historyBinPage');
    el.historyBinCount = document.getElementById('historyBinCount');
    el.historyBinImages = document.getElementById('historyBinImages');
    el.historyBinSelectionBar = document.getElementById('historyBinSelectionBar');
    el.historyBinSelectionMeta = document.getElementById('historyBinSelectionMeta');
    el.historyBinSelectAllBtn = document.getElementById('historyBinSelectAllBtn');
    el.historyBinClearSelectionBtn = document.getElementById('historyBinClearSelectionBtn');
    el.historyBinRestoreBtn = document.getElementById('historyBinRestoreBtn');
    el.historyBinDeleteBtn = document.getElementById('historyBinDeleteBtn');
    el.historyBinRestoreAllBtn = document.getElementById('historyBinRestoreAllBtn');
    el.historyBinEmptyBtn = document.getElementById('historyBinEmptyBtn');
    el.historyGridBtn = document.getElementById('historyGridBtn');
    el.historyListBtn = document.getElementById('historyListBtn');
    el.historyImages = document.getElementById('historyImages');
    el.historySelectionBar = document.getElementById('historySelectionBar');
    el.historySelectionMeta = document.getElementById('historySelectionMeta');
    el.historySelectAllBtn = document.getElementById('historySelectAllBtn');
    el.historyInvertBtn = document.getElementById('historyInvertBtn');
    el.historyClearSelectionBtn = document.getElementById('historyClearSelectionBtn');
    el.historyDetailDrawer = document.getElementById('historyDetailDrawer');
    el.historyDetailBody = document.getElementById('historyDetailBody');
    el.historyDetailCloseBtn = document.getElementById('historyDetailCloseBtn');
    el.historyDetailExpandBtn = document.getElementById('historyDetailExpandBtn');
    el.historyDetailSummary = document.getElementById('historyDetailSummary');
    el.historyDetailTrashBtn = document.getElementById('historyDetailTrashBtn');
    el.historyReferenceBtn = document.getElementById('historyReferenceBtn');
    el.historyPreviewBtn = document.getElementById('historyPreviewBtn');
    el.historySaveBtn = document.getElementById('historySaveBtn');
    el.historyReverseBtn = document.getElementById('historyReverseBtn');
    el.historyEditBtn = document.getElementById('historyEditBtn');
    el.historyPreviewOverlay = document.getElementById('historyPreviewOverlay');
    el.historyPreviewImage = document.getElementById('historyPreviewImage');
    el.historyPreviewCloseBtn = document.getElementById('historyPreviewCloseBtn');
    el.sequenceTabs = document.getElementById('sequenceTabs');
    el.addSequenceBtn = document.getElementById('addSequenceBtn');
    el.providerSelect = document.getElementById('providerSelect');
    el.modelSelect = document.getElementById('modelSelect');
    el.promptInput = document.getElementById('promptInput');
    el.mentionMenu = document.getElementById('mentionMenu');
    el.ratioField = document.getElementById('ratioField');
    el.ratioLabelWrap = document.getElementById('ratioLabelWrap');
    el.ratioLabel = document.getElementById('ratioLabel');
    el.ratioPicker = document.getElementById('ratioPicker');
    el.ratioPickerButton = document.getElementById('ratioPickerButton');
    el.ratioPickerIcon = document.getElementById('ratioPickerIcon');
    el.ratioPickerValue = document.getElementById('ratioPickerValue');
    el.ratioPickerMenu = document.getElementById('ratioPickerMenu');
    el.ratioSelect = document.getElementById('ratioSelect');
    el.ratioGrid = document.getElementById('ratioGrid');
    el.referenceRatioPicker = document.getElementById('referenceRatioPicker');
    el.referenceRatioPickerClose = document.getElementById('referenceRatioPickerClose');
    el.referenceRatioOptions = document.getElementById('referenceRatioOptions');
    el.referenceRatioEmpty = document.getElementById('referenceRatioEmpty');
    el.countSelect = document.getElementById('countSelect');
    el.imageSizeField = document.getElementById('imageSizeField');
    el.imageSizeSelect = document.getElementById('imageSizeSelect');
    el.imageSizeSliderHost = document.getElementById('imageSizeSliderHost');
    el.countSliderHost = document.getElementById('countSliderHost');
    el.outputMimeSelect = document.getElementById('outputMimeSelect');
    el.imageCompressionRange = document.getElementById('imageCompressionRange');
    el.imageCompressionValue = document.getElementById('imageCompressionValue');
    el.gptQualitySelect = document.getElementById('gptQualitySelect');
    el.gptBackgroundSelect = document.getElementById('gptBackgroundSelect');
    el.gptImageWidthInput = document.getElementById('gptImageWidthInput');
    el.gptImageHeightInput = document.getElementById('gptImageHeightInput');
    el.openAIModerationSelect = document.getElementById('openAIModerationSelect');
    el.nativeResponseFormatSelect = document.getElementById('nativeResponseFormatSelect');
    el.openAIStyleSelect = document.getElementById('openAIStyleSelect');
    el.inputFidelitySelect = document.getElementById('inputFidelitySelect');
    el.apiUserInput = document.getElementById('apiUserInput');
    el.responseModalitiesSelect = document.getElementById('responseModalitiesSelect');
    el.thinkingLevelSelect = document.getElementById('thinkingLevelSelect');
    el.includeThoughtsToggle = document.getElementById('includeThoughtsToggle');
    el.temperatureInput = document.getElementById('temperatureInput');
    el.topPInput = document.getElementById('topPInput');
    el.topKInput = document.getElementById('topKInput');
    el.googleSearchToggle = document.getElementById('googleSearchToggle');
    el.imageSearchToggle = document.getElementById('imageSearchToggle');
    el.xaiStoreToggle = document.getElementById('xaiStoreToggle');
    el.xaiFilenameInput = document.getElementById('xaiFilenameInput');
    el.xaiExpiresAfterInput = document.getElementById('xaiExpiresAfterInput');
    el.xaiPublicUrlToggle = document.getElementById('xaiPublicUrlToggle');
    el.referenceRail = document.getElementById('referenceRail');
    el.referenceStack = document.getElementById('referenceStack');
    el.referenceFileInput = document.getElementById('referenceFileInput');
    el.promptDropOverlay = document.getElementById('promptDropOverlay');
    el.generateBtn = document.getElementById('generateBtn');
    el.optimizePromptBtn = document.getElementById('optimizePromptBtn');
    el.optimizePromptIcon = document.getElementById('optimizePromptIcon');
    el.optimizePromptLabel = document.getElementById('optimizePromptLabel');
    el.stopBtn = document.getElementById('stopBtn');
    el.clearPromptBtn = document.getElementById('clearPromptBtn');
    el.batchProgressText = document.getElementById('batchProgressText');
    el.batchProgressCount = document.getElementById('batchProgressCount');
    el.batchProgressBar = document.getElementById('batchProgressBar');
    el.taskStatus = document.getElementById('taskStatus');
    el.openOutputFolderBtn = document.getElementById('openOutputFolderBtn');
    el.imageHoverPreview = document.getElementById('imageHoverPreview');
    el.imageHoverPreviewImg = document.getElementById('imageHoverPreviewImg');
    el.imageHoverPreviewDimensions = document.getElementById('imageHoverPreviewDimensions');
    el.imageHoverPreviewModel = document.getElementById('imageHoverPreviewModel');
    el.imageHoverPreviewProvider = document.getElementById('imageHoverPreviewProvider');
    el.imageContextMenu = document.getElementById('imageContextMenu');
    el.queuePage = document.getElementById('queuePage');
    el.queueList = document.getElementById('queueList');
    el.queueMeta = document.getElementById('queueMeta');
    el.queueRunningCount = document.getElementById('queueRunningCount');
    el.queuePendingCount = document.getElementById('queuePendingCount');
    el.refreshQueueBtn = document.getElementById('refreshQueueBtn');
    el.cancelAllTasksBtn = document.getElementById('cancelAllTasksBtn');
    el.reversePromptPage = document.getElementById('reversePromptPage');
    el.workspacePage = document.getElementById('workspacePage');
    el.workspaceRoot = document.getElementById('workspaceRoot');
    el.workspaceNavBtn = document.getElementById('workspaceNavBtn');
    el.reversePromptSettingsBtn = document.getElementById('reversePromptSettingsBtn');
    el.reversePromptDrop = document.getElementById('reversePromptDrop');
    el.reversePromptFileInput = document.getElementById('reversePromptFileInput');
    el.reversePromptEmpty = document.getElementById('reversePromptEmpty');
    el.reversePromptPreview = document.getElementById('reversePromptPreview');
    el.reversePromptPreviewImage = document.getElementById('reversePromptPreviewImage');
    el.reversePromptImageName = document.getElementById('reversePromptImageName');
    el.reversePromptImageMeta = document.getElementById('reversePromptImageMeta');
    el.reversePromptClearImageBtn = document.getElementById('reversePromptClearImageBtn');
    el.reversePromptInstructionInput = document.getElementById('reversePromptInstructionInput');
    el.reversePromptProviderSelect = document.getElementById('reversePromptProviderSelect');
    el.reversePromptModelSelect = document.getElementById('reversePromptModelSelect');
    el.reversePromptProviderMeta = document.getElementById('reversePromptProviderMeta');
    el.reversePromptStatus = document.getElementById('reversePromptStatus');
    el.reversePromptResultInput = document.getElementById('reversePromptResultInput');
    el.reversePromptResultInput.value = localStorage.getItem('picgen_last_reverse_prompt') || '';
    el.reversePromptRunBtn = document.getElementById('reversePromptRunBtn');
    el.reversePromptCopyBtn = document.getElementById('reversePromptCopyBtn');
    el.reversePromptCreateSequenceBtn = document.getElementById('reversePromptCreateSequenceBtn');
    el.errorLogsPage = document.getElementById('errorLogsPage');
    el.errorLogsMeta = document.getElementById('errorLogsMeta');
    el.refreshErrorLogsBtn = document.getElementById('refreshErrorLogsBtn');
    el.clearErrorLogsBtn = document.getElementById('clearErrorLogsBtn');
    el.errorLogsSearchInput = document.getElementById('errorLogsSearchInput');
    el.errorLogsSearchClearBtn = document.getElementById('errorLogsSearchClearBtn');
    el.errorLogsSourceFilter = document.getElementById('errorLogsSourceFilter');
    el.errorLogsTimeFilter = document.getElementById('errorLogsTimeFilter');
    el.errorLogsDayCount = document.getElementById('errorLogsDayCount');
    el.errorLogsTotalCount = document.getElementById('errorLogsTotalCount');
    el.errorLogsRepeatCount = document.getElementById('errorLogsRepeatCount');
    el.errorLogsList = document.getElementById('errorLogsList');
    el.settingsOverlay = document.getElementById('settingsOverlay');
    el.settingsCloseBtn = document.getElementById('settingsCloseBtn');
    el.imageSettingsTab = document.getElementById('imageSettingsTab');
    el.concurrencySettingsTab = document.getElementById('concurrencySettingsTab');
    el.chatSettingsTab = document.getElementById('chatSettingsTab');
    el.networkSettingsTab = document.getElementById('networkSettingsTab');
    el.outputSettingsTab = document.getElementById('outputSettingsTab');
    el.imageSettingsPanel = document.getElementById('imageSettingsPanel');
    el.concurrencySettingsPanel = document.getElementById('concurrencySettingsPanel');
    el.chatSettingsPanel = document.getElementById('chatSettingsPanel');
    el.networkSettingsPanel = document.getElementById('networkSettingsPanel');
    el.outputSettingsPanel = document.getElementById('outputSettingsPanel');
    el.outputDirectoryInput = document.getElementById('outputDirectoryInput');
    el.outputDirectoryMode = document.getElementById('outputDirectoryMode');
    el.chooseOutputDirectoryBtn = document.getElementById('chooseOutputDirectoryBtn');
    el.resetOutputDirectoryBtn = document.getElementById('resetOutputDirectoryBtn');
    el.openConfiguredOutputDirectoryBtn = document.getElementById('openConfiguredOutputDirectoryBtn');
    el.proxyModeSelect = document.getElementById('proxyModeSelect');
    el.proxyCustomField = document.getElementById('proxyCustomField');
    el.proxyCustomInput = document.getElementById('proxyCustomInput');
    el.proxyActiveHint = document.getElementById('proxyActiveHint');
    el.testProxyBtn = document.getElementById('testProxyBtn');
    el.saveProxyBtn = document.getElementById('saveProxyBtn');
    el.failoverEnabledToggle = document.getElementById('failoverEnabledToggle');
    el.failoverMaxAttemptsInput = document.getElementById('failoverMaxAttemptsInput');
    el.maxGlobalConcurrentInput = document.getElementById('maxGlobalConcurrentInput');
    el.failoverThresholdInput = document.getElementById('failoverThresholdInput');
    el.saveFailoverBtn = document.getElementById('saveFailoverBtn');
    el.fixedProviderField = document.getElementById('fixedProviderField');
    el.fixedProviderSelect = document.getElementById('fixedProviderSelect');
    el.strategyProviderSelect = document.getElementById('strategyProviderSelect');
    el.settingsPresetSelect = document.getElementById('settingsPresetSelect');
    el.settingsProviderList = document.getElementById('settingsProviderList');
    el.unifiedSupplierWorkspace = document.getElementById('unifiedSupplierWorkspace');
    // The supplier workspace below this host is a React sub-root
    // (SupplierManager); its controls are not part of the cached contract.
    el.unifiedSupplierList = document.getElementById('unifiedSupplierList');
    el.settingsToc = document.getElementById('settingsToc');
    el.promptOptimizeEnabledToggle = document.getElementById('promptOptimizeEnabledToggle');
    el.promptOptimizeProviderSelect = document.getElementById('promptOptimizeProviderSelect');
    el.promptOptimizeSystemInput = document.getElementById('promptOptimizeSystemInput');
    el.promptOptimizeResetBtn = document.getElementById('promptOptimizeResetBtn');
    el.promptOptimizeSaveBtn = document.getElementById('promptOptimizeSaveBtn');
    el.providerStrategySelect = document.getElementById('providerStrategySelect');
    el.settingsProviderMeta = document.getElementById('settingsProviderMeta');
    el.settingsFormTitle = document.getElementById('settingsFormTitle');
    el.newProviderBtn = document.getElementById('newProviderBtn');
    el.deleteProviderBtn = document.getElementById('deleteProviderBtn');
    el.presetNameInput = document.getElementById('presetNameInput');
    el.baseUrlInput = document.getElementById('baseUrlInput');
    el.apiKeyInput = document.getElementById('apiKeyInput');
    el.providerEnabledToggle = document.getElementById('providerEnabledToggle');
    el.providerConcurrencyInput = document.getElementById('providerConcurrencyInput');
    el.providerPriorityInput = document.getElementById('providerPriorityInput');
    el.discoveredModelPicker = document.getElementById('discoveredModelPicker');
    el.discoveredModelSelect = document.getElementById('discoveredModelSelect');
    el.modelRows = document.getElementById('modelRows');
    el.addModelRowBtn = document.getElementById('addModelRowBtn');
    el.chatModelRows = document.getElementById('chatModelRows');
    el.addChatModelRowBtn = document.getElementById('addChatModelRowBtn');
    el.promptOptimizerSystemInput = document.getElementById('promptOptimizerSystemInput');
    el.testProviderBtn = document.getElementById('testProviderBtn');
    el.discoverProviderBtn = document.getElementById('discoverProviderBtn');
    el.savePresetBtn = document.getElementById('savePresetBtn');
    el.chatSettingsPresetSelect = document.getElementById('chatSettingsPresetSelect');
    el.chatProviderList = document.getElementById('chatProviderList');
    el.newChatProviderBtn = document.getElementById('newChatProviderBtn');
    el.chatSettingsFormTitle = document.getElementById('chatSettingsFormTitle');
    el.deleteChatProviderBtn = document.getElementById('deleteChatProviderBtn');
    el.chatProviderNameInput = document.getElementById('chatProviderNameInput');
    el.chatProviderBaseUrlInput = document.getElementById('chatProviderBaseUrlInput');
    el.chatProviderApiKeyInput = document.getElementById('chatProviderApiKeyInput');
    el.testChatProviderBtn = document.getElementById('testChatProviderBtn');
    el.saveChatProviderBtn = document.getElementById('saveChatProviderBtn');
    el.toast = document.getElementById('toast');
}

function bindWindowEvents() {
    const dragState = {
        active: false,
        moved: false,
        pointerId: null,
        startX: 0,
        startY: 0
    };

    const finishMove = () => {
        if (!dragState.active) return false;
        const shouldExpand = !dragState.moved;
        dragState.active = false;
        dragState.pointerId = null;
        window.picgenDesktop.endWindowMove();
        el.body.classList.remove('window-moving');
        return shouldExpand;
    };

    el.collapsedLauncher.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;

        dragState.active = true;
        dragState.moved = false;
        dragState.pointerId = event.pointerId;
        dragState.startX = event.screenX;
        dragState.startY = event.screenY;
        el.body.classList.add('window-moving');
        el.collapsedLauncher.setPointerCapture(event.pointerId);
        window.picgenDesktop.startWindowMove(screenPoint(event));
    });

    el.collapsedLauncher.addEventListener('pointermove', (event) => {
        if (!dragState.active || event.pointerId !== dragState.pointerId) return;

        const distance = Math.hypot(event.screenX - dragState.startX, event.screenY - dragState.startY);
        if (distance > 4) dragState.moved = true;
        if (dragState.moved) window.picgenDesktop.moveWindow(screenPoint(event));
    });

    el.collapsedLauncher.addEventListener('pointerup', (event) => {
        if (!dragState.active || event.pointerId !== dragState.pointerId) return;

        if (el.collapsedLauncher.hasPointerCapture(event.pointerId)) {
            el.collapsedLauncher.releasePointerCapture(event.pointerId);
        }

        if (finishMove()) window.picgenDesktop.setExpanded(true);
    });

    el.collapsedLauncher.addEventListener('pointercancel', (event) => {
        if (!dragState.active || event.pointerId !== dragState.pointerId) return;
        if (el.collapsedLauncher.hasPointerCapture(event.pointerId)) {
            el.collapsedLauncher.releasePointerCapture(event.pointerId);
        }
        finishMove();
    });

    el.collapsedLauncher.addEventListener('contextmenu', showContextMenu);
    el.desktopPanel.addEventListener('contextmenu', showContextMenu);
    el.closeBtn.addEventListener('click', () => window.picgenDesktop.close());
    document.addEventListener('pointerdown', (event) => {
        if (!event.target.closest('#imageContextMenu')) hideImageContextMenu();
        if (!event.target.closest('.prompt-shell')) hideMentionMenu();
    });
    window.addEventListener('blur', hideImageContextMenu);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && el.imageContextMenu && !el.imageContextMenu.hidden) hideImageContextMenu();
    });
    // 统一图片右键菜单：发送到图片工作台默认进标注模式（比例 / 蒙版在工作台顶部切换）
    el.workspaceImageBtn?.addEventListener('click', () => openWorkspaceFromContextImage('annotate'));
    el.copyImageBtn?.addEventListener('click', copyContextImage);
    el.copyPromptImageBtn?.addEventListener('click', copyPromptFromContextImage);
    el.saveImageAsBtn?.addEventListener('click', saveContextImageAs);
    el.workspaceNavBtn?.addEventListener('click', showWorkspaceView);
    el.sendReferenceActiveBtn.addEventListener('click', () => sendContextImageToReference(false));
    el.sendReferenceNewBtn.addEventListener('click', () => sendContextImageToReference(true));
    el.findSimilarImageBtn?.addEventListener('click', findSimilarFromContext);
    el.setCoverImageBtn?.addEventListener('click', () => applySimilarOverrideFromContext('setCover'));
    el.detachImageBtn?.addEventListener('click', () => applySimilarOverrideFromContext('detach'));
    el.historyPreviewImage.addEventListener('contextmenu', event => { const image = getActiveHistoryImage(); if (image) showImageContextMenu(image, event); });
    // The full preview goes through the same native drag as the gallery, so a drag-out is counted.
    el.historyPreviewImage.draggable = true;
    el.historyPreviewImage.addEventListener('dragstart', event => {
        const image = getActiveHistoryImage();
        event.preventDefault();
        if (!image?.filePath) return;
        rememberDraggedRecentImage(image);
        beginRecentImageDrag(image);
    });
    el.historyPreviewImage.addEventListener('dragend', clearDraggedRecentImage);

    let dockPoll = null;
    let dockPointerDown = false;
    let lastDockBusy = false;
    let dockPinned = true; // 默认置顶，与主进程 mainWindowPinned 默认值一致
    const updateDockBusy = () => {
        const active = document.activeElement;
        const editing = document.hasFocus() && active?.matches('input, textarea, [contenteditable="true"]');
        const overlay = document.querySelector('[role="dialog"], [data-slot="select-trigger"][aria-expanded="true"], #maskOverlay:not([hidden]), #historyPreviewOverlay:not([hidden]), #imageContextMenu:not([hidden])');
        const busy = !!(dockPointerDown || editing || overlay);
        if (busy !== lastDockBusy) { lastDockBusy = busy; window.picgenDesktop.setDockInteraction?.(busy); }
    };
    document.addEventListener('pointerdown', () => { dockPointerDown = true; updateDockBusy(); }, true);
    document.addEventListener('pointerup', () => { dockPointerDown = false; updateDockBusy(); }, true);
    document.addEventListener('pointercancel', () => { dockPointerDown = false; updateDockBusy(); }, true);
    window.addEventListener('blur', () => { dockPointerDown = false; updateDockBusy(); });
    bindHoverPreviewToggle();
    // 悬停大图预览：按下图片（准备拖拽）即收起；拖拽结束后等一次真实移动再允许预览。
    document.addEventListener('pointerdown', handleImagePointerDown, true);
    document.addEventListener('pointerup', handleImagePointerRelease, true);
    document.addEventListener('pointercancel', handleImagePointerRelease, true);
    window.addEventListener('blur', handleImagePointerRelease);
    document.addEventListener('mousemove', handleHoverPreviewRealMove, true);
    document.addEventListener('dragenter', handleForeignDragEnter, true);
    const pinButton = document.getElementById('pinWindowBtn');
    pinButton?.addEventListener('click', () => window.picgenDesktop.pinWindow?.(!dockPinned));
    const applyWindowState = windowState => {
        const collapsed = !windowState.expanded;
        el.body.classList.toggle('collapsed', collapsed);
        if (collapsed) window.PicGenAppica?.dismissToasts?.();
        else window.PicGenAppica?.clearLauncherNotificationBadge?.();
        window.PicGenAppica?.updateLauncherNotificationBadge?.();
        el.body.classList.toggle('edge-hidden', !!windowState.dock?.hidden);
        el.body.dataset.dockEdge = windowState.dock?.edge || '';
        dockPinned = !!windowState.dock?.pinned;
        if (pinButton) {
            pinButton.setAttribute('aria-pressed', String(dockPinned));
            pinButton.title = dockPinned
                ? '取消置顶（窗口可被其他窗口覆盖，贴边时自动收起）'
                : '置顶窗口（保持在最前，暂停贴边自动收起）';
            pinButton.innerHTML = dockPinned ? '<i data-lucide="pin"></i>' : '<i data-lucide="pin-off"></i>';
            refreshLucideIcons(pinButton);
        }
        el.collapsedLauncher.title = windowState.dock?.hidden ? '悬停展开 PicGen；拖离屏幕边缘可取消吸附' : '展开 PicGen；拖到屏幕边缘可自动收起';
        clearInterval(dockPoll);
        dockPoll = windowState.dock?.edge ? setInterval(updateDockBusy, 200) : null;
        if (windowState.dock?.hidden) hideImageHoverPreview();
        updateDockBusy();
    };
    window.picgenDesktop.onWindowState(applyWindowState);
    window.picgenDesktop.getWindowState().then(applyWindowState);

    // 参考图卡的原生拖拽结束（主进程在 startDrag 返回后回传光标落点）。
    // 拖回发起窗口自身时 Chromium 不给拖拽源派发 drop 事件，所以"拖到垃圾桶删除"
    // 用落点矩形命中检测实现（±10px 容差）；未命中则仅清理拖拽状态。
    // 主页/历史拖出的图片同理：松手落点在参考图有效区内 → 直接加为参考图
    // （原生拖拽不会给拖拽源派发 drop，落到别处则什么都不做）。
    window.picgenDesktop.onImageDragEnded?.(point => {
        // 原生拖拽结束时 Chromium 会在拖拽起点补发一次悬停（mouseenter），而真实光标可能已在窗外
        // 或停在别处 → 大图预览会弹出并挂住。拖拽结束先收起预览，并在真实移动之前忽略这类补发的悬停。
        endImageDragPreviewGuard();
        const drag = state.draggedReferenceCard;
        if (!drag) {
            const recent = state.draggedRecentImage;
            if (!recent) return;
            const batch = state.draggedRecentBatch || [recent];
            // 垃圾篓收起前先量落点（隐藏后矩形为 0）。
            const toTrash = historyDragTrashHitFromPoint(point);
            const zone = toTrash ? null : promptDropZoneFromPoint(point);
            clearDraggedRecentImage(); // 同时收起拖拽期间点亮的分区提示
            if (toTrash) void dropHistoryImageToTrash(recent, batch);
            // 只认参考图带。落在文本区不读提示词：主进程在 Esc 取消、或松手落在盖住本窗的
            // 其它程序上时也会回传落点，分不出「真放下」，照读会悄悄覆盖用户的提示词。
            else if (zone === 'reference') addHistoryImageAsReference(batch);
            return;
        }
        const trash = document.querySelector('.reference-trash');
        if (trash && point) {
            const rect = trash.getBoundingClientRect();
            const x = point.x - window.screenX;
            const y = point.y - window.screenY;
            const pad = 10;
            if (x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad) {
                dropReferenceCardToTrash();
                return;
            }
        }
        endReferenceCardDrag();
    });

    window.picgenDesktop.onErrorLog?.(handleIncomingErrorLog);
    window.addEventListener('error', (event) => {
        if (event.target !== window) return;
        reportRendererError({
            title: '界面脚本错误',
            message: event.message || event.error?.message || '未知脚本错误',
            stack: event.error?.stack || '',
            operation: 'window-error',
            details: {
                fileName: event.filename || '',
                line: event.lineno || 0,
                column: event.colno || 0
            }
        });
    });
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        reportRendererError({
            title: '未处理的界面异常',
            message: reason?.message || String(reason || '未知 Promise 异常'),
            stack: reason?.stack || '',
            operation: 'unhandled-rejection'
        });
    });
}

function screenPoint(event) {
    return {
        x: event.screenX,
        y: event.screenY
    };
}

function showContextMenu(event) {
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    // 图片菜单本身上右键：不再叠一个原生菜单
    if (event.target.closest('#imageContextMenu')) return;
    window.picgenDesktop.showContextMenu();
}

function bindFormEvents() {
    bindRatioPickerEvents();
    el.generateNavBtn.addEventListener('click', () => {
        showGenerationView();
    });
    el.historyBtn.addEventListener('click', () => {
        showHistoryView();
    });
    el.queueBtn.addEventListener('click', openQueue);
    el.refreshQueueBtn.addEventListener('click', refreshQueue);
    el.cancelAllTasksBtn.addEventListener('click', cancelAllQueuedTasks);
    el.reversePromptNavBtn.addEventListener('click', openReversePrompt);
    // 序列标签栏隐藏了滚动条（它会压住标签下沿），竖向滚轮转为横向滚动以翻到被挡住的序列。
    el.sequenceTabs.addEventListener('wheel', (event) => {
        const tabs = el.sequenceTabs;
        if (tabs.scrollWidth <= tabs.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
        event.preventDefault();
        tabs.scrollLeft += event.deltaY;
    }, { passive: false });
    el.reversePromptDrop.addEventListener('click', () => el.reversePromptFileInput.click());
    el.reversePromptDrop.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        el.reversePromptFileInput.click();
    });
    el.reversePromptDrop.addEventListener('dragenter', (event) => {
        if (!hasDraggedImage(event.dataTransfer)) return;
        event.preventDefault();
        el.reversePromptDrop.classList.add('drag-active');
    });
    el.reversePromptDrop.addEventListener('dragover', (event) => {
        if (!hasDraggedImage(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        el.reversePromptDrop.classList.add('drag-active');
    });
    el.reversePromptDrop.addEventListener('dragleave', (event) => {
        if (!el.reversePromptDrop.contains(event.relatedTarget)) {
            el.reversePromptDrop.classList.remove('drag-active');
        }
    });
    el.reversePromptDrop.addEventListener('drop', async (event) => {
        event.preventDefault();
        el.reversePromptDrop.classList.remove('drag-active');
        const file = Array.from(event.dataTransfer?.files || []).find(item => item.type.startsWith('image/'));
        if (file) await setReversePromptImage(file);
    });
    el.reversePromptFileInput.addEventListener('change', async () => {
        const [file] = Array.from(el.reversePromptFileInput.files || []);
        if (file) await setReversePromptImage(file);
        el.reversePromptFileInput.value = '';
    });
    // Ctrl+V 粘贴图片：分析要求输入框、上传区或页面任意处都接收；纯文本照常粘贴。
    document.getElementById('reversePromptPage')?.addEventListener('paste', handleReversePromptPaste);
    el.reversePromptClearImageBtn.addEventListener('click', clearReversePromptImage);
    // 待分析图片右键：同一个图片菜单（只有像素，没有历史记录可查相似）
    el.reversePromptPreviewImage?.addEventListener('contextmenu', event => {
        const image = state.reversePromptImage;
        if (image) showImageContextMenu({ kind: 'data', name: image.name || '图片.png', base64: image.base64, mimeType: image.mimeType }, event);
    });
    el.reversePromptProviderSelect.addEventListener('change', () => {
        setActiveChatProvider(el.reversePromptProviderSelect.value);
        renderReversePromptModels();
        updateReversePromptProviderState();
    });
    el.reversePromptModelSelect.addEventListener('change', () => {
        const provider = getChatPresetById(state.currentChatPresetId);
        if (provider) {
            const model = el.reversePromptModelSelect.value || '';
            provider.activeModel = model;
            provider.model = model;
            localStorage.setItem(DESKTOP_ACTIVE_CHAT_MODEL_KEY, model);
        }
        updateReversePromptProviderState();
    });
    el.reversePromptRunBtn.addEventListener('click', runReversePrompt);
    el.reversePromptCopyBtn.addEventListener('click', copyReversePromptResult);
    el.reversePromptCreateSequenceBtn.addEventListener('click', createSequenceFromReversePrompt);
    el.reversePromptResultInput.addEventListener('input', updateReversePromptActionState);
    el.errorLogsBtn.addEventListener('click', openErrorLogs);
    el.historyBinBtn?.addEventListener('click', () => { void showHistoryBinView(); });
    el.historyBinSelectAllBtn?.addEventListener('click', selectAllHistoryBinItems);
    el.historyBinClearSelectionBtn?.addEventListener('click', clearHistoryBinSelection);
    el.historyBinRestoreBtn?.addEventListener('click', () => { void restoreHistoryBin([...state.historyBin.selected]); });
    el.historyBinDeleteBtn?.addEventListener('click', () => { void purgeHistoryBin([...state.historyBin.selected]); });
    el.historyBinRestoreAllBtn?.addEventListener('click', () => { void restoreHistoryBin(null); });
    el.historyBinEmptyBtn?.addEventListener('click', () => { void purgeHistoryBin(null); });
    el.refreshErrorLogsBtn.addEventListener('click', () => refreshErrorLogs());
    el.clearErrorLogsBtn.addEventListener('click', clearErrorLogs);
    el.errorLogsSearchInput.addEventListener('input', () => {
        el.errorLogsSearchClearBtn.hidden = !el.errorLogsSearchInput.value;
        renderErrorLogs();
    });
    el.errorLogsSearchClearBtn.addEventListener('click', () => {
        el.errorLogsSearchInput.value = '';
        el.errorLogsSearchClearBtn.hidden = true;
        renderErrorLogs();
        el.errorLogsSearchInput.focus();
    });
    el.errorLogsSourceFilter.addEventListener('change', renderErrorLogs);
    el.errorLogsTimeFilter.addEventListener('change', renderErrorLogs);

    el.apiSettingsBtn.addEventListener('click', () => openSettings());
    // The in-sheet header (title + close/new buttons) was removed; the sidebar
    // now owns navigation. Guard the optional controls that used to live there.
    el.settingsCloseBtn?.addEventListener('click', closeSettings);
    el.imageSettingsTab.addEventListener('click', () => setSettingsMode('image'));
    el.concurrencySettingsTab.addEventListener('click', () => setSettingsMode('concurrency'));
    el.chatSettingsTab?.addEventListener('click', () => setSettingsMode('optimize'));
    el.promptOptimizeEnabledToggle?.addEventListener('change', () => {
        state.promptOptimizeEnabled = el.promptOptimizeEnabledToggle.checked;
        try { localStorage.setItem('picgen.promptOptimizeEnabled', state.promptOptimizeEnabled ? '1' : '0'); } catch { /* storage */ }
        updateOptimizeButtonVisibility();
    });
    el.promptOptimizeProviderSelect?.addEventListener('change', () => {
        if (el.promptOptimizeProviderSelect.value) setActiveChatProvider(el.promptOptimizeProviderSelect.value);
    });
    el.promptOptimizeResetBtn?.addEventListener('click', () => {
        if (el.promptOptimizeSystemInput) el.promptOptimizeSystemInput.value = DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT;
    });
    el.promptOptimizeSaveBtn?.addEventListener('click', savePromptOptimizeSettings);
    el.networkSettingsTab.addEventListener('click', () => setSettingsMode('network'));
    el.outputSettingsTab.addEventListener('click', () => setSettingsMode('output'));
    for (const input of document.querySelectorAll('[name="providerStrategy"]')) {
        input.addEventListener('change', () => {
            el.providerStrategySelect.value = input.value;
            syncStrategyUi();
            saveFailoverSettings();
        });
    }
    for (const input of document.querySelectorAll('[name="proxyMode"]')) {
        input.addEventListener('change', () => {
            el.proxyModeSelect.value = input.value;
            syncProxyCustomVisibility();
            saveProxySettings();
        });
    }
    el.proxyCustomInput?.addEventListener('change', saveProxySettings);
    el.strategyProviderSelect.addEventListener('change', () => {
        state.strategyProviderId = el.strategyProviderSelect.value || null;
        fillProviderCapacityForm();
    });
    el.fixedProviderSelect.addEventListener('change', () => {
        if (normalizeRoutingStrategy(el.providerStrategySelect.value) === 'fixed') saveFailoverSettings();
    });
    for (const input of [el.failoverEnabledToggle, el.failoverMaxAttemptsInput, el.maxGlobalConcurrentInput,
        el.failoverThresholdInput, el.providerConcurrencyInput, el.providerPriorityInput]) {
        input?.addEventListener('change', () => saveFailoverSettings());
    }
    el.saveProxyBtn?.addEventListener('click', saveProxySettings);
    el.testProxyBtn.addEventListener('click', testProxyConnection);
    el.chooseOutputDirectoryBtn.addEventListener('click', chooseOutputDirectory);
    el.resetOutputDirectoryBtn.addEventListener('click', resetOutputDirectory);
    el.openConfiguredOutputDirectoryBtn.addEventListener('click', openOutputFolder);
    el.saveFailoverBtn?.addEventListener('click', saveFailoverSettings);

    el.settingsPresetSelect.addEventListener('change', () => {
        state.currentPresetId = el.settingsPresetSelect.value || null;
        fillSettingsForm();
    });
    el.chatSettingsPresetSelect.addEventListener('change', () => {
        state.currentChatPresetId = el.chatSettingsPresetSelect.value || null;
        fillChatSettingsForm();
    });

    el.newProviderBtn?.addEventListener('click', () => {
        if (state.settingsMode !== 'image') return;
        window.dispatchEvent(new CustomEvent('picgen:open-new-supplier'));
    });
    el.newChatProviderBtn.addEventListener('click', startNewChatProvider);
    el.deleteProviderBtn.addEventListener('click', deleteCurrentProvider);
    el.testProviderBtn.addEventListener('click', testCurrentProvider);
    el.discoverProviderBtn.addEventListener('click', discoverCurrentProvider);
    el.savePresetBtn.addEventListener('click', saveCurrentPresetFromForm);
    el.discoveredModelSelect.addEventListener('change', addSelectedDiscoveredModel);
    el.deleteChatProviderBtn.addEventListener('click', deleteCurrentChatProvider);
    el.testChatProviderBtn.addEventListener('click', testCurrentChatProvider);
    el.saveChatProviderBtn.addEventListener('click', saveCurrentChatProviderFromForm);
    el.addModelRowBtn.addEventListener('click', () => {
        addModelRow('', '');
        const rows = el.modelRows.querySelectorAll('.model-row');
        rows[rows.length - 1]?.querySelector('[data-model-name]')?.focus();
    });
    el.addChatModelRowBtn.addEventListener('click', () => {
        addChatModelRow('', el.chatModelRows.children.length === 0);
        const rows = el.chatModelRows.querySelectorAll('.chat-model-row');
        rows[rows.length - 1]?.querySelector('[data-chat-model-name]')?.focus();
    });
    el.addSequenceBtn.addEventListener('click', addSequence);
    el.providerSelect.addEventListener('change', changeGenerationProvider);
    el.modelSelect.addEventListener('change', () => {
        saveCurrentSequenceFromForm();
        updateDimensionOptions();
        saveCurrentSequenceFromForm();
        updateAdvancedSettingsVisibility();
    });
    // change 只由真人操作触发（脚本赋值 select.value 不会派发），所以在这里清掉回落标记：
    // 用户亲手选的值必须能存下去。
    el.ratioSelect.addEventListener('change', () => {
        delete el.ratioSelect.dataset.fallback;
        if (el.ratioSelect.value === 'reference') {
            // This is an action entry, not a persisted API ratio. Keep the
            // previous concrete value until the user picks a reference image.
            el.ratioSelect.dataset.fallback = '1';
            openReferenceRatioPicker();
            // 按钮与置顶窗一致显示「参考图」；选定/取消后由 change 链写回具体比例。
            updatePrefsTriggerValues();
            return;
        }
        updateRatioPickerSelection();
        updateRatioLabelHint();
        saveCurrentSequenceFromForm();
        updateAdvancedSettingsVisibility();
    });
    el.countSelect.addEventListener('change', () => {
        delete el.countSelect.dataset.fallback;
        saveCurrentSequenceFromForm();
    });
    el.imageSizeSelect.addEventListener('change', () => {
        delete el.imageSizeSelect.dataset.fallback;
        const profile = imageApiProfiles.getImageApiProfile(el.modelSelect.value);
        if (profile.controls.customSize && el.imageSizeSelect.value === 'custom') {
            document.querySelector('.advanced-settings').open = true;
        }
        saveCurrentSequenceFromForm();
        updateAdvancedSettingsVisibility();
    });
    bindAdvancedSettingEvents();
    el.promptInput.addEventListener('input', debounce(() => {
        saveCurrentSequenceFromForm();
        renderSequenceTabs();
    }, 250));
    el.promptInput.addEventListener('input', handlePromptUndoInput);
    el.promptInput.addEventListener('input', updateMentionMenu);
    el.promptInput.addEventListener('click', handlePromptClick);
    el.promptInput.addEventListener('keydown', handlePromptKeydown);
    el.promptInput.addEventListener('paste', handlePromptPaste);
    el.promptInput.addEventListener('copy', handlePromptCopy);
    el.promptInput.addEventListener('cut', handlePromptCopy);
    el.promptInput.addEventListener('dragover', handlePromptDragOver);
    el.promptInput.addEventListener('drop', handlePromptDrop);
    // 参考图堆叠（含上传按钮）是 #promptInput 的兄弟节点、且浮在它上面（.reference-corner,
    // z-index 6）：拖到按钮上时事件落在按钮自身，没人 preventDefault，光标就换成禁止符号，
    // 松手能不能加上参考图全靠穿透碰运气。把整列也接进同一套拖拽契约，落在它上面一律按
    // 「参考图有效区」处理 —— 与 promptDropZoneFromEvent 的判据一致（按钮在上传带内）。
    el.referenceRail.addEventListener('dragenter', handleReferenceRailDragOver);
    el.referenceRail.addEventListener('dragover', handleReferenceRailDragOver);
    // 文本区与照片堆是兄弟节点：在两者之间移动只算换区，离开整行才收起提示层（否则一路闪烁）。
    const leavePromptDropRow = (event) => {
        if (!el.promptInput.parentElement?.contains(event.relatedTarget)) clearPromptDropSplit();
    };
    el.referenceRail.addEventListener('dragleave', leavePromptDropRow);
    el.referenceRail.addEventListener('drop', (event) => {
        // 直接落在上传块上时未必先来过 dragover，这里显式钉死分区再走同一条落盘链路。
        state.promptDropZone = 'reference';
        handlePromptDrop(event);
    });

    el.generateBtn.addEventListener('click', generateImages);
    el.optimizePromptBtn.addEventListener('click', optimizeCurrentPrompt);
    el.stopBtn.addEventListener('click', stopCurrentSequence);
    el.clearPromptBtn.addEventListener('click', () => {
        const sequence = getCurrentSequence();
        const previousReferences = sequence.references;
        state.pendingMaskEdits.delete(sequence.id);
        renderPendingMaskEdit();
        setPromptEditorValue('');
        sequence.references = [];
        renderReferences();
        saveCurrentSequenceFromForm();
        renderSequenceTabs();
        deleteReferenceImagesCache(previousReferences);
    });

    // 文件拖入统一走提示词上下分区（上=读提示词，底部带=加参考图，见 promptDropBandTop），
    // 上传入口在参考图堆叠的空位卡菜单里（React ReferenceStack → onUpload/onPaste）。
    el.promptInput.addEventListener('dragleave', leavePromptDropRow);
    window.addEventListener('blur', clearPromptDropSplit);
    document.addEventListener('dragend', clearPromptDropSplit);
    document.addEventListener('drop', clearPromptDropSplit);
    document.addEventListener('paste', handleGlobalReferencePaste);
    // 参考图卡原生拖拽期间的兜底：落在垃圾桶以外的位置一律吞掉（防 Chromium 对
    // 落下的文件执行默认导航），并顺手清理拖拽状态（垃圾桶落区自身 stopPropagation）。
    document.addEventListener('dragover', event => { if (state.draggedReferenceCard) event.preventDefault(); });
    document.addEventListener('drop', event => {
        if (!state.draggedReferenceCard) return;
        event.preventDefault();
        endReferenceCardDrag();
    });
    el.referenceFileInput.addEventListener('change', async () => {
        await addImageFilesFromList(el.referenceFileInput.files);
        el.referenceFileInput.value = '';
    });
    bindReferenceRatioPickerEvents();
    bindGenerationPrefsEvents();
    el.ratioSelect?.addEventListener('change', updateRatioGridSelection);
    el.imageSizeSelect?.addEventListener('change', renderGenerationSliders);
    el.imageSizeSelect?.addEventListener('change', syncRatioForCustomSize);
    el.countSelect?.addEventListener('change', renderGenerationSliders);
    el.gptImageWidthInput?.addEventListener('change', () => roundImageSizeInputTo16(el.gptImageWidthInput));
    el.gptImageHeightInput?.addEventListener('change', () => roundImageSizeInputTo16(el.gptImageHeightInput));
    el.openOutputFolderBtn.addEventListener('click', openOutputFolder);
    el.openRecentFolderBtn.addEventListener('click', openOutputFolder);
    el.recentViewToggleBtn?.addEventListener('click', toggleRecentViewMode);
    el.historySearchInput.addEventListener('input', debounce(() => {
        el.historySearchClearBtn.hidden = !el.historySearchInput.value;
        applyHistoryFilters();
    }, 120));
    el.historySearchClearBtn.addEventListener('click', () => {
        el.historySearchInput.value = '';
        el.historySearchClearBtn.hidden = true;
        applyHistoryFilters();
        el.historySearchInput.focus();
    });
    bindHistoryImageSearch();
    el.historyTrashUndoBtn?.addEventListener('click', () => { void undoHistoryTrash(); });
    el.historyImages.addEventListener('scroll', () => {
        const remaining = el.historyImages.scrollHeight - el.historyImages.scrollTop - el.historyImages.clientHeight;
        if (remaining < 600) appendHistoryImages();
    }, { passive: true });
    el.historyGridBtn.addEventListener('click', () => setHistoryLayout('grid'));
    el.historyListBtn.addEventListener('click', () => setHistoryLayout('list'));
    el.historySimilarBtn.addEventListener('click', () => setHistoryLayout('similar'));
    loadSimilarPreferences();
    loadHistoryFilterPreferences();
    renderHistoryFilterControls();
    el.historySimilarPreset?.addEventListener('change', () => setSimilarPreset(el.historySimilarPreset.value));
    el.historySimilarSort?.addEventListener('change', () => setSimilarSort(el.historySimilarSort.value));
    el.historySimilarSingles?.addEventListener('change', () => setShowSingles(el.historySimilarSingles.checked));
    el.historyFindSimilarBtn?.addEventListener('click', () => runActiveHistoryAction(findSimilarFromContext));
    el.historySelectAllBtn.addEventListener('click', selectAllVisibleHistoryImages);
    el.historyInvertBtn.addEventListener('click', invertVisibleHistorySelection);
    el.historyClearSelectionBtn.addEventListener('click', clearHistorySelection);
    el.historyTrashBtn?.addEventListener('click', () => { void confirmTrash(); });
    el.historyTrashIncludeProtected?.addEventListener('change', () => {
        state.historyTrashIncludeProtected = el.historyTrashIncludeProtected.checked;
        updateHistorySelectionUi();
    });
    el.historyTrashOpenBinBtn?.addEventListener('click', openHistoryRecycleBin);
    el.historyTrashRetryBtn?.addEventListener('click', () => { void retryHistoryTrash(); });
    el.historyTrashDismissBtn?.addEventListener('click', dismissHistoryTrashResult);
    el.historyDetailCloseBtn.addEventListener('click', closeHistoryDetail);
    try { state.historyDetailExpanded = localStorage.getItem(HISTORY_DETAIL_EXPANDED_KEY) === '1'; } catch { /* storage unavailable */ }
    el.historyDetailExpandBtn?.addEventListener('click', () => setHistoryDetailExpanded(!state.historyDetailExpanded));
    el.historyDetailTrashBtn?.addEventListener('click', () => { void trashActiveHistoryImage(); });
    for (const button of el.historyDetailDrawer.querySelectorAll('[data-history-tab]')) {
        button.addEventListener('click', () => setHistoryDetailTab(button.dataset.historyTab));
    }
    el.historyReferenceBtn?.addEventListener('click', () => runActiveHistoryAction(() => sendContextImageToReference(false, 'drawer')));
    el.historyPreviewBtn?.addEventListener('click', previewActiveHistoryImage);
    el.historySaveBtn.addEventListener('click', () => runActiveHistoryAction(saveContextImageAs));
    el.historyReverseBtn.addEventListener('click', () => runActiveHistoryAction(copyPromptFromContextImage));
    el.historyEditBtn.addEventListener('click', () => runActiveHistoryAction(() => openWorkspaceFromContextImage('mask')));
    el.historyPreviewCloseBtn.addEventListener('click', closeHistoryPreview);
    el.historyPreviewOverlay.addEventListener('click', (event) => {
        if (event.target === el.historyPreviewOverlay) closeHistoryPreview();
    });
}

function refreshLucideIcons(root = document) {
    if (!window.lucide?.createIcons) return;
    window.lucide.createIcons({ root });
    // lucide 1.34 的 createIcons 非幂等：生成的 svg 仍带 data-lucide，下次扫描会把
    // 已渲染好的图标 replaceChild 整个重建（可见闪烁）。转换后摘掉属性使其幂等——
    // 已转换图标不再被任何后续 refreshLucideIcons 调用重建。
    const scope = root.querySelectorAll ? root : document;
    scope.querySelectorAll('svg[data-lucide]').forEach(svg => svg.removeAttribute('data-lucide'));
}

function setSidebarActive(activeButton) {
    for (const button of document.querySelectorAll('.sidebar-button')) {
        const isActive = button === activeButton;
        button.classList.toggle('active', isActive);
        if (isActive) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    }
}

function showGenerationView() {
    if (state.historyLayout === 'similar' && state.activeView === 'history') state.historyDirty = true;
    // The find-similar results view is transient: coming back to history shows the normal layout.
    if (state.similarFind) closeFindSimilar({ render: false });
    state.activeView = 'generation';
    hideSettingsPage();
    el.tabsBar.hidden = false;
    el.mainContentScroll.hidden = false;
    el.historyPage.hidden = true;
    el.queuePage.hidden = true;
    el.reversePromptPage.hidden = true;
    if (el.workspacePage) el.workspacePage.hidden = true;
    el.errorLogsPage.hidden = true;
    if (el.historyBinPage) el.historyBinPage.hidden = true;
    setSidebarActive(el.generateNavBtn);
    hideImageHoverPreview();
    // 新视图在静止的光标下铺开，Chromium 会补发悬停：等真实移动再预览
    armHoverPreviewMoveGate();
    closeHistoryPreview();
    // The grid↔carousel decision needs the generation page laid out; re-render
    // now that it is visible so a short viewport shows the carousel immediately.
    renderRecentImages();
}

function showHistoryView() {
    state.activeView = 'history';
    hideSettingsPage();
    el.tabsBar.hidden = true;
    el.mainContentScroll.hidden = true;
    el.historyPage.hidden = false;
    el.queuePage.hidden = true;
    el.reversePromptPage.hidden = true;
    if (el.workspacePage) el.workspacePage.hidden = true;
    el.errorLogsPage.hidden = true;
    if (el.historyBinPage) el.historyBinPage.hidden = true;
    setSidebarActive(el.historyBtn);
    hideMentionMenu();
    hideImageHoverPreview();
    // 点主页图块会切到这里，网格在静止的光标下铺开、补发悬停：等真实移动再预览
    armHoverPreviewMoveGate();
    if (state.historyLoaded) {
        if (state.historyDirty) reconcileHistoryImages();
    } else {
        renderHistoryImages();
        ensureFullHistoryLoaded().catch(error => {
            showToast(`历史图片读取失败: ${error.message}`);
        });
    }
}

function ensureFullHistoryLoaded() {
    if (state.historyLoaded) return Promise.resolve(state.recentImages);
    if (!state.historyLoadPromise) {
        state.historyLoadPromise = refreshRecentImages({ full: true })
            .finally(() => {
                state.historyLoadPromise = null;
            });
    }
    return state.historyLoadPromise;
}

function syncSidebarWithView() {
    const activeButton = state.activeView === 'settings'
        ? el.apiSettingsBtn
        : state.activeView === 'logs'
            ? el.errorLogsBtn
        : state.activeView === 'bin'
            ? el.historyBinBtn
        : state.activeView === 'history'
        ? el.historyBtn
        : state.activeView === 'reverse-prompt'
            ? el.reversePromptNavBtn
        : state.activeView === 'workspace'
            ? el.workspaceNavBtn
        : state.activeView === 'queue'
            ? el.queueBtn
            : el.generateNavBtn;
    setSidebarActive(activeButton);
}

const ERROR_LOG_SOURCE_META = {
    generation: { label: '图片生成', icon: 'image-off' },
    provider: { label: 'API 提供商', icon: 'server-crash' },
    prompt: { label: '提示词优化', icon: 'wand-sparkles' },
    network: { label: '网络', icon: 'wifi-off' },
    storage: { label: '本地存储', icon: 'hard-drive' },
    renderer: { label: '界面', icon: 'monitor-x' },
    system: { label: '系统', icon: 'triangle-alert' }
};

function updateErrorLogBadge() {
    const count = Math.max(0, Number(state.errorLogUnreadCount) || 0);
    el.errorLogBadge.hidden = count === 0;
    el.errorLogBadge.textContent = count > 99 ? '99+' : String(count);
    el.errorLogBadge.setAttribute('aria-label', `${count} 条未读错误`);
}

function handleIncomingErrorLog(entry) {
    if (!entry?.id) return;
    const existingIndex = state.errorLogs.findIndex(item => item.id === entry.id);
    if (existingIndex >= 0) state.errorLogs.splice(existingIndex, 1);
    state.errorLogs.unshift(entry);
    state.errorLogs.sort((left, right) => Number(right.lastSeenAt || right.timestamp)
        - Number(left.lastSeenAt || left.timestamp));
    if (state.activeView !== 'logs') state.errorLogUnreadCount += 1;
    else state.errorLogUnreadCount = 0;
    updateErrorLogBadge();
    if (state.activeView === 'logs') renderErrorLogs();
    else if (existingIndex < 0) {
        const explanation = ux.explainError(entry);
        showToast(`${explanation.title}：${explanation.advice}`, 'error');
    }
}

async function refreshErrorLogs(options = {}) {
    try {
        const entries = await window.picgenDesktop.listErrorLogs({ limit: 500 });
        state.errorLogs = Array.isArray(entries) ? entries : [];
        if (options.setUnread) state.errorLogUnreadCount = state.errorLogs.length;
        if (state.activeView === 'logs') state.errorLogUnreadCount = 0;
        updateErrorLogBadge();
        if (options.render !== false) renderErrorLogs();
    } catch (error) {
        if (options.render !== false) showToast(`错误日志读取失败: ${error.message}`);
    }
}

async function refreshErrorLogCount() {
    if (!window.picgenDesktop.countErrorLogs) return;
    try {
        state.errorLogUnreadCount = await window.picgenDesktop.countErrorLogs();
        updateErrorLogBadge();
    } catch (error) {
        console.warn('[ErrorLogs] count failed:', error.message);
    }
}

async function openErrorLogs() {
    clearTimeout(state.toastTimer);
    if (window.PicGenAppica?.dismissToasts) window.PicGenAppica.dismissToasts();
    if (el.toast) el.toast.hidden = true;
    state.activeView = 'logs';
    hideSettingsPage();
    el.tabsBar.hidden = true;
    el.mainContentScroll.hidden = true;
    el.historyPage.hidden = true;
    el.queuePage.hidden = true;
    el.reversePromptPage.hidden = true;
    if (el.workspacePage) el.workspacePage.hidden = true;
    el.errorLogsPage.hidden = false;
    if (el.historyBinPage) el.historyBinPage.hidden = true;
    setSidebarActive(el.errorLogsBtn);
    hideMentionMenu();
    hideImageHoverPreview();
    closeHistoryPreview();
    state.errorLogUnreadCount = 0;
    updateErrorLogBadge();
    await refreshErrorLogs();
}

function getFilteredErrorLogs() {
    const query = el.errorLogsSearchInput.value.trim().toLowerCase();
    const source = el.errorLogsSourceFilter.value;
    const timeFilter = el.errorLogsTimeFilter.value;
    const now = Date.now();
    const cutoff = timeFilter === '24h'
        ? now - 24 * 60 * 60 * 1000
        : timeFilter === '7d'
            ? now - 7 * 24 * 60 * 60 * 1000
            : 0;

    return state.errorLogs.filter(entry => {
        if (source && entry.source !== source) return false;
        if (cutoff && Number(entry.lastSeenAt || entry.timestamp || 0) < cutoff) return false;
        if (!query) return true;
        return [
            entry.title,
            entry.message,
            entry.providerName,
            entry.providerId,
            entry.model,
            entry.taskId,
            entry.sequenceId,
            entry.code,
            entry.operation
        ].some(value => String(value || '').toLowerCase().includes(query));
    });
}

function formatErrorLogTime(timestamp) {
    const value = Number(timestamp);
    if (!value) return '未知时间';
    return new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

function createErrorLogElement(entry) {
    const meta = ERROR_LOG_SOURCE_META[entry.source] || ERROR_LOG_SOURCE_META.system;
    const expanded = state.expandedErrorLogIds.has(entry.id);
    const explanation = ux.explainError(entry);
    const article = document.createElement('article');
    article.className = 'error-log-item';
    article.dataset.source = entry.source || 'system';
    article.dataset.errorLogId = entry.id;

    const summary = document.createElement('button');
    summary.className = 'error-log-summary';
    summary.type = 'button';
    summary.setAttribute('aria-expanded', String(expanded));

    const sourceIcon = document.createElement('span');
    sourceIcon.className = 'error-log-source-icon';
    sourceIcon.innerHTML = `<i data-lucide="${meta.icon}"></i>`;

    const copy = document.createElement('span');
    copy.className = 'error-log-copy';
    const titleLine = document.createElement('span');
    titleLine.className = 'error-log-title-line';
    const title = document.createElement('strong');
    title.textContent = explanation.title;
    const source = document.createElement('small');
    source.className = 'error-log-source-label';
    source.textContent = meta.label;
    titleLine.append(title, source);

    const message = document.createElement('span');
    message.className = 'error-log-message';
    message.textContent = explanation.advice;

    const details = [
        formatErrorLogTime(entry.lastSeenAt || entry.timestamp),
        entry.providerName || '',
        entry.model || '',
        '点击展开技术详情',
        Number(entry.occurrences) > 1 ? `重复 ${entry.occurrences} 次` : ''
    ].filter(Boolean);
    const detailLine = document.createElement('span');
    detailLine.className = 'error-log-meta-line';
    detailLine.textContent = details.join(' · ');
    copy.append(titleLine, message, detailLine);

    const chevron = document.createElement('i');
    chevron.className = 'error-log-chevron';
    chevron.setAttribute('data-lucide', expanded ? 'chevron-up' : 'chevron-down');
    summary.append(sourceIcon, copy, chevron);
    summary.addEventListener('click', () => {
        if (state.expandedErrorLogIds.has(entry.id)) state.expandedErrorLogIds.delete(entry.id);
        else state.expandedErrorLogIds.add(entry.id);
        renderErrorLogs();
    });
    article.appendChild(summary);
    const action = document.createElement('button');
    action.type = 'button'; action.className = 'error-log-copy-button';
    const actions = { provider: ['检查供应商设置', 'image'], network: ['检查网络设置', 'network'], concurrency: ['调整并发设置', 'concurrency'], output: ['检查保存目录', 'output'] };
    const next = actions[explanation.action];
    action.textContent = next ? next[0] : '复制诊断信息';
    action.addEventListener('click', () => {
        if (!next) return copyErrorLog(entry);
        openSettings(); setSettingsMode(next[1]);
    });
    article.appendChild(action);

    if (expanded) {
        const detail = document.createElement('div');
        detail.className = 'error-log-detail';
        const fields = [
            ['原始错误', entry.message],
            ['错误代码', entry.code],
            ['HTTP 状态', entry.httpStatus || ''],
            ['供应商', entry.providerName || entry.providerId],
            ['模型', entry.model],
            ['任务 ID', entry.taskId],
            ['序列 ID', entry.sequenceId],
            ['请求 ID', entry.requestId],
            ['阶段', entry.phase],
            ['操作', entry.operation],
            ['协议', entry.protocol],
            ['首次发生', formatErrorLogTime(entry.timestamp)],
            ['最近发生', formatErrorLogTime(entry.lastSeenAt || entry.timestamp)]
        ].filter(([, value]) => value !== '' && value != null);
        const fieldGrid = document.createElement('dl');
        fieldGrid.className = 'error-log-fields';
        for (const [label, value] of fields) {
            const term = document.createElement('dt');
            const description = document.createElement('dd');
            term.textContent = label;
            description.textContent = String(value);
            fieldGrid.append(term, description);
        }
        detail.appendChild(fieldGrid);

        const diagnostic = {};
        if (entry.stack) diagnostic.stack = entry.stack;
        if (entry.details && Object.keys(entry.details).length > 0) diagnostic.details = entry.details;
        if (Object.keys(diagnostic).length > 0) {
            const pre = document.createElement('pre');
            pre.className = 'error-log-diagnostic';
            pre.textContent = JSON.stringify(diagnostic, null, 2);
            detail.appendChild(pre);
        }

        const copyButton = document.createElement('button');
        copyButton.className = 'error-log-copy-button';
        copyButton.type = 'button';
        copyButton.innerHTML = '<i data-lucide="copy"></i><span>复制诊断信息</span>';
        copyButton.addEventListener('click', () => copyErrorLog(entry));
        detail.appendChild(copyButton);
        article.appendChild(detail);
    }
    return article;
}

function renderErrorLogs() {
    const now = Date.now();
    const filtered = getFilteredErrorLogs();
    const dayCount = state.errorLogs.filter(entry => Number(entry.lastSeenAt || entry.timestamp || 0)
        >= now - 24 * 60 * 60 * 1000).length;
    const repeatCount = state.errorLogs.reduce((total, entry) => total + Math.max(0, Number(entry.occurrences || 1) - 1), 0);
    const timeLabel = el.errorLogsTimeFilter.options[el.errorLogsTimeFilter.selectedIndex]?.textContent || '全部';

    el.errorLogsMeta.textContent = `${timeLabel} · ${filtered.length} 条`;
    el.errorLogsDayCount.textContent = String(dayCount);
    el.errorLogsTotalCount.textContent = String(state.errorLogs.length);
    el.errorLogsRepeatCount.textContent = String(repeatCount);
    el.clearErrorLogsBtn.disabled = state.errorLogs.length === 0;
    el.errorLogsList.innerHTML = '';

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'error-logs-empty';
        empty.innerHTML = '<i data-lucide="circle-check-big"></i><strong>没有匹配的错误</strong><span>调整搜索或筛选条件后重试</span>';
        el.errorLogsList.appendChild(empty);
    } else {
        const fragment = document.createDocumentFragment();
        for (const entry of filtered) fragment.appendChild(createErrorLogElement(entry));
        el.errorLogsList.appendChild(fragment);
    }
    refreshLucideIcons(el.errorLogsList);
}

async function clearErrorLogs() {
    if (state.errorLogs.length === 0) return;
    const confirmed = await askConfirm('确定清空全部错误日志吗？此操作无法撤销。', {
        title: '清空错误日志',
        okText: '清空',
        danger: true
    });
    if (!confirmed) return;
    try {
        await window.picgenDesktop.clearErrorLogs();
        state.errorLogs = [];
        state.expandedErrorLogIds.clear();
        state.errorLogUnreadCount = 0;
        updateErrorLogBadge();
        renderErrorLogs();
        showToast('错误日志已清空');
    } catch (error) {
        showToast(`清空失败: ${error.message}`);
    }
}

async function copyErrorLog(entry) {
    try {
        await window.picgenDesktop.copyText(JSON.stringify(entry, null, 2));
        showToast('诊断信息已复制');
    } catch (error) {
        showToast(`复制失败: ${error.message}`);
    }
}

function reportRendererError(payload) {
    window.picgenDesktop.reportRendererError?.(payload).catch(() => {});
}

function bindAdvancedSettingEvents() {
    const saveAndUpdate = () => {
        updateCompressionValue();
        saveCurrentSequenceFromForm();
        updateAdvancedSettingsVisibility();
    };

    const controls = [
        el.outputMimeSelect,
        el.imageCompressionRange,
        el.gptQualitySelect,
        el.gptBackgroundSelect,
        el.gptImageWidthInput,
        el.gptImageHeightInput,
        el.openAIModerationSelect,
        el.nativeResponseFormatSelect,
        el.openAIStyleSelect,
        el.inputFidelitySelect,
        el.apiUserInput,
        el.responseModalitiesSelect,
        el.thinkingLevelSelect,
        el.includeThoughtsToggle,
        el.temperatureInput,
        el.topPInput,
        el.topKInput,
        el.googleSearchToggle,
        el.imageSearchToggle,
        el.xaiStoreToggle,
        el.xaiFilenameInput,
        el.xaiExpiresAfterInput,
        el.xaiPublicUrlToggle
    ].filter(Boolean);

    for (const control of controls) {
        control.addEventListener('change', saveAndUpdate);
        control.addEventListener('input', saveAndUpdate);
    }
}

function prepareApiStorage() {
    for (const key of legacyApiStorageKeys) {
        localStorage.removeItem(key);
    }
}

function createFallbackProvider() {
    return {
        id: 'api_unavailable',
        name: '当前 API',
        baseUrl: '',
        url: '',
        apiKey: '',
        models: [],
        modelPricing: {},
        chatModels: [],
        activeChatModel: '',
        chatModel: '',
        promptOptimizerSystemPrompt: DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT
    };
}

function normalizeModelPricing(input = {}) {
    const pricing = {};
    if (!input || typeof input !== 'object') return pricing;

    for (const [model, value] of Object.entries(input)) {
        const name = String(model || '').trim();
        if (value == null || (typeof value === 'string' && !value.trim())
            || !['number', 'string'].includes(typeof value)) continue;
        const price = Number(value);
        if (name && Number.isFinite(price) && price >= 0) {
            pricing[name] = price;
        }
    }

    return pricing;
}

function normalizeStringList(input = []) {
    return Array.isArray(input)
        ? input.map(item => String(item).trim()).filter(Boolean)
        : [];
}

function normalizeDiscoveredModels(input = []) {
    const discovered = [];
    const seen = new Set();
    for (const item of Array.isArray(input) ? input : []) {
        const source = item && typeof item === 'object' ? item : { id: item };
        const id = String(source.id || source.name || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        discovered.push({
            id,
            supported_endpoint_types: normalizeStringList(source.supported_endpoint_types),
            discoveredAt: Number(source.discoveredAt) || 0
        });
    }
    return discovered;
}

function normalizeProvider(provider = {}) {
    const baseUrl = String(provider.baseUrl ?? provider.url ?? '').trim();
    const chatModels = normalizeStringList(provider.chatModels || [provider.chatModel].filter(Boolean));
    const activeChatModel = chatModels.includes(provider.activeChatModel || provider.chatModel)
        ? String(provider.activeChatModel || provider.chatModel).trim()
        : (chatModels[0] || '');
    return {
        id: String(provider.id || `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).trim(),
        name: String(provider.name || '未命名 API').trim() || '未命名 API',
        // 角色的每条「供应商」其实是一个配置组：供应商名单独带一份，供生成区拼显示名用。
        supplierName: String(provider.supplierName || '').trim(),
        baseUrl,
        url: baseUrl,
        apiKey: String(provider.apiKey ?? '').trim(),
        models: Array.isArray(provider.models)
            ? provider.models.map(item => String(item).trim()).filter(Boolean)
            : [],
        modelPricing: normalizeModelPricing(provider.modelPricing || provider.pricing),
        modelRouting: provider.modelRouting && typeof provider.modelRouting === 'object' ? provider.modelRouting : {},
        modelCapabilities: provider.modelCapabilities && typeof provider.modelCapabilities === 'object' ? provider.modelCapabilities : {},
        discoveredModels: normalizeDiscoveredModels(provider.discoveredModels),
        enabled: provider.enabled !== false,
        maxConcurrent: Math.max(1, Number(provider.maxConcurrent) || 1),
        priority: Math.max(1, Number(provider.priority) || 1),
        chatModels,
        activeChatModel,
        chatModel: activeChatModel,
        promptOptimizerSystemPrompt: String(provider.promptOptimizerSystemPrompt || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT).trim()
            || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT
    };
}

function createFallbackChatProvider() {
    return {
        id: 'chat_unavailable',
        name: '对话 API',
        baseUrl: '',
        url: '',
        apiKey: '',
        models: [],
        activeModel: '',
        model: '',
        promptOptimizerSystemPrompt: DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT
    };
}

function normalizeChatProvider(provider = {}) {
    const baseUrl = String(provider.baseUrl ?? provider.url ?? '').trim();
    const models = normalizeStringList(provider.models || [provider.model].filter(Boolean));
    const activeModel = models.includes(provider.activeModel || provider.model)
        ? String(provider.activeModel || provider.model).trim()
        : (models[0] || '');
    return {
        id: String(provider.id || `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).trim(),
        name: String(provider.name || '对话 API').trim() || '对话 API',
        baseUrl,
        url: baseUrl,
        apiKey: String(provider.apiKey ?? '').trim(),
        models,
        activeModel,
        model: activeModel,
        promptOptimizerSystemPrompt: String(provider.promptOptimizerSystemPrompt || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT).trim()
            || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT
    };
}

async function loadChatProviders() {
    try {
        const response = await fetch(`${state.serverUrl}/api/chat-providers`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '读取对话 API 设置失败');

        const list = Array.isArray(result) ? result : result.providers;
        const providers = (Array.isArray(list) ? list : [])
            .map(normalizeChatProvider)
            .filter(provider => provider.id);
        return providers;
    } catch (error) {
        showToast(`对话 API 设置读取失败: ${error.message}`);
    }

    return [createFallbackChatProvider()];
}

async function saveChatProviderConfig(provider, existingId = null) {
    const path = existingId
        ? `/api/chat-providers/${encodeURIComponent(existingId)}`
        : '/api/chat-providers';
    const method = existingId ? 'PUT' : 'POST';
    const saved = await requestProvider(path, {
        method,
        body: JSON.stringify(provider)
    });
    return normalizeChatProvider(saved);
}

async function deleteChatProviderConfig(providerId) {
    const result = await requestProvider(`/api/chat-providers/${encodeURIComponent(providerId)}`, {
        method: 'DELETE'
    });
    const providers = Array.isArray(result.providers) ? result.providers.map(normalizeChatProvider) : null;
    return providers;
}

function renderModelRows(models = [], pricing = {}, routing = {}, discoveredModels = []) {
    el.modelRows.innerHTML = '';
    const normalizedPricing = normalizeModelPricing(pricing);
    const modelList = Array.isArray(models) ? models : [];

    for (const model of modelList) {
        addModelRow(model, normalizedPricing[model] ?? '', routing?.[model] || {});
    }

    if (el.modelRows.children.length === 0) {
        addModelRow('', '');
    }
    renderDiscoveredModelPicker(discoveredModels, modelList);
}

function currentModelRowNames() {
    return [...el.modelRows.querySelectorAll('[data-model-name]')]
        .map(input => input.value.trim())
        .filter(Boolean);
}

function renderDiscoveredModelPicker(discoveredModels = [], selectedModels = currentModelRowNames()) {
    const discovered = normalizeDiscoveredModels(discoveredModels);
    const selected = new Set(normalizeStringList(selectedModels));
    const available = discovered.filter(item => !selected.has(item.id));
    el.discoveredModelSelect.innerHTML = '';

    if (discovered.length === 0) {
        el.discoveredModelPicker.hidden = true;
        el.discoveredModelSelect.disabled = true;
        return;
    }

    el.discoveredModelPicker.hidden = false;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = available.length > 0
        ? `选择已发现模型（${available.length}/${discovered.length}）`
        : `已添加全部发现模型（${discovered.length}）`;
    el.discoveredModelSelect.appendChild(placeholder);

    for (const item of available) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.id;
        el.discoveredModelSelect.appendChild(option);
    }
    el.discoveredModelSelect.value = '';
    el.discoveredModelSelect.disabled = available.length === 0;
}

function refreshDiscoveredModelPickerForForm() {
    const preset = state.currentPresetId ? getPresetById(state.currentPresetId) : null;
    renderDiscoveredModelPicker(preset?.discoveredModels || [], currentModelRowNames());
}

function addSelectedDiscoveredModel() {
    const model = el.discoveredModelSelect.value.trim();
    if (!model) return;
    const inputs = [...el.modelRows.querySelectorAll('[data-model-name]')];
    const existing = inputs.find(input => input.value.trim() === model);
    if (existing) {
        existing.focus();
        renderDiscoveredModelPicker(
            getPresetById(state.currentPresetId)?.discoveredModels || [],
            currentModelRowNames()
        );
        return;
    }

    const empty = inputs.find(input => !input.value.trim());
    const target = empty || addModelRow(model, '');
    if (empty) empty.value = model;
    refreshDiscoveredModelPickerForForm();
    (empty || target)?.focus();
}

function bindDoubleConfirmRemove(button, row, afterRemove) {
    let resetTimer = null;
    button.addEventListener('click', () => {
        if (button.dataset.confirmRemove === 'true') {
            clearTimeout(resetTimer);
            row.remove();
            afterRemove();
            return;
        }

        button.dataset.confirmRemove = 'true';
        button.classList.add('confirming');
        button.title = '再点一次删除';
        resetTimer = setTimeout(() => {
            button.dataset.confirmRemove = '';
            button.classList.remove('confirming');
            button.title = '删除模型';
        }, 1600);
    });
}

function addModelRow(model = '', price = '', routing = {}) {
    const row = document.createElement('div');
    row.className = 'model-row image-model-row';

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.autocomplete = 'off';
    modelInput.placeholder = '模型名称';
    modelInput.value = model || '';
    modelInput.dataset.modelName = 'true';
    modelInput.addEventListener('change', refreshDiscoveredModelPickerForForm);
    row.appendChild(modelInput);

    const priceInput = document.createElement('input');
    priceInput.type = 'number';
    priceInput.min = '0';
    priceInput.step = '0.0001';
    priceInput.placeholder = '单次价格';
    priceInput.value = price === '' || price == null ? '' : String(price);
    priceInput.dataset.modelPrice = 'true';
    row.appendChild(priceInput);

    const protocolSelect = document.createElement('select');
    protocolSelect.dataset.modelProtocol = 'true';
    protocolSelect.title = '请求该模型时走哪个接口。不确定就用「自动识别」，它按模型名推断。';
    for (const [value, label] of [
        ['auto', '自动识别'],
        ['gemini-native', 'Gemini Native'],
        ['grsai-nano-banana', 'Grsai Nano Banana'],
        ['openai-images', 'OpenAI Images'],
        ['xai-imagine', 'Grok Imagine'],
        ['openai-chat', 'OpenAI Compatible']
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        protocolSelect.appendChild(option);
    }
    protocolSelect.value = routing.protocol || 'auto';
    row.appendChild(protocolSelect);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary-button compact-button model-row-remove';
    remove.title = '删除模型';
    remove.setAttribute('aria-label', '删除模型');
    remove.innerHTML = '<i data-lucide="trash-2"></i>';
    bindDoubleConfirmRemove(remove, row, () => {
        if (el.modelRows.children.length === 0) {
            addModelRow('', '');
        }
        refreshDiscoveredModelPickerForForm();
    });
    row.appendChild(remove);

    el.modelRows.appendChild(row);
    refreshLucideIcons(row);
    return modelInput;
}

function renderChatModelRows(chatModels = [], activeChatModel = '') {
    el.chatModelRows.innerHTML = '';
    const modelList = normalizeStringList(chatModels);
    const active = modelList.includes(activeChatModel) ? activeChatModel : (modelList[0] || '');

    for (const model of modelList) {
        addChatModelRow(model, model === active);
    }

    if (el.chatModelRows.children.length === 0) {
        addChatModelRow('', true);
    }
}

function addChatModelRow(model = '', checked = false) {
    const row = document.createElement('div');
    row.className = 'model-row chat-model-row';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'activeChatModel';
    radio.className = 'model-row-radio';
    radio.checked = checked;
    radio.dataset.chatModelActive = 'true';
    row.appendChild(radio);

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.autocomplete = 'off';
    modelInput.placeholder = '对话模型名称';
    modelInput.value = model || '';
    modelInput.dataset.chatModelName = 'true';
    row.appendChild(modelInput);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary-button compact-button model-row-remove';
    remove.title = '删除模型';
    remove.setAttribute('aria-label', '删除模型');
    remove.innerHTML = '<i data-lucide="trash-2"></i>';
    bindDoubleConfirmRemove(remove, row, () => {
        if (el.chatModelRows.children.length === 0) {
            addChatModelRow('', true);
            return;
        }

        if (!el.chatModelRows.querySelector('[data-chat-model-active]:checked')) {
            el.chatModelRows.querySelector('[data-chat-model-active]').checked = true;
        }
    });
    row.appendChild(remove);

    el.chatModelRows.appendChild(row);
    refreshLucideIcons(row);
}

function readModelRows() {
    const models = [];
    const modelPricing = {};
    const modelRouting = {};

    for (const row of el.modelRows.querySelectorAll('.model-row')) {
        const model = row.querySelector('[data-model-name]')?.value.trim();
        const priceText = row.querySelector('[data-model-price]')?.value.trim();
        if (!model || models.includes(model)) continue;

        models.push(model);
        modelRouting[model] = {
            protocol: row.querySelector('[data-model-protocol]')?.value || 'auto',
            enabled: true
        };
        if (priceText !== '') {
            const price = Number(priceText);
            if (Number.isFinite(price) && price >= 0) {
                modelPricing[model] = price;
            }
        }
    }

    return { models, modelPricing, modelRouting };
}

function readChatModelRows() {
    const chatModels = [];
    let activeChatModel = '';

    for (const row of el.chatModelRows.querySelectorAll('.chat-model-row')) {
        const model = row.querySelector('[data-chat-model-name]')?.value.trim();
        const checked = !!row.querySelector('[data-chat-model-active]')?.checked;
        if (!model || chatModels.includes(model)) continue;

        chatModels.push(model);
        if (checked) activeChatModel = model;
    }

    if (!activeChatModel && chatModels.length > 0) {
        activeChatModel = chatModels[0];
    }

    return {
        chatModels,
        activeChatModel,
        chatModel: activeChatModel
    };
}

async function loadProviders() {
    try {
        const response = await fetch(`${state.serverUrl}/api/providers`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '读取 API 设置失败');

        const list = Array.isArray(result) ? result : result.providers;
        const providers = (Array.isArray(list) ? list : [])
            .map(normalizeProvider)
            .filter(provider => provider.id);
        return providers;
    } catch (error) {
        showToast(`API 设置读取失败: ${error.message}`);
    }

    return [createFallbackProvider()];
}

async function requestProvider(path, options = {}) {
    const response = await fetch(`${state.serverUrl}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'API 设置保存失败');
    return result;
}

async function loadProviderRoutingConfig() {
    try {
        return await requestProvider('/api/providers/failover');
    } catch (error) {
        console.warn('[ProviderRouting] startup config load failed:', error.message);
        return { strategy: 'order', selectedProviderId: '' };
    }
}

const ROUTING_STRATEGY_LABELS = Object.freeze({
    order: '按顺序使用', priority: '优先级优先', balanced: '负载均衡', fixed: '指定提供商', price: '价格优先', speed: '速度优先'
});

function normalizeRoutingStrategy(value) {
    return Object.hasOwn(ROUTING_STRATEGY_LABELS, value) ? value : 'order';
}

function applyProviderRoutingConfig(config = {}, options = {}) {
    const strategy = normalizeRoutingStrategy(config.strategy);
    if (strategy !== 'fixed') state.automaticRoutingStrategy = strategy;
    state.routingStrategy = strategy;
    state.fixedProviderId = getPresetById(config.selectedProviderId)?.id || null;
    if (state.settingsMode === 'concurrency') updateSettingsProviderMeta();

    if (strategy === 'fixed' && state.fixedProviderId) {
        setActiveProvider(state.fixedProviderId);
    }
    if (options.render !== false && state.sequences.length > 0) {
        renderProviderSelect();
        renderModelSelect();
        updateDimensionOptions();
    }
}

async function changeGenerationProvider() {
    const requestedValue = el.providerSelect.value || AUTO_PROVIDER_VALUE;
    el.providerSelect.disabled = true;
    try {
        const useAutomaticRouting = requestedValue === AUTO_PROVIDER_VALUE;
        const result = await requestProvider('/api/providers/failover', {
            method: 'POST',
            body: JSON.stringify({
                strategy: useAutomaticRouting ? state.automaticRoutingStrategy : 'fixed',
                selectedProviderId: useAutomaticRouting ? '' : requestedValue
            })
        });
        applyProviderRoutingConfig(result.config || {}, { render: false });

        const sequence = getCurrentSequence();
        if (!useAutomaticRouting) {
            setActiveProvider(requestedValue);
            sequence.providerId = requestedValue;
        }
        renderProviderSelect();
        renderModelSelect(sequence);
        const provider = getSequencePreset(sequence);
        sequence.providerId = provider?.id || sequence.providerId || '';
        updateDimensionOptions(sequence);
        saveCurrentSequenceFromForm();
        updateAdvancedSettingsVisibility();
        showToast(useAutomaticRouting
            ? '已切换为自动路由'
            : `已指定 ${getPresetById(requestedValue)?.name || '供应商'}`);
    } catch (error) {
        showToast(`供应商切换失败: ${error.message}`);
    } finally {
        renderProviderSelect();
        el.providerSelect.disabled = false;
    }
}

async function saveProviderConfig(provider, existingId = null) {
    const path = existingId
        ? `/api/providers/${encodeURIComponent(existingId)}`
        : '/api/providers';
    const method = existingId ? 'PUT' : 'POST';
    const saved = await requestProvider(path, {
        method,
        body: JSON.stringify(provider)
    });
    return normalizeProvider(saved);
}

async function deleteProviderConfig(providerId) {
    const result = await requestProvider(`/api/providers/${encodeURIComponent(providerId)}`, {
        method: 'DELETE'
    });
    const providers = Array.isArray(result.providers) ? result.providers.map(normalizeProvider) : null;
    return providers;
}

async function reorderProviders(ids) {
    return requestProvider('/api/providers/reorder', {
        method: 'POST',
        body: JSON.stringify({ ids })
    });
}

async function refreshProviders(selectProviderId = null) {
    state.presets = await loadProviders();
    await refreshProviderHealth({ render: false });

    state.currentPresetId = getPresetById(selectProviderId)?.id
        || getPresetById(state.currentPresetId)?.id
        || state.presets[0]?.id
        || null;
    setActiveProvider(state.currentPresetId);

    normalizeSequenceProviders();
    renderSettingsPresetSelect();
    renderProviderSelect();
    // 保存供应商可能改了模型清单：renderModelSelect 会把序列里已不存在的模型收敛到首项，
    // 而比例/尺寸/数量的档位完全由模型决定。必须按 模型 → 画面档位 → 触发器摘要 的顺序补算：
    // renderProviderSelect 内部那次 updatePrefsTriggerValues 读到的是尚未更新的下拉值，
    // 而档位若不重算，生成区会一直显示保存前那支模型的「比例」标签与可选比例。
    renderModelSelect();
    if (state.sequences.length > 0) updateDimensionOptions();
    updatePrefsTriggerValues();
    fillSettingsForm();
    saveSequences();
}

function applyProviderHealth(statuses = [], render = true) {
    if (!Array.isArray(statuses)) return;
    const next = new Map(statuses
        .filter(status => status?.id)
        .map(status => [String(status.id), status]));
    const visibleHealth = health => health
        ? JSON.stringify([health.rating, health.ratingLabel, formatProviderHealthTooltip(health)]) : '';
    const changedIds = new Set([...state.providerHealth.keys(), ...next.keys()].filter(id =>
        visibleHealth(state.providerHealth.get(id)) !== visibleHealth(next.get(id))));
    state.providerHealth = next;
    if (changedIds.size && render && el.settingsOverlay && !el.settingsOverlay.hidden) {
        for (const card of el.settingsProviderList.querySelectorAll('[data-provider-id]')) {
            const id = card.dataset.providerId;
            if (!changedIds.has(id)) continue;
            const preset = getPresetById(id);
            const badge = card.querySelector('.provider-health-badge');
            if (!preset || !badge) continue;
            const health = next.get(id) || { rating: 'failed', ratingLabel: '故障' };
            const tooltip = formatProviderHealthTooltip(health);
            badge.className = `provider-health-badge ${health.rating}`;
            setElementText(badge, health.ratingLabel || '故障');
            badge.title = tooltip;
            badge.setAttribute('aria-label', `路由状态：${badge.textContent}`);
            card.title = `${preset.name || '未命名 API'}\n${tooltip}`;
        }
        updateSettingsProviderMeta();
        // Re-render the React supplier manager so its aggregated health dots
        // follow the same updates. React reconciles (stable component tree), so
        // any open editor draft and expansion state are preserved.
        // sync:false —— 健康推送随时可能落在折叠动画窗口内，走普通调度即可，
        // 避免 flushSync 在动画中间插入一个同步全树重渲的长帧。
        if (el.unifiedSupplierWorkspace && !el.unifiedSupplierWorkspace.classList.contains('is-unavailable')) {
            renderUnifiedSuppliers({ sync: false });
        }
    }
}

async function refreshProviderHealth(options = {}) {
    if (state.providerHealthLoadPromise) return state.providerHealthLoadPromise;
    state.providerHealthLoadPromise = (async () => { try {
        const response = await fetch(`${state.serverUrl}/api/providers/health`);
        const result = await response.json().catch(() => []);
        if (!response.ok) throw new Error(result.error || '路由状态读取失败');
        applyProviderHealth(result, options.render !== false);
    } catch (error) {
        console.warn('[ProviderHealth] refresh failed:', error.message);
    } })().finally(() => { state.providerHealthLoadPromise = null; });
    return state.providerHealthLoadPromise;
}

function startProviderHealthPolling() {
    clearInterval(state.providerHealthTimer);
    state.providerHealthTimer = setInterval(() => {
        if (!el.settingsOverlay.hidden && state.settingsMode === 'image') {
            refreshProviderHealth();
        }
    }, 30000);
}

function stopProviderHealthPolling() {
    clearInterval(state.providerHealthTimer);
    state.providerHealthTimer = null;
}

async function ensureChatProvidersLoaded() {
    if (state.chatProvidersLoaded) return state.chatPresets;
    if (state.chatProvidersLoadPromise) return state.chatProvidersLoadPromise;

    state.chatProvidersLoadPromise = (async () => {
        state.chatPresets = await loadChatProviders();
        const storedProviderId = state.currentChatPresetId
            || localStorage.getItem(DESKTOP_ACTIVE_CHAT_PROVIDER_KEY);
        state.currentChatPresetId = getChatPresetById(storedProviderId)?.id
            || state.chatPresets[0]?.id
            || null;
        setActiveChatProvider(state.currentChatPresetId);
        state.chatProvidersLoaded = true;
        renderChatSettingsPresetSelect();
        fillChatSettingsForm();
        return state.chatPresets;
    })();

    try {
        return await state.chatProvidersLoadPromise;
    } finally {
        state.chatProvidersLoadPromise = null;
    }
}

async function refreshChatProviders(selectProviderId = null) {
    state.chatPresets = await loadChatProviders();

    state.currentChatPresetId = getChatPresetById(selectProviderId)?.id
        || getChatPresetById(state.currentChatPresetId)?.id
        || state.chatPresets[0]?.id
        || null;
    setActiveChatProvider(state.currentChatPresetId);
    state.chatProvidersLoaded = true;

    renderChatSettingsPresetSelect();
    fillChatSettingsForm();
}

function normalizeSequenceProviders() {
    const fallbackProviderId = state.currentPresetId || state.presets[0]?.id || '';
    for (const sequence of state.sequences) {
        const fixedProvider = getFixedRoutingProvider();
        if (fixedProvider) sequence.providerId = fixedProvider.id;
        else if (!getPresetById(sequence.providerId)) sequence.providerId = fallbackProviderId;

        const models = getGenerationModels();
        if (!sequence.model || !models.includes(sequence.model)) {
            sequence.model = models[0] || '';
        }
        const provider = findProviderForModel(sequence.model, sequence.providerId);
        if (provider) sequence.providerId = provider.id;
    }
}

function normalizeSequenceNames() {
    state.sequences.forEach((sequence, index) => {
        sequence.name = `序列${index + 1}`;
    });
}

function isOpenAIImage2Model(model = '') {
    return imageApiProfiles.isOpenAIImage2Model(model);
}

function parseImageSize(value) {
    const match = String(value || '').trim().match(/^(\d+)\s*(?:x|\*|\u00d7)\s*(\d+)$/i);
    if (!match) return null;
    return {
        width: parseInt(match[1], 10),
        height: parseInt(match[2], 10)
    };
}

function normalizeImageSize(value) {
    const parsed = parseImageSize(value);
    return parsed ? `${parsed.width}x${parsed.height}` : String(value || '').trim();
}

function mapRatioToOpenAIImageSize(value, options = OPENAI_LEGACY_IMAGE_SIZE_OPTIONS) {
    const size = normalizeImageSize(value);
    if (options.some(option => option.value === size)) return size;
    if (parseImageSize(size) && options.some(option => option.value === 'custom')) return 'custom';

    const sizeMap = {
        '1:1': '1024x1024',
        '3:2': '1536x1024',
        '2:3': '1024x1536'
    };
    return sizeMap[size] || 'auto';
}

function mapOpenAIImageSizeToRatio(value) {
    const sizeMap = {
        '1024x1024': '1:1',
        '1536x1024': '3:2',
        '1024x1536': '2:3'
    };
    return sizeMap[normalizeImageSize(value)] || '1:1';
}

function renderSelectOptions(select, options, value) {
    select.innerHTML = '';
    for (const optionData of options) {
        const option = document.createElement('option');
        option.value = optionData.value;
        option.textContent = optionData.label;
        select.appendChild(option);
    }
    const exact = options.find(option => option.value === value);
    const caseInsensitive = options.find(option => option.value.toLowerCase() === String(value || '').toLowerCase());
    const matched = exact?.value || caseInsensitive?.value;
    select.value = matched || options[0]?.value || '';
    // 旧值在新模型里没有对应项时只能显示首项，但那不是用户选的。留个标记，
    // 让 saveCurrentSequenceFromForm 别把这个回落值当成用户输入写回序列——
    // 否则改任意别的字段都会顺手把比例/张数改成首项，就是"设置自己会变"。
    if (!matched && value) select.dataset.fallback = '1';
    else delete select.dataset.fallback;
    if (select === el.ratioSelect) renderRatioPickerOptions();
    refreshModernSelect(select);
}

// The generation surface uses compact, icon-led dropdowns instead of the
// browser-native select popup.  The original select remains in the DOM as the
// source of truth so existing form and persistence code keeps working.
const modernSelects = new WeakMap();
const modernSelectIcons = {
    unifiedGroupRoleSelect: 'layers-3',
    unifiedGroupActiveModelSelect: 'box',
    reversePromptProviderSelect: 'messages-square',
    reversePromptModelSelect: 'cpu',
    strategyProviderSelect: 'server',
    discoveredModelSelect: 'scan-search',
    providerSelect: 'server',
    modelSelect: 'box',
    countSelect: 'layers-3',
    imageSizeSelect: 'maximize-2',
    outputMimeSelect: 'file-image',
    gptQualitySelect: 'sparkles',
    gptBackgroundSelect: 'palette',
    openAIModerationSelect: 'shield-check',
    nativeResponseFormatSelect: 'brackets',
    openAIStyleSelect: 'paintbrush',
    inputFidelitySelect: 'scan-face',
    responseModalitiesSelect: 'image',
    thinkingLevelSelect: 'brain'
};
const modernSelectLabels = {
    providerSelect: '生图供应商',
    modelSelect: '模型',
    countSelect: '生成数量',
    imageSizeSelect: '分辨率',
    outputMimeSelect: '输出格式',
    gptQualitySelect: '图片质量',
    gptBackgroundSelect: '背景',
    openAIModerationSelect: '内容审核',
    nativeResponseFormatSelect: '响应格式',
    openAIStyleSelect: '图片风格',
    inputFidelitySelect: '参考图保真度',
    responseModalitiesSelect: '响应内容',
    thinkingLevelSelect: '思考级别',
    reversePromptProviderSelect: '反推供应商',
    reversePromptModelSelect: '反推模型',
    promptOptimizeProviderSelect: '优化对话模型',
    strategyProviderSelect: '配置组',
    fixedProviderSelect: '指定配置组',
    proxyModeSelect: '代理模式',
    discoveredModelSelect: '已发现模型',
    errorLogsSourceFilter: '错误来源筛选',
    errorLogsTimeFilter: '错误时间筛选'
};

function modernSelectIcon(select) {
    return modernSelectIcons[select.id] || 'chevron-right';
}

function initModernSelects(root = document) {
    if (window.PicGenAppica) return window.PicGenAppica.mountSelects(root, modernSelectLabels);
    root.querySelectorAll('select').forEach(select => {
        // Hidden selects are compatibility/state sources (ratio, routing mode,
        // etc.). Visible selects in hidden panels are still initialized now so
        // they are ready when that panel is opened.
        if (select.hidden || modernSelects.has(select)) return;
        if (!select.id) select.id = `modernSelect-${++initModernSelects.sequence}`;
        const wrapper = document.createElement('div');
        wrapper.className = 'modern-select';
        wrapper.dataset.selectId = select.id;
        select.parentNode.insertBefore(wrapper, select);
        wrapper.appendChild(select);
        select.classList.add('modern-select-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'modern-select-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        const fieldLabel = modernSelectLabels[select.id]
            || select.getAttribute('aria-label')
            || select.closest('label')?.querySelector(':scope > span')?.textContent?.trim()
            || select.id;
        trigger.dataset.fieldLabel = fieldLabel;
        trigger.setAttribute('aria-label', fieldLabel);
        trigger.innerHTML = `<span class="modern-select-leading"><i data-lucide="${modernSelectIcon(select)}"></i></span><span class="modern-select-value"></span><i class="modern-select-chevron" data-lucide="chevron-down"></i>`;
        wrapper.appendChild(trigger);

        const menu = document.createElement('div');
        menu.className = 'modern-select-menu';
        menu.id = `${select.id || 'select'}ModernMenu`;
        menu.setAttribute('role', 'listbox');
        menu.hidden = true;
        document.body.appendChild(menu);
        trigger.setAttribute('aria-controls', menu.id);

        const record = { select, wrapper, trigger, menu, observer: null };
        modernSelects.set(select, record);
        // Setting a select property does not emit change or a DOM mutation.
        // Preserve native behavior while synchronizing the visible trigger.
        for (const property of ['value', 'selectedIndex']) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, property);
            if (descriptor?.get && descriptor?.set) Object.defineProperty(select, property, {
                configurable: true,
                get() { return descriptor.get.call(this); },
                set(value) { descriptor.set.call(this, value); refreshModernSelect(this); }
            });
        }
        trigger.addEventListener('click', () => {
            if (trigger.disabled || select.disabled) return;
            menu.hidden ? openModernSelect(record) : closeModernSelect(record);
        });
        trigger.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openModernSelect(record, event.key === 'ArrowUp' ? 'last' : 'first');
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                closeModernSelect(record);
            }
        });
        select.addEventListener('change', () => refreshModernSelect(select));
        menu.addEventListener('click', event => {
            const optionButton = event.target.closest('[data-modern-value]');
            if (!optionButton || optionButton.disabled) return;
            select.value = optionButton.dataset.modernValue;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            closeModernSelect(record);
            trigger.focus();
        });
        menu.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeModernSelect(record);
                trigger.focus();
                return;
            }
            const options = [...menu.querySelectorAll('.modern-select-option:not(:disabled)')];
            const current = options.indexOf(document.activeElement);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                if (!options.length) return;
                const direction = event.key === 'ArrowUp' ? -1 : 1;
                const next = event.key === 'Home' ? 0
                    : event.key === 'End' ? options.length - 1
                        : (current < 0 ? 0 : (current + direction + options.length) % options.length);
                options[next].focus();
                return;
            }
            if (event.key === 'Tab') {
                closeModernSelect(record);
                trigger.focus();
            }
        });
        record.observer = new MutationObserver(() => refreshModernSelect(select));
        record.observer.observe(select, { childList: true, subtree: true, attributes: true });
        refreshModernSelect(select);
    });
    refreshLucideIcons(root);
}
initModernSelects.sequence = 0;

function refreshModernSelect(select) {
    if (window.PicGenAppica) return window.PicGenAppica.refreshSelect(select);
    const record = modernSelects.get(select);
    if (!record) return;
    const selected = [...select.options].find(option => option.value === select.value)
        || select.options[0];
    record.trigger.disabled = !!select.disabled;
    record.trigger.classList.toggle('is-disabled', !!select.disabled);
    record.trigger.classList.toggle('is-empty', !selected);
    record.trigger.querySelector('.modern-select-value').textContent = selected?.textContent || '暂无选项';
    const fieldLabel = record.trigger.dataset.fieldLabel || select.getAttribute('aria-label') || select.id;
    record.trigger.setAttribute('aria-label', `${fieldLabel}：${selected?.textContent || '暂无选项'}`);
    record.trigger.title = selected?.textContent || '暂无选项';
    record.menu.innerHTML = '';
    [...select.options].forEach(option => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'modern-select-option';
        item.setAttribute('role', 'option');
        item.dataset.modernValue = option.value;
        item.disabled = option.disabled;
        item.tabIndex = option.value === select.value && !option.disabled ? 0 : -1;
        item.setAttribute('aria-selected', option.value === select.value ? 'true' : 'false');
        if (option.value === select.value) item.classList.add('selected');
        item.innerHTML = `<i data-lucide="${modernSelectIcon(select)}"></i><span>${escapeHtml(option.textContent || option.value)}</span>${option.value === select.value ? '<i class="modern-select-check" data-lucide="check"></i>' : ''}`;
        record.menu.appendChild(item);
    });
    refreshLucideIcons(record.menu);
    if (!record.menu.hidden) positionModernSelect(record);
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value);
    return div.innerHTML;
}

function positionModernSelect(record) {
    const rect = record.trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 168), window.innerWidth - 16);
    const margin = 8;
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - margin - 5);
    const availableAbove = Math.max(0, rect.top - margin - 5);
    const desiredHeight = Math.min(300, record.menu.scrollHeight || 300);
    const opensUp = availableBelow < desiredHeight && availableAbove > availableBelow;
    const maxHeight = Math.min(300, opensUp ? availableAbove : availableBelow);
    record.menu.style.width = `${width}px`;
    record.menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
    record.menu.style.maxHeight = `${maxHeight}px`;
    const menuHeight = Math.min(record.menu.scrollHeight || maxHeight, maxHeight);
    record.menu.style.top = `${Math.round(opensUp ? rect.top - menuHeight - 5 : rect.bottom + 5)}px`;
    record.menu.classList.toggle('opens-up', opensUp);
}

function openModernSelect(record, initialFocus = 'selected') {
    closeAllModernSelects(record);
    refreshModernSelect(record.select);
    record.menu.hidden = false;
    record.trigger.setAttribute('aria-expanded', 'true');
    record.wrapper.classList.add('open');
    positionModernSelect(record);
    const options = [...record.menu.querySelectorAll('.modern-select-option:not(:disabled)')];
    const target = initialFocus === 'last' ? options.at(-1)
        : initialFocus === 'first' ? options[0]
            : record.menu.querySelector('.modern-select-option.selected:not(:disabled)') || options[0];
    target?.focus();
}

function closeModernSelect(record) {
    record.menu.hidden = true;
    record.trigger.setAttribute('aria-expanded', 'false');
    record.wrapper.classList.remove('open');
}

function closeAllModernSelects(except = null) {
    if (window.PicGenAppica) return window.PicGenAppica.closeSelects(except?.select);
    document.querySelectorAll('.modern-select.open').forEach(wrapper => {
        const select = wrapper.querySelector('select');
        const record = select && modernSelects.get(select);
        if (record && record !== except) closeModernSelect(record);
    });
}

document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.modern-select, .modern-select-menu')) closeAllModernSelects();
});
if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
        document.querySelectorAll('.modern-select.open').forEach(wrapper => {
            const select = wrapper.querySelector('select');
            const record = select && modernSelects.get(select);
            if (record) positionModernSelect(record);
        });
    });
    window.addEventListener('scroll', event => {
        if (!event.target.closest?.('.modern-select-menu')) closeAllModernSelects();
    }, true);
}

function updateModelSpecificAdvancedOptions(profile, advancedInput = {}) {
    const advanced = createDefaultAdvancedSettings(advancedInput);
    if (profile.qualityOptions) {
        renderSelectOptions(el.gptQualitySelect, profile.qualityOptions, advanced.gptQuality);
    }
    if (profile.backgroundOptions) {
        renderSelectOptions(el.gptBackgroundSelect, profile.backgroundOptions, advanced.gptBackground);
    }
}

function updateDimensionOptions(sequence = getCurrentSequence()) {
    const model = sequence?.model || el.modelSelect.value;
    const profile = imageApiProfiles.getImageApiProfile(model);
    updateModelSpecificAdvancedOptions(profile, sequence?.advanced);
    const currentDimension = sequence?.ratio || el.ratioSelect.value;
    const isOpenAIImage = profile.apiKind === 'openai';
    const isOpenAIImage2 = imageApiProfiles.isOpenAIImage2Model(model)
        || imageApiProfiles.isOpenAIImage25Model(model);
    const legacyImage2Selection = isOpenAIImage2
        ? imageApiProfiles.openAIImage2SelectionFromLegacySize(currentDimension)
        : null;
    const nextValue = isOpenAIImage2
        ? (profile.dimensionOptions.some(option => option.value === currentDimension)
            ? currentDimension
            : legacyImage2Selection?.ratio || '1:1')
        : isOpenAIImage
        ? mapRatioToOpenAIImageSize(currentDimension, profile.dimensionOptions)
        : (profile.dimensionOptions.some(option => option.value === currentDimension)
            ? currentDimension
            : mapOpenAIImageSizeToRatio(currentDimension));

    el.ratioLabel.textContent = profile.dimensionLabel;
    renderSelectOptions(el.ratioSelect, getDimensionOptions(profile), nextValue);
    updateRatioLabelHint();
    renderRatioGrid();
    renderSelectOptions(el.countSelect, profile.countOptions, sequence?.count || el.countSelect.value || '1');

    el.imageSizeField.hidden = profile.imageSizeOptions.length === 0;
    if (profile.imageSizeOptions.length > 0) {
        const stored = legacyImage2Selection?.resolution
            || sequence?.imageSize
            || el.imageSizeSelect.value
            || profile.imageSizeOptions[0].value;
        // 序列里存的可能是当前模型根本没有的档位（新序列默认 4K，而 grok 只有 1k/2k）。
        // 这里就把它收敛到模型真正支持的档，而不是让 renderSelectOptions 静默回落到首项——
        // 提交时用的也是同一条规则，两边不一致等于下拉框在骗人（显示 1k、实发 2k）。
        const resolution = imageApiProfiles.resolveImageSizePreference(stored, profile.imageSizeOptions)
            || stored;
        renderSelectOptions(el.imageSizeSelect, profile.imageSizeOptions, resolution);
        // 显示的既然不是用户自己选的档位，就别让 saveCurrentSequenceFromForm 把它当成输入写回
        // 序列：保留原偏好，切回支持 4K 的模型还能还原。（用户一改就会清掉这个标记。）
        if (resolution !== stored) el.imageSizeSelect.dataset.fallback = '1';
    }
    renderGenerationSliders();
    // 模型不支持参考图时隐藏整个左侧参考轨（堆叠 + 计数）。
    if (el.referenceRail) el.referenceRail.hidden = profile.maxReferences === 0;

    if (sequence) {
        if (profile.controls.customSize && el.imageSizeSelect.value === 'custom') {
            const parsed = parseImageSize(sequence.ratio);
            if (parsed && !sequence.advanced?.gptImageWidth && !sequence.advanced?.gptImageHeight) {
                sequence.advanced = {
                    ...createDefaultAdvancedSettings(sequence.advanced),
                    gptImageWidth: String(parsed.width),
                    gptImageHeight: String(parsed.height)
                };
            }
        }
        // 这里只补空值，绝不回写。renderSelectOptions 在旧值不在新模型选项里时会静默回落到
        // options[0]，从前无条件回写就把用户选的比例/张数悄悄改成了首项——而且每次切模型、
        // 切序列都会触发，表现成"设置自己会变"。真正的持久化交给 saveCurrentSequenceFromForm。
        if (!sequence.ratio) sequence.ratio = el.ratioSelect.value;
        if (!sequence.count) sequence.count = el.countSelect.value;
        if (profile.imageSizeOptions.length > 0 && !sequence.imageSize) {
            sequence.imageSize = el.imageSizeSelect.value;
        }
    }
    // 比例/数量档位在这里按模型重建，是各「重载表单」链路（启动、切/增/关序列、
    // WS 路由推送、换供应商、换模型）里最后改动比例/数量下拉的一步；renderProviderSelect
    // 那次摘要读的是旧下拉值，档位落定后必须再写一次按钮摘要。
    updatePrefsTriggerValues();
}

function getDimensionOptions(profile) {
    const options = Array.isArray(profile?.dimensionOptions) ? [...profile.dimensionOptions] : [];
    if (Number(profile?.maxReferences || 0) > 0) {
        options.push({ value: 'reference', label: '贴合参考图比例' });
    }
    return options;
}

function createDefaultAdvancedSettings(input = {}) {
    return {
        outputMimeType: input.outputMimeType || '',
        imageCompression: String(input.imageCompression ?? '80'),
        gptQuality: input.gptQuality || 'auto',
        gptBackground: input.gptBackground || 'auto',
        gptImageWidth: input.gptImageWidth ?? '',
        gptImageHeight: input.gptImageHeight ?? '',
        openAIModeration: input.openAIModeration || input.moderation || 'auto',
        nativeResponseFormat: input.nativeResponseFormat || input.responseFormat || '',
        openAIStyle: input.openAIStyle || input.style || '',
        inputFidelity: input.inputFidelity || '',
        apiUser: input.apiUser || input.user || '',
        responseModalities: input.responseModalities || 'TEXT_IMAGE',
        thinkingLevel: input.thinkingLevel && input.thinkingLevel !== 'none' ? input.thinkingLevel : 'default',
        includeThoughts: !!input.includeThoughts,
        temperature: input.temperature ?? '',
        topP: input.topP ?? '',
        topK: input.topK ?? '',
        googleSearch: !!input.googleSearch,
        imageSearch: !!input.imageSearch,
        xaiStore: !!input.xaiStore,
        xaiFilename: input.xaiFilename || '',
        xaiExpiresAfter: input.xaiExpiresAfter ?? '',
        xaiPublicUrl: !!input.xaiPublicUrl
    };
}

function readAdvancedSettingsFromForm() {
    return createDefaultAdvancedSettings({
        outputMimeType: el.outputMimeSelect.value,
        imageCompression: el.imageCompressionRange.value,
        gptQuality: el.gptQualitySelect.value,
        gptBackground: el.gptBackgroundSelect.value,
        gptImageWidth: el.gptImageWidthInput.value,
        gptImageHeight: el.gptImageHeightInput.value,
        openAIModeration: el.openAIModerationSelect.value,
        nativeResponseFormat: el.nativeResponseFormatSelect.value,
        openAIStyle: el.openAIStyleSelect.value,
        inputFidelity: el.inputFidelitySelect.value,
        apiUser: el.apiUserInput.value.trim(),
        responseModalities: el.responseModalitiesSelect.value,
        thinkingLevel: el.thinkingLevelSelect.value,
        includeThoughts: el.includeThoughtsToggle.checked,
        temperature: el.temperatureInput.value,
        topP: el.topPInput.value,
        topK: el.topKInput.value,
        googleSearch: el.googleSearchToggle.checked,
        imageSearch: el.imageSearchToggle.checked,
        xaiStore: el.xaiStoreToggle.checked,
        xaiFilename: el.xaiFilenameInput.value.trim(),
        xaiExpiresAfter: el.xaiExpiresAfterInput.value,
        xaiPublicUrl: el.xaiPublicUrlToggle.checked
    });
}

function updateRatioLabelHint() {
    if (!el.ratioLabelWrap) return;
    const value = String(el.ratioSelect.value || '').trim();
    const ratio = value.includes(':') ? value : value.replace(/x/i, ':');
    const hint = ratio ? `图片宽高比 ${ratio}` : '图片宽高比';
    el.ratioLabelWrap.title = hint;
    el.ratioField.setAttribute('aria-label', hint);
    if (el.ratioPickerButton) el.ratioPickerButton.title = hint;
}

function parseAspectRatio(value) {
    const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/i);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? width / height : null;
}

function referenceDataUrl(reference) {
    if (!reference?.base64) return '';
    return `data:${reference.mimeType || 'image/png'};base64,${reference.base64}`;
}

async function readReferenceDimensions(reference) {
    if (Number(reference?.width) > 0 && Number(reference?.height) > 0) {
        return { width: Number(reference.width), height: Number(reference.height) };
    }
    let dataUrl = referenceDataUrl(reference);
    if (!dataUrl && reference?.filePath && window.picgenDesktop?.loadReferenceImage) {
        const loaded = await window.picgenDesktop.loadReferenceImage({ filePath: reference.filePath, mimeType: reference.mimeType });
        reference.base64 = loaded.base64 || '';
        reference.mimeType = loaded.mimeType || reference.mimeType || 'image/png';
        dataUrl = referenceDataUrl(reference);
    }
    if (!dataUrl) throw new Error('参考图内容不可读取');
    const dimensions = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error('参考图尺寸读取失败'));
        image.src = dataUrl;
    });
    reference.width = dimensions.width;
    reference.height = dimensions.height;
    return dimensions;
}

function getReferenceRatioLabel(reference, dimensions) {
    const ratio = dimensions.width / dimensions.height;
    return `${reference.name || '参考图'} · ${dimensions.width} × ${dimensions.height} · ${ratio.toFixed(3)}`;
}

function getDimensionOptionRatio(option) {
    return parseAspectRatio(option?.value) || (() => {
        const size = parseImageSize(option?.value);
        return size?.height ? size.width / size.height : null;
    })();
}

function nearestDimensionOption(targetRatio, profile) {
    const candidates = getDimensionOptions(profile)
        .filter(option => option.value !== 'reference' && option.value !== 'custom' && option.value !== 'auto')
        .map(option => ({ option, ratio: getDimensionOptionRatio(option) }))
        .filter(item => Number.isFinite(item.ratio) && item.ratio > 0);
    if (!candidates.length) {
        const fallback = getDimensionOptions(profile).find(option => option.value === 'auto');
        return fallback || null;
    }
    return candidates.reduce((nearest, current) => {
        // Log distance treats 2:1 and 1:2 symmetrically while keeping exact
        // portrait/landscape matches at zero distance.
        const currentDistance = Math.abs(Math.log(current.ratio / targetRatio));
        const nearestDistance = Math.abs(Math.log(nearest.ratio / targetRatio));
        return currentDistance < nearestDistance ? current : nearest;
    }).option;
}

function positionReferenceRatioPicker() {
    if (!el.referenceRatioPicker || el.referenceRatioPicker.hidden) return;
    const trigger = el.ratioGrid || document.querySelector('[data-select-id="ratioSelect"]') || el.ratioField;
    const rect = trigger?.getBoundingClientRect?.();
    if (!rect) return;
    const width = Math.min(320, window.innerWidth - 24);
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
    const below = rect.bottom + 8;
    const estimatedHeight = Math.min(300, el.referenceRatioPicker.scrollHeight || 240);
    const top = below + estimatedHeight <= window.innerHeight - 12
        ? below
        : Math.max(12, rect.top - estimatedHeight - 8);
    el.referenceRatioPicker.style.width = `${width}px`;
    el.referenceRatioPicker.style.left = `${Math.round(left)}px`;
    el.referenceRatioPicker.style.top = `${Math.round(top)}px`;
}

function closeReferenceRatioPicker({ restore = true } = {}) {
    if (!el.referenceRatioPicker) return;
    if (restore && state.referenceRatioPrevious && el.ratioSelect.value === 'reference') {
        el.ratioSelect.value = state.referenceRatioPrevious;
        el.ratioSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    state.referenceRatioPrevious = null;
    el.referenceRatioPicker.hidden = true;
}

async function applyReferenceRatio(reference) {
    if (state.referenceRatioPickerBusy) return;
    state.referenceRatioPickerBusy = true;
    try {
        const dimensions = await readReferenceDimensions(reference);
        const sequence = getCurrentSequence();
        const profile = imageApiProfiles.getImageApiProfile(sequence.model);
        const option = nearestDimensionOption(dimensions.width / dimensions.height, profile);
        if (!option) throw new Error('当前模型没有可用的比例选项');
        el.ratioSelect.value = option.value;
        closeReferenceRatioPicker({ restore: false });
        el.ratioSelect.dispatchEvent(new Event('change', { bubbles: true }));
        showToast(`已匹配参考图比例：${option.label}`,'success');
    } catch (error) {
        showToast(`参考图比例匹配失败：${error.message}`,'error');
    } finally {
        state.referenceRatioPickerBusy = false;
    }
}

function renderReferenceRatioOptions() {
    if (!el.referenceRatioOptions) return;
    const references = getCurrentSequence()?.references || [];
    el.referenceRatioOptions.replaceChildren();
    el.referenceRatioEmpty.hidden = references.length > 0;
    for (const reference of references) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'reference-ratio-option';
        const preview = document.createElement('img');
        preview.src = referenceDataUrl(reference);
        preview.alt = '';
        const copy = document.createElement('span');
        copy.className = 'reference-ratio-option-copy';
        const name = document.createElement('strong');
        name.textContent = reference.name || '参考图';
        const detail = document.createElement('small');
        detail.textContent = '读取尺寸中…';
        copy.append(name, detail);
        button.append(preview, copy);
        button.addEventListener('click', () => applyReferenceRatio(reference));
        el.referenceRatioOptions.appendChild(button);
        readReferenceDimensions(reference).then(dimensions => {
            if (detail.isConnected) detail.textContent = getReferenceRatioLabel(reference, dimensions);
        }).catch(() => {
            if (detail.isConnected) detail.textContent = '无法读取尺寸';
        });
    }
}

function openReferenceRatioPicker() {
    const sequence = getCurrentSequence();
    state.referenceRatioPrevious = sequence?.ratio || '1:1';
    renderReferenceRatioOptions();
    el.referenceRatioPicker.hidden = false;
    positionReferenceRatioPicker();
    if (!(sequence?.references || []).length) showToast('请先上传参考图');
}

// 三个横向设置入口各自的浮层面板：供应商&模型 / 比例&分辨率&数量 / 高级设置。
// 面板常驻 DOM（仅 hidden 切换），此处只负责显隐、按触发按钮定位、外点/Esc 关闭；
// 同一时刻只开一个。
const PREFS_PANELS = [
    // 供应商已并入画面面板（prefsPanelImage）。点击开关；已打开时横移相邻触发器切换。
    { btn: 'prefsBtnImage', panel: 'prefsPanelImage' },
    { btn: 'prefsBtnAdvanced', panel: 'prefsPanelAdvanced' },
];
let openPrefsEntry = null;
let prefsHoverTimer = null;

// bottom 栏设置按钮直接显示 供应商 · 模型 · 比例 · 数量。
// 它与置顶窗镜像读同一组隐藏下拉，必须一起刷新（syncNativePrefs 的常规入口都经这里），
// 否则弹窗已是新值、按钮还是旧值，要等点生成（saveCurrentSequenceFromForm）才对上。
function updatePrefsTriggerValues() {
    const summary = typeof document !== 'undefined' && typeof document.getElementById === 'function'
        ? document.getElementById('prefsValueProvider') : null;
    if (summary) {
        const provider = el.providerSelect?.selectedOptions?.[0]?.textContent?.trim() || '';
        const model = el.modelSelect?.value || '';
        let ratio = el.ratioSelect?.value || '';
        if (ratio === 'reference') ratio = '参考图';
        else if (ratio === 'auto') ratio = '智能';
        const count = el.countSelect?.value ? `${el.countSelect.value}张` : '';
        // 供应商/模型名常很长，省略号只截头部；比例/数量放不收缩的尾段，改了总能看见。
        const head = [provider, model].filter(Boolean).join(' · ');
        const tailParts = [ratio, count].filter(Boolean).join(' · ');
        const tail = head && tailParts ? ` · ${tailParts}` : tailParts;
        // 调用变密（每次镜像同步都会走到），同值不重写，避免无谓 DOM 变更。
        if (summary.textContent !== head + tail) {
            const headNode = document.createElement('span');
            headNode.className = 'prefs-tab-value-head';
            headNode.textContent = head;
            const tailNode = document.createElement('span');
            tailNode.className = 'prefs-tab-value-tail';
            tailNode.textContent = tail;
            summary.replaceChildren(...[headNode, tailNode].filter(node => node.textContent));
            // 头段可能被省略号截断，悬停给出完整摘要。
            summary.title = head + tail;
        }
    }
    // 触发按钮摘要变化 = 供应商/模型/比例/数量有变 → 同步置顶窗镜像。
    if (typeof syncNativePrefs === 'function') syncNativePrefs();
}

function cancelClosePrefs() { clearTimeout(prefsHoverTimer); prefsHoverTimer = null; }
function scheduleClosePrefs() {
    clearTimeout(prefsHoverTimer);
    prefsHoverTimer = setTimeout(() => {
        // 仅当桥接 select 的弹层（传送到 body、不在面板内）真的打开时，才不因鼠标离开而关闭。
        if (document.querySelector('[data-slot="select-trigger"][aria-expanded="true"], .ratio-picker-menu')) {
            scheduleClosePrefs();
            return;
        }
        closeAllPrefs();
    }, 260);
}

function positionPrefsPanel(panel, btn) {
    if (!panel || panel.hidden || !btn) return;
    const rect = btn.getBoundingClientRect?.();
    if (!rect) return;
    const margin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(360, viewportWidth - 24);
    // 跟随按钮左对齐，水平夹取避免出界。
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - width - margin));
    // 高度上限=视口高，绝不超出窗口；只有内容比视口还高时才滚动（普通面板不会出现滚动条）。
    const maxHeight = viewportHeight - margin * 2;
    panel.style.maxHeight = `${maxHeight}px`;
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.round(left)}px`;
    // 优先在按钮下方；若下方放不下，则上移贴合视口——始终浮于主内容之上、完整可见、不截断。
    const height = Math.min(panel.scrollHeight || maxHeight, maxHeight);
    let top = rect.bottom + margin;
    if (top + height > viewportHeight - margin) top = Math.max(margin, viewportHeight - margin - height);
    panel.style.top = `${Math.round(top)}px`;
}

function closeAllPrefs() {
    for (const { btn, panel } of PREFS_PANELS) {
        const p = document.getElementById(panel);
        if (p) p.hidden = true;
        document.getElementById(btn)?.setAttribute('aria-expanded', 'false');
    }
    openPrefsEntry = null;
}

function openPrefsPanel(entry) {
    if (openPrefsEntry && openPrefsEntry.panel === entry.panel) { cancelClosePrefs(); return; }
    closeAllPrefs();
    const panel = document.getElementById(entry.panel);
    const btn = document.getElementById(entry.btn);
    if (!panel || !btn) return;
    updatePrefsTriggerValues();
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    positionPrefsPanel(panel, btn);
    refreshLucideIcons(panel);
    openPrefsEntry = entry;
    cancelClosePrefs();
}

function togglePrefsPanel(entry) {
    const panel = document.getElementById(entry.panel);
    if (panel && !panel.hidden) closeAllPrefs();
    else openPrefsPanel(entry);
}

function repositionOpenPrefs() {
    if (!openPrefsEntry) return;
    positionPrefsPanel(document.getElementById(openPrefsEntry.panel), document.getElementById(openPrefsEntry.btn));
}

// ===== 置顶设置窗（独立 BrowserWindow）——高级面板 =====
// 面板真身仍是主窗里的隐藏 DOM（#prefsPanelAdvanced，所有 change 处理链不动）；
// 这里把它序列化成快照推给置顶窗镜像渲染，改动回流后写回隐藏控件并派发 change，
// 再回推新快照（显隐/数值标签由既有逻辑更新）。能力规则因此只有 desktop.js 一份。
let nativePrefsClosedAt = 0;

function nativePrefsAvailable() {
    return !!(window.picgenDesktop?.openPrefsWindow && window.picgenDesktop?.onPrefsChange);
}

function serializeAdvancedPrefsSnapshot() {
    const panel = document.getElementById('prefsPanelAdvanced');
    if (!panel) return null;
    const advanced = panel.querySelector('.advanced-settings');
    const controls = [];
    for (const label of panel.querySelectorAll('.advanced-grid > label')) {
        const field = label.querySelector('select, input, textarea');
        if (!field || !field.id) continue;
        const span = label.querySelector(':scope > span');
        const entry = { id: field.id, hidden: !!label.hidden };
        if (field.tagName === 'SELECT') {
            entry.type = 'select';
            entry.value = field.value;
            entry.options = Array.from(field.options, option => ({ value: option.value, label: option.textContent }));
            entry.label = span?.childNodes[0]?.textContent?.trim() || field.id;
        } else if (field.type === 'checkbox') {
            entry.type = 'checkbox';
            entry.checked = field.checked;
            entry.label = span?.textContent?.trim() || field.id;
        } else if (field.type === 'range') {
            entry.type = 'range';
            entry.value = field.value;
            entry.min = field.min; entry.max = field.max; entry.step = field.step;
            entry.label = span?.childNodes[0]?.textContent?.trim() || field.id;
            entry.valueLabel = span?.querySelector('b')?.textContent || null;
        } else {
            entry.type = field.type === 'number' ? 'number' : 'text';
            entry.value = field.value;
            entry.placeholder = field.placeholder || '';
            if (field.min !== '') entry.min = field.min;
            if (field.max !== '') entry.max = field.max;
            if (field.step !== '') entry.step = field.step;
            if (Number(field.maxLength) > 0) entry.maxLength = field.maxLength;
            entry.label = span?.childNodes[0]?.textContent?.trim() || field.id;
        }
        controls.push(entry);
    }
    const anyVisible = controls.some(control => !control.hidden);
    return {
        panel: 'advanced',
        title: '高级设置',
        hint: '模型支持的可选参数',
        empty: (advanced?.hidden || !anyVisible) ? '当前模型没有可调的高级参数' : null,
        controls
    };
}

// 画面面板快照：供应商/模型下拉、比例宫格（含形状图形参数）、分辨率/数量档位、
// 自定义尺寸。全部取自主窗隐藏控件的当前态。
function serializeImagePrefsSnapshot() {
    if (!el.providerSelect || !el.modelSelect) return null;
    const selectData = select => ({
        value: select.value,
        options: Array.from(select.options, option => ({ value: option.value, label: option.textContent || option.value, disabled: option.disabled }))
    });
    const tierData = select => (select && select.options.length ? {
        index: Math.max(0, select.selectedIndex),
        options: [...select.options].map(option => ({
            value: option.value,
            label: option.value === 'custom' ? '自定义' : (option.textContent || option.value)
        }))
    } : null);
    const ratioOptions = el.ratioSelect ? [...el.ratioSelect.options]
        .map((option, index) => ({ option, index, bucket: ratioGridBucket(option) }))
        .sort((a, b) => a.bucket - b.bucket || a.index - b.index)
        .map(({ option }) => {
            const isReference = option.value === 'reference';
            const isSmart = option.value === 'auto';
            const fullLabel = isReference ? '匹配参考图' : isSmart ? '智能比例' : (option.textContent || option.value);
            const metrics = getRatioVisualMetrics(option.value);
            return {
                value: option.value,
                disabled: option.disabled,
                label: isReference ? '参考图' : isSmart ? '智能' : fullLabel,
                title: fullLabel,
                shape: metrics ? { w: metrics.width, h: metrics.height } : null,
                symbol: isSmart ? 'scan' : 'scaling'
            };
        }) : [];
    return {
        panel: 'image',
        title: '画面设置',
        hint: '供应商 · 模型 · 比例 · 分辨率 · 数量',
        provider: selectData(el.providerSelect),
        model: selectData(el.modelSelect),
        ratio: { value: el.ratioSelect?.value || '', options: ratioOptions },
        resolution: tierData(el.imageSizeSelect),
        count: tierData(el.countSelect),
        customSize: {
            visible: !!document.querySelector('.custom-size-row [data-api-control="customSize"]:not([hidden])'),
            width: el.gptImageWidthInput?.value || '',
            height: el.gptImageHeightInput?.value || ''
        }
    };
}

// 两个可迁入置顶窗的面板：按钮 + 序列化器。
const NATIVE_PREFS_SOURCES = {
    advanced: { btn: 'prefsBtnAdvanced', serialize: () => serializeAdvancedPrefsSnapshot() },
    image: { btn: 'prefsBtnImage', serialize: () => serializeImagePrefsSnapshot() }
};
let nativePrefsLastKind = null;

function openNativePrefs(kind) {
    const source = NATIVE_PREFS_SOURCES[kind];
    const btn = source && document.getElementById(source.btn);
    if (!btn) return;
    closeAllPrefs();
    const rect = btn.getBoundingClientRect();
    state.nativePrefsOpen = kind;
    nativePrefsLastKind = kind;
    for (const [name, entry] of Object.entries(NATIVE_PREFS_SOURCES)) {
        document.getElementById(entry.btn)?.setAttribute('aria-expanded', String(name === kind));
    }
    window.picgenDesktop.openPrefsWindow({
        anchor: {
            x: Math.round(window.screenX + rect.left),
            y: Math.round(window.screenY + rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        },
        snapshot: source.serialize()
    });
}

// 兼容旧入口（诊断脚本/历史调用）。
function openNativeAdvancedPrefs() { openNativePrefs('advanced'); }

function resetNativePrefsButtons() {
    for (const entry of Object.values(NATIVE_PREFS_SOURCES)) {
        document.getElementById(entry.btn)?.setAttribute('aria-expanded', 'false');
    }
}

function closeNativePrefs() {
    if (!state.nativePrefsOpen) return;
    state.nativePrefsOpen = null;
    window.picgenDesktop.hidePrefsWindow?.();
    resetNativePrefsButtons();
}

function handleNativePrefsClosed() {
    if (!state.nativePrefsOpen) return;
    nativePrefsLastKind = state.nativePrefsOpen;
    state.nativePrefsOpen = null;
    nativePrefsClosedAt = Date.now();
    resetNativePrefsButtons();
}

// 同一轮同步代码里会连刷多次（换模型 → 重建档位 → 显隐），只推最后一份快照：
// 省掉重复序列化，也免得置顶窗闪一帧「新模型 + 旧比例」。
// 用 Promise 而非 queueMicrotask：单测跑在 vm 上下文，那里没有 queueMicrotask。
let nativePrefsSyncQueued = false;
function syncNativePrefs() {
    if (nativePrefsSyncQueued || !NATIVE_PREFS_SOURCES[state.nativePrefsOpen]) return;
    nativePrefsSyncQueued = true;
    Promise.resolve().then(() => {
        nativePrefsSyncQueued = false;
        const snapshot = NATIVE_PREFS_SOURCES[state.nativePrefsOpen]?.serialize();
        if (snapshot) window.picgenDesktop.syncPrefsWindow?.(snapshot);
    });
}

function applyNativePrefsChange(payload) {
    if (!payload) return;
    // 画面面板：按字段寻址写回隐藏控件，走既有 change 链。
    if (payload.panel === 'image') {
        const apply = (select, value) => {
            if (!select || select.value === String(value)) return;
            select.value = String(value);
            select.dispatchEvent(new Event('change', { bubbles: true }));
        };
        switch (payload.field) {
            case 'provider': apply(el.providerSelect, payload.value); break;
            case 'model': apply(el.modelSelect, payload.value); break;
            case 'ratio': apply(el.ratioSelect, payload.value); break;
            case 'resolution': {
                const option = el.imageSizeSelect?.options[Number(payload.value)];
                if (option) apply(el.imageSizeSelect, option.value);
                break;
            }
            case 'count': {
                const option = el.countSelect?.options[Number(payload.value)];
                if (option) apply(el.countSelect, option.value);
                break;
            }
            case 'customWidth':
            case 'customHeight': {
                const input = payload.field === 'customWidth' ? el.gptImageWidthInput : el.gptImageHeightInput;
                if (!input) break;
                input.value = payload.value != null ? String(payload.value) : '';
                roundImageSizeInputTo16(input);
                input.dispatchEvent(new Event('change', { bubbles: true }));
                break;
            }
        }
        // 同值点击（apply 早退、不派发 change）也回推：镜像与按钮一起对齐隐藏下拉。
        updatePrefsTriggerValues();
        return;
    }
    // 高级面板：按控件 id 寻址。
    const field = document.getElementById(String(payload.id || ''));
    if (!field || !field.closest('#prefsPanelAdvanced')) return; // 只接受高级面板内的控件
    if (field.type === 'checkbox') field.checked = !!payload.checked;
    else field.value = payload.value != null ? String(payload.value) : '';
    // 控件的 change 监听（saveAndUpdate）会持久化、更新数值标签与能力显隐，
    // 末端的 updateAdvancedSettingsVisibility 会回推新快照给置顶窗。
    field.dispatchEvent(new Event('change', { bubbles: true }));
}

function bindGenerationPrefsEvents() {
    let bound = false;
    for (const entry of PREFS_PANELS) {
        const btn = document.getElementById(entry.btn);
        if (!btn) continue;
        bound = true;
        // 两个面板都优先走独立置顶窗（可超出主窗、覆盖其上）；无置顶能力时回退主窗内面板。
        const nativeKind = entry.btn === 'prefsBtnAdvanced' ? 'advanced'
            : entry.btn === 'prefsBtnImage' ? 'image' : null;
        // 点击=开关该面板（不再 hover 弹出，避免误触）。置顶窗因本次点击失焦刚被
        // blur 关闭（同一个按钮）时，视为"关闭"而不是立刻重开（350ms 手感窗口）。
        btn.addEventListener('click', event => {
            event.stopPropagation();
            if (nativeKind && nativePrefsAvailable()) {
                if (state.nativePrefsOpen === nativeKind) { closeNativePrefs(); return; }
                if (!state.nativePrefsOpen && nativePrefsLastKind === nativeKind
                    && Date.now() - nativePrefsClosedAt < 350) return;
                openNativePrefs(nativeKind);
                return;
            }
            closeNativePrefs();
            togglePrefsPanel(entry);
        });
        // 已有面板（主窗内或置顶窗）打开时，鼠标横移到相邻触发器即无缝切换；
        // 没有任何面板打开时 hover 不弹出。
        btn.addEventListener('mouseenter', () => {
            if (nativeKind && nativePrefsAvailable()) {
                const somethingOpen = openPrefsEntry || state.nativePrefsOpen;
                if (somethingOpen && state.nativePrefsOpen !== nativeKind) openNativePrefs(nativeKind);
                return;
            }
            if (state.nativePrefsOpen) { closeNativePrefs(); openPrefsPanel(entry); return; }
            if (openPrefsEntry && openPrefsEntry.panel !== entry.panel) openPrefsPanel(entry);
        });
        // 移出即关（接力式）：离开触发按钮 350ms 内若指针没进入置顶窗（或另一触发器
        // 重开面板），置顶窗自动消失；进入窗体则由 pointer-enter 取消定时器。
        btn.addEventListener('mouseleave', () => {
            if (nativeKind && state.nativePrefsOpen === nativeKind) {
                window.picgenDesktop.schedulePrefsClose?.();
            }
        });
    }
    if (!bound) return;
    // 置顶设置窗的回流通道：改动写回隐藏控件、关闭同步触发按钮状态。
    window.picgenDesktop.onPrefsChange?.(applyNativePrefsChange);
    window.picgenDesktop.onPrefsClosed?.(handleNativePrefsClosed);
    updatePrefsTriggerValues();
    document.querySelectorAll('.prefs-close').forEach(button => button.addEventListener('click', () => closeAllPrefs()));
    window.addEventListener('resize', repositionOpenPrefs);
    window.addEventListener('scroll', repositionOpenPrefs, true);
    document.addEventListener('pointerdown', event => {
        if (!openPrefsEntry) return;
        // 面板内、任一触发按钮、以及被传送到 body 的 Appica select 弹层内的点击都不关闭。
        const t = event.target;
        if (t.closest?.('.generation-prefs-panel, #prefsBtnProvider, #prefsBtnImage, #prefsBtnAdvanced, .ratio-picker-menu, #referenceRatioPicker')) return;
        if (t.closest?.('[data-slot^="select"], [data-slot^="popover"], [role="listbox"], [role="option"]')) return;
        closeAllPrefs();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && openPrefsEntry) closeAllPrefs();
    });
}

function bindReferenceRatioPickerEvents() {
    if (!el.referenceRatioPicker) return;
    el.referenceRatioPickerClose?.addEventListener('click', () => closeReferenceRatioPicker());
    window.addEventListener('resize', positionReferenceRatioPicker);
    window.addEventListener('scroll', positionReferenceRatioPicker, true);
    document.addEventListener('pointerdown', event => {
        if (!el.referenceRatioPicker.hidden && !event.target.closest('#referenceRatioPicker, #ratioGrid, [data-select-id="ratioSelect"]')) {
            closeReferenceRatioPicker();
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !el.referenceRatioPicker.hidden) closeReferenceRatioPicker();
    });
}

function getRatioVisualMetrics(value) {
    const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/i);
    if (!match) return null;
    const sourceWidth = Number(match[1]);
    const sourceHeight = Number(match[2]);
    if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
    const scale = Math.min(22 / sourceWidth, 18 / sourceHeight);
    return {
        sourceWidth,
        sourceHeight,
        width: Math.max(3, Number((sourceWidth * scale).toFixed(2))),
        height: Math.max(3, Number((sourceHeight * scale).toFixed(2)))
    };
}

function getRatioOrientationDescription(metrics) {
    if (!metrics) return '自定义尺寸';
    const difference = Math.abs(metrics.sourceWidth - metrics.sourceHeight);
    if (difference < 0.01) return '方形比例';
    return metrics.sourceWidth > metrics.sourceHeight ? '横向比例' : '竖向比例';
}

// 给优化器看的比例说明。它得知道「这次要出什么画幅」，才能在提示词里与用户描述冲突时
// 以参数为准 —— 否则用户写着「画幅 3:4」而生成区设的是 1:1，优化结果就会自相矛盾。
function describeSequenceRatio(ratioValue) {
    const value = String(ratioValue || '').trim();
    if (!value) return '';
    if (value === 'reference') return '贴合参考图比例（由上传的参考图决定，提示词里不要写死具体画幅）';
    const metrics = getRatioVisualMetrics(value);
    return metrics ? `${value}（${getRatioOrientationDescription(metrics)}）` : value;
}

function createRatioVisual(value) {
    const metrics = getRatioVisualMetrics(value);
    const visual = document.createElement('span');
    visual.className = 'ratio-option-visual';
    visual.setAttribute('aria-hidden', 'true');

    if (!metrics) {
        const icon = document.createElement('i');
        icon.dataset.lucide = String(value || '').toLowerCase() === 'auto' ? 'scan' : 'scaling';
        visual.classList.add('is-symbolic');
        visual.appendChild(icon);
        return visual;
    }

    const shape = document.createElement('span');
    shape.className = 'ratio-shape';
    shape.style.width = `${metrics.width}px`;
    shape.style.height = `${metrics.height}px`;
    shape.dataset.ratioWidth = String(metrics.sourceWidth);
    shape.dataset.ratioHeight = String(metrics.sourceHeight);
    visual.appendChild(shape);
    return visual;
}

// 内联比例网格（Tabs 样式）：从 #ratioSelect 的选项渲染形状图标按钮，
// 分组顺序为 参考图 → 方形 → 横向 → 竖向，铺在一个 flex-wrap 区域内。
// 点击写回 #ratioSelect 并派发 change，复用既有比例逻辑（含 reference 打开参考图匹配）。
function ratioGridBucket(option) {
    if (option.value === 'reference') return 0;
    const metrics = getRatioVisualMetrics(option.value);
    if (!metrics) return 1; // 符号项（如 auto）
    if (Math.abs(metrics.sourceWidth - metrics.sourceHeight) < 0.01) return 1; // 方形
    return metrics.sourceWidth > metrics.sourceHeight ? 2 : 3; // 横向 / 竖向
}

function renderRatioGrid() {
    if (!el.ratioGrid || !el.ratioSelect) return;
    const ordered = [...el.ratioSelect.options]
        .map((option, index) => ({ option, index, bucket: ratioGridBucket(option) }))
        .sort((a, b) => a.bucket - b.bucket || a.index - b.index);
    el.ratioGrid.replaceChildren();
    for (const { option } of ordered) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'ratio-grid-item';
        item.dataset.value = option.value;
        item.disabled = option.disabled;
        const isReference = option.value === 'reference';
        const isSmart = option.value === 'auto';
        const fullLabel = isReference ? '匹配参考图' : isSmart ? '智能比例' : (option.textContent || option.value);
        const shortLabel = isReference ? '参考图' : isSmart ? '智能' : fullLabel;
        item.title = fullLabel;
        item.appendChild(createRatioVisual(option.value));
        const text = document.createElement('span');
        text.className = 'ratio-grid-label';
        text.textContent = shortLabel;
        item.appendChild(text);
        item.addEventListener('click', () => {
            if (el.ratioSelect.value === option.value && option.value !== 'reference') return;
            el.ratioSelect.value = option.value;
            el.ratioSelect.dispatchEvent(new Event('change', { bubbles: true }));
        });
        el.ratioGrid.appendChild(item);
    }
    updateRatioGridSelection();
    refreshLucideIcons(el.ratioGrid);
}

function updateRatioGridSelection() {
    if (!el.ratioGrid) return;
    const value = el.ratioSelect?.value;
    for (const item of el.ratioGrid.querySelectorAll('.ratio-grid-item')) {
        const active = item.dataset.value === value;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
    }
}

// 把任意隐藏原生 <select> 渲染成 Appica Slider（离散档位），并双向同步。
function renderOptionSliderInto(host, select, ariaLabel) {
    if (!host || !select || !window.PicGenAppica?.renderOptionSlider) return;
    const options = [...select.options].map(option => ({
        value: option.value,
        label: option.value === 'custom' ? '自定义' : (option.textContent || option.value),
    }));
    window.PicGenAppica.renderOptionSlider(host, {
        options,
        index: Math.max(0, select.selectedIndex),
        ariaLabel,
        onChange: nextIndex => {
            const option = select.options[nextIndex];
            if (!option || select.value === option.value) return;
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        },
    });
}

// 选“自定义分辨率”时，比例自动切到 auto（智能）——宽高已决定画幅，比例交给智能。
function syncRatioForCustomSize() {
    if (!el.imageSizeSelect || !el.ratioSelect) return;
    if (el.imageSizeSelect.value !== 'custom') return;
    const hasAuto = [...el.ratioSelect.options].some(option => option.value === 'auto');
    if (hasAuto && el.ratioSelect.value !== 'auto') {
        el.ratioSelect.value = 'auto';
        el.ratioSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

// 自定义分辨率输入自动取最接近的 16 倍数（夹在 256–3840）。
function roundImageSizeInputTo16(input) {
    if (!input) return;
    const raw = Number(input.value);
    if (!Number.isFinite(raw) || raw <= 0) return;
    const rounded = Math.min(3840, Math.max(256, Math.round(raw / 16) * 16));
    if (String(rounded) !== String(input.value)) {
        input.value = String(rounded);
        saveCurrentSequenceFromForm();
    }
}

// 分辨率 + 数量：并排的 Appica Slider，从隐藏原生 select 渲染。
function renderGenerationSliders() {
    const resField = document.getElementById('imageSizeSliderField');
    const hasResolution = !!(el.imageSizeSelect && el.imageSizeSelect.options.length > 0);
    if (resField) resField.hidden = !hasResolution;
    if (hasResolution) renderOptionSliderInto(el.imageSizeSliderHost, el.imageSizeSelect, '分辨率');
    renderOptionSliderInto(el.countSliderHost, el.countSelect, '数量');
}

function updateRatioPickerSelection() {
    if (!el.ratioPickerMenu) return;
    const value = el.ratioSelect.value;
    const selectedOption = [...el.ratioSelect.options].find(option => option.value === value);
    el.ratioPickerValue.textContent = selectedOption?.textContent || value || '选择';
    el.ratioPickerIcon.replaceChildren(createRatioVisual(value));

    for (const option of el.ratioPickerMenu.querySelectorAll('.ratio-picker-option')) {
        const selected = option.dataset.value === value;
        option.classList.toggle('selected', selected);
        option.setAttribute('aria-selected', String(selected));
        option.tabIndex = selected ? 0 : -1;
    }
    refreshLucideIcons(el.ratioPickerIcon);
}

function renderRatioPickerOptions() {
    if (!el.ratioPickerMenu) return;
    closeRatioPicker();
    el.ratioPickerMenu.innerHTML = '';

    [...el.ratioSelect.options].forEach((nativeOption, index) => {
        const option = document.createElement('button');
        const metrics = getRatioVisualMetrics(nativeOption.value);
        option.id = `ratioPickerOption${index}`;
        option.type = 'button';
        option.className = 'ratio-picker-option';
        option.dataset.value = nativeOption.value;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-label', `${nativeOption.textContent}，${getRatioOrientationDescription(metrics)}`);
        option.disabled = nativeOption.disabled;
        option.appendChild(createRatioVisual(nativeOption.value));

        const label = document.createElement('span');
        label.className = 'ratio-picker-option-label';
        label.textContent = nativeOption.textContent;
        option.appendChild(label);

        const check = document.createElement('i');
        check.className = 'ratio-option-check';
        check.dataset.lucide = 'check';
        check.setAttribute('aria-hidden', 'true');
        option.appendChild(check);
        option.addEventListener('click', () => selectRatioPickerValue(nativeOption.value));
        el.ratioPickerMenu.appendChild(option);
    });

    updateRatioPickerSelection();
    refreshLucideIcons(el.ratioPickerMenu);
}

function openRatioPicker({ focusSelected = false } = {}) {
    if (!el.ratioPickerMenu.hidden) return;
    el.ratioPickerMenu.hidden = false;
    if (typeof el.ratioPickerMenu.showPopover === 'function') {
        el.ratioPickerMenu.showPopover();
    }
    el.ratioPickerButton.setAttribute('aria-expanded', 'true');
    el.ratioPicker.classList.add('open');
    updateRatioPickerSelection();
    positionRatioPickerMenu();
    if (focusSelected) {
        requestAnimationFrame(() => {
            el.ratioPickerMenu.querySelector('.ratio-picker-option.selected')?.focus();
        });
    }
}

function closeRatioPicker({ restoreFocus = false } = {}) {
    if (!el.ratioPickerMenu || el.ratioPickerMenu.hidden) return;
    if (typeof el.ratioPickerMenu.hidePopover === 'function' && el.ratioPickerMenu.matches(':popover-open')) {
        el.ratioPickerMenu.hidePopover();
    }
    el.ratioPickerMenu.hidden = true;
    el.ratioPickerButton.setAttribute('aria-expanded', 'false');
    el.ratioPicker.classList.remove('open');
    if (restoreFocus) el.ratioPickerButton.focus();
}

function positionRatioPickerMenu() {
    if (!el.ratioPickerMenu || el.ratioPickerMenu.hidden) return;
    const viewportMargin = 8;
    const triggerGap = 6;
    const triggerRect = el.ratioPickerButton.getBoundingClientRect();
    const menuWidth = Math.min(220, window.innerWidth - viewportMargin * 2);
    el.ratioPickerMenu.style.width = `${menuWidth}px`;
    el.ratioPickerMenu.style.maxHeight = '300px';

    const availableAbove = triggerRect.top - viewportMargin - triggerGap;
    const availableBelow = window.innerHeight - triggerRect.bottom - viewportMargin - triggerGap;
    const naturalHeight = Math.min(el.ratioPickerMenu.scrollHeight, 300);
    const opensUp = availableBelow < naturalHeight && availableAbove > availableBelow;
    const availableHeight = opensUp ? availableAbove : availableBelow;
    const maxHeight = Math.max(96, Math.min(300, availableHeight));
    el.ratioPickerMenu.style.maxHeight = `${maxHeight}px`;

    const renderedHeight = Math.min(el.ratioPickerMenu.scrollHeight, maxHeight);
    const left = Math.min(
        Math.max(viewportMargin, triggerRect.right - menuWidth),
        window.innerWidth - menuWidth - viewportMargin
    );
    const top = opensUp
        ? triggerRect.top - renderedHeight - triggerGap
        : triggerRect.bottom + triggerGap;
    el.ratioPickerMenu.style.left = `${Math.round(left)}px`;
    el.ratioPickerMenu.style.top = `${Math.round(Math.max(viewportMargin, top))}px`;
    el.ratioPickerMenu.classList.toggle('opens-up', opensUp);
}

function selectRatioPickerValue(value) {
    if (![...el.ratioSelect.options].some(option => option.value === value)) return;
    el.ratioSelect.value = value;
    el.ratioSelect.dispatchEvent(new Event('change', { bubbles: true }));
    closeRatioPicker({ restoreFocus: true });
}

function moveRatioPickerFocus(direction) {
    const options = [...el.ratioPickerMenu.querySelectorAll('.ratio-picker-option:not(:disabled)')];
    if (!options.length) return;
    const currentIndex = options.indexOf(document.activeElement);
    let nextIndex;
    if (direction === 'first') nextIndex = 0;
    else if (direction === 'last') nextIndex = options.length - 1;
    else nextIndex = (Math.max(0, currentIndex) + direction + options.length) % options.length;
    options[nextIndex].focus();
}

function bindRatioPickerEvents() {
    if (window.PicGenAppica) return;
    renderRatioPickerOptions();
    el.ratioPickerButton.addEventListener('click', () => {
        if (el.ratioPickerMenu.hidden) openRatioPicker();
        else closeRatioPicker();
    });
    el.ratioPickerButton.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        openRatioPicker({ focusSelected: true });
    });
    el.ratioPickerMenu.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault();
            moveRatioPickerFocus(1);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault();
            moveRatioPickerFocus(-1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            moveRatioPickerFocus('first');
        } else if (event.key === 'End') {
            event.preventDefault();
            moveRatioPickerFocus('last');
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closeRatioPicker({ restoreFocus: true });
        }
    });
    document.addEventListener('pointerdown', event => {
        if (!event.target.closest('#ratioPicker')) closeRatioPicker();
    });
    window.addEventListener('resize', positionRatioPickerMenu);
    window.addEventListener('blur', () => closeRatioPicker());
}

function writeAdvancedSettingsToForm(sequence) {
    const advanced = createDefaultAdvancedSettings(sequence.advanced);
    const profile = imageApiProfiles.getImageApiProfile(sequence.model);
    updateModelSpecificAdvancedOptions(profile, advanced);
    el.outputMimeSelect.value = advanced.outputMimeType;
    el.imageCompressionRange.value = advanced.imageCompression || '80';
    el.gptImageWidthInput.value = advanced.gptImageWidth;
    el.gptImageHeightInput.value = advanced.gptImageHeight;
    el.openAIModerationSelect.value = advanced.openAIModeration;
    el.nativeResponseFormatSelect.value = advanced.nativeResponseFormat;
    el.openAIStyleSelect.value = advanced.openAIStyle;
    el.inputFidelitySelect.value = advanced.inputFidelity;
    el.apiUserInput.value = advanced.apiUser;
    el.responseModalitiesSelect.value = advanced.responseModalities;
    el.thinkingLevelSelect.value = advanced.thinkingLevel;
    el.includeThoughtsToggle.checked = !!advanced.includeThoughts;
    el.temperatureInput.value = advanced.temperature;
    el.topPInput.value = advanced.topP;
    el.topKInput.value = advanced.topK;
    el.googleSearchToggle.checked = !!advanced.googleSearch;
    el.imageSearchToggle.checked = !!advanced.imageSearch;
    el.xaiStoreToggle.checked = !!advanced.xaiStore;
    el.xaiFilenameInput.value = advanced.xaiFilename;
    el.xaiExpiresAfterInput.value = advanced.xaiExpiresAfter;
    el.xaiPublicUrlToggle.checked = !!advanced.xaiPublicUrl;
    updateCompressionValue();
    updateAdvancedSettingsVisibility();
}

function buildGenerationConfig(sequence) {
    const advanced = createDefaultAdvancedSettings(sequence.advanced);
    const profile = imageApiProfiles.getImageApiProfile(sequence.model);
    const kind = profile.apiKind;
    const config = {};

    if (profile.controls.outputFormat && advanced.outputMimeType) config.outputMimeType = advanced.outputMimeType;
    if (profile.controls.compression && advanced.imageCompression !== '' && advanced.outputMimeType) {
        config.imageCompression = parseInt(advanced.imageCompression, 10);
    }

    if (kind === 'openai') {
        if (advanced.gptQuality) config.gptQuality = advanced.gptQuality;
        if (advanced.gptBackground) config.gptBackground = advanced.gptBackground;
        if (advanced.gptImageWidth !== '') config.gptImageWidth = parseInt(advanced.gptImageWidth, 10);
        if (advanced.gptImageHeight !== '') config.gptImageHeight = parseInt(advanced.gptImageHeight, 10);
        if (advanced.openAIModeration) config.moderation = advanced.openAIModeration;
        if (advanced.nativeResponseFormat) config.responseFormat = advanced.nativeResponseFormat;
        if (advanced.openAIStyle) config.style = advanced.openAIStyle;
        if (advanced.inputFidelity) config.inputFidelity = advanced.inputFidelity;
        if (advanced.apiUser) config.user = advanced.apiUser;
    }

    if (kind === 'gemini') {
        config.responseModalities = advanced.responseModalities || 'TEXT_IMAGE';
        config.thinkingLevel = advanced.thinkingLevel || 'default';
        config.includeThoughts = !!advanced.includeThoughts;
        if (advanced.temperature !== '') config.temperature = parseFloat(advanced.temperature);
        if (advanced.topP !== '') config.topP = parseFloat(advanced.topP);
        if (advanced.topK !== '') config.topK = parseInt(advanced.topK, 10);
        config.googleSearch = !!advanced.googleSearch;
        config.imageSearch = !!advanced.imageSearch;
    }

    if (kind === 'xai') {
        if (profile.controls.quality && advanced.gptQuality) config.gptQuality = advanced.gptQuality;
        if (profile.controls.responseFormat && advanced.nativeResponseFormat) {
            config.responseFormat = advanced.nativeResponseFormat;
        }
    }

    return config;
}

function updateCompressionValue() {
    el.imageCompressionValue.textContent = el.imageCompressionRange.value;
}

function updateAdvancedSettingsVisibility() {
    const sequence = getCurrentSequence();
    const model = el.modelSelect.value || sequence.model || '';
    const profile = imageApiProfiles.getImageApiProfile(model);
    const hasAdvancedSettings = profile.apiKind !== 'legacy';
    const advancedPanel = document.querySelector('.advanced-settings');

    if (advancedPanel) {
        advancedPanel.hidden = !hasAdvancedSettings;
        if (!hasAdvancedSettings) advancedPanel.open = false;
    }

    document.querySelectorAll('[data-api-control]').forEach(node => {
        const control = node.dataset.apiControl;
        let visible = !!profile.controls[control];
        if (control === 'customSize') visible = visible && el.imageSizeSelect.value === 'custom';
        if (control === 'compression') {
            visible = visible && ['image/jpeg', 'image/webp'].includes(el.outputMimeSelect.value);
        }
        if (control === 'inputFidelity') visible = visible && sequence.references.length > 0;
        if (control === 'xaiStorageOption') visible = !!profile.controls.xaiStorage && el.xaiStoreToggle.checked;
        node.hidden = !visible;
    });
    // 置顶设置窗打开时，把最新显隐/数值同步过去（它是本面板的镜像）；
    // 经 updatePrefsTriggerValues 让触发按钮摘要同源刷新，两边不会分叉。
    updatePrefsTriggerValues();
}

function normalizeReferences(references = []) {
    if (!Array.isArray(references)) return [];
    return references
        .filter(ref => ref && (ref.base64 || ref.filePath))
        .slice(0, 16)
        .map(ref => ({
            id: ref.id || `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: ref.name || 'reference.png',
            alias: ref.alias || '',
            mimeType: ref.mimeType || 'image/png',
            base64: ref.base64 || '',
            filePath: ref.filePath || '',
            ...referenceAnnotationFields(ref)
        }));
}

// 标注图记住自己的标注文档和原图，便于原位重新编辑。
function referenceAnnotationFields(ref) {
    const fields = {};
    // 图片工作台：文档 + 原始图片的缓存路径
    if (ref?.workspace?.doc && Array.isArray(ref.workspace.sourceFiles)) fields.workspace = ref.workspace;
    return fields;
}

function serializeReference(reference) {
    const ref = normalizeReferences([reference])[0];
    if (!ref) return null;
    const serialized = {
        id: ref.id,
        name: ref.name,
        alias: ref.alias,
        mimeType: ref.mimeType,
        ...referenceAnnotationFields(ref)
    };
    if (ref.filePath) {
        serialized.filePath = ref.filePath;
    } else if (ref.base64) {
        serialized.base64 = ref.base64;
    }
    return serialized;
}

async function persistReferenceImage(reference) {
    if (!reference?.base64 || reference.filePath || !window.picgenDesktop?.saveReferenceImage) {
        return reference;
    }

    try {
        const saved = await window.picgenDesktop.saveReferenceImage({
            id: reference.id,
            name: reference.name,
            mimeType: reference.mimeType,
            base64: reference.base64
        });
        return {
            ...reference,
            filePath: saved.filePath || reference.filePath || '',
            mimeType: saved.mimeType || reference.mimeType || 'image/png'
        };
    } catch (error) {
        console.warn('[References] cache save failed:', error.message);
        return reference;
    }
}

async function deleteReferenceImageCache(reference) {
    if (!reference?.filePath || !window.picgenDesktop?.deleteReferenceImage) return;
    try {
        await window.picgenDesktop.deleteReferenceImage({ filePath: reference.filePath });
    } catch (error) {
        console.warn('[References] cache delete failed:', error.message);
    }
}

function deleteReferenceImagesCache(references = []) {
    for (const reference of normalizeReferences(references)) {
        deleteReferenceImageCache(reference);
        for (const file of reference.workspace?.sourceFiles || []) deleteReferenceImageCache(file);
    }
}

async function hydrateSequenceReferences(sequences = state.sequences) {
    let changed = false;

    for (const sequence of sequences) {
        if (!sequence?.id || state.hydratedSequenceIds.has(sequence.id)) continue;
        let hydration = state.sequenceHydrationPromises.get(sequence.id);
        if (!hydration) {
            hydration = hydrateSequenceReferenceSet(sequence);
            state.sequenceHydrationPromises.set(sequence.id, hydration);
        }

        try {
            if (await hydration) changed = true;
            state.hydratedSequenceIds.add(sequence.id);
        } finally {
            state.sequenceHydrationPromises.delete(sequence.id);
        }
    }

    if (changed) saveSequences();
}

async function hydrateSequenceReferenceSet(sequence) {
    let changed = false;
    const originalReferences = Array.isArray(sequence.references) ? sequence.references : [];
    const hydrated = [];

    for (const ref of normalizeReferences(originalReferences)) {
        let nextRef = ref;
        if (!nextRef.base64 && nextRef.filePath && window.picgenDesktop?.loadReferenceImage) {
            try {
                const loaded = await window.picgenDesktop.loadReferenceImage({
                    filePath: nextRef.filePath,
                    mimeType: nextRef.mimeType
                });
                nextRef = {
                    ...nextRef,
                    base64: loaded.base64 || '',
                    mimeType: loaded.mimeType || nextRef.mimeType || 'image/png'
                };
            } catch (error) {
                console.warn('[References] cache load failed:', error.message);
                changed = true;
                continue;
            }
        }

        const persisted = await persistReferenceImage(nextRef);
        if (persisted.filePath && persisted.filePath !== nextRef.filePath) {
            changed = true;
        }
        hydrated.push(persisted);
    }

    if (hydrated.length !== originalReferences.length) {
        changed = true;
    }
    sequence.references = hydrated;
    return changed;
}

function createSequence(overrides = {}) {
    return {
        id: overrides.id || `desktop_seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: overrides.name || `序列${state.sequences.length + 1}`,
        prompt: overrides.prompt || '',
        providerId: overrides.providerId || state.currentPresetId || state.presets[0]?.id || '',
        model: overrides.model || '',
        ratio: overrides.ratio || '1:1',
        count: overrides.count || '1',
        imageSize: overrides.imageSize || imageApiProfiles.DEFAULT_IMAGE_SIZE,
        advanced: createDefaultAdvancedSettings(overrides.advanced || overrides.generationConfig),
        references: normalizeReferences(overrides.references),
        runningTasks: new Set(),
        taskProgress: new Map(),
        batch: createEmptyBatch(),
        status: overrides.status || '就绪'
    };
}

function createEmptyBatch(overrides = {}) {
    return {
        id: overrides.id || '',
        total: Number(overrides.total || 0),
        taskIds: overrides.taskIds instanceof Set ? overrides.taskIds : new Set(overrides.taskIds || []),
        taskStates: overrides.taskStates instanceof Map ? overrides.taskStates : new Map(overrides.taskStates || []),
        sourceBatchTotals: overrides.sourceBatchTotals instanceof Map
            ? overrides.sourceBatchTotals
            : new Map(overrides.sourceBatchTotals || []),
        enqueueing: Math.max(0, Number(overrides.enqueueing || 0)),
        createdAt: overrides.createdAt || 0
    };
}

function ensureSequenceRuntime(sequence) {
    if (!sequence.runningTasks || !(sequence.runningTasks instanceof Set)) {
        sequence.runningTasks = new Set(sequence.runningTasks || []);
    }
    if (!sequence.taskProgress || !(sequence.taskProgress instanceof Map)) {
        sequence.taskProgress = new Map(sequence.taskProgress || []);
    }
    if (!sequence.batch || !(sequence.batch.taskIds instanceof Set) || !(sequence.batch.taskStates instanceof Map)) {
        sequence.batch = createEmptyBatch(sequence.batch);
    } else {
        if (!(sequence.batch.sourceBatchTotals instanceof Map)) {
            sequence.batch.sourceBatchTotals = new Map(sequence.batch.sourceBatchTotals || []);
        }
        sequence.batch.enqueueing = Math.max(0, Number(sequence.batch.enqueueing || 0));
    }
    return sequence;
}

function batchHasOpenTasks(batch) {
    if (!batch) return false;
    if (batch.enqueueing > 0) return true;
    return [...batch.taskStates.values()].some(status => !isTerminalTaskStatus(status));
}

function recalculateBatchTotal(batch) {
    if (!batch) return 0;
    const sourceTotal = [...batch.sourceBatchTotals.values()]
        .reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
    batch.total = Math.max(Number(batch.total || 0), batch.taskIds.size, sourceTotal);
    return batch.total;
}

function startBatch(sequence, total) {
    ensureSequenceRuntime(sequence);
    const requestedTotal = Math.max(1, Number(total || 1));
    const appendToOpenRun = sequence.batch.id
        && (sequence.runningTasks.size > 0 || batchHasOpenTasks(sequence.batch));

    if (!appendToOpenRun) {
        sequence.taskProgress.clear();
        const id = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        sequence.batch = createEmptyBatch({
            id,
            total: requestedTotal,
            sourceBatchTotals: [[id, requestedTotal]],
            createdAt: Date.now()
        });
    }

    const batch = sequence.batch;
    const currentSourceTotal = Math.max(0, Number(batch.sourceBatchTotals.get(batch.id) || 0));
    const startIndex = appendToOpenRun ? currentSourceTotal : 0;
    if (appendToOpenRun) {
        batch.sourceBatchTotals.set(batch.id, currentSourceTotal + requestedTotal);
        recalculateBatchTotal(batch);
    }
    batch.enqueueing += 1;
    updateBatchProgress();
    return {
        batch,
        startIndex,
        batchTotal: batch.sourceBatchTotals.get(batch.id) || requestedTotal
    };
}

function finishBatchSubmission(sequence, batch) {
    if (!sequence || !batch) return;
    batch.enqueueing = Math.max(0, Number(batch.enqueueing || 0) - 1);
    if (sequence.batch === batch) updateBatchProgress();
}

function restoreBatchFromTask(sequence, task) {
    if (!task?.batchId) return null;
    ensureSequenceRuntime(sequence);
    const keepOpenRun = sequence.batch.id
        && sequence.batch.id !== task.batchId
        && (sequence.runningTasks.size > 0 || batchHasOpenTasks(sequence.batch));
    if (!sequence.batch.id || (!keepOpenRun && sequence.batch.id !== task.batchId && task.createdAt > sequence.batch.createdAt)) {
        const sourceTotal = Math.max(Number(task.batchTotal || 0), Number(task.batchIndex || 0) + 1, 1);
        sequence.batch = createEmptyBatch({
            id: task.batchId,
            total: sourceTotal,
            sourceBatchTotals: [[task.batchId, sourceTotal]],
            createdAt: task.createdAt || Date.now()
        });
    }
    return sequence.batch.id === task.batchId || keepOpenRun ? sequence.batch : null;
}

function isTerminalTaskStatus(status) {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function trackBatchTask(sequence, batch, taskId, status = 'pending') {
    if (!sequence || !batch || !taskId) return;
    const previous = batch.taskStates.get(taskId);
    if (isTerminalTaskStatus(previous) && !isTerminalTaskStatus(status)) {
        return;
    }
    if (previous === 'running' && status === 'pending') return;
    batch.taskIds.add(taskId);
    batch.taskStates.set(taskId, status);
    recalculateBatchTotal(batch);
    if (isTerminalTaskStatus(status)) {
        sequence.taskProgress?.delete(taskId);
    }
    if (sequence.batch?.id === batch.id) updateBatchProgress();
}

function markBatchTaskStatus(sequence, taskId, status) {
    ensureSequenceRuntime(sequence);
    const batch = sequence.batch;
    if (!batch?.taskIds?.has(taskId)) return;
    trackBatchTask(sequence, batch, taskId, status);
}

function markOpenBatchTasksCancelled(sequence) {
    ensureSequenceRuntime(sequence);
    const batch = sequence.batch;
    if (!batch?.taskIds) return;
    for (const taskId of batch.taskIds) {
        const status = batch.taskStates.get(taskId);
        if (!isTerminalTaskStatus(status)) {
            batch.taskStates.set(taskId, 'cancelled');
        }
    }
    updateBatchProgress();
}

function updateBatchFromTask(sequence, task) {
    if (!task?.batchId) return;
    const batch = restoreBatchFromTask(sequence, task);
    if (!batch) return;

    const batchIndexTotal = Number.isFinite(task.batchIndex) ? task.batchIndex + 1 : 0;
    const sourceTotal = Math.max(
        Number(batch.sourceBatchTotals.get(task.batchId) || 0),
        Number(task.batchTotal || 0),
        batchIndexTotal,
        1
    );
    batch.sourceBatchTotals.set(task.batchId, sourceTotal);
    recalculateBatchTotal(batch);
    trackBatchTask(sequence, batch, task.id, task.status || 'pending');
    if (task.progress && !isTerminalTaskStatus(task.status)) {
        sequence.taskProgress.set(task.id, task.progress);
    }
}

function getBatchCounts(batch) {
    const counts = {
        completed: 0,
        failed: 0,
        cancelled: 0,
        terminal: 0
    };

    if (!batch?.taskStates) return counts;

    for (const status of batch.taskStates.values()) {
        if (status === 'completed') counts.completed += 1;
        if (status === 'failed') counts.failed += 1;
        if (status === 'cancelled') counts.cancelled += 1;
        if (isTerminalTaskStatus(status)) counts.terminal += 1;
    }

    return counts;
}

function normalizeProgressPercent(progress) {
    const value = Number(progress?.displayProgress);
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, value));
}

function getLatestTaskProgress(sequence) {
    ensureSequenceRuntime(sequence);
    let latest = null;
    for (const taskId of sequence.runningTasks) {
        const progress = sequence.taskProgress.get(taskId);
        if (!progress) continue;
        if (!latest || (progress.updatedAt || 0) >= (latest.updatedAt || 0)) {
            latest = progress;
        }
    }
    return latest;
}

function progressPhaseText(progress) {
    if (!progress) return '';
    const phaseText = {
        requesting: '提交请求',
        routing: '选择通道',
        failover: '切换通道',
        response_received: '收到响应',
        image_received: '图片已生成',
        downloading: '下载图片',
        downloaded: '下载完成',
        saving: '本地保存',
        'outcome-uncertain': '结果待确认'
    };
    const label = phaseText[progress.phase] || progress.message || '生成中';
    const percent = normalizeProgressPercent(progress);
    return percent == null ? label : `${label} ${Math.round(percent)}%`;
}

function updateBatchProgress() {
    if (!el.batchProgressText || !el.batchProgressCount || !el.batchProgressBar) return;

    const sequence = getCurrentSequence();
    ensureSequenceRuntime(sequence);
    const runningTotal = sequence.runningTasks.size;
    const batch = sequence.batch;
    const counts = getBatchCounts(batch);
    const trackedTaskIds = new Set(batch?.taskIds || []);
    for (const taskId of sequence.runningTasks) trackedTaskIds.add(taskId);
    const batchTotal = Math.max(batch?.total || 0, trackedTaskIds.size);
    const liveProgress = getLatestTaskProgress(sequence);
    const liveText = progressPhaseText(liveProgress);
    let liveProgressUnits = 0;
    for (const taskId of sequence.runningTasks) {
        if (isTerminalTaskStatus(batch?.taskStates?.get(taskId))) continue;
        const percent = normalizeProgressPercent(sequence.taskProgress.get(taskId));
        if (percent != null) liveProgressUnits += percent / 100;
    }
    const progressTotal = Math.max(batchTotal, 1);
    const progressDone = Math.min(progressTotal, counts.terminal + liveProgressUnits);
    const aggregatePercent = Math.round((progressDone / progressTotal) * 100);

    if (!runningTotal && !batchTotal) {
        el.batchProgressText.textContent = '当前无任务';
        el.batchProgressCount.textContent = '0 / 0';
        el.batchProgressBar.style.width = '0%';
        return;
    }

    const extra = counts.failed || counts.cancelled
        ? `，失败 ${counts.failed}，取消 ${counts.cancelled}`
        : '';
    el.batchProgressText.textContent = runningTotal > 0 && liveText
        ? `${liveText}，本序列完成 ${counts.completed} 张${extra}`
        : runningTotal > 0
        ? `生成中 ${runningTotal} 个任务，本序列完成 ${counts.completed} 张${extra}`
        : `本序列完成 ${counts.completed} 张${extra}`;
    el.batchProgressCount.textContent = runningTotal > 0
        ? `${counts.completed} / ${batchTotal || runningTotal} · ${aggregatePercent}%`
        : `${counts.completed} / ${batchTotal}`;
    el.batchProgressBar.style.width = `${aggregatePercent}%`;
}

function loadSequences() {
    try {
        const stored = JSON.parse(localStorage.getItem(DESKTOP_SEQUENCES_KEY) || 'null');
        if (Array.isArray(stored) && stored.length > 0) {
            return stored.map((sequence, index) => createSequence({
                id: sequence.id,
                name: `序列${index + 1}`,
                prompt: sequence.prompt,
                providerId: sequence.providerId || sequence.presetId,
                model: sequence.model,
                ratio: sequence.ratio,
                count: sequence.count,
                imageSize: sequence.imageSize,
                advanced: sequence.advanced || sequence.generationConfig,
                references: sequence.references
            }));
        }
    } catch {
        // Fall through to legacy migration.
    }

    const legacy = getLegacyDraft();
    return [createSequence({
        name: '序列1',
        prompt: legacy.prompt,
        providerId: legacy.providerId || legacy.presetId,
        model: legacy.model,
        ratio: legacy.ratio,
        count: legacy.count,
        imageSize: legacy.imageSize,
        advanced: legacy.advanced || legacy.generationConfig
    })];
}

function getLegacyDraft() {
    try {
        return JSON.parse(localStorage.getItem(DESKTOP_LEGACY_DRAFT_KEY) || '{}');
    } catch {
        return {};
    }
}

function serializeSequence(sequence) {
    return {
        id: sequence.id,
        name: sequence.name,
        prompt: sequence.prompt,
        providerId: sequence.providerId,
        model: sequence.model,
        ratio: sequence.ratio,
        count: sequence.count,
        imageSize: sequence.imageSize,
        advanced: createDefaultAdvancedSettings(sequence.advanced),
        references: normalizeReferences(sequence.references).map(serializeReference).filter(Boolean)
    };
}

function saveSequences() {
    localStorage.setItem(DESKTOP_SEQUENCES_KEY, JSON.stringify(state.sequences.map(serializeSequence)));
    localStorage.setItem(DESKTOP_CURRENT_SEQUENCE_KEY, state.currentSequenceId);
}

function pickCurrentSequenceId() {
    const stored = localStorage.getItem(DESKTOP_CURRENT_SEQUENCE_KEY);
    if (stored && state.sequences.some(sequence => sequence.id === stored)) return stored;
    return state.sequences[0].id;
}

function getCurrentPreset() {
    return state.presets.find(preset => preset.id === state.currentPresetId) || state.presets[0];
}

function getPresetById(presetId) {
    return state.presets.find(preset => preset.id === presetId) || null;
}

function getChatPresetById(presetId) {
    return state.chatPresets.find(preset => preset.id === presetId) || null;
}

function getFixedRoutingProvider() {
    if (state.routingStrategy !== 'fixed') return null;
    return getPresetById(state.fixedProviderId);
}

function findProviderForModel(model, preferredProviderId = '') {
    const fixedProvider = getFixedRoutingProvider();
    if (fixedProvider) return fixedProvider;
    const enabledProviders = state.presets.filter(provider => provider.enabled !== false);
    const preferred = getPresetById(preferredProviderId);
    if (preferred?.enabled !== false && preferred?.models?.includes(model)) return preferred;
    const active = getPresetById(state.currentPresetId);
    if (active?.enabled !== false && active?.models?.includes(model)) return active;
    return enabledProviders.find(provider => provider.models?.includes(model))
        || preferred
        || active
        || enabledProviders[0]
        || state.presets[0]
        || null;
}

function getGenerationModels() {
    const fixedProvider = getFixedRoutingProvider();
    if (fixedProvider) return [...(fixedProvider.models || [])];
    return [...new Set(state.presets
        .filter(provider => provider.enabled !== false)
        .flatMap(provider => provider.models || []))];
}

function setActiveProvider(providerId) {
    state.currentPresetId = getPresetById(providerId)?.id || state.presets[0]?.id || null;
    if (state.currentPresetId) {
        localStorage.setItem(DESKTOP_ACTIVE_PROVIDER_KEY, state.currentPresetId);
    } else {
        localStorage.removeItem(DESKTOP_ACTIVE_PROVIDER_KEY);
    }
}

function setActiveChatProvider(providerId) {
    state.currentChatPresetId = getChatPresetById(providerId)?.id || state.chatPresets[0]?.id || null;
    if (state.currentChatPresetId) {
        localStorage.setItem(DESKTOP_ACTIVE_CHAT_PROVIDER_KEY, state.currentChatPresetId);
    } else {
        localStorage.removeItem(DESKTOP_ACTIVE_CHAT_PROVIDER_KEY);
    }
}

function getSequencePreset(sequence = getCurrentSequence()) {
    const fixedProvider = getFixedRoutingProvider();
    const provider = fixedProvider || findProviderForModel(sequence?.model, sequence?.providerId);
    const providerId = provider?.id || '';
    if (sequence && sequence.providerId !== providerId) sequence.providerId = providerId;
    if (providerId && state.currentPresetId !== providerId) setActiveProvider(providerId);
    return provider || state.presets[0];
}

function getCurrentSequence() {
    let sequence = state.sequences.find(item => item.id === state.currentSequenceId);
    if (!sequence) {
        sequence = state.sequences[0] || createSequence({ name: '序列1' });
        state.sequences = [sequence];
        normalizeSequenceNames();
        state.currentSequenceId = sequence.id;
    }
    return ensureSequenceRuntime(sequence);
}

function renderSettingsPresetSelect() {
    el.settingsPresetSelect.innerHTML = '';
    if (!state.currentPresetId || !getPresetById(state.currentPresetId)) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '新建 API';
        el.settingsPresetSelect.appendChild(option);
    }

    for (const preset of state.presets) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.name;
        el.settingsPresetSelect.appendChild(option);
    }
    if (state.currentPresetId) el.settingsPresetSelect.value = state.currentPresetId;
    el.deleteProviderBtn.disabled = !state.currentPresetId || !getPresetById(state.currentPresetId);
    renderSettingsProviderList();
    updateSettingsProviderMeta();
}

function renderSettingsProviderList() {
    el.settingsProviderList.innerHTML = '';

    if (!state.currentPresetId || !getPresetById(state.currentPresetId)) {
        el.settingsProviderList.appendChild(createProviderCard({
            id: '',
            name: '新建 API',
            baseUrl: '',
            apiKey: '',
            models: []
        }, true));
    }

    for (const preset of state.presets) {
        const isActive = preset.id === state.currentPresetId;
        el.settingsProviderList.appendChild(createProviderCard(preset, isActive));
    }

    renderStrategyProviderOptions();
}

function renderStrategyProviderOptions() {
    if (!el.strategyProviderSelect || !el.fixedProviderSelect) return;
    const previousStrategyProvider = state.strategyProviderId
        || el.strategyProviderSelect.value
        || state.currentPresetId
        || state.presets[0]?.id
        || '';
    const previousFixedProvider = state.fixedProviderId || el.fixedProviderSelect.value;

    for (const select of [el.strategyProviderSelect, el.fixedProviderSelect]) {
        select.innerHTML = '';
        for (const preset of state.presets) {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = `${preset.name}${preset.enabled === false ? '（已停用）' : ''}`;
            option.disabled = select === el.fixedProviderSelect && preset.enabled === false;
            select.appendChild(option);
        }
    }

    state.strategyProviderId = getPresetById(previousStrategyProvider)?.id
        || state.currentPresetId
        || state.presets[0]?.id
        || null;
    el.strategyProviderSelect.value = state.strategyProviderId || '';
    el.fixedProviderSelect.value = getPresetById(previousFixedProvider)?.enabled !== false
        && getPresetById(previousFixedProvider) ? previousFixedProvider : '';
    refreshModernSelect(el.strategyProviderSelect);
    refreshModernSelect(el.fixedProviderSelect);
    fillProviderCapacityForm();
}

function fillProviderCapacityForm() {
    const preset = getPresetById(state.strategyProviderId)
        || getPresetById(el.strategyProviderSelect?.value)
        || getPresetById(state.currentPresetId)
        || state.presets[0];
    if (!preset) {
        el.providerConcurrencyInput.value = '1';
        el.providerPriorityInput.value = '1';
        return;
    }

    state.strategyProviderId = preset.id;
    if (el.strategyProviderSelect.value !== preset.id) el.strategyProviderSelect.value = preset.id;
    el.providerConcurrencyInput.value = String(preset.maxConcurrent || 1);
    el.providerPriorityInput.value = String(preset.priority || 1);
}

function renderChatSettingsPresetSelect() {
    el.chatSettingsPresetSelect.innerHTML = '';
    if (!state.currentChatPresetId || !getChatPresetById(state.currentChatPresetId)) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '新建对话 API';
        el.chatSettingsPresetSelect.appendChild(option);
    }

    for (const preset of state.chatPresets) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.name;
        el.chatSettingsPresetSelect.appendChild(option);
    }
    if (state.currentChatPresetId) el.chatSettingsPresetSelect.value = state.currentChatPresetId;
    el.deleteChatProviderBtn.disabled = !state.currentChatPresetId || !getChatPresetById(state.currentChatPresetId);
    renderChatProviderList();
    updateSettingsProviderMeta();
}

function renderChatProviderList() {
    el.chatProviderList.innerHTML = '';

    if (!state.currentChatPresetId || !getChatPresetById(state.currentChatPresetId)) {
        el.chatProviderList.appendChild(createChatProviderCard({
            id: '',
            name: '新建对话 API',
            baseUrl: '',
            apiKey: '',
            models: []
        }, true));
    }

    for (const preset of state.chatPresets) {
        const isActive = preset.id === state.currentChatPresetId;
        el.chatProviderList.appendChild(createChatProviderCard(preset, isActive));
    }
}

function createChatProviderCard(preset, isActive) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `settings-provider-card${isActive ? ' active' : ''}`;
    card.title = preset.name || '对话 API';
    card.addEventListener('click', () => {
        if (preset.id) {
            setActiveChatProvider(preset.id);
        } else {
            state.currentChatPresetId = null;
        }
        renderChatSettingsPresetSelect();
        fillChatSettingsForm();
    });

    const top = document.createElement('span');
    top.className = 'provider-card-top';

    const name = document.createElement('span');
    name.className = 'provider-card-name';
    name.textContent = preset.name || '对话 API';
    top.appendChild(name);
    card.appendChild(top);

    const url = document.createElement('span');
    url.className = 'provider-card-url';
    url.textContent = formatProviderHost(preset.baseUrl || preset.url) || '未设置 Base URL';
    card.appendChild(url);

    const meta = document.createElement('span');
    meta.className = 'provider-card-meta';
    const modelCount = preset.models?.length || 0;
    meta.textContent = `${modelCount} 模型 · ${preset.model || '未选模型'}`;
    card.appendChild(meta);

    return card;
}

function createProviderCard(preset, isActive) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `settings-provider-card${isActive ? ' active' : ''}`;
    card.title = preset.name || '未命名 API';
    // 只有已保存的配置能拖：占位的"新建 API"没有 id，排进顺序里会被后端丢掉。
    if (preset.id) attachProviderCardDrag(card, String(preset.id));
    card.addEventListener('click', () => {
        if (preset.id) {
            setActiveProvider(preset.id);
            const sequence = getCurrentSequence();
            sequence.providerId = preset.id;
            if (!preset.models.includes(sequence.model)) sequence.model = preset.models[0] || '';
            renderProviderSelect();
            renderModelSelect();
            // 换模型后比例/数量档位要按新模型重建（末尾顺带刷新触发按钮摘要）。
            updateDimensionOptions();
            saveSequences();
        } else {
            state.currentPresetId = null;
        }
        renderSettingsPresetSelect();
        fillSettingsForm();
    });

    const top = document.createElement('span');
    top.className = 'provider-card-top';

    const name = document.createElement('span');
    name.className = 'provider-card-name';
    name.textContent = preset.name || '未命名 API';
    top.appendChild(name);

    if (preset.id) {
        const health = state.providerHealth.get(String(preset.id)) || {
            rating: 'failed',
            ratingLabel: '故障',
            ratingReason: '未收到路由健康状态',
            routeCount: preset.models?.length || 0,
            availableRouteCount: 0,
            fallbackRouteCount: 0,
            lastError: ''
        };
        const badge = document.createElement('span');
        badge.className = `provider-health-badge ${health.rating}`;
        badge.textContent = health.ratingLabel || '故障';
        badge.title = formatProviderHealthTooltip(health);
        badge.setAttribute('aria-label', `路由状态：${badge.textContent}`);
        top.appendChild(badge);
        card.title = `${preset.name || '未命名 API'}\n${formatProviderHealthTooltip(health)}`;
    }

    card.appendChild(top);

    const url = document.createElement('span');
    url.className = 'provider-card-url';
    url.textContent = formatProviderHost(preset.baseUrl || preset.url) || '未设置 Base URL';
    card.appendChild(url);

    const meta = document.createElement('span');
    meta.className = 'provider-card-meta';
    const modelCount = preset.models?.length || 0;
    const priceCount = Object.keys(preset.modelPricing || {}).length;
    const chatCount = preset.chatModels?.length || (preset.chatModel ? 1 : 0);
    meta.textContent = `${modelCount} 生图 · ${priceCount} 价格 · ${chatCount} 对话`;
    card.appendChild(meta);

    return card;
}

let providerDragId = null;

function clearProviderDropMarkers() {
    for (const node of el.settingsProviderList.querySelectorAll('.drop-before, .drop-after')) {
        node.classList.remove('drop-before', 'drop-after');
    }
}

function attachProviderCardDrag(card, providerId) {
    card.draggable = true;
    card.dataset.providerId = providerId;

    card.addEventListener('dragstart', event => {
        providerDragId = providerId;
        card.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        // Firefox 不设 data 就不触发 drop，值本身用不上。
        event.dataTransfer.setData('text/plain', providerId);
    });

    card.addEventListener('dragend', () => {
        providerDragId = null;
        card.classList.remove('dragging');
        clearProviderDropMarkers();
    });

    card.addEventListener('dragover', event => {
        if (!providerDragId || providerDragId === providerId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rect = card.getBoundingClientRect();
        const after = event.clientX > rect.left + rect.width / 2;
        clearProviderDropMarkers();
        card.classList.add(after ? 'drop-after' : 'drop-before');
    });

    card.addEventListener('dragleave', () => {
        card.classList.remove('drop-before', 'drop-after');
    });

    card.addEventListener('drop', event => {
        if (!providerDragId || providerDragId === providerId) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = card.getBoundingClientRect();
        const after = event.clientX > rect.left + rect.width / 2;
        const dragged = providerDragId;
        providerDragId = null;
        clearProviderDropMarkers();
        void moveProvider(dragged, providerId, after);
    });
}

async function moveProvider(draggedId, targetId, insertAfter) {
    const ids = state.presets.map(preset => String(preset.id));
    const from = ids.indexOf(draggedId);
    if (from < 0) return;
    ids.splice(from, 1);
    // 目标下标要在移除之后重算，否则往后拖会差一位。
    const target = ids.indexOf(targetId);
    if (target < 0) return;
    ids.splice(insertAfter ? target + 1 : target, 0, draggedId);

    const byId = new Map(state.presets.map(preset => [String(preset.id), preset]));
    const previous = state.presets;
    state.presets = ids.map(id => byId.get(id)).filter(Boolean);
    renderSettingsProviderList();
    renderProviderSelect();

    try {
        await reorderProviders(ids);
        showToast('已更新供应商优先级');
    } catch (error) {
        // 后端没落盘就把顺序退回去，免得界面显示的优先级和实际选路不一致。
        state.presets = previous;
        renderSettingsProviderList();
        renderProviderSelect();
        showToast(`排序保存失败：${error.message}`, 'error');
    }
}

function formatProviderHealthTooltip(health = {}) {
    const routeCount = Number(health.routeCount) || 0;
    const availableCount = Number(health.availableRouteCount) || 0;
    const fallbackCount = Number(health.fallbackRouteCount) || 0;
    const details = [
        health.ratingReason || '未收到路由健康状态',
        `可用模型 ${availableCount}/${routeCount}`
    ];
    if (fallbackCount > 0) details.push(`${fallbackCount} 个模型可切换到其他供应商`);
    if (health.lastError) details.push(`最近错误：${health.lastError}`);
    return details.join('\n');
}

function formatProviderHost(url) {
    try {
        return new URL(url).host;
    } catch {
        return String(url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    }
}

function updateSettingsProviderMeta() {
    if (!el.settingsProviderMeta) return; // header removed
    const count = state.settingsMode === 'chat' ? state.chatPresets.length : state.presets.length;
    if (state.settingsMode === 'chat') {
        el.settingsProviderMeta.textContent = `${count} 个提示词优化配置`;
        return;
    }
    if (state.settingsMode === 'concurrency') {
        el.settingsProviderMeta.textContent = `当前策略：${ROUTING_STRATEGY_LABELS[state.routingStrategy] || ROUTING_STRATEGY_LABELS.order}`;
        return;
    }
    if (state.settingsMode === 'network') {
        const proxyLabels = { direct: '直连', system: '系统代理', custom: '自定义代理' };
        el.settingsProviderMeta.textContent = `当前连接：${proxyLabels[el.proxyModeSelect.value] || '直连'}`;
        return;
    }
    if (state.settingsMode === 'output') {
        el.settingsProviderMeta.textContent = state.outputDirectoryConfig?.isDefault
            ? '当前：应用默认目录'
            : '当前：自定义目录';
        return;
    }
    const ratings = state.presets.map(preset => state.providerHealth.get(String(preset.id))?.rating || 'failed');
    const available = ratings.filter(rating => rating === 'available').length;
    const degraded = ratings.filter(rating => rating === 'degraded').length;
    const failed = ratings.filter(rating => rating === 'failed').length;
    setElementText(el.settingsProviderMeta, `${count} 个配置 · 可用 ${available} · 降级 ${degraded} · 故障 ${failed}`);
}

// 下拉里每一条其实是一个配置组（设置页那节叫「提供商 / 生图配置组」），但用户认知里那是
// 供应商：组名与供应商名不同时拼上组名，好区分同一供应商下的多个组；相同（迁移期组名是
// 供应商名的副本）、缺失、或组名本身已含供应商名（迁移期的「X · 对话」）时只显示其一，
// 免得出现「X · X」。只用于显示，绝不回写进表单（旧的 ProviderStore 表单拿 preset.name
// 直接当可编辑的 API 名字，混入组合串会被保存回去）。
function providerRoleLabel(preset) {
    const supplier = String(preset?.supplierName || '').trim();
    const groupName = String(preset?.name || '').trim();
    if (!supplier) return groupName;
    if (!groupName || groupName === supplier || groupName.startsWith(supplier)) return groupName || supplier;
    return `${supplier} · ${groupName}`;
}

function renderProviderSelect() {
    el.providerSelect.innerHTML = '';
    if (state.presets.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '未配置 API';
        el.providerSelect.appendChild(option);
        el.providerSelect.value = '';
        refreshModernSelect(el.providerSelect);
        updatePrefsTriggerValues();
        return;
    }

    const automatic = document.createElement('option');
    automatic.value = AUTO_PROVIDER_VALUE;
    automatic.textContent = `自动路由 · ${ROUTING_STRATEGY_LABELS[state.automaticRoutingStrategy] || ROUTING_STRATEGY_LABELS.order}`;
    el.providerSelect.appendChild(automatic);

    for (const preset of state.presets) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = `${providerRoleLabel(preset)}${preset.enabled === false ? '（已停用）' : ''}`;
        option.disabled = preset.enabled === false;
        el.providerSelect.appendChild(option);
    }
    const fixedProvider = getFixedRoutingProvider();
    if (state.routingStrategy === 'fixed' && !fixedProvider) {
        const missing = document.createElement('option');
        missing.value = '';
        missing.textContent = '指定提供商不可用 · 请重新选择';
        missing.disabled = true;
        el.providerSelect.appendChild(missing);
    }
    el.providerSelect.value = state.routingStrategy === 'fixed' ? fixedProvider?.id || '' : AUTO_PROVIDER_VALUE;
    refreshModernSelect(el.providerSelect);
    updatePrefsTriggerValues();
}

function renderModelSelect(sequence = getCurrentSequence()) {
    el.modelSelect.innerHTML = '';

    const models = getGenerationModels();
    if (models.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '先在 API 设置中填写模型';
        el.modelSelect.appendChild(option);
        sequence.model = '';
        el.modelSelect.value = '';
        refreshModernSelect(el.modelSelect);
        updateAdvancedSettingsVisibility();
        return;
    }

    for (const model of models) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        el.modelSelect.appendChild(option);
    }

    if (!sequence.model || !models.includes(sequence.model)) {
        sequence.model = models[0] || '';
    }
    el.modelSelect.value = sequence.model || '';
    refreshModernSelect(el.modelSelect);
    updateAdvancedSettingsVisibility();
}

function renderSequenceTabs() {
    if (window.PicGenAppica) return window.PicGenAppica.renderSequenceTabs(el.sequenceTabs, {
        items: state.sequences.map(sequence => ({ id: sequence.id, title: getSequenceTitle(sequence) })),
        currentId: state.currentSequenceId, select: switchSequence, close: closeSequence
    });
    el.sequenceTabs.innerHTML = '';
    for (const sequence of state.sequences) {
        const tab = document.createElement('button');
        tab.className = `tab-button${sequence.id === state.currentSequenceId ? ' active' : ''}`;
        tab.type = 'button';
        tab.title = getSequenceTitle(sequence);

        const name = document.createElement('span');
        name.className = 'tab-name';
        name.textContent = getSequenceTitle(sequence);
        tab.appendChild(name);

        const close = document.createElement('span');
        close.className = 'tab-close';
        close.title = '关闭序列';
        close.innerHTML = '<i data-lucide="x"></i>';
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            closeSequence(sequence.id);
        });
        tab.appendChild(close);

        tab.addEventListener('click', () => switchSequence(sequence.id));
        el.sequenceTabs.appendChild(tab);
    }
    refreshLucideIcons(el.sequenceTabs);
}

function getSequenceTitle(sequence) {
    const index = state.sequences.findIndex(item => item.id === sequence.id);
    return `序列${index >= 0 ? index + 1 : 1}`;
}

function switchSequence(sequenceId) {
    if (sequenceId === state.currentSequenceId) return;
    saveCurrentSequenceFromForm();
    state.currentSequenceId = sequenceId;
    saveSequences();
    renderSequenceTabs();
    loadCurrentSequenceToForm();
}

function addSequence() {
    saveCurrentSequenceFromForm();
    const sequence = createSequence({ name: `序列${state.sequences.length + 1}` });
    const preset = getSequencePreset(sequence);
    sequence.model = preset?.models?.[0] || '';
    state.sequences.push(sequence);
    normalizeSequenceNames();
    state.currentSequenceId = sequence.id;
    saveSequences();
    renderSequenceTabs();
    loadCurrentSequenceToForm();
}

function closeSequence(sequenceId) {
    if (state.sequences.length <= 1) {
        showToast('至少保留一个序列');
        return;
    }

    const sequence = state.sequences.find(item => item.id === sequenceId);
    if (sequence?.runningTasks.size) {
        showToast('序列正在生成，先停止后再关闭');
        return;
    }

    const index = state.sequences.findIndex(item => item.id === sequenceId);
    state.sequences = state.sequences.filter(item => item.id !== sequenceId);
    state.pendingMaskEdits.delete(sequenceId);
    state.hydratedSequenceIds.delete(sequenceId);
    state.sequenceHydrationPromises.delete(sequenceId);
    deleteReferenceImagesCache(sequence?.references);
    normalizeSequenceNames();
    if (state.currentSequenceId === sequenceId) {
        const next = state.sequences[Math.max(0, index - 1)] || state.sequences[0];
        state.currentSequenceId = next.id;
    }
    saveSequences();
    renderSequenceTabs();
    loadCurrentSequenceToForm();
}

function loadCurrentSequenceToForm() {
    const sequence = getCurrentSequence();
    const needsHydration = sequence.references.some(reference => !reference.base64 && reference.filePath);
    if (needsHydration && !state.hydratedSequenceIds.has(sequence.id)) {
        const sequenceId = sequence.id;
        hydrateSequenceReferences([sequence]).then(() => {
            if (state.currentSequenceId === sequenceId) loadCurrentSequenceToForm();
        }).catch(error => {
            console.warn('[References] sequence hydration failed:', error.message);
            state.hydratedSequenceIds.add(sequenceId);
            if (state.currentSequenceId === sequenceId) loadCurrentSequenceToForm();
        });
        return;
    }
    state.hydratedSequenceIds.add(sequence.id);
    const preset = getSequencePreset(sequence);
    renderProviderSelect();
    renderModelSelect(sequence);

    // 编辑器内容整体来自序列状态（映射外部状态，不是一次编辑）：不记一步，而是重设该序列的撤销基线。
    setPromptEditorValue(sequence.prompt || '', sequence.references, { undo: false });
    promptUndoResetIfDiverged(sequence.prompt || '', sequence.id);
    syncPromptOptimizeLock();
    el.modelSelect.value = sequence.model || '';
    updateDimensionOptions(sequence);
    writeAdvancedSettingsToForm(sequence);
    el.taskStatus.textContent = sequence.status || '就绪';
    renderReferences();
    updateActionState();
}

function saveCurrentSequenceFromForm() {
    const sequence = getCurrentSequence();
    sequence.prompt = getPromptEditorValue();
    const selectedProviderId = el.providerSelect.value;
    if (selectedProviderId && selectedProviderId !== AUTO_PROVIDER_VALUE) {
        sequence.providerId = selectedProviderId;
    } else {
        sequence.providerId = findProviderForModel(el.modelSelect.value, sequence.providerId)?.id
            || sequence.providerId
            || state.currentPresetId
            || '';
    }
    sequence.model = el.modelSelect.value;
    // 带 fallback 标记的下拉框显示的是回落首项而非用户选择，保留原值。
    if (!el.ratioSelect.dataset.fallback) sequence.ratio = el.ratioSelect.value;
    if (!el.countSelect.dataset.fallback) sequence.count = el.countSelect.value;
    if (!el.imageSizeSelect.dataset.fallback) sequence.imageSize = el.imageSizeSelect.value;
    sequence.advanced = readAdvancedSettingsFromForm();
    saveSequences();
    updatePrefsTriggerValues();
}

function openSettings(returnView = 'generation') {
    state.settingsReturnView = returnView;
    state.activeView = 'settings';
    // 每次进入 API 设置都从供应商目录开始，避免上次未完成的内联编辑
    // 状态把供应商/配置组列表推到首屏之外。
    window.dispatchEvent(new CustomEvent('picgen:close-supplier-panel'));
    el.tabsBar.hidden = true;
    el.mainContentScroll.hidden = true;
    el.historyPage.hidden = true;
    el.queuePage.hidden = true;
    el.reversePromptPage.hidden = true;
    if (el.workspacePage) el.workspacePage.hidden = true;
    el.errorLogsPage.hidden = true;
    if (el.historyBinPage) el.historyBinPage.hidden = true;
    setSidebarActive(el.apiSettingsBtn);
    renderSettingsPresetSelect();
    if (state.settingsMode === 'image') refreshUnifiedSuppliers();
    fillSettingsForm();
    if (state.chatProvidersLoaded) {
        renderChatSettingsPresetSelect();
        fillChatSettingsForm();
    }
    el.settingsOverlay.hidden = false;
    setSettingsMode(state.settingsMode || 'image');
    startProviderHealthPolling();
}

async function refreshUnifiedSuppliers() {
    if (!el.unifiedSupplierList) return;
    if (!state.serverUrl) { el.unifiedSupplierWorkspace?.classList.add('is-unavailable'); return; }
    try {
        const response = await fetch(`${state.serverUrl}/api/suppliers`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        state.unifiedSuppliers = Array.isArray(result) ? result : (Array.isArray(result.suppliers) ? result.suppliers : []);
        if (!state.unifiedSupplierFocusId) {
            try { state.unifiedSupplierFocusId = localStorage.getItem('picgen.unifiedSupplierFocusId') || ''; } catch { /* storage unavailable */ }
        }
        const focusedIndex = state.unifiedSuppliers.findIndex(item => item.id === state.unifiedSupplierFocusId);
        if (focusedIndex >= 0) state.unifiedSupplierIndex = focusedIndex;
        else if (state.unifiedSuppliers.length > 1 && !state.unifiedSupplierFocusId) state.unifiedSupplierIndex = state.unifiedSuppliers.length - 1;
        state.unifiedSupplierIndex = Math.min(Math.max(0, state.unifiedSupplierIndex || 0), Math.max(0, state.unifiedSuppliers.length - 1));
        el.unifiedSupplierWorkspace?.classList.remove('is-unavailable');
        renderUnifiedSuppliers();
    } catch {
        // 后端尚未提供统一接口时，保留旧的生图/对话配置页面。
        el.unifiedSupplierWorkspace?.classList.add('is-unavailable');
    }
}

function renderUnifiedSuppliers(options = {}) {
    if (!el.unifiedSupplierList) return;
    const index = state.unifiedSuppliers.length ? Math.min(Math.max(0, state.unifiedSupplierIndex || 0), state.unifiedSuppliers.length - 1) : 0;
    state.unifiedSupplierIndex = index;
    if (!window.PicGenAppica?.renderSupplierManager) return;
    const health = {};
    for (const [id, status] of state.providerHealth || []) health[id] = status;
    window.PicGenAppica.renderSupplierManager({
        suppliers: state.unifiedSuppliers,
        startIndex: index,
        protocols: UNIFIED_MODEL_PROTOCOLS,
        defaultPrompt: DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
        health,
        onSelect: selected => {
            state.unifiedSupplierIndex = selected;
            const focused = state.unifiedSuppliers[selected];
            if (focused?.id) rememberUnifiedSupplierFocus(focused.id);
        },
        actions: unifiedSupplierActions
    }, options);
}

function rememberUnifiedSupplierFocus(id) {
    state.unifiedSupplierFocusId = id;
    try { localStorage.setItem('picgen.unifiedSupplierFocusId', id); } catch { /* storage unavailable */ }
}

// Hover-expand table of contents for the settings sheet: a hairline rail of
// ticks by default, expanding on hover to icon + section title. Built from the
// visible panel's [data-toc-title] sections; hidden when fewer than two exist.
function renderSettingsToc() {
    const rail = el.settingsToc;
    if (!rail) return;
    state.tocCleanup?.();
    state.tocCleanup = null;
    const panel = [...document.querySelectorAll('#settingsOverlay .settings-panel')].find(node => !node.hidden);
    const sections = panel ? [...panel.querySelectorAll('[data-toc-title]')].filter(node => node.offsetParent !== null) : [];
    rail.innerHTML = '';
    if (sections.length < 2) { rail.hidden = true; return; }
    rail.hidden = false;
    sections.forEach((section, index) => {
        if (!section.id) section.id = `tocSection_${index}`;
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'settings-toc-item';
        item.dataset.target = section.id;
        const icon = (section.dataset.tocIcon || 'circle').replace(/[^a-z0-9-]/gi, '') || 'circle';
        item.innerHTML = `<span class="settings-toc-tick"></span><span class="settings-toc-label"><i data-lucide="${icon}"></i><span>${escapeHtml(section.dataset.tocTitle || '')}</span></span>`;
        item.addEventListener('click', () => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        rail.appendChild(item);
    });
    refreshLucideIcons(rail);
    const items = [...rail.querySelectorAll('.settings-toc-item')];
    // Track the active section on scroll of the actual container (varies per tab).
    let container = sections[0].parentElement;
    while (container && !['auto', 'scroll'].includes(getComputedStyle(container).overflowY)) container = container.parentElement;
    const setActive = id => { for (const item of items) item.classList.toggle('is-active', item.dataset.target === id); };
    const onScroll = () => {
        const anchor = (container === document.scrollingElement || !container) ? 0 : container.getBoundingClientRect().top;
        let activeId = sections[0].id;
        for (const section of sections) if (section.getBoundingClientRect().top - anchor <= 24) activeId = section.id;
        setActive(activeId);
    };
    (container || window).addEventListener('scroll', onScroll, { passive: true });
    state.tocCleanup = () => (container || window).removeEventListener('scroll', onScroll);
    onScroll();
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function refreshAfterSupplierMutation() {
    await refreshUnifiedSuppliers();
    await refreshProviders();
    if (state.chatProvidersLoaded) await refreshChatProviders();
}

async function saveUnifiedSupplierRequest(path, method, payload, successMessage) {
    try {
        const saved = await requestProvider(path, { method, body: JSON.stringify(payload) });
        rememberUnifiedSupplierFocus(saved.id);
        try { await refreshAfterSupplierMutation(); showToast(successMessage); }
        catch { showToast('配置已保存，列表刷新失败，请重新打开设置'); }
        return saved;
    } catch (error) { showToast(`保存失败：${error.message}`, 'error'); throw error; }
}

// REST/toast/refresh layer behind the React supplier manager. The panel owns
// drafts and validation; every mutation lands here so the legacy role views
// (generation/reverse-prompt selectors) stay in sync.
const unifiedSupplierActions = {
    createSupplier: payload => saveUnifiedSupplierRequest('/api/suppliers', 'POST', payload, '供应商已保存'),
    updateSupplier: (supplierId, payload) => saveUnifiedSupplierRequest(
        `/api/suppliers/${encodeURIComponent(supplierId)}`, 'PUT', payload, '供应商已保存'),
    saveGroup: (supplierId, groupId, payload) => saveUnifiedSupplierRequest(
        groupId
            ? `/api/suppliers/${encodeURIComponent(supplierId)}/groups/${encodeURIComponent(groupId)}`
            : `/api/suppliers/${encodeURIComponent(supplierId)}/groups`,
        groupId ? 'PUT' : 'POST', payload, '配置组已保存'),
    async deleteGroup(supplierId, groupId) {
        if (!(await askConfirm('删除此配置组？此操作不可恢复。', { title: '删除配置组', okText: '删除', danger: true }))) return false;
        try { await requestProvider(`/api/suppliers/${encodeURIComponent(supplierId)}/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' }); }
        catch (error) { showToast(`删除失败：${error.message}`, 'error'); return false; }
        // The deletion is already persisted; a refresh hiccup must not report
        // failure or keep the panel open on stale data.
        try { await refreshAfterSupplierMutation(); showToast('配置组已删除'); }
        catch { showToast('配置组已删除，列表刷新失败，请重新打开设置'); }
        return true;
    },
    deleteSupplier: supplier => deleteUnifiedSupplier(supplier),
    // Quick enable/disable from the card switch — a partial group PUT (the server
    // merges over the existing group, so only `enabled` changes).
    async setGroupEnabled(supplierId, groupId, enabled) {
        try {
            await requestProvider(`/api/suppliers/${encodeURIComponent(supplierId)}/groups/${encodeURIComponent(groupId)}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
            await refreshAfterSupplierMutation();
        } catch (error) { showToast(`切换失败：${error.message}`, 'error'); }
    },
    testDraft: payload => requestProvider('/api/suppliers/test-draft', { method: 'POST', body: JSON.stringify(payload) }),
    discoverDraft: payload => requestProvider('/api/suppliers/discover-draft', { method: 'POST', body: JSON.stringify(payload) })
};
const UNIFIED_MODEL_PROTOCOLS = [
    ['auto', '自动识别'],
    ['gemini-native', 'Gemini Native'],
    ['grsai-nano-banana', 'Grsai Nano Banana'],
    ['openai-images', 'OpenAI Images'],
    ['xai-imagine', 'Grok Imagine'],
    ['openai-chat', 'OpenAI Compatible']
];

async function deleteUnifiedSupplier(supplier) {
    if (!supplier?.id) return false;
    if (!(await askConfirm(`删除供应商「${supplier.name || ''}」及其全部配置组？`, { title: '删除供应商', okText: '删除', danger: true }))) return false;
    try { await requestProvider(`/api/suppliers/${encodeURIComponent(supplier.id)}`, { method: 'DELETE' }); }
    catch (error) { showToast(`删除失败：${error.message}`, 'error'); return false; }
    try { await refreshAfterSupplierMutation(); showToast('供应商已删除'); }
    catch { showToast('供应商已删除，列表刷新失败，请重新打开设置'); }
    return true;
}

function closeSettings() {
    const returnView = state.settingsReturnView;
    state.settingsReturnView = 'generation';
    if (returnView === 'reverse-prompt') {
        openReversePrompt().catch(error => showToast(`提示词反推页面打开失败: ${error.message}`));
        return;
    }
    showGenerationView();
}

function hideSettingsPage() {
    el.settingsOverlay.hidden = true;
    stopProviderHealthPolling();
    state.tocCleanup?.();
    state.tocCleanup = null;
}

function setSettingsMode(mode) {
    // The chat tab is now the "提示词优化" (prompt optimization) settings page.
    const known = ['image', 'concurrency', 'optimize', 'network', 'output'];
    state.settingsMode = known.includes(mode) ? mode : 'image';
    const active = state.settingsMode;
    el.imageSettingsTab.classList.toggle('active', active === 'image');
    el.concurrencySettingsTab.classList.toggle('active', active === 'concurrency');
    el.chatSettingsTab.classList.toggle('active', active === 'optimize');
    el.networkSettingsTab.classList.toggle('active', active === 'network');
    el.outputSettingsTab.classList.toggle('active', active === 'output');
    el.imageSettingsPanel.hidden = active !== 'image';
    el.concurrencySettingsPanel.hidden = active !== 'concurrency';
    el.chatSettingsPanel.hidden = active !== 'optimize';
    el.networkSettingsPanel.hidden = active !== 'network';
    el.outputSettingsPanel.hidden = active !== 'output';
    if (el.newProviderBtn) {
        el.newProviderBtn.hidden = active !== 'image';
        el.newProviderBtn.title = '新建 API 供应商';
        el.newProviderBtn.setAttribute('aria-label', el.newProviderBtn.title);
    }
    for (const [tab, tabMode] of [
        [el.imageSettingsTab, 'image'],
        [el.concurrencySettingsTab, 'concurrency'],
        [el.chatSettingsTab, 'optimize'],
        [el.networkSettingsTab, 'network'],
        [el.outputSettingsTab, 'output']
    ]) {
        tab.setAttribute('aria-selected', String(active === tabMode));
    }
    updateSettingsProviderMeta();
    if (active === 'concurrency') refreshConcurrencySettings();
    if (active === 'optimize') refreshPromptOptimizeSettings();
    if (active === 'network') refreshProxySettings();
    if (active === 'output') refreshOutputDirectorySettings();
    if (active === 'image' && !el.settingsOverlay.hidden) { refreshProviderHealth(); refreshUnifiedSuppliers(); }
    refreshLucideIcons();
    // Rebuild after the panel visibility settles so section offsets are correct.
    requestAnimationFrame(renderSettingsToc);
}

function updateOptimizeButtonVisibility() {
    if (el.optimizePromptBtn) el.optimizePromptBtn.hidden = !state.promptOptimizeEnabled;
    // 图标宿主是空的：首次挂载也要填一次，否则在用户点优化之前按钮没有图标。
    if (el.optimizePromptIcon) {
        window.PicGenAppica?.renderOptimizeIcon?.(el.optimizePromptIcon, { busy: Boolean(state.promptOptimizeRun) });
    }
}

async function refreshPromptOptimizeSettings() {
    if (el.promptOptimizeEnabledToggle) el.promptOptimizeEnabledToggle.checked = state.promptOptimizeEnabled;
    if (el.promptOptimizeSystemInput) {
        el.promptOptimizeSystemInput.value = state.promptOptimizeSystemPrompt || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT;
    }
    const select = el.promptOptimizeProviderSelect;
    if (select) {
        try { await ensureChatProvidersLoaded(); } catch { /* offline */ }
        select.innerHTML = '';
        const presets = state.chatPresets || [];
        if (!presets.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '请先在 API 提供商添加“对话”配置组';
            select.appendChild(option);
            select.disabled = true;
        } else {
            select.disabled = false;
            for (const preset of presets) {
                const option = document.createElement('option');
                option.value = preset.id;
                option.textContent = `${preset.name || '未命名'}${preset.model ? ' · ' + preset.model : ''}`;
                select.appendChild(option);
            }
            select.value = getChatPresetById(state.currentChatPresetId)?.id || presets[0].id;
        }
        refreshModernSelect(select);
    }
    updateOptimizeButtonVisibility();
}

function savePromptOptimizeSettings() {
    state.promptOptimizeSystemPrompt = (el.promptOptimizeSystemInput?.value || '').trim();
    state.promptOptimizeEnabled = el.promptOptimizeEnabledToggle?.checked !== false;
    try {
        localStorage.setItem('picgen.promptOptimizeSystemPrompt', state.promptOptimizeSystemPrompt);
        localStorage.setItem('picgen.promptOptimizeEnabled', state.promptOptimizeEnabled ? '1' : '0');
    } catch { /* storage unavailable */ }
    updateOptimizeButtonVisibility();
    showToast('提示词优化设置已保存', 'success');
}

// 历次发布过的「默认系统提示词」原文。用户在设置里点过保存（哪怕一个字没改），这段
// 文本就会进 localStorage，并且在之后一直盖住新的默认值 —— 于是我们改默认提示词时，
// 对这些人完全不起作用，表现成「升级了但优化行为毫无变化」。加载时若存的就是某个旧默认，
// 说明用户从没真正自定义过，就当没存过、改用新默认；真改过的内容原样保留。
const LEGACY_PROMPT_OPTIMIZER_SYSTEM_PROMPTS = [
    [
        '你是专业的 AI 生图提示词优化助手，精通主流图像生成模型的提示词工程。',
        '将用户输入改写为一条更利于图像模型理解的提示词，严格忠于原始意图，不新增与原意冲突的主体、风格或限制。',
        '在与原意相关时按需补充以下要素，不要生硬堆砌：主体与用途（照片／海报／图标／插画等）；构图（取景、主体位置、画幅比例）；光线与色彩（光源方向、氛围、主色调）；材质与媒介（表面质感、绘制或摄影风格，需要真实感时明确"照片级写实"）；关键细节与艺术风格。',
        '用具体可见的描述代替笼统的情绪词；若画面内需出现文字，用引号给出确切文案并说明位置，同时声明不出现多余文字；必要时补充排除项（如无水印、无多余元素）。',
        '只返回优化后的提示词正文，语言与用户输入保持一致，不要解释，不要使用 Markdown 或分点符号。'
    ].join('\n')
].map(text => text.trim());

function isLegacyPromptOptimizerSystemPrompt(text) {
    const value = String(text || '').trim();
    return Boolean(value) && LEGACY_PROMPT_OPTIMIZER_SYSTEM_PROMPTS.includes(value);
}

function loadPromptOptimizeSettings() {
    try {
        state.promptOptimizeEnabled = localStorage.getItem('picgen.promptOptimizeEnabled') !== '0';
        const stored = String(localStorage.getItem('picgen.promptOptimizeSystemPrompt') || '').trim();
        const isStockDefault = isLegacyPromptOptimizerSystemPrompt(stored);
        if (isStockDefault) localStorage.removeItem('picgen.promptOptimizeSystemPrompt');
        // 空串 = 用默认值（见 refreshPromptOptimizeSettings 的 `|| DEFAULT_...`）。
        state.promptOptimizeSystemPrompt = isStockDefault ? '' : stored;
    } catch { state.promptOptimizeEnabled = true; state.promptOptimizeSystemPrompt = ''; }
    updateOptimizeButtonVisibility();
}

async function refreshRoutingRanking() {
    const container = el.routingRanking;
    const strategy = el.providerStrategySelect.value;
    const requestId = state.rankingRequest = (state.rankingRequest || 0) + 1;
    if (!container || container.hidden || !state.serverUrl) return;
    const model = getCurrentSequence()?.model || '';
    if (!container.querySelector('table')) container.textContent = '正在读取排行…';
    try {
        const rows = await requestProvider(`/api/providers/ranking?model=${encodeURIComponent(model)}&strategy=${strategy}`);
        if (requestId !== state.rankingRequest || container.hidden) return;
        container.replaceChildren();
        const title = document.createElement('strong'); title.textContent = `${strategy === 'price' ? '价格' : '速度'}前 5 名 · ${model || '请先选择模型'}`;
        const note = document.createElement('p'); note.textContent = '单张价格按你填写的金额展示，请统一币种；耗时为配置组本次运行的成功请求加权平均（包含不同模型），重启后重新统计。满载或冷却时可能使用下一组。';
        container.append(title, note);
        if (!rows.length) { const empty = document.createElement('p'); empty.textContent = '此模型暂无已启用且配置完整的供应商。'; container.append(empty); return; }
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>排名 / 配置组</th><th>价格 / 张</th><th>耗时</th></tr></thead>';
        const body = document.createElement('tbody');
        rows.forEach((row, index) => {
            const tr = document.createElement('tr');
            const values = [`${index + 1}. ${row.name}${!row.available ? '（冷却中）' : row.busy ? '（满载）' : ''}`,
                row.price == null ? '未标价' : String(row.price),
                row.latencyMs == null ? '暂无数据' : `${(row.latencyMs / 1000).toFixed(1)} 秒 · ${row.samples} 次`];
            values.forEach(value => { const cell = document.createElement('td'); cell.textContent = value; tr.append(cell); }); body.append(tr);
        });
        table.append(body); container.append(table);
    } catch { if (requestId === state.rankingRequest) container.textContent = '排行暂时无法读取，请重新进入此页面。'; }
}

function syncProxyCustomVisibility() {
    el.proxyCustomField.hidden = el.proxyModeSelect.value !== 'custom';
    for (const input of document.querySelectorAll('[name="proxyMode"]')) {
        input.checked = input.value === el.proxyModeSelect.value;
    }
}

function syncStrategyUi() {
    const strategy = normalizeRoutingStrategy(el.providerStrategySelect.value);
    el.providerStrategySelect.value = strategy;
    for (const input of document.querySelectorAll('[name="providerStrategy"]')) {
        input.checked = input.value === strategy;
    }
    el.fixedProviderField.hidden = strategy !== 'fixed';
    if (el.providerCapacityPanel) el.providerCapacityPanel.hidden = !['priority', 'balanced'].includes(strategy);
    if (el.providerPriorityField) el.providerPriorityField.hidden = !['priority', 'balanced'].includes(strategy);
    if (el.routingRanking) el.routingRanking.hidden = !['price', 'speed'].includes(strategy);
    for (const control of [el.failoverEnabledToggle, el.failoverMaxAttemptsInput, el.failoverThresholdInput]) if (control?.closest) control.closest('label').hidden = strategy === 'fixed';
    refreshRoutingRanking();
    if (strategy === 'fixed' && !el.fixedProviderSelect.value) {
        const available = state.presets.filter(preset => preset.enabled !== false);
        el.fixedProviderSelect.value = available.find(preset => preset.id === state.fixedProviderId)?.id
            || available.find(preset => preset.id === state.currentPresetId)?.id
            || available[0]?.id || '';
    }
    refreshModernSelect(el.fixedProviderSelect);
}

function applyOutputDirectoryConfig(config = {}) {
    const directory = String(config.directory || '');
    state.outputDirectoryConfig = {
        directory,
        effectiveDirectory: String(config.effectiveDirectory || ''),
        defaultDirectory: String(config.defaultDirectory || ''),
        isDefault: typeof config.isDefault === 'boolean' ? config.isDefault : !directory
    };
    el.outputDirectoryInput.value = state.outputDirectoryConfig.effectiveDirectory;
    el.outputDirectoryInput.title = state.outputDirectoryConfig.effectiveDirectory;
    el.outputDirectoryMode.textContent = state.outputDirectoryConfig.isDefault
        ? '应用默认目录'
        : '自定义目录';
    el.resetOutputDirectoryBtn.disabled = state.outputDirectoryConfig.isDefault;
    updateSettingsProviderMeta();
}

async function refreshOutputDirectorySettings() {
    try {
        applyOutputDirectoryConfig(await window.picgenDesktop.getOutputDirectory());
    } catch (error) {
        showToast(`保存目录读取失败: ${error.message}`);
    }
}

async function chooseOutputDirectory() {
    el.chooseOutputDirectoryBtn.disabled = true;
    try {
        const result = await window.picgenDesktop.chooseOutputDirectory();
        if (result?.cancelled) return;
        applyOutputDirectoryConfig(result);
        showToast('默认保存目录已更新');
    } catch (error) {
        showToast(`保存目录设置失败: ${error.message}`);
    } finally {
        el.chooseOutputDirectoryBtn.disabled = false;
    }
}

async function resetOutputDirectory() {
    el.resetOutputDirectoryBtn.disabled = true;
    try {
        applyOutputDirectoryConfig(await window.picgenDesktop.resetOutputDirectory());
        showToast('已恢复应用默认保存目录');
    } catch (error) {
        showToast(`恢复默认目录失败: ${error.message}`);
    } finally {
        el.resetOutputDirectoryBtn.disabled = state.outputDirectoryConfig?.isDefault === true;
    }
}

async function refreshProxySettings() {
    try {
        const proxy = await requestProvider('/api/providers/proxy');
        el.proxyModeSelect.value = proxy.mode || 'direct';
        el.proxyCustomInput.value = proxy.customProxy || '';
        el.proxyActiveHint.textContent = proxy.mode === 'direct'
            ? '当前：绕过系统代理'
            : `当前：${proxy.effectiveProxy || '跟随系统'}`;
        syncProxyCustomVisibility();
    } catch (error) {
        showToast(`网络设置读取失败: ${error.message}`);
    }
}

async function refreshConcurrencySettings() {
    const requestId = ++state.concurrencySettingsRequestId;
    try {
        const failover = await requestProvider('/api/providers/failover');
        if (requestId !== state.concurrencySettingsRequestId) return;
        applyProviderRoutingConfig(failover, { render: false });
        el.failoverEnabledToggle.checked = failover.enabled !== false;
        el.failoverMaxAttemptsInput.value = String(failover.maxAttempts || 3);
        el.maxGlobalConcurrentInput.value = String(failover.maxGlobalConcurrent || 12);
        el.failoverThresholdInput.value = String(failover.failoverThreshold || 3);
        el.providerStrategySelect.value = state.routingStrategy;
        state.strategyProviderId = getPresetById(state.strategyProviderId)?.id
            || state.currentPresetId
            || state.presets[0]?.id
            || null;
        renderStrategyProviderOptions();
        el.fixedProviderSelect.value = state.fixedProviderId || '';
        syncStrategyUi();
    } catch (error) {
        if (requestId !== state.concurrencySettingsRequestId) return;
        showToast(`并发策略读取失败: ${error.message}`);
    }
}

const settingsWriteTails = new Map();
function serializeSettingsWrite(key, work) {
    const next = (settingsWriteTails.get(key) || Promise.resolve()).catch(() => {}).then(work);
    settingsWriteTails.set(key, next.catch(() => {}));
    return next;
}

async function saveProxySettings() {
    const requestId = ++state.proxySaveRequestId;
    const mode = el.proxyModeSelect.value;
    const customProxy = el.proxyCustomInput.value.trim();
    if (mode === 'custom' && !customProxy) {
        showToast('请填写代理地址');
        return;
    }

    try {
        const result = await serializeSettingsWrite('proxy', () => requestProvider('/api/providers/proxy', {
            method: 'POST', body: JSON.stringify({ mode, customProxy })
        }));
        if (requestId !== state.proxySaveRequestId) return;
        showToast(result.config?.mode === 'direct' ? '已切换为直连' : '代理设置已保存');
    } catch (error) {
        if (requestId === state.proxySaveRequestId) showToast(`代理设置保存失败: ${error.message}`);
    }
}

async function testProxyConnection() {
    el.testProxyBtn.disabled = true;
    el.testProxyBtn.textContent = '测试中…';
    try {
        const result = await requestProvider('/api/providers/proxy/test', { method: 'POST' });
        // 耗时缺失时宁可不显示，也不要把 undefined 甩给用户。
        const latency = Number(result.latencyMs);
        const latencyText = Number.isFinite(latency) && latency > 0 ? `，耗时 ${latency}ms` : '';
        showToast(result.success
            ? `连接正常（${result.summary || '目标可达'}）${latencyText}`
            : `连接失败: ${result.message || '未知原因'}`);
    } catch (error) {
        showToast(`测试失败: ${error.message}`);
    } finally {
        el.testProxyBtn.disabled = false;
        el.testProxyBtn.textContent = '测试连接';
    }
}

async function saveFailoverSettings() {
    if (el.saveFailoverBtn?.disabled) return;

    // Capture the draft before any awaited request can refresh the form.
    const saveRequestId = ++state.routingSaveRequestId;
    state.concurrencySettingsRequestId += 1;
    const strategy = normalizeRoutingStrategy(el.providerStrategySelect.value);
    const selectedProviderId = strategy === 'fixed' ? el.fixedProviderSelect.value : '';
    if (strategy === 'fixed' && (!getPresetById(selectedProviderId)
        || getPresetById(selectedProviderId).enabled === false)) {
        showToast('请选择一个已启用的生图配置组');
        return;
    }
    const capacityProviderId = el.strategyProviderSelect.value || state.strategyProviderId || '';
    const capacityValues = {
        maxConcurrent: el.providerConcurrencyInput.value,
        priority: el.providerPriorityInput.value
    };
    if (['priority', 'balanced'].includes(strategy) && ![el.providerConcurrencyInput, el.providerPriorityInput].every(input => input.value.trim() && input.checkValidity())) { showToast('请填写有效的整数并发数和优先级'); return; }
    if (el.saveFailoverBtn) { el.saveFailoverBtn.disabled = true; el.saveFailoverBtn.textContent = '保存中'; }
    const payload = {
        enabled: el.failoverEnabledToggle.checked,
        maxAttempts: Number(el.failoverMaxAttemptsInput.value) || 3,
        maxGlobalConcurrent: Number(el.maxGlobalConcurrentInput.value) || 12,
        failoverThreshold: Number(el.failoverThresholdInput.value) || 3,
        strategy, selectedProviderId
    };
    try {
        const result = await serializeSettingsWrite('routing', async () => {
            const saved = await requestProvider('/api/providers/failover', { method: 'POST', body: JSON.stringify(payload) });
            if (['priority', 'balanced'].includes(strategy)) await saveProviderCapacityFromForm(capacityProviderId, capacityValues);
            return saved;
        });
        if (saveRequestId !== state.routingSaveRequestId) return;
        applyProviderRoutingConfig(result.config || {}, { render: false });

        showToast('并发策略已切换');
        refreshRoutingRanking();
    } catch (error) {
        if (saveRequestId === state.routingSaveRequestId) showToast(`保存失败: ${error.message}`);
    } finally {
        if (el.saveFailoverBtn) { el.saveFailoverBtn.disabled = false; el.saveFailoverBtn.textContent = '保存并发策略'; }
    }
}

async function openQueue() {
    state.activeView = 'queue';
    hideSettingsPage();
    el.tabsBar.hidden = true;
    el.mainContentScroll.hidden = true;
    el.historyPage.hidden = true;
    el.queuePage.hidden = false;
    el.reversePromptPage.hidden = true;
    if (el.workspacePage) el.workspacePage.hidden = true;
    el.errorLogsPage.hidden = true;
    if (el.historyBinPage) el.historyBinPage.hidden = true;
    setSidebarActive(el.queueBtn);
    hideMentionMenu();
    hideImageHoverPreview();
    closeHistoryPreview();
    await refreshQueue();
}

async function openReversePrompt() {
    state.activeView = 'reverse-prompt';
    hideSettingsPage();
    el.tabsBar.hidden = true;
    el.mainContentScroll.hidden = true;
    el.historyPage.hidden = true;
    el.queuePage.hidden = true;
    el.reversePromptPage.hidden = false;
    if (el.workspacePage) el.workspacePage.hidden = true;
    el.errorLogsPage.hidden = true;
    if (el.historyBinPage) el.historyBinPage.hidden = true;
    setSidebarActive(el.reversePromptNavBtn);
    hideMentionMenu();
    hideImageHoverPreview();
    closeHistoryPreview();
    await ensureChatProvidersLoaded();
    renderReversePromptProviders();
    updateReversePromptProviderState();
    updateReversePromptActionState();
}

function openReversePromptSettings() {
    // Kept as a compatibility shim for older renderer state or extensions.
    // The visible reverse-prompt page no longer exposes a separate settings
    // entry; unified supplier/group editing always opens the main API page.
    state.settingsMode = 'image';
    openSettings('reverse-prompt');
}

function setElementText(element, value) {
    if (element && element.textContent !== String(value)) element.textContent = String(value);
}

function scheduleQueueRender() {
    if (state.queueRenderFrame || state.activeView !== 'queue' || el.queuePage.hidden) return;
    state.queueRenderFrame = requestAnimationFrame(() => {
        state.queueRenderFrame = 0;
        if (state.activeView === 'queue' && !el.queuePage.hidden) renderQueue();
    });
}

function applyQueueTask(task) {
    if (!task?.id) return;
    const id = String(task.id);
    const previous = state.queueTasksById.get(id);
    const merged = { ...previous, ...task };
    const active = merged.status === 'pending' || merged.status === 'running';
    if (!active && !previous && !state.queueSnapshotsInFlight) return;
    if ((!active && !previous && state.queueChanges.get(id)?.task === null)
        || (active && previous && JSON.stringify(previous) === JSON.stringify(merged))) return;
    state.queueRevision += 1;
    if (state.queueSnapshotsInFlight) {
        state.queueChanges.set(id, { revision: state.queueRevision, task: active ? merged : null, latest: merged });
    }
    if (active) state.queueTasksById.set(id, merged);
    else state.queueTasksById.delete(id);
    state.queueTasks = [...state.queueTasksById.values()];
    scheduleQueueRender();
}

function applyQueueSnapshot(tasks, startedRevision = state.queueRevision) {
    const next = new Map((Array.isArray(tasks) ? tasks : [])
        .filter(task => task?.id && (task.status === 'pending' || task.status === 'running'))
        .map(task => [String(task.id), task]));
    // A websocket completion can arrive while the HTTP snapshot is in flight.
    for (const [id, change] of state.queueChanges) {
        if (change.revision > startedRevision) {
            if (change.task) next.set(id, change.task);
            else next.delete(id);
        }
    }
    state.queueTasksById = next;
    state.queueTasks = [...next.values()];
    scheduleQueueRender();
}

async function refreshQueue() {
    if (state.queueLoadPromise) return state.queueLoadPromise;
    const startedRevision = state.queueRevision;
    state.queueSnapshotsInFlight += 1;
    state.queueLoadPromise = (async () => {
        try {
            const response = await fetch(`${state.serverUrl}/api/tasks?status=pending,running`);
            const tasks = await response.json();
            if (!response.ok) throw new Error(tasks.error || '队列读取失败');
            applyQueueSnapshot(tasks, startedRevision);
        } catch (error) {
            showToast(`队列读取失败: ${error.message}`);
        }
    })().finally(() => {
        state.queueLoadPromise = null;
        state.queueSnapshotsInFlight -= 1;
        if (!state.queueSnapshotsInFlight) state.queueChanges.clear();
    });
    return state.queueLoadPromise;
}

function createQueueItem(taskId) {
    const item = document.createElement('div');
    item.className = 'queue-item';
    item.dataset.taskId = taskId;
    const main = document.createElement('div');
    main.className = 'queue-task-main';
    const title = document.createElement('div'); title.className = 'queue-item-title';
    const model = document.createElement('div'); model.className = 'queue-item-model';
    const prompt = document.createElement('div'); prompt.className = 'queue-item-prompt';
    const detail = document.createElement('div'); detail.className = 'queue-item-detail';
    main.append(title, model, prompt, detail);
    const route = document.createElement('div'); route.className = 'queue-task-route';
    const status = document.createElement('span'); status.className = 'queue-status';
    const statusDot = document.createElement('i');
    const statusLabel = document.createElement('span');
    status.append(statusDot, statusLabel);
    const provider = document.createElement('div'); provider.className = 'queue-provider';
    const progress = document.createElement('div'); progress.className = 'queue-progress';
    const phase = document.createElement('span');
    const track = document.createElement('i');
    const bar = document.createElement('b');
    track.appendChild(bar); progress.append(phase, track);
    route.append(status, provider, progress);
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'queue-cancel-button'; cancel.title = '取消任务';
    cancel.innerHTML = '<i data-lucide="x"></i>';
    cancel.addEventListener('click', () => cancelQueuedTask(taskId));
    item.append(main, route, cancel);
    item._queueElements = { title, model, prompt, detail, status, statusLabel, provider, progress, phase, bar, cancel };
    return item;
}

function updateQueueItem(item, task) {
    const q = item._queueElements;
    setElementText(q.title, task.sequenceName || task.sequenceId || '未命名序列');
    setElementText(q.model, task.model || '未选择模型');
    setElementText(q.prompt, task.prompt || '无提示词');
    q.prompt.title = task.prompt || '';
    const attempts = Array.isArray(task.attempts) ? task.attempts.length : 0;
    const time = task.createdAt ? new Date(task.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    setElementText(q.detail, [task.protocol || 'auto', `尝试 ${attempts}`, time].filter(Boolean).join(' · '));
    q.status.className = `queue-status ${task.status || 'pending'}`;
    setElementText(q.statusLabel, queueStatusText(task.status));
    setElementText(q.provider, task.status === 'running' && task.providerName ? task.providerName : '等待分配供应商');
    q.provider.title = q.provider.textContent;
    q.progress.hidden = task.status !== 'running';
    if (!q.progress.hidden) {
        const percent = normalizeProgressPercent(task.progress);
        setElementText(q.phase, progressPhaseText(task.progress) || '生成中');
        q.bar.style.width = `${percent == null ? 18 : Math.max(4, percent)}%`;
    }
    q.cancel.setAttribute('aria-label', `取消任务：${q.title.textContent}`);
}

function renderQueue() {
    const tasks = state.queueTasks || [];
    setElementText(el.queueMeta, `${tasks.length} 个任务`);
    setElementText(el.queueRunningCount, tasks.filter(task => task.status === 'running').length);
    setElementText(el.queuePendingCount, tasks.filter(task => task.status === 'pending').length);
    el.cancelAllTasksBtn.disabled = tasks.length === 0;
    const existing = new Map([...el.queueList.children]
        .filter(item => item.dataset.taskId).map(item => [item.dataset.taskId, item]));
    const ids = new Set(tasks.map(task => String(task.id)));
    for (const [id, item] of existing) if (!ids.has(id)) item.remove();
    const empty = el.queueList.querySelector('.queue-empty');
    if (!tasks.length) {
        if (!empty) {
            const placeholder = document.createElement('div');
            placeholder.className = 'queue-empty';
            placeholder.innerHTML = '<i data-lucide="list-todo"></i><strong>暂无任务</strong><span>开始生成图片后，任务将显示在这里</span>';
            el.queueList.appendChild(placeholder);
            refreshLucideIcons(placeholder);
        }
        return;
    }
    empty?.remove();
    tasks.forEach((task, index) => {
        const id = String(task.id);
        let item = existing.get(id);
        const created = !item;
        if (!item) item = createQueueItem(id);
        const signature = JSON.stringify(task);
        if (item._queueSignature !== signature) {
            updateQueueItem(item, task);
            item._queueSignature = signature;
        }
        if (el.queueList.children[index] !== item) el.queueList.insertBefore(item, el.queueList.children[index] || null);
        if (created) refreshLucideIcons(item);
    });
}

function queueStatusText(status) {
    const map = {
        pending: '等待中',
        running: '运行中',
        completed: '已完成',
        failed: '失败',
        cancelled: '已取消'
    };
    return map[status] || status || '等待';
}

function applyConfirmedCancellation(taskId) {
    for (const sequence of state.sequences) {
        const status = sequence.batch?.taskStates?.get(taskId);
        if (isTerminalTaskStatus(status)) continue;
        sequence.runningTasks.delete(taskId);
        sequence.taskProgress?.delete(taskId);
        markBatchTaskStatus(sequence, taskId, 'cancelled');
    }
    applyQueueTask({ id: taskId, status: 'cancelled' });
}

async function cancelQueuedTask(taskId) {
    try {
        const response = await fetch(`${state.serverUrl}/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '取消失败');
        if (result.success) applyConfirmedCancellation(taskId);
        await syncTasks();
        showToast(result.success ? '任务已取消' : '任务正在保存或已经结束');
    } catch (error) {
        showToast(`取消失败: ${error.message}`);
    } finally {
        updateActionState();
    }
}

async function cancelAllQueuedTasks() {
    const tasks = [...(state.queueTasks || [])];
    if (tasks.length === 0) return;
    const confirmed = await askConfirm(`确定取消队列中的 ${tasks.length} 个任务？`, {
        title: '取消全部任务', okText: '全部取消', danger: true
    });
    if (!confirmed) return;
    el.cancelAllTasksBtn.disabled = true;
    try {
        const results = await Promise.allSettled(tasks.map(async task => {
            const response = await fetch(`${state.serverUrl}/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '取消失败');
            if (result.success) applyConfirmedCancellation(task.id);
            return result.success === true;
        }));
        const cancelled = results.filter(result => result.status === 'fulfilled' && result.value).length;
        const failed = results.filter(result => result.status === 'rejected').length;
        await syncTasks();
        const remaining = tasks.length - cancelled - failed;
        showToast(`已取消 ${cancelled} 个任务${remaining ? `，${remaining} 个正在保存或已结束` : ''}${failed ? `，${failed} 个取消失败` : ''}`);
    } finally {
        el.cancelAllTasksBtn.disabled = state.queueTasks.length === 0;
        updateActionState();
    }
}

function fillSettingsForm() {
    const preset = state.currentPresetId ? getPresetById(state.currentPresetId) : null;
    if (!preset) {
        el.settingsFormTitle.textContent = '新增 API';
        el.presetNameInput.value = '';
        el.baseUrlInput.value = '';
        el.apiKeyInput.value = '';
        el.providerEnabledToggle.checked = true;
        el.providerConcurrencyInput.value = '1';
        el.providerPriorityInput.value = '1';
        renderModelRows([], {}, {}, []);
        el.deleteProviderBtn.disabled = true;
        el.testProviderBtn.disabled = true;
        return;
    }

    el.settingsFormTitle.textContent = '编辑 API';
    el.settingsPresetSelect.value = preset.id;
    el.presetNameInput.value = preset.name || '';
    el.baseUrlInput.value = preset.baseUrl || preset.url || '';
    el.apiKeyInput.value = preset.apiKey || '';
    el.providerEnabledToggle.checked = preset.enabled !== false;
    state.strategyProviderId = preset.id;
    if (el.strategyProviderSelect) el.strategyProviderSelect.value = preset.id;
    el.providerConcurrencyInput.value = String(preset.maxConcurrent || 1);
    el.providerPriorityInput.value = String(preset.priority || 1);
    renderModelRows(
        preset.models || [],
        preset.modelPricing || preset.pricing,
        preset.modelRouting || {},
        preset.discoveredModels || []
    );
    el.deleteProviderBtn.disabled = false;
    el.testProviderBtn.disabled = false;
}

function fillChatSettingsForm() {
    // Legacy chat-provider form was replaced by the 提示词优化 settings panel.
    // Its inputs are hidden shims; bail out if the DOM no longer carries them.
    if (!el.chatSettingsFormTitle || !el.chatProviderNameInput) return;
    const preset = state.currentChatPresetId ? getChatPresetById(state.currentChatPresetId) : null;
    if (!preset) {
        el.chatSettingsFormTitle.textContent = '新增提示词优化 API';
        el.chatProviderNameInput.value = '';
        el.chatProviderBaseUrlInput.value = '';
        el.chatProviderApiKeyInput.value = '';
        renderChatModelRows([], '');
        el.deleteChatProviderBtn.disabled = true;
        el.testChatProviderBtn.disabled = true;
        return;
    }

    el.chatSettingsFormTitle.textContent = '编辑提示词优化 API';
    el.chatSettingsPresetSelect.value = preset.id;
    el.chatProviderNameInput.value = preset.name || '';
    el.chatProviderBaseUrlInput.value = preset.baseUrl || preset.url || '';
    el.chatProviderApiKeyInput.value = preset.apiKey || '';
    renderChatModelRows(preset.models || [], preset.activeModel || preset.model);
    el.deleteChatProviderBtn.disabled = false;
    el.testChatProviderBtn.disabled = false;
}

function startNewProvider() {
    state.currentPresetId = null;
    renderSettingsPresetSelect();
    fillSettingsForm();
    el.presetNameInput.focus();
}

function startNewChatProvider() {
    state.currentChatPresetId = null;
    renderChatSettingsPresetSelect();
    fillChatSettingsForm();
    el.chatProviderNameInput.focus();
}

async function deleteCurrentProvider() {
    const current = state.currentPresetId ? getPresetById(state.currentPresetId) : null;
    if (!current) return;

    const confirmed = await askConfirm(`删除 API 配置「${current.name}」？此操作不可恢复。`, {
        title: '删除 API 配置',
        okText: '删除',
        danger: true
    });
    if (!confirmed) return;

    el.deleteProviderBtn.disabled = true;
    try {
        await deleteProviderConfig(current.id);
        state.currentPresetId = null;
        await refreshProviders();
        showToast('API 配置已删除');
    } catch (error) {
        showToast(`删除失败: ${error.message}`);
    } finally {
        renderSettingsPresetSelect();
    }
}

async function deleteCurrentChatProvider() {
    const current = state.currentChatPresetId ? getChatPresetById(state.currentChatPresetId) : null;
    if (!current) return;

    const confirmed = await askConfirm(`删除提示词优化配置「${current.name}」？此操作不可恢复。`, {
        title: '删除提示词优化配置',
        okText: '删除',
        danger: true
    });
    if (!confirmed) return;

    el.deleteChatProviderBtn.disabled = true;
    try {
        await deleteChatProviderConfig(current.id);
        state.currentChatPresetId = null;
        await refreshChatProviders();
        showToast('提示词优化配置已删除');
    } catch (error) {
        showToast(`删除失败: ${error.message}`);
    } finally {
        renderChatSettingsPresetSelect();
    }
}

function formatApiTestMessage(label, result = {}) {
    const latency = Number.isFinite(Number(result.latencyMs)) && Number(result.latencyMs) > 0
        ? `，时延 ${Math.round(Number(result.latencyMs))}ms`
        : '';
    const status = result.status ? `HTTP ${result.status}` : '';

    if (result.success) {
        return `${label}有效${latency}`;
    }

    const detail = [status, result.message].filter(Boolean).join('，');
    return `${label}测试失败${latency}${detail ? `：${detail}` : ''}`;
}

async function testCurrentProvider() {
    const current = state.currentPresetId ? getPresetById(state.currentPresetId) : null;
    if (!current) {
        showToast('请先保存 API 后再测试');
        return;
    }

    el.testProviderBtn.disabled = true;
    const previousText = el.testProviderBtn.textContent;
    el.testProviderBtn.textContent = '测试中';
    try {
        const result = await requestProvider(`/api/providers/${encodeURIComponent(current.id)}/test`, {
            method: 'POST'
        });
        if (result.health) applyProviderHealth([
            ...state.providerHealth.values()].filter(status => status.id !== result.health.id).concat(result.health));
        else await refreshProviderHealth();
        showToast(formatApiTestMessage('API', result));
    } catch (error) {
        showToast(`测试失败: ${error.message}`);
    } finally {
        el.testProviderBtn.disabled = false;
        el.testProviderBtn.textContent = previousText;
    }
}

async function discoverCurrentProvider() {
    let current = state.currentPresetId ? getPresetById(state.currentPresetId) : null;
    const payload = readProviderFormPayload();
    if (!payload.baseUrl || !payload.apiKey) {
        showToast('请填写 Base URL 和 API Key');
        return;
    }
    el.discoverProviderBtn.disabled = true;
    el.savePresetBtn.disabled = true;
    const previousText = el.discoverProviderBtn.textContent;
    el.discoverProviderBtn.textContent = '发现中';
    try {
        const saved = await saveProviderConfig(payload, current?.id || null);
        setActiveProvider(saved.id);
        await refreshProviders(saved.id);
        current = getPresetById(saved.id);
        const result = await requestProvider(`/api/providers/${encodeURIComponent(current.id)}/discover`, {
            method: 'POST',
            body: JSON.stringify({ model: current.models?.[0] || '' })
        });
        await refreshProviders(current.id);
        fillSettingsForm();
        showToast(`已发现 ${result.models?.length || 0} 个模型的能力`);
    } catch (error) {
        showToast(`能力发现失败: ${error.message}`);
    } finally {
        el.discoverProviderBtn.disabled = false;
        el.savePresetBtn.disabled = false;
        el.discoverProviderBtn.textContent = previousText;
    }
}

async function testCurrentChatProvider() {
    const current = state.currentChatPresetId ? getChatPresetById(state.currentChatPresetId) : null;
    if (!current) {
        showToast('请先保存提示词优化 API 后再测试');
        return;
    }

    el.testChatProviderBtn.disabled = true;
    const previousText = el.testChatProviderBtn.textContent;
    el.testChatProviderBtn.textContent = '测试中';
    try {
        const result = await requestProvider(`/api/chat-providers/${encodeURIComponent(current.id)}/test`, {
            method: 'POST'
        });
        showToast(formatApiTestMessage('提示词优化 API', result));
    } catch (error) {
        showToast(`测试失败: ${error.message}`);
    } finally {
        el.testChatProviderBtn.disabled = false;
        el.testChatProviderBtn.textContent = previousText;
    }
}

function readProviderFormPayload() {
    const name = el.presetNameInput.value.trim() || '未命名 API';
    const url = el.baseUrlInput.value.trim();
    const apiKey = el.apiKeyInput.value.trim();
    const { models, modelPricing, modelRouting } = readModelRows();

    return {
        name,
        baseUrl: url,
        apiKey,
        models,
        modelPricing,
        modelRouting,
        enabled: el.providerEnabledToggle.checked,
        maxConcurrent: Number(el.providerConcurrencyInput.value) || 1,
        priority: getPresetById(state.currentPresetId)?.priority || 1
    };
}

async function saveCurrentPresetFromForm() {
    const current = state.currentPresetId ? getCurrentPreset() : null;
    const payload = readProviderFormPayload();

    if (!payload.baseUrl || !payload.apiKey) {
        showToast('请填写 Base URL 和 API Key');
        return;
    }

    el.savePresetBtn.disabled = true;
    const previousText = el.savePresetBtn.textContent;
    el.savePresetBtn.textContent = '保存中';
    try {
        const next = await saveProviderConfig(payload, current?.id || null);
        setActiveProvider(next.id);

        const sequence = getCurrentSequence();
        sequence.providerId = next.id;
        if (!next.models.includes(sequence.model)) {
            sequence.model = next.models[0] || '';
        }
        saveSequences();

        await refreshProviders(next.id);
        loadCurrentSequenceToForm();
        showToast('API 设置已保存');
    } catch (error) {
        showToast(`保存失败: ${error.message}`);
    } finally {
        el.savePresetBtn.disabled = false;
        el.savePresetBtn.textContent = previousText;
    }
}

async function saveCurrentChatProviderFromForm() {
    const current = state.currentChatPresetId ? getChatPresetById(state.currentChatPresetId) : null;
    const name = el.chatProviderNameInput.value.trim() || '提示词优化 API';
    const url = el.chatProviderBaseUrlInput.value.trim();
    const apiKey = el.chatProviderApiKeyInput.value.trim();
    const { chatModels, activeChatModel, chatModel } = readChatModelRows();
    const promptOptimizerSystemPrompt = (el.promptOptimizerSystemInput?.value.trim())
        || state.promptOptimizeSystemPrompt
        || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT;

    if (!url || !apiKey || chatModels.length === 0) {
        showToast('请填写提示词优化 API 的 Base URL、API Key 和至少一个模型');
        return;
    }

    const payload = {
        name,
        baseUrl: url,
        apiKey,
        models: chatModels,
        activeModel: activeChatModel,
        model: chatModel,
        promptOptimizerSystemPrompt
    };

    el.saveChatProviderBtn.disabled = true;
    const previousText = el.saveChatProviderBtn.textContent;
    el.saveChatProviderBtn.textContent = '保存中';
    try {
        const next = await saveChatProviderConfig(payload, current?.id || null);
        setActiveChatProvider(next.id);
        await refreshChatProviders(next.id);
        showToast('提示词优化设置已保存');
    } catch (error) {
        showToast(`保存失败: ${error.message}`);
    } finally {
        el.saveChatProviderBtn.disabled = false;
        el.saveChatProviderBtn.textContent = previousText;
    }
}

function getClipboardImageFiles(event) {
    const files = [];
    const data = event.clipboardData;
    if (!data) return files;

    for (const file of Array.from(data.files || [])) {
        if (isImageFile(file)) files.push(file);
    }

    for (const item of Array.from(data.items || [])) {
        if (item.kind !== 'file' || !String(item.type || '').startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file && !files.some(existing => existing === file || existing.name === file.name && existing.size === file.size)) {
            files.push(file);
        }
    }

    return files;
}

function isImageFile(file) {
    if (!file) return false;
    if (String(file.type || '').startsWith('image/')) return true;
    return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(String(file.name || ''));
}

function getImageFilesFromList(fileList) {
    return Array.from(fileList || []).filter(isImageFile);
}

function extractDroppedImageFiles(event) {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return [];
    if (!Array.from(dataTransfer.types || []).includes('Files')) return [];
    return getImageFilesFromList(dataTransfer.files);
}

function isFileDrag(event) {
    const dataTransfer = event.dataTransfer;
    return !!dataTransfer && Array.from(dataTransfer.types || []).includes('Files');
}

// 拖动途中只看得到条目的 MIME（看不到文件内容）：一个图片都没有（PDF、PSD…）就不亮提示层，
// 免得显示「松手添加」再在松手时什么都不做。类型为空的条目按可能是图片放行。
function isImageFileDrag(event) {
    if (!isFileDrag(event)) return false;
    const items = Array.from(event.dataTransfer.items || []).filter(item => item.kind === 'file');
    return !items.length || items.some(item => !item.type || item.type.startsWith('image/'));
}

// 文件拖到提示词行里但不接收（不是图片）：仍要 preventDefault，否则 Chromium 会把文件当页面打开。
function refuseFileDrag(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
    clearPromptDropSplit();
}

function createPromptReferenceToken(reference, index = 0, mention = '') {
    const token = document.createElement('span');
    token.className = 'prompt-reference-token';
    token.contentEditable = 'false';
    token.dataset.referenceId = reference.id || '';
    token.dataset.mention = mention || `@{${mentionNameForReference(reference, index)}}`;
    token.title = reference.name || mentionNameForReference(reference, index);
    token.setAttribute('role', 'img');
    token.setAttribute('aria-label', `引用图片 ${token.title}`);

    const preview = document.createElement('img');
    preview.src = `data:${reference.mimeType || 'image/png'};base64,${reference.base64 || ''}`;
    preview.alt = '';
    token.appendChild(preview);

    const name = document.createElement('span');
    name.className = 'prompt-reference-name';
    name.textContent = reference.name || mentionNameForReference(reference, index);
    token.appendChild(name);
    return token;
}

// 空 @：引用的参考图被删后留下的占位。点它弹出参考图选择（openEmptyMentionPicker）。
function createEmptyReferenceToken() {
    const token = document.createElement('span');
    token.className = 'prompt-reference-token is-empty';
    token.contentEditable = 'false';
    token.dataset.mention = rendererUtils.EMPTY_REFERENCE_MENTION;
    token.title = '引用的参考图已删除，点击选择一张';
    token.setAttribute('role', 'button');
    token.setAttribute('aria-label', '未选择参考图，点击选择');
    const name = document.createElement('span');
    name.className = 'prompt-reference-name';
    name.textContent = '@ 选择参考图';
    token.appendChild(name);
    return token;
}

function setPromptEditorValue(prompt, references = getCurrentSequence()?.references || [], options = {}) {
    const fragment = document.createDocumentFragment();
    for (const segment of rendererUtils.promptSegments(prompt, references)) {
        if (segment.type === 'reference') {
            fragment.appendChild(createPromptReferenceToken(segment.reference, segment.index, segment.mention));
        } else if (segment.type === 'empty-reference') {
            fragment.appendChild(createEmptyReferenceToken());
        } else if (segment.text) {
            fragment.appendChild(document.createTextNode(segment.text));
        }
    }
    el.promptInput.replaceChildren(fragment);
    // 整段替换也是一次可撤销的编辑；只有“把编辑器当作映射外部状态”的调用
    // （加载表单、流式覆盖、撤销自身）才传 undo:false 跳过记录。
    if (options.undo !== false) promptUndoRecord(getPromptEditorValue(), { sequenceId: options.sequenceId });
}

// ── 提示词编辑器撤销栈 ──────────────────────────────────────────────
// Chromium 自带的 contenteditable 撤销栈与本编辑器必然失配：Enter 换行、粘贴、
// @ 提及、token 增删、以及所有 setPromptEditorValue 都是手写 Range / 裸 DOM 变更，
// 原生栈记不到这些步骤，放行 Ctrl+Z 会撤出与屏幕内容不符的结果。
// 所以这里自建快照栈并独占 Ctrl+Z —— 机制照搬 mask 画布（pushMaskHistory）。
const PROMPT_UNDO_LIMIT = 100;
// 连续打字的合并窗口：窗口内的击键并成一步，停手 700ms 后另起一步。
const PROMPT_UNDO_BURST_MS = 700;
const PROMPT_UNDO_BURST_TYPES = new Set([
    'insertText', 'insertCompositionText', 'insertLineBreak', 'insertParagraph',
    'deleteContentBackward', 'deleteContentForward', 'deleteWordBackward', 'deleteWordForward'
]);

function promptUndoState(sequenceId = state.currentSequenceId) {
    if (!sequenceId) return null;
    let record = state.promptHistory.get(sequenceId);
    if (!record) {
        record = { stack: [], index: -1, burstUntil: 0, suspended: 0 };
        state.promptHistory.set(sequenceId, record);
    }
    return record;
}

// 整个编辑器内容被外部状态重建（切序列、加载表单）后重设基线。
// 与 promptUndoRecord 不同，这里不受 suspended 影响。
function promptUndoReset(text = getPromptEditorValue(), sequenceId = state.currentSequenceId) {
    const record = promptUndoState(sequenceId);
    if (!record) return;
    record.stack = [text];
    record.index = 0;
    record.burstUntil = 0;
    // 顺手清掉已关闭序列的桶；只在切序列/加载表单时跑，不在击键路径上。
    if (state.promptHistory.size > 1 && state.sequences.length) {
        const alive = new Set(state.sequences.map(sequence => sequence.id));
        for (const id of state.promptHistory.keys()) {
            if (!alive.has(id) && id !== sequenceId) state.promptHistory.delete(id);
        }
    }
}

// 切序列时用的重设入口。loadCurrentSequenceToForm 会整段重建编辑器，但「切走再
// 切回来」内容一个字都没变 —— 无条件重设会把用户刚敲的、或流式优化刚落下的历史
// 全清掉，Ctrl+Z 从此按不动。只有桶里已经对不上这段内容时才重设基线。
function promptUndoResetIfDiverged(text, sequenceId = state.currentSequenceId) {
    const record = state.promptHistory.get(sequenceId);
    // 挂起中（正在被这次优化运行改写）的桶由运行接管，重设会把「优化前原文」这条
    // 唯一的回退基线抹掉，收尾后 Ctrl+Z 就回不去了。
    if (record && (record.suspended > 0 || record.stack[record.index] === text)) return;
    promptUndoReset(text, sequenceId);
}

// 流式覆盖期间挂起记录。必须显式传 sequenceId：整段流可能跨过用户切序列，
// 用默认的「当前序列」会让挂起和还原落在不同的桶上，留下永远挂着的历史。
function promptUndoSuspend(on, sequenceId = state.currentSequenceId) {
    const record = promptUndoState(sequenceId);
    if (!record) return;
    record.suspended = Math.max(0, record.suspended + (on ? 1 : -1));
}

function promptUndoRecord(text = getPromptEditorValue(), options = {}) {
    const record = promptUndoState(options.sequenceId);
    if (!record || record.suspended > 0) return;
    if (record.index < 0) { record.stack = [text]; record.index = 0; return; }
    if (record.stack[record.index] === text) return;

    const now = Date.now();
    const atTip = record.index === record.stack.length - 1;
    if (options.coalesce && atTip && now < record.burstUntil) {
        record.stack[record.index] = text;
    } else {
        // 在历史中间编辑：丢弃被撤销掉的重做分支。
        record.stack = record.stack.slice(0, record.index + 1);
        record.stack.push(text);
        if (record.stack.length > PROMPT_UNDO_LIMIT) record.stack.shift();
        record.index = record.stack.length - 1;
    }
    record.burstUntil = options.coalesce ? now + PROMPT_UNDO_BURST_MS : 0;
}

function focusPromptEditorEnd() {
    const range = document.createRange();
    range.selectNodeContents(el.promptInput);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

function promptUndoApply(delta) {
    const record = promptUndoState();
    if (!record) return false;
    const next = Math.max(0, Math.min(record.stack.length - 1, record.index + delta));
    const snapshot = record.stack[next];
    if (typeof snapshot !== 'string') return true; // 桶还没落过基线，直接吞掉按键
    if (next === record.index) return true; // 到头了也吞掉按键，别落到失配的原生栈
    record.index = next;
    record.burstUntil = 0;
    const sequence = getCurrentSequence();
    setPromptEditorValue(snapshot, sequence.references, { undo: false });
    focusPromptEditorEnd();
    saveCurrentSequenceFromForm();
    renderSequenceTabs();
    return true;
}

function handlePromptUndoInput(event) {
    promptUndoRecord(getPromptEditorValue(), {
        coalesce: PROMPT_UNDO_BURST_TYPES.has(event?.inputType)
    });
}

function handlePromptUndoKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    const undo = key === 'z' && !event.shiftKey;
    const redo = key === 'y' || (key === 'z' && event.shiftKey);
    if (!undo && !redo) return false;
    event.preventDefault();
    // 就地覆盖进行中：编辑器正被流式改写，此时撤销只会把两边的状态搅乱。
    if (state.promptOptimizeRun?.sequenceId === state.currentSequenceId) return true;
    return promptUndoApply(redo ? 1 : -1);
}

function serializePromptChildren(parent) {
    let value = '';
    for (const child of parent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            value += child.nodeValue || '';
            continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.classList.contains('prompt-reference-token')) {
            value += child.dataset.mention || '';
            continue;
        }
        if (child.tagName === 'BR') {
            value += '\n';
            continue;
        }

        const block = PROMPT_BLOCK_TAGS.has(child.tagName);
        if (block && value && !value.endsWith('\n')) value += '\n';
        value += serializePromptChildren(child);
        if (block && child.nextSibling && !value.endsWith('\n')) value += '\n';
    }
    return value;
}

function getPromptEditorValue() {
    return serializePromptChildren(el.promptInput)
        .replace(/\u00a0/g, ' ')
        .replace(/\u200b/g, '');
}

function promptSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!el.promptInput.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== el.promptInput) {
        return null;
    }
    return { selection, range };
}

function insertPromptTextAtSelection(text) {
    el.promptInput.focus();
    let current = promptSelection();
    if (!current) {
        const range = document.createRange();
        range.selectNodeContents(el.promptInput);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        current = { selection, range };
    }

    current.range.deleteContents();
    const textNode = document.createTextNode(String(text || ''));
    current.range.insertNode(textNode);
    const caret = document.createRange();
    caret.setStart(textNode, textNode.nodeValue.length);
    caret.collapse(true);
    current.selection.removeAllRanges();
    current.selection.addRange(caret);
}

function dispatchPromptInput(inputType = 'insertText', data = null) {
    el.promptInput.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType,
        data
    }));
}

function deleteAdjacentPromptToken(key) {
    const current = promptSelection();
    if (!current || !current.selection.isCollapsed) return false;
    const node = current.selection.anchorNode;
    const offset = current.selection.anchorOffset;
    let candidate = null;
    let rootCaretOffset = null;

    if (node === el.promptInput) {
        const index = key === 'Backspace' ? offset - 1 : offset;
        candidate = index >= 0 ? el.promptInput.childNodes[index] : null;
        rootCaretOffset = key === 'Backspace' ? Math.max(0, offset - 1) : offset;
    } else if (node?.nodeType === Node.TEXT_NODE) {
        const atBoundary = key === 'Backspace' ? offset === 0 : offset === node.nodeValue.length;
        if (atBoundary && node.parentNode === el.promptInput) {
            candidate = key === 'Backspace' ? node.previousSibling : node.nextSibling;
        }
    }

    if (!candidate?.classList?.contains('prompt-reference-token')) return false;
    candidate.remove();
    if (rootCaretOffset !== null) {
        const caret = document.createRange();
        caret.setStart(el.promptInput, Math.min(rootCaretOffset, el.promptInput.childNodes.length));
        caret.collapse(true);
        current.selection.removeAllRanges();
        current.selection.addRange(caret);
    }
    dispatchPromptInput(key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward');
    return true;
}

// 复制 / 剪切只写纯文本。原生复制会把选区里的引用图 token 连同 <img src="data:…完整 base64"> 一起写成 text/html，
// 几 MB 的 HTML 粘进 Obsidian 之类的编辑器会让对方卡死；本编辑器自己粘贴时只读 text/plain，用不上 HTML。
// token 序列化成 @{名称}，与发出去的提示词（getPromptEditorValue）一致。
function handlePromptCopy(event) {
    const current = promptSelection();
    if (!current || current.range.collapsed || !event.clipboardData) return;
    const text = serializePromptChildren(current.range.cloneContents())
        .replace(/ /g, ' ')
        .replace(/​/g, '');
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    // preventDefault 同时取消了原生剪切的删除；execCommand 走原生编辑，照常触发 input 事件（撤销栈、@ 菜单都靠它）。
    if (event.type === 'cut') document.execCommand('delete');
}

async function handlePromptPaste(event) {
    const files = getClipboardImageFiles(event);
    if (files.length > 0) {
        event.preventDefault();
        try {
            await addReferenceFiles(files, { source: 'paste' });
            showToast(`已添加 ${files.length} 张参考图`);
        } catch (error) {
            showToast(`粘贴图片失败: ${error.message}`);
        }
        return;
    }

    const text = event.clipboardData?.getData('text/plain');
    if (typeof text !== 'string') return;
    event.preventDefault();
    insertPromptTextAtSelection(text);
    dispatchPromptInput('insertFromPaste', text);
}

function mentionNameForReference(reference, index = 0) {
    return rendererUtils.referenceAlias(reference, index);
}

function mentionRangeAtCursor() {
    const current = promptSelection();
    if (!current || !current.selection.isCollapsed) return null;
    let textNode = current.selection.anchorNode;
    let cursor = current.selection.anchorOffset;
    if (textNode === el.promptInput) {
        const beforeNode = el.promptInput.childNodes[cursor - 1];
        const afterNode = el.promptInput.childNodes[cursor];
        if (beforeNode?.nodeType === Node.TEXT_NODE) {
            textNode = beforeNode;
            cursor = beforeNode.nodeValue.length;
        } else if (afterNode?.nodeType === Node.TEXT_NODE) {
            textNode = afterNode;
            cursor = 0;
        } else {
            return null;
        }
    }
    if (textNode?.nodeType !== Node.TEXT_NODE || textNode.parentNode !== el.promptInput) return null;

    const before = textNode.nodeValue.slice(0, cursor);
    const at = before.lastIndexOf('@');
    if (at < 0) return null;
    const query = before.slice(at + 1);
    if (/\s|[{}]/.test(query)) return null;
    if (at > 0 && /[\w@]/.test(before[at - 1])) return null;
    return { textNode, start: at, end: cursor, query: query.toLowerCase() };
}

function updateMentionMenu() {
    const range = mentionRangeAtCursor();
    if (!range) {
        hideMentionMenu();
        return;
    }
    const sequence = getCurrentSequence();
    state.mentionItems = sequence.references.map((reference, index) => ({
        reference,
        label: mentionNameForReference(reference, index),
        detail: `参考图 ${index + 1}`,
        previewUrl: `data:${reference.mimeType || 'image/png'};base64,${reference.base64}`
    }))
        .filter(item => !range.query || `${item.label} ${item.detail}`.toLowerCase().includes(range.query))
        .slice(0, 8);
    state.mentionRange = range;
    // 键入 @ 打开的是插入菜单：清掉之前点空 @ 留下的目标，否则选中项会填到那个旧占位上。
    state.mentionTargetToken = null;
    state.mentionIndex = Math.min(state.mentionIndex, Math.max(0, state.mentionItems.length - 1));
    renderMentionMenu();
}

function renderMentionMenu() {
    el.mentionMenu.innerHTML = '';
    if (state.mentionItems.length === 0) {
        hideMentionMenu();
        return;
    }
    state.mentionItems.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = index === state.mentionIndex ? 'active' : '';
        button.setAttribute('role', 'option');

        const preview = document.createElement('img');
        preview.className = 'mention-preview';
        preview.src = item.previewUrl;
        preview.alt = '';
        button.appendChild(preview);

        const text = document.createElement('span');
        text.className = 'mention-text';
        const label = document.createElement('span');
        label.className = 'mention-label';
        label.textContent = item.label;
        const detail = document.createElement('small');
        detail.textContent = item.detail;
        text.append(label, detail);
        button.appendChild(text);

        button.addEventListener('pointerdown', event => event.preventDefault());
        button.addEventListener('click', () => selectMentionItem(item));
        el.mentionMenu.appendChild(button);
    });
    el.mentionMenu.hidden = false;
}

function hideMentionMenu() {
    if (!el.mentionMenu) return;
    el.mentionMenu.hidden = true;
    state.mentionItems = [];
    state.mentionRange = null;
    state.mentionTargetToken = null;
    state.mentionIndex = 0;
}

function handleMentionKeydown(event) {
    if (el.mentionMenu.hidden || state.mentionItems.length === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        state.mentionIndex = (state.mentionIndex + delta + state.mentionItems.length) % state.mentionItems.length;
        renderMentionMenu();
        return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        selectMentionItem(state.mentionItems[state.mentionIndex]);
        return true;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        hideMentionMenu();
        return true;
    }
    return false;
}

function handlePromptKeydown(event) {
    if (event.isComposing) return;
    if (handlePromptUndoKeydown(event)) return;
    if (handleMentionKeydown(event)) return;
    if ((event.key === 'Backspace' || event.key === 'Delete') && deleteAdjacentPromptToken(event.key)) {
        event.preventDefault();
        return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    insertPromptTextAtSelection('\n');
    dispatchPromptInput('insertLineBreak', '\n');
}

function selectMentionItem(item) {
    if (item && state.mentionTargetToken) { fillEmptyMention(state.mentionTargetToken, item.reference); return; }
    const range = state.mentionRange;
    if (!item || !range || !range.textNode?.isConnected) return;
    const reference = item.reference;
    const sequence = getCurrentSequence();
    const index = sequence.references.findIndex(candidate => candidate.id === reference.id);
    const mention = `@{${mentionNameForReference(reference, index)}}`;
    const domRange = document.createRange();
    domRange.setStart(range.textNode, range.start);
    domRange.setEnd(range.textNode, range.end);
    domRange.deleteContents();

    const token = createPromptReferenceToken(reference, index, mention);
    const trailingSpace = document.createTextNode(' ');
    const fragment = document.createDocumentFragment();
    fragment.append(token, trailingSpace);
    domRange.insertNode(fragment);

    const selection = window.getSelection();
    const caret = document.createRange();
    caret.setStart(trailingSpace, 1);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    hideMentionMenu();
    dispatchPromptInput('insertReplacementText', mention);
    saveCurrentSequenceFromForm();
    renderSequenceTabs();
    el.promptInput.focus();
}

// 点空 @：用同一个 @ 菜单列出参考图栏里的全部图片，选中的那张替换这个占位。
function handlePromptClick(event) {
    const token = event.target.closest?.('.prompt-reference-token.is-empty');
    if (token && el.promptInput.contains(token)) { openEmptyMentionPicker(token); return; }
    updateMentionMenu();
}

function openEmptyMentionPicker(token) {
    if (state.promptOptimizeRun) return; // 优化正在就地改写
    const sequence = getCurrentSequence();
    if (!sequence.references.length) {
        hideMentionMenu();
        showToast('参考图栏还没有图片，先添加参考图再选择');
        return;
    }
    state.mentionItems = sequence.references.map((reference, index) => ({
        reference,
        label: mentionNameForReference(reference, index),
        detail: `参考图 ${index + 1}`,
        previewUrl: `data:${reference.mimeType || 'image/png'};base64,${reference.base64}`
    }));
    state.mentionRange = null;
    state.mentionTargetToken = token;
    state.mentionIndex = 0;
    el.promptInput.focus();
    renderMentionMenu();
}

function fillEmptyMention(token, reference) {
    hideMentionMenu();
    if (!token.isConnected || !reference) return;
    const sequence = getCurrentSequence();
    const index = sequence.references.findIndex(candidate => candidate.id === reference.id);
    if (index < 0) return;
    const mention = `@{${mentionNameForReference(reference, index)}}`;
    token.replaceWith(createPromptReferenceToken(reference, index, mention));
    dispatchPromptInput('insertReplacementText', mention);
    saveCurrentSequenceFromForm();
    renderSequenceTabs();
    el.promptInput.focus();
}

// 空 @ 不指向任何图：照样提交的话，模型收到的提示词会缺一个引用对象。
function blockEmptyReferenceMentions(sequence, action) {
    const count = rendererUtils.countEmptyReferenceMentions(sequence.prompt);
    if (!count) return false;
    showToast(`提示词里有 ${count} 个空 @ 还没选图，点它选择参考图或删掉后再${action}`);
    return true;
}

function resolvePromptMentions(sequence) {
    return rendererUtils.resolvePromptMentions(sequence.prompt, sequence.references);
}

// 拖图到提示词区的上下分区（整行宽度）：
//   · 上部（文本区）＝ 读取提示词——松手读取图片内嵌提示词；
//   · 底部带（参考图照片堆所在那一条）＝ 加参考图。
// 分界线只有一处来源：promptDropBandTop。拖拽提示层按同一条线画出两个区，
// 文件拖入（promptDropZoneFromEvent）与应用内拖图（onImageDragEnded 的落点命中）
// 都按它判定 —— 看到的区域就是实际接收的区域。
// 应用内拖历史图走不了 dragover/drop：原生拖拽由主进程的 OLE 模态循环接管，
// Chromium 不给拖拽源窗口派发这些事件，命中在 onImageDragEnded 里用光标落点做。
// 模型不支持参考图时没有底部带，整框都是读提示词。
const PROMPT_DROP_BAND_MARGIN = 12;

function promptDropReferenceEnabled() {
    return Boolean(el.referenceRail && !el.referenceRail.hidden);
}

// 量照片堆本体（.reference-group 带 scale 变换，getBoundingClientRect 量的是画出来的样子），
// 不量 #referenceRail：后者的布局盒是未缩放尺寸，比看到的堆高出约 38px。
// 底部带最多占半行，矮窗口里「读提示词」区不会被挤没。
function promptDropBandTop(rowRect) {
    const group = el.referenceRail?.querySelector('.reference-group');
    const groupRect = group?.getBoundingClientRect();
    const visualTop = groupRect?.height ? groupRect.top : rowRect.bottom - 64;
    return Math.max(visualTop - PROMPT_DROP_BAND_MARGIN, rowRect.top + rowRect.height / 2);
}

function promptDropZoneFromEvent(event) {
    if (!promptDropReferenceEnabled()) return 'prompt';
    const rect = promptDropRowRect();
    if (!rect) return 'prompt';
    return event.clientY >= promptDropBandTop(rect) ? 'reference' : 'prompt';
}

// zone：'prompt' | 'reference' 高亮光标所在的区；'reference-only'（应用内拖图）只画参考图带。
function setPromptDropZone(zone) {
    state.promptDropZone = zone;
    const overlay = el.promptDropOverlay;
    if (!overlay) return;
    const rect = promptDropRowRect();
    const referenceEnabled = promptDropReferenceEnabled();
    overlay.style.setProperty('--prompt-drop-band', rect && referenceEnabled ? `${Math.round(rect.bottom - promptDropBandTop(rect))}px` : '0px');
    overlay.dataset.reference = referenceEnabled ? 'on' : 'off';
    overlay.dataset.zone = zone;
    // 已显示时只换分区：重新取消 hidden 会重放淡入动画，表现成闪烁。
    if (overlay.hidden) overlay.hidden = false;
}

function clearPromptDropSplit() {
    state.promptDropZone = null;
    if (el.promptDropOverlay) {
        el.promptDropOverlay.hidden = true;
        delete el.promptDropOverlay.dataset.zone;
    }
}

function handlePromptDragOver(event) {
    // 正在拖拽参考图卡：不接收（否则松手会把自己重复加一份）。
    if (state.draggedReferenceCard) { event.preventDefault(); return; }
    if (state.draggedRecentImage) {
        event.preventDefault();
        return;
    }
    if (!isFileDrag(event)) return;
    if (!isImageFileDrag(event)) { refuseFileDrag(event); return; }
    event.preventDefault();
    setPromptDropZone(promptDropZoneFromEvent(event));
}

// 落在参考图上传块上的拖拽：和文本区共用分区状态机，只是分区恒定是「参考图」。
// 必须 preventDefault，否则 Chromium 不给这一块显示可放置（copy）光标，而是禁止符号。
function handleReferenceRailDragOver(event) {
    if (state.draggedReferenceCard) { event.preventDefault(); return; }
    if (state.draggedRecentImage) { event.preventDefault(); return; }
    if (!isFileDrag(event)) return;
    if (!isImageFileDrag(event)) { refuseFileDrag(event); return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setPromptDropZone('reference');
}

async function handlePromptDrop(event) {
    if (state.draggedReferenceCard) { event.preventDefault(); return; }
    const draggedImage = state.draggedRecentImage;
    const zone = state.promptDropZone;
    clearPromptDropSplit();
    const files = extractDroppedImageFiles(event);
    if (!draggedImage && files.length === 0) return;

    event.preventDefault();
    clearDraggedRecentImage();

    try {
        // 内部拖历史图：按**落点**判分区（promptDropZoneFromEvent），不能沿用 state.promptDropZone
        // ——拖拽一开始 rememberDraggedRecentImage 就把整框点亮成「参考图」，照它判会把
        // 「拖到文本区取提示词」也变成加参考图。落点在上传块/底部带 → 加参考图。
        if (draggedImage && promptDropZoneFromEvent(event) === 'reference') {
            await addHistoryImageAsReference(draggedImage);
            return;
        }

        if (draggedImage?.prompt) {
            applyPromptFromGeneratedImage(draggedImage.prompt);
            return;
        }

        // 底部参考图带：加为参考图（限额/落盘/@别名 走既有链路）。
        if (files.length && zone === 'reference') {
            await addReferenceFiles(files, { source: 'drop' });
            return;
        }

        // 文本区：提取图片内嵌提示词。
        const generated = await findGeneratedPromptFromDroppedFiles(files);
        if (generated?.prompt) {
            applyPromptFromGeneratedImage(generated.prompt);
            return;
        }

        showToast('未找到该图片的生成提示词');
    } catch (error) {
        showToast(`处理拖入图片失败: ${error.message}`);
    }
}

function applyPromptFromGeneratedImage(prompt) {
    setPromptEditorValue(prompt);
    saveCurrentSequenceFromForm();
    renderSequenceTabs();
    showToast('已填入该图片生成时的提示词');
}

function rememberDraggedRecentImage(image) {
    clearDraggedRecentImage();
    state.draggedRecentImage = image;
    state.recentDragClearTimer = setTimeout(clearDraggedRecentImage, 20000);
    // 原生拖拽期间渲染层收不到 dragover，没法跟随光标切换分区；应用内拖图也只接收
    // 「加参考图」（见 onImageDragEnded），所以拖拽一开始只按真实分界画出参考图带；
    // 生成视图不可见（历史页）或模型不支持参考图时什么都不亮。
    if (promptDropReferenceEnabled() && promptDropRowRect()) setPromptDropZone('reference-only');
    // 历史页拖图：右下角亮出垃圾篓（同理收不到 dragover，落点命中在 onImageDragEnded 里做）。
    if (state.activeView === 'history' && el.historyDragTrash) el.historyDragTrash.hidden = false;
    setImageDragShield(true);
}

// 拖拽期间盖一层透明遮罩：光标下没有可滚动元素，Chromium 的贴边自动滚动就不会把图库往下滚。
// 所有落点（参考图区、垃圾篓）都按坐标命中，不依赖遮罩下的元素。
function setImageDragShield(on) {
    if (!document.body) return;
    let shield = el.imageDragShield;
    if (!shield) {
        if (!on) return;
        shield = document.createElement('div');
        shield.className = 'image-drag-shield';
        shield.setAttribute('aria-hidden', 'true');
        document.body.appendChild(shield);
        el.imageDragShield = shield;
    }
    shield.hidden = !on;
}

// 记住拖拽源并交给主进程发起原生拖拽（主页/历史图条共用）。
// 点亮了参考图提示时先把这一帧交给浏览器合成，再进 startDrag 的 OLE 模态循环——
// 否则整个拖拽期间主进程被占住，提示很可能一帧都来不及显示（两帧 ≈32ms，无感）。
// 在历史页拖一张多选中的图：整批一起拖（系统拖拽图标是带张数角标的一沓缩略图），
// 被拖的那张在最上面。其余情况只拖这一张。
function historyDragBatch(image) {
    const key = historyImageKey(image);
    if (state.activeView !== 'history' || state.historySelectedIds.size < 2 || !state.historySelectedIds.has(key)) return [image];
    const records = historyRecordsByKey();
    const others = [...state.historySelectedIds].filter(id => id !== key).map(id => records.get(id)).filter(record => record?.filePath);
    return [image, ...others];
}

// 原生拖拽期间（以及结束后到第一次真实移动之前）不弹大图预览
function beginImageDragPreviewGuard() {
    hideImageHoverPreview();
    state.imageDragPreviewGuard = true;
}

function endImageDragPreviewGuard() {
    hideImageHoverPreview();
    state.imageDragPreviewGuard = false;
    // OLE 模态循环吞掉了松键，渲染层收不到 pointerup
    state.imagePointerPressed = false;
    // 取代固定的 400ms：落下后的图条重建、垃圾篓收起、慢 IPC 都可能远晚于 400ms 才补发悬停
    armHoverPreviewMoveGate();
}

function beginRecentImageDrag(image) {
    beginImageDragPreviewGuard();
    hideImageContextMenu();
    const batch = historyDragBatch(image);
    state.draggedRecentBatch = batch;
    const start = () => window.picgenDesktop.startImageDrag(batch.length > 1 ? batch.map(record => record.filePath) : image.filePath);
    if (state.promptDropZone === 'reference' || (el.historyDragTrash && !el.historyDragTrash.hidden)) requestAnimationFrame(() => requestAnimationFrame(start));
    else start();
}

function clearDraggedRecentImage() {
    // 20s 兜底超时也要解除拖拽期间的预览屏蔽；但只结束自己这次拖拽的，
    // 没有主页/历史拖拽在进行时不碰参考图卡拖拽的屏蔽
    if (state.draggedRecentImage) endImageDragPreviewGuard();
    if (state.recentDragClearTimer) {
        clearTimeout(state.recentDragClearTimer);
        state.recentDragClearTimer = null;
    }
    // 拖拽结束（主进程回传光标落点 / 20s 兜底超时）时收起分屏提示。
    if (state.draggedRecentImage) clearPromptDropSplit();
    if (el.historyDragTrash) el.historyDragTrash.hidden = true;
    setImageDragShield(false);
    state.draggedRecentImage = null;
    state.draggedRecentBatch = null;
}

async function findGeneratedPromptFromDroppedFiles(files) {
    for (const file of files) {
        const lookup = await window.picgenDesktop.getGeneratedImagePrompt({
            filePath: getFilePathFromDropFile(file),
            fileName: file.name || ''
        });
        if (lookup?.found) {
            return lookup;
        }
    }
    return null;
}

function getFilePathFromDropFile(file) {
    try {
        return window.picgenDesktop.getPathForFile(file) || '';
    } catch {
        return '';
    }
}

async function addImageFilesFromList(fileList) {
    const files = getImageFilesFromList(fileList);
    if (!files.length) {
        showToast('请选择图片文件');
        return;
    }
    await addReferenceFiles(files);
}

async function addReferenceFiles(files, options = {}) {
    if (!files.length) return;

    const sequence = getCurrentSequence();
    const { profile, available } = referenceSlotBudget(sequence);
    if (available === 0) {
        reportReferenceLimit(profile);
        return;
    }

    const payloads = [];
    for (const file of files.slice(0, available)) {
        const dataUrl = await fileToDataUrl(file);
        const [, mimeType, base64] = dataUrl.match(/^data:(.+);base64,(.*)$/) || [];
        if (!base64) continue;
        payloads.push({
            name: file.name || `${options.source || 'image'}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
            mimeType: mimeType || file.type || 'image/png',
            base64
        });
    }

    await addReferencePayloads(payloads, { profile, available, requested: files.length });
}

function referenceSlotBudget(sequence) {
    const profile = imageApiProfiles.getImageApiProfile(sequence.model);
    return { profile, available: Math.max(0, profile.maxReferences - sequence.references.length) };
}

function reportReferenceLimit(profile) {
    showToast(profile.maxReferences === 0
        ? '当前模型不支持参考图'
        : `当前模型最多支持 ${profile.maxReferences} 张参考图`);
}

// 已解码图片载荷 → 当前序列参考图（上传 / 粘贴 / 拖拽 / 历史图拖入共用）。
async function addReferencePayloads(payloads, options = {}) {
    const usable = payloads.filter(payload => payload?.base64);
    if (!usable.length) return;

    const sequence = getCurrentSequence();
    const { profile, available } = options.profile
        ? { profile: options.profile, available: options.available }
        : referenceSlotBudget(sequence);
    if (available === 0) {
        reportReferenceLimit(profile);
        return;
    }

    const prompt = getPromptEditorValue();
    let added = 0;
    for (const payload of usable.slice(0, available)) {
        const reference = {
            id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: payload.name || '参考图片.png',
            mimeType: payload.mimeType || 'image/png',
            base64: payload.base64,
            ...referenceAnnotationFields(payload)
        };
        reference.alias = uniqueReferenceAlias(reference, sequence.references);
        const persisted = await persistReferenceImage(reference);
        sequence.references.push(persisted);
        options.collect?.push(persisted);
        added += 1;
    }

    setPromptEditorValue(prompt, sequence.references);
    renderReferences();
    saveCurrentSequenceFromForm();
    if ((options.requested ?? usable.length) > available) reportReferenceLimit(profile);
    return added;
}

// 从主页/历史图条拖入参考图：主进程原生拖拽结束后用光标落点命中检测
// （Windows 上 startDrag 阻塞主进程，Chromium 不会把 drop 事件回派给拖拽源窗口）。
function promptDropRowRect() {
    const row = el.promptInput?.parentElement || el.referenceRail?.parentElement;
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return rect.width && rect.height ? rect : null; // 零尺寸＝生成视图不可见
}

function historyDragTrashHitFromPoint(point) {
    const trash = el.historyDragTrash;
    if (!point || !trash || trash.hidden || state.activeView !== 'history') return false;
    const rect = trash.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const x = point.x - window.screenX;
    const y = point.y - window.screenY;
    const pad = 12;
    return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
}

// 拖到垃圾篓：不确认，直接进应用内回收站（拖用过的也一样，可在回收站还原）。
// 拖的是多选中的一张时整批带走（batch 是拖拽开始时定下的那一批）。
async function dropHistoryImageToTrash(image, batch = historyDragBatch(image)) {
    if (state.historyTrashBusy) return;
    const items = batch.map(record => ({ id: record.id || historyImageKey(record), filePath: record.filePath }));
    state.historyTrashBusy = true;
    try {
        await runHistoryTrash(items, { includeProtected: true, confirmProtected: items.map(item => item.id), reason: 'drag' });
    } finally {
        state.historyTrashBusy = false;
        updateHistorySelectionUi();
    }
}

// 应用内拖图的松手落点（屏幕坐标）→ 'reference' | 'prompt' | null（不在提示词行内）。
// 与 promptDropZoneFromEvent 共用 promptDropBandTop 这条分界线；行四周留 10px 容差。
function promptDropZoneFromPoint(point) {
    if (!point) return null;
    const rect = promptDropRowRect();
    if (!rect) return null;
    const x = point.x - window.screenX;
    const y = point.y - window.screenY;
    const pad = 10;
    if (x < rect.left - pad || x > rect.right + pad || y < rect.top - pad || y > rect.bottom + pad) return null;
    return promptDropReferenceEnabled() && y >= promptDropBandTop(rect) ? 'reference' : 'prompt';
}

function referenceDropHitFromPoint(point) {
    return promptDropZoneFromPoint(point) === 'reference';
}

// One image or a dragged batch (one addReferencePayloads call, so the reference limit applies once).
async function addHistoryImageAsReference(imageOrBatch) {
    const images = (Array.isArray(imageOrBatch) ? imageOrBatch : [imageOrBatch]).filter(image => image?.filePath);
    if (!images.length || state.addingHistoryReference) return;
    state.addingHistoryReference = true;
    try {
        const payloads = [];
        for (const image of images) {
            const loaded = await window.picgenDesktop.loadCachedImage({
                filePath: image.filePath,
                mimeType: image.mimeType || ''
            });
            if (!loaded?.base64) throw new Error('图片读取为空');
            payloads.push({
                name: image.fileName || '参考图片.png',
                mimeType: loaded.mimeType || image.mimeType || 'image/png',
                base64: loaded.base64
            });
        }
        const added = await addReferencePayloads(payloads);
        if (added) {
            for (const image of images) noteHistoryImageUse(image, 'drop');
            showToast(images.length > 1 ? `已添加 ${images.length} 张参考图` : '已添加为参考图');
        }
    } catch (error) {
        showToast(`添加参考图失败: ${error.message}`);
    } finally {
        state.addingHistoryReference = false;
    }
}

function uniqueReferenceAlias(reference, references) {
    const base = rendererUtils.referenceAlias(reference).slice(0, 22);
    const used = new Set(references.map((ref, index) => rendererUtils.referenceAlias(ref, index).toLowerCase()));
    let alias = base, index = 2;
    while (used.has(alias.toLowerCase())) alias = `${base} (${index++})`;
    return alias;
}

// 去掉参考图后，幸存者的别名可能还挂着「(2)」这种去重后缀 —— 当初是为了跟刚被删掉的
// 那张区分。留着它没有意义，而且现在别名会原样进优化提示词、显示给模型看。
// 这里在增删参考图后重算一遍别名，并用重写后的 @提及 同步编辑器。
function normalizeSequenceReferenceAliases(sequence = getCurrentSequence()) {
    if (!sequence) return null;
    // 必须在改名之前按旧别名解析：编辑器 token 存的是插入时的原文 @{旧别名}，
    // 改名后再解析就对不上，@提及 会退化成纯文本（例如删掉 "a" 后 "a (2)" 改名为 "a"）。
    const segments = rendererUtils.promptSegments(getPromptEditorValue(), sequence.references);
    const allocated = [];
    let changed = false;
    for (const item of sequence.references) {
        // 从 name 而不是 item.alias 出发：referenceAlias 会优先读 alias，直接把
        // "劳顶笨 (2)" 当基准重算，去重后缀就永远消不掉（自我复现）。
        const next = uniqueReferenceAlias({ ...item, alias: '' }, allocated);
        if (item.alias !== next) { item.alias = next; changed = true; }
        allocated.push(item);
    }
    if (!changed) return null;
    // 别名变了，编辑器里对应的 @提及 也要跟着改；segment.reference 就是同一个对象，已带新别名。
    return segments.map(segment => (
        segment.type === 'reference' ? `@{${segment.reference.alias}}` : segment.text
    )).join('');
}

// 参考图渲染：提示词右下角的照片堆（React ReferenceStack 子根）。
// 上传按钮直接触发文件选择框；Ctrl+V 粘贴走 handleGlobalReferencePaste。
function renderReferences() {
    renderPendingMaskEdit();
    const sequence = getCurrentSequence();
    const profile = imageApiProfiles.getImageApiProfile(el.modelSelect.value);
    if (el.referenceRail) el.referenceRail.hidden = profile.maxReferences === 0;
    if (window.PicGenAppica?.renderReferenceStack && el.referenceStack) {
        window.PicGenAppica.renderReferenceStack(el.referenceStack, {
            sequenceId: sequence.id,
            references: [...sequence.references],
            maxReferences: profile.maxReferences,
            remove: removeSequenceReference,
            onContextMenu: showReferenceContextMenu,
            onUpload: () => el.referenceFileInput?.click(),
            preview: showImageHoverPreview,
            previewMove: queueImageHoverPreviewPosition,
            previewHide: hideImageHoverPreview,
            draggingId: state.draggedReferenceCard?.id || null,
            onDragStart: reference => startReferenceCardDrag(sequence.id, reference),
            onDragEnd: endReferenceCardDrag,
            onDropTrash: dropReferenceCardToTrash
        });
    }
    updateAdvancedSettingsVisibility();
}

// 参考图卡拖拽（原生文件拖拽，同历史图模式）：拖出程序=给其它应用一个真实图片文件；
// 拖回本窗口右侧的垃圾桶落区=删除。原生拖拽不携带自定义数据，所以"拖的是哪张"
// 记录在 state.draggedReferenceCard（带 20s 兜底清理，防 dragend 丢失）。
function startReferenceCardDrag(sequenceId, reference) {
    // 原图缓存还没落盘/落盘失败：无法原生拖拽，也就不进入拖拽态（否则预览屏蔽要挂 20s 才解除）
    if (!reference.filePath) return;
    clearTimeout(state.referenceDragClearTimer);
    state.draggedReferenceCard = { sequenceId, id: reference.id };
    state.referenceDragClearTimer = setTimeout(endReferenceCardDrag, 20000);
    beginImageDragPreviewGuard();
    renderReferences();
    window.picgenDesktop.startImageDrag(reference.filePath);
}

function endReferenceCardDrag() {
    clearTimeout(state.referenceDragClearTimer);
    state.referenceDragClearTimer = null;
    if (!state.draggedReferenceCard) return;
    endImageDragPreviewGuard();
    state.draggedReferenceCard = null;
    renderReferences();
}

function dropReferenceCardToTrash() {
    const drag = state.draggedReferenceCard;
    if (!drag) return;
    clearTimeout(state.referenceDragClearTimer);
    state.referenceDragClearTimer = null;
    state.draggedReferenceCard = null;
    removeSequenceReference(drag.sequenceId, drag.id);
}

// 全局 Ctrl+V：剪贴板里有图片时直接加为当前序列的参考图。
// 提示词编辑器自己的 paste 处理（handlePromptPaste）已覆盖它内部的粘贴，这里跳过；
// 也不劫持其它输入框、以及设置浮层打开时的粘贴。
function handleGlobalReferencePaste(event) {
    if (!el.promptInput || el.promptInput.contains(event.target)) return;
    if (el.promptInput.offsetParent === null) return; // 生成视图不可见
    if (el.settingsOverlay && !el.settingsOverlay.hidden) return;
    if (el.referenceRail?.hidden) return; // 当前模型不支持参考图
    if (event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    const files = getImageFilesFromList(event.clipboardData?.files || []);
    if (!files.length) return;
    event.preventDefault();
    addReferenceFiles(files, { source: 'paste' });
}


function reorderSequenceReference(sequenceId, draggedId, targetId, after) {
    const sequence = getCurrentSequence();
    if (sequence.id !== sequenceId) return;
    const segments = rendererUtils.promptSegments(getPromptEditorValue(), sequence.references);
    const allocated = [];
    for (const item of sequence.references) { item.alias = uniqueReferenceAlias(item, allocated); allocated.push(item); }
    const prompt = segments.map(segment => segment.type === 'reference' ? `@{${segment.reference.alias}}` : segment.text).join('');
    sequence.references = ux.reorderReferences(sequence.references, draggedId, targetId, after);
    setPromptEditorValue(prompt, sequence.references);
    renderReferences();
    saveCurrentSequenceFromForm();
}

function removeSequenceReference(sequenceId, referenceId) {
    const sequence = getCurrentSequence();
    if (sequence.id !== sequenceId) return;
    const reference = sequence.references.find(item => item.id === referenceId);
    if (!reference) return;
    hideImageHoverPreview();
    // 指向这张图的 @提及 先变成空 @（必须在移除前按旧列表解析），用户点它可以重新选图。
    const detached = rendererUtils.promptWithReferenceRemoved(getPromptEditorValue(), sequence.references, referenceId);
    setPromptEditorValue(detached, sequence.references, { undo: false });
    sequence.references = sequence.references.filter(item => item.id !== referenceId);
    // 再重算别名（可能要去掉「(2)」后缀），拿到重写后的 @提及，再一次性落进编辑器。
    const rewritten = normalizeSequenceReferenceAliases(sequence);
    setPromptEditorValue(rewritten ?? detached, sequence.references);
    if (state.pendingMaskEdits.get(sequence.id)?.sourceRefId === referenceId) {
        state.pendingMaskEdits.delete(sequence.id);
        renderPendingMaskEdit();
    }
    renderReferences();
    saveCurrentSequenceFromForm();
    deleteReferenceImageCache(reference);
    for (const file of reference.workspace?.sourceFiles || []) deleteReferenceImageCache(file);
}

// ── 参考图快捷标注 / 尺寸参照图 ─────────────────────────────────────
// 两个对话框都是 React 子根（main.jsx openAnnotationEditor / openSizeReference），
// 这里只负责取图、占参考图名额、把结果加为参考图并把提示词片段写进编辑器。

async function referenceImageData(reference) {
    if (reference.base64) return { base64: reference.base64, mimeType: reference.mimeType || 'image/png' };
    const loaded = await window.picgenDesktop.loadReferenceImage({ filePath: reference.filePath, mimeType: reference.mimeType });
    if (!loaded?.base64) throw new Error('参考图读取为空');
    return { base64: loaded.base64, mimeType: loaded.mimeType || reference.mimeType || 'image/png' };
}

function appendPromptLine(prompt, text) {
    return prompt.trim() ? `${prompt.replace(/\s+$/, '')}\n${text}` : text;
}

// 片段换行接在提示词末尾。
function writePromptSnippet(text, sequence) {
    setPromptEditorValue(appendPromptLine(getPromptEditorValue(), text), sequence.references);
    saveCurrentSequenceFromForm();
}

// ── 图片工作台 ─────────────────────────────────────────────────────
// 页面是 React 子根（main.jsx renderWorkspace），这里只负责：取图、切换视图、
// 把发送结果变成参考图 + 提示词 + 局部修改，以及保存/导出。

// 把当前活动序列换成工作台里选的生成模型（与用户在模型下拉框里手动切换走同一条路）
function applyWorkspaceModel(model) {
    const sequence = getCurrentSequence();
    if (!model || sequence.model === model || !getGenerationModels().includes(model)) return;
    el.modelSelect.value = model;
    refreshModernSelect(el.modelSelect);
    saveCurrentSequenceFromForm();
    updateDimensionOptions();
    saveCurrentSequenceFromForm();
    updateAdvancedSettingsVisibility();
}

const workspaceApi = {
    listAnchors: () => window.picgenDesktop.listSizeAnchors(),
    // 输出到参考图：当前画面合成的一张图，加进活动序列（不动提示词）
    async addToReferences({ base64, name }) {
        const sequence = getCurrentSequence();
        await hydrateSequenceReferences([sequence]);
        const budget = referenceSlotBudget(sequence);
        if (budget.available < 1) { reportReferenceLimit(budget.profile); return false; }
        const added = await addReferencePayloads([{ name, mimeType: 'image/png', base64 }], { profile: budget.profile, available: budget.available });
        return added === 1;
    },
    saveAs: ({ base64, name }) => window.picgenDesktop.saveImageAs({ base64, fileName: name, mimeType: 'image/png' })
};

function renderWorkspace() {
    if (!window.PicGenAppica?.renderWorkspace || !el.workspaceRoot) return;
    window.PicGenAppica.renderWorkspace(el.workspaceRoot, {
        session: state.workspaceSession,
        models: getGenerationModels(),
        targetName: getSequenceTitle(getCurrentSequence()),
        api: workspaceApi,
        onSend: sendWorkspaceToGeneration
    });
}

function showWorkspaceView() {
    state.activeView = 'workspace';
    hideSettingsPage();
    el.tabsBar.hidden = true;
    el.mainContentScroll.hidden = true;
    el.historyPage.hidden = true;
    el.queuePage.hidden = true;
    el.reversePromptPage.hidden = true;
    el.errorLogsPage.hidden = true;
    if (el.historyBinPage) el.historyBinPage.hidden = true;
    el.workspacePage.hidden = false;
    setSidebarActive(el.workspaceNavBtn);
    hideMentionMenu();
    hideImageHoverPreview();
    closeHistoryPreview();
    renderWorkspace();
}

function openWorkspace({ images = [], mode = 'annotate', doc = null } = {}) {
    state.workspaceSession = { id: `ws_${Date.now()}`, images, mode, doc };
    showWorkspaceView();
}

// 发送到图片工作台（右键菜单默认标注模式；详情抽屉「局部编辑」传 'mask'）。新开一张画布，替换当前画布。
// 参考图卡片交给 openWorkspaceForReference（带工作台文档的卡片回到原画布）；只有历史图计一次 'workspace'
async function openWorkspaceFromContextImage(mode = 'annotate') {
    const target = takeImageContextTarget();
    if (!target) return;
    if (target.kind === 'reference') {
        await openWorkspaceForReference(target.sequenceId, target.reference, mode);
        return;
    }
    try {
        openWorkspace({ mode, images: [await loadContextImageData(target)] });
        if (target.kind === 'history') noteHistoryImageUse(target.record, 'workspace');
    } catch (error) { showToast(`读取图片失败：${error.message}`, 'error'); }
}

// 参考图卡片：带着工作台文档的卡片回到原来的画布继续改，普通卡片新开一张
async function openWorkspaceForReference(sequenceId, reference, mode) {
    if (getCurrentSequence().id !== sequenceId) return;
    try {
        const saved = reference.workspace;
        if (saved?.doc && Array.isArray(saved.sourceFiles) && saved.sourceFiles.length) {
            const images = [];
            for (const file of saved.sourceFiles) {
                const loaded = await window.picgenDesktop.loadReferenceImage({ filePath: file.filePath, mimeType: file.mimeType });
                images.push({ name: file.name, base64: loaded.base64, mimeType: loaded.mimeType || file.mimeType });
            }
            openWorkspace({ mode, images, doc: saved.doc });
            return;
        }
        openWorkspace({ mode, images: [{ name: reference.name, ...(await referenceImageData(reference)) }] });
    } catch (error) { showToast(`读取参考图失败：${error.message}`, 'error'); }
}

async function persistWorkspaceSources(sources = []) {
    const files = [];
    for (const [index, source] of sources.entries()) {
        const saved = await window.picgenDesktop.saveReferenceImage({
            id: `wssrc_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
            name: source.name || '图片.png', mimeType: source.mimeType || 'image/png', base64: source.base64
        });
        files.push({ filePath: saved.filePath, mimeType: saved.mimeType || source.mimeType, name: source.name || '图片.png' });
    }
    return files;
}

// 局部修改时原图必须是第 1 张：发送顺序和 @提及 解析都用这一份顺序，拖动排序后也不会指错
function workspaceMaskReferences(sequence, pending) {
    const source = sequence.references.find(ref => ref.id === pending.sourceRefId);
    if (!source) throw new Error('要修改的原图已被移除，请重新在工作台里发送');
    return [source, ...sequence.references.filter(ref => ref !== source)];
}

// 发送到当前活动序列，并把它的模型换成工作台里选的模型（参考图名额按新模型计算）
async function sendWorkspaceToGeneration({ model = '', references = [], prompt = '', aliases = {}, mask = null, workspace = null }) {
    const sequence = getCurrentSequence();
    await hydrateSequenceReferences([sequence]);
    // 名额按要切换到的模型算，但模型等参考图都加成功后才切：发送失败不能改掉用户的生成设置
    const budget = referenceSlotBudget({ ...sequence, model: model || sequence.model });
    if (budget.available < references.length) {
        showToast(budget.profile.maxReferences === 0
            ? '当前模型不支持参考图，请换一个模型'
            : `参考图名额不够：需要 ${references.length} 张，还剩 ${budget.available} 张，请先移除一些参考图`, 'warning');
        return false;
    }
    const saved = workspace?.doc ? { doc: workspace.doc, sourceFiles: await persistWorkspaceSources(workspace.sources) } : null;
    const added = [];
    await addReferencePayloads(references.map((ref, index) => ({
        name: ref.name, mimeType: ref.mimeType || 'image/png', base64: ref.base64,
        ...(saved && index === 0 ? { workspace: saved } : {})
    })), { collect: added, profile: budget.profile, available: budget.available });
    if (added.length !== references.length) {
        // 没加全：撤掉已加的卡片和原图缓存，别留下半套
        for (const ref of added) removeSequenceReference(sequence.id, ref.id);
        return false;
    }
    applyWorkspaceModel(model);
    const byRole = Object.fromEntries(references.map((ref, index) => [ref.role, added[index]]));
    if (mask && byRole.original) {
        // 修改区域落在原图上：原图排在序列参考图第一位（OpenAI 的修改区域只作用于第 1 张图）
        const source = byRole.original;
        sequence.references = [source, ...sequence.references.filter(ref => ref !== source)];
    }
    let text = prompt;
    for (const [role, placeholder] of Object.entries(aliases)) {
        if (byRole[role]) text = text.split(`@{${placeholder}}`).join(`@{${byRole[role].alias}}`);
    }
    if (text.trim()) writePromptSnippet(text, sequence);
    if (mask && byRole.original) {
        state.pendingMaskEdits.set(sequence.id, {
            sourceRefId: byRole.original.id,
            preview: `data:${byRole.original.mimeType || 'image/png'};base64,${byRole.original.base64}`,
            maskImage: { base64: mask.base64, mimeType: 'image/png', guideIncluded: !!mask.guideIncluded, composite: !!mask.composite }
        });
        setSequenceStatus(sequence, '局部编辑待生成');
    }
    renderReferences();
    saveCurrentSequenceFromForm();
    showGenerationView();
    showToast(mask ? '已发送：参考图、提示词和修改区域都已就绪' : '已发送：参考图和提示词已就绪', 'success');
    return true;
}

function hasDraggedImage(dataTransfer) {
    if (!dataTransfer || !Array.from(dataTransfer.types || []).includes('Files')) return false;
    const fileItems = Array.from(dataTransfer.items || []).filter(item => item.kind === 'file');
    return fileItems.length === 0
        || fileItems.some(item => !item.type || item.type.startsWith('image/'));
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function renderReversePromptProviders() {
    if (!el.reversePromptProviderSelect) return;
    const currentId = state.currentChatPresetId;
    el.reversePromptProviderSelect.innerHTML = '';
    for (const provider of state.chatPresets) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = provider.name || '对话 API';
        option.disabled = provider.enabled === false;
        el.reversePromptProviderSelect.appendChild(option);
    }
    const selected = state.chatPresets.find(provider => provider.id === currentId && provider.enabled !== false)
        || state.chatPresets.find(provider => provider.enabled !== false)
        || state.chatPresets[0];
    el.reversePromptProviderSelect.value = selected?.id || '';
    if (selected?.id && selected.id !== state.currentChatPresetId) setActiveChatProvider(selected.id);
    renderReversePromptModels();
    refreshModernSelect(el.reversePromptProviderSelect);
}

function renderReversePromptModels() {
    if (!el.reversePromptModelSelect) return;
    const provider = getChatPresetById(state.currentChatPresetId);
    const models = normalizeStringList(provider?.models || [provider?.model].filter(Boolean));
    el.reversePromptModelSelect.innerHTML = '';
    if (!models.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '先在 API 设置中添加模型';
        el.reversePromptModelSelect.appendChild(option);
        el.reversePromptModelSelect.value = '';
        refreshModernSelect(el.reversePromptModelSelect);
        return;
    }
    for (const model of models) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        el.reversePromptModelSelect.appendChild(option);
    }
    const activeModel = models.includes(provider?.activeModel || provider?.model)
        ? (provider.activeModel || provider.model)
        : models[0];
    if (provider) {
        provider.activeModel = activeModel;
        provider.model = activeModel;
    }
    el.reversePromptModelSelect.value = activeModel || '';
    refreshModernSelect(el.reversePromptModelSelect);
}

function updateReversePromptProviderState() {
    const provider = getChatPresetById(state.currentChatPresetId);
    const model = provider ? (el.reversePromptModelSelect?.value || provider.activeModel || provider.model || '') : '';
    const complete = !!provider?.id && !!provider.baseUrl && !!provider.apiKey && !!model;
    // 不再断言「支持/不支持视觉输入」：模型名推不出这个能力（中转站尤其如此），
    // 反推本身就会把图片发给上游，真的不支持时由上游报错说明。
    if (!provider) {
        el.reversePromptProviderMeta.textContent = '请在 API 设置中添加提示词优化供应商';
    } else if (!complete) {
        el.reversePromptProviderMeta.textContent = '配置不完整，请到 API 设置补充 Base URL、API Key 和模型';
    } else {
        el.reversePromptProviderMeta.textContent = `${provider.name} · ${model}`;
    }
    updateReversePromptActionState();
}

function updateReversePromptActionState() {
    const hasImage = !!state.reversePromptImage;
    const result = String(el.reversePromptResultInput?.value || '').trim();
    const provider = getChatPresetById(state.currentChatPresetId);
    const model = provider ? (el.reversePromptModelSelect?.value || provider.activeModel || provider.model || '') : '';
    const providerReady = !!provider?.id && !!provider.baseUrl && !!provider.apiKey && !!model;
    el.reversePromptRunBtn.disabled = state.reversePromptBusy || !hasImage || !providerReady;
    el.reversePromptCopyBtn.disabled = !result;
    el.reversePromptCreateSequenceBtn.disabled = !result;
}

async function setReversePromptImage(file) {
    if (!file || !String(file.type || '').startsWith('image/')) {
        showToast('请选择图片文件');
        return;
    }
    try {
        const dataUrl = await fileToDataUrl(file);
        const match = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
        if (!match?.[2]) throw new Error('图片读取失败');
        state.reversePromptImage = {
            name: file.name || '待分析图片',
            mimeType: match[1] || file.type || 'image/png',
            base64: match[2],
            dataUrl
        };
        el.reversePromptEmpty.hidden = true;
        el.reversePromptPreview.hidden = false;
        el.reversePromptPreviewImage.src = dataUrl;
        el.reversePromptImageName.textContent = state.reversePromptImage.name;
        el.reversePromptImageMeta.textContent = `${Math.max(1, Math.round(file.size / 1024))} KB · ${state.reversePromptImage.mimeType}`;
        el.reversePromptClearImageBtn.hidden = false;
        el.reversePromptStatus.textContent = '图片已就绪，可以开始反推';
        updateReversePromptActionState();
    } catch (error) {
        showToast(`读取图片失败: ${error.message}`);
    }
}

async function handleReversePromptPaste(event) {
    const [file] = getClipboardImageFiles(event);
    if (!file) return;
    event.preventDefault();
    await setReversePromptImage(file);
    if (state.reversePromptImage) showToast('已粘贴待分析图片');
}

function clearReversePromptImage() {
    state.reversePromptImage = null;
    el.reversePromptEmpty.hidden = false;
    el.reversePromptPreview.hidden = true;
    el.reversePromptPreviewImage.removeAttribute('src');
    el.reversePromptImageName.textContent = '';
    el.reversePromptImageMeta.textContent = '';
    el.reversePromptClearImageBtn.hidden = true;
    el.reversePromptStatus.textContent = '等待上传图片';
    updateReversePromptActionState();
}

async function runReversePrompt() {
    const image = state.reversePromptImage;
    const provider = getChatPresetById(state.currentChatPresetId);
    const model = provider ? (el.reversePromptModelSelect?.value || provider.activeModel || provider.model || '') : '';
    if (!image || !provider || !model) return;
    state.reversePromptBusy = true;
    el.reversePromptRunBtn.disabled = true;
    el.reversePromptRunBtn.querySelector('span').textContent = '分析中';
    el.reversePromptStatus.textContent = '正在读取图片并生成提示词';
    const stream = window.PicGenAppica.startPromptStream('reversePromptStream', '提示词反推');
    try {
        const prompt = await window.PicGenAppica.fetchPromptStream(`${state.serverUrl}/api/prompts/reverse`, {
            chatProviderId: provider.id, model, instruction: el.reversePromptInstructionInput.value.trim(),
            image: { base64: image.base64, mimeType: image.mimeType }
        }, stream);
        if (state.reversePromptImage !== image) { stream.complete(prompt, '原图片的反推已完成，可复制'); return; }
        stream.complete(prompt);
        localStorage.setItem('picgen_last_reverse_prompt', prompt);
        el.reversePromptResultInput.value = prompt;
        el.reversePromptStatus.textContent = `已完成 · ${provider.name} · ${model}`;
        showToast('提示词反推完成');
    } catch (error) {
        stream.fail(error);
        el.reversePromptStatus.textContent = `反推失败：${error.message}`;
        showToast(`提示词反推失败: ${error.message}`);
    } finally {
        state.reversePromptBusy = false;
        el.reversePromptRunBtn.querySelector('span').textContent = '开始反推';
        updateReversePromptActionState();
    }
}

async function copyReversePromptResult() {
    const prompt = String(el.reversePromptResultInput.value || '').trim();
    if (!prompt) return;
    try {
        if (window.picgenDesktop.copyText) await window.picgenDesktop.copyText(prompt);
        else await navigator.clipboard.writeText(prompt);
        showToast('提示词已复制');
    } catch (error) {
        showToast(`复制失败: ${error.message}`);
    }
}

function createSequenceFromReversePrompt() {
    const prompt = String(el.reversePromptResultInput.value || '').trim();
    if (!prompt) return;
    createSequenceFromImagePrompt(prompt);
    showGenerationView();
    showToast('已在新序列中填入反推提示词');
}

// ── 提示词优化：就地覆盖 #promptInput ────────────────────────────────
// 优化结果不再另开面板，而是边流式边把编辑器内容改成模型输出。整段流在撤销栈里
// 只算「一步」：开始时挂起记录、结束时把终稿落一步 —— 收尾后按一次 Ctrl+Z 直接
// 回到优化前的原文。流未结束时编辑器锁成只读（外观不变），按钮变成「停止」。
// 流式重写是整段 replaceChildren（还要重排 @提及 token），按 token 速率刷新会
// 把主线程打满，所以节流到 PROMPT_OPTIMIZE_FLUSH_MS，收尾时再强制刷一次。
const PROMPT_OPTIMIZE_FLUSH_MS = 120;
// 停止后这段时间内的点击视为「停止手势的余手」，不当作重新开始优化。停止与优化共用
// 同一颗按钮：abort 会在几毫秒内把状态清干净，用户第二下点击（双响、或「咋没反应」）
// 落在清理之后，就会被当成「再优化一次」——表现成停不掉，只能重启程序。
const PROMPT_OPTIMIZE_RESTART_COOLDOWN_MS = 600;

// 只有「正在被这次运行改写的那条序列」显示在编辑器里时才锁编辑。
// 用户中途切到别的序列，那边应当照常可编辑。
function syncPromptOptimizeLock() {
    if (!el.promptInput) return;
    const run = state.promptOptimizeRun;
    const locked = Boolean(run) && state.currentSequenceId === run.sequenceId;
    // React 只在 contentEditable prop 变化时才写 DOM，这里恒为 true，命令式 false 不会被冲掉。
    el.promptInput.setAttribute('contenteditable', locked ? 'false' : 'true');
}

function updatePromptOptimizeButton() {
    if (!el.optimizePromptBtn) return;
    const running = Boolean(state.promptOptimizeRun);
    // 进行中按钮仍然可点 —— 那一下就是「停止」；只有异步校验期间才禁用。
    el.optimizePromptBtn.disabled = !running && state.promptOptimizeStarting;
    if (el.optimizePromptLabel) el.optimizePromptLabel.textContent = running ? '停止' : '优化';
    // 图标走 React 子根：进行中显示 Appica Spinner，空闲显示魔杖。
    // 这里每次都重渲染是幂等的（同一个组件、同一个 busy 值），不会闪。
    if (el.optimizePromptIcon) {
        window.PicGenAppica?.renderOptimizeIcon?.(el.optimizePromptIcon, { busy: running });
    }
}

function promptOptimizeFlush(run) {
    run.timer = null;
    if (state.promptOptimizeRun !== run) return;
    if (state.currentSequenceId !== run.sequenceId) return;
    setPromptEditorValue(run.latest, run.sequence.references, { undo: false });
}

function schedulePromptOptimizeFlush(run) {
    if (run.timer) return;
    run.timer = setTimeout(() => promptOptimizeFlush(run), PROMPT_OPTIMIZE_FLUSH_MS);
}

function beginPromptOptimizeRun(sequence) {
    const run = {
        sequence,
        sequenceId: sequence.id,
        // sequence.prompt 刚刚由 saveCurrentSequenceFromForm 从编辑器同步过，
        // 比此刻再读一次 DOM 稳（校验期间用户可能已经切走序列）。
        original: String(sequence.prompt || ''),
        latest: '',
        timer: null,
        controller: new AbortController()
    };
    state.promptOptimizeRun = run;
    // 整段流记一步：期间所有刷新都不入栈，收尾时统一落终稿。
    promptUndoSuspend(true, run.sequenceId);
    syncPromptOptimizeLock();
    updatePromptOptimizeButton();
    return run;
}

// text 为空串是合法值（优化结果可以被清空），用 null/undefined 表示「不回写」。
function endPromptOptimizeRun(run, { text = null, record = false } = {}) {
    if (state.promptOptimizeRun !== run) return false;
    state.promptOptimizeRun = null;
    if (run.timer) { clearTimeout(run.timer); run.timer = null; }
    promptUndoSuspend(false, run.sequenceId);

    const alive = state.sequences.includes(run.sequence);
    if (alive && typeof text === 'string') {
        run.sequence.prompt = text;
        if (state.currentSequenceId === run.sequenceId) {
            setPromptEditorValue(text, run.sequence.references, { undo: false });
        }
        saveSequences();
        renderSequenceTabs();
    }
    // 落一步终稿：此刻栈顶还是优化前的内容，所以 Ctrl+Z 一下就回到原文。
    if (record && alive) promptUndoRecord(text, { sequenceId: run.sequenceId });

    syncPromptOptimizeLock();
    updatePromptOptimizeButton();
    return true;
}

// 停止＝当场收尾，不等网络层把 AbortError 抛回来：请求链路（本地服务 → 中转站）
// 只要有一环不响应中止，按钮就会一直卡在「停止」或禁用，只能重启程序。
// 之后那个迟到的结果/异常由 endPromptOptimizeRun 的 run 身份校验丢弃。
function cancelPromptOptimizeRun() {
    state.promptOptimizeStoppedAt = Date.now();
    const run = state.promptOptimizeRun;
    if (!run) return;
    run.controller.abort();
    const streamed = Boolean(run.latest.trim());
    endPromptOptimizeRun(run, { text: streamed ? run.latest : run.original, record: streamed });
    state.promptOptimizeStarting = false;
    state.promptOptimizeStartTicket = null;
    updatePromptOptimizeButton();
    showToast(streamed ? '已停止优化（Ctrl+Z 撤回）' : '已停止优化');
}

async function runPromptOptimizeStream(sequence, chatPreset) {
    const run = beginPromptOptimizeRun(sequence);
    const requestId = `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const originalReferenceImages = sequence.references.map(ref => ({
        base64: ref.base64,
        mimeType: ref.mimeType
    }));
    // 参考图一律随行发出，不按模型名猜测「能不能读图」：旧实现对名字/地址里含
    // deepseek 的一律判死并静默丢图，而 DeepSeek V4.1 已支持读图，中转站上的模型名
    // 更是推不出真实能力。真不支持时由上游报错，比我们猜错后悄悄不附图诚实得多。
    const referenceImages = originalReferenceImages;
    const referenceMimeTypes = originalReferenceImages.map(ref => ref.mimeType || 'image/png');
    // 优化用「带名字」的提及解析：@{大张} 而不是「参考图1」。图片 part 本身不带名字，
    // 用序号称呼模型既对不上号、也只会编出「@第一张参考图文件名」这种占位符。
    const referenceNames = sequence.references.map((ref, index) => rendererUtils.referenceAlias(ref, index));
    // 生成区已设置的画幅比例也要告诉优化器：用户常在提示词里手写「画幅 3:4」，
    // 而实际参数可能是别的值。带上它，模型才能发现并改掉冲突描述。
    const ratio = describeSequenceRatio(sequence.ratio);
    const prompt = rendererUtils.resolvePromptMentionsWithNames(sequence.prompt, sequence.references).trim();
    console.info('[PromptOptimize][client] submit', {
        requestId,
        chatProviderId: chatPreset.id,
        chatProviderName: chatPreset.name,
        model: chatPreset.model,
        promptLength: prompt.length,
        referenceCount: originalReferenceImages.length,
        sentReferenceCount: referenceImages.length,
        referenceMimeTypes,
        referenceNames,
        ratio,
        imageMode: referenceImages.length ? 'inline' : 'text-only'
    });

    // fetchPromptStream 只依赖适配器的 signal 与 delta 两项；delta 收到的是增量片段。
    const stream = {
        signal: run.controller.signal,
        delta(chunk) {
            if (state.promptOptimizeRun !== run) return;
            run.latest += String(chunk || '');
            schedulePromptOptimizeFlush(run);
        }
    };

    try {
        const optimized = await window.PicGenAppica.fetchPromptStream(`${state.serverUrl}/api/prompts/optimize`, {
            requestId, chatProviderId: chatPreset.id, prompt,
            systemPrompt: state.promptOptimizeSystemPrompt || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
            referenceImageCount: originalReferenceImages.length, referenceMimeTypes, referenceNames, ratio, referenceImages
        }, stream);
        const finalText = String(optimized || run.latest || run.original);
        // 已被「停止」当场收尾的运行返回 false：迟到的结果不再回写。
        if (!endPromptOptimizeRun(run, { text: finalText, record: true })) return;
        console.info('[PromptOptimize][client] success', { requestId, optimizedLength: finalText.length });
        showToast(originalReferenceImages.length > 0
            ? `已结合 ${originalReferenceImages.length} 张参考图优化（Ctrl+Z 撤回）`
            : '提示词已就地覆盖（Ctrl+Z 撤回）');
    } catch (error) {
        // 中途停止由 cancelPromptOptimizeRun 当场收尾，这里只剩迟到的 AbortError。
        if (error?.name === 'AbortError' || state.promptOptimizeRun !== run) return;
        console.error('[PromptOptimize][client] error', error);
        // 失败：编辑器退回原文，栈不落步（本来就没改过）。
        endPromptOptimizeRun(run, { text: run.original, record: false });
        showToast(`优化失败: ${error.message}`);
    }
}

async function optimizeCurrentPrompt() {
    // 正在就地覆盖时，这个按钮就是「停止」。
    if (state.promptOptimizeRun) { cancelPromptOptimizeRun(); return; }
    if (state.promptOptimizeStarting) return;
    // 刚停过：这一下多半是停止手势的余手，别再自己跑起来。
    if (Date.now() - state.promptOptimizeStoppedAt < PROMPT_OPTIMIZE_RESTART_COOLDOWN_MS) return;
    if (!state.promptOptimizeEnabled) {
        showToast('提示词优化已关闭，请在“API 设置 › 提示词优化”中开启');
        openSettings(); setSettingsMode('optimize');
        return;
    }
    saveCurrentSequenceFromForm();
    const sequence = getCurrentSequence();
    if (blockEmptyReferenceMentions(sequence, '优化')) return;
    const prompt = resolvePromptMentions(sequence).trim();

    if (!prompt) {
        showToast('请输入要优化的提示词');
        return;
    }

    state.promptOptimizeStarting = true;
    // 停止后可以马上开下一次优化：上一次迟到的 finally 凭票据认出自己，不去清掉新一次的启动标志。
    const ticket = {};
    state.promptOptimizeStartTicket = ticket;
    updatePromptOptimizeButton();
    try {
        await ensureChatProvidersLoaded();
        const chatPreset = getChatPresetById(state.currentChatPresetId);
        if (!chatPreset?.id || !chatPreset?.baseUrl || !chatPreset?.apiKey || !chatPreset?.model) {
            // 优化曾经寄生在反推页，所以老代码在这里把用户甩到反推页去配 —— 但那是
            // 另一个功能。优化就在生成区，缺配置就把人送到「API 设置 › 提示词优化」
            // 那个选模型的地方，关掉设置自然回到生成区（settingsReturnView）。
            showToast('请先在“API 设置 › 提示词优化”里选择优化使用的对话模型');
            openSettings();
            setSettingsMode('optimize');
            el.promptOptimizeProviderSelect?.focus();
            return;
        }
        // 校验期间用户可能已经关掉原序列 —— 那就别再往一条死序列上写。
        if (!state.sequences.includes(sequence)) return;
        await runPromptOptimizeStream(sequence, chatPreset);
    } finally {
        if (state.promptOptimizeStartTicket === ticket) {
            state.promptOptimizeStarting = false;
            state.promptOptimizeStartTicket = null;
        }
        updatePromptOptimizeButton();
    }
}

async function saveProviderCapacityFromForm(providerId = '', values = null) {
    const preset = getPresetById(providerId || el.strategyProviderSelect.value || state.strategyProviderId);
    if (!preset) return;
    const draft = values || {
        maxConcurrent: el.providerConcurrencyInput.value,
        priority: el.providerPriorityInput.value
    };
    const payload = {
        name: preset.name,
        baseUrl: preset.baseUrl || preset.url,
        apiKey: preset.apiKey,
        models: preset.models,
        modelPricing: preset.modelPricing || preset.pricing || {},
        modelRouting: preset.modelRouting || {},
        enabled: preset.enabled !== false,
        maxConcurrent: Number(draft.maxConcurrent) || preset.maxConcurrent || 1,
        priority: Number(draft.priority) || preset.priority || 1
    };
    const updated = await saveProviderConfig(payload, preset.id);
    const index = state.presets.findIndex(item => item.id === preset.id);
    if (index >= 0) state.presets[index] = updated;
    renderSettingsProviderList();
    renderProviderSelect();
}

async function generateImages() {
    saveCurrentSequenceFromForm();
    const sequence = getCurrentSequence();
    if (blockEmptyReferenceMentions(sequence, '生成')) return;
    const preset = getSequencePreset(sequence);
    const pendingMaskEdit = state.pendingMaskEdits.get(sequence.id);
    let orderedReferences = sequence.references;
    if (pendingMaskEdit) {
        try { orderedReferences = workspaceMaskReferences(sequence, pendingMaskEdit); }
        catch (error) { state.pendingMaskEdits.delete(sequence.id); renderPendingMaskEdit(); showToast(error.message, 'warning'); return; }
    }
    const prompt = resolvePromptMentions({ ...sequence, references: orderedReferences }).trim();
    const count = pendingMaskEdit ? 1 : Math.min(5, parseInt(sequence.count, 10) || 1);
    const providerUrl = preset?.baseUrl || preset?.url || '';

    if (!preset?.id || !providerUrl || !preset?.apiKey || !sequence.model || preset.enabled === false) {
        showToast('请先在 API 设置中填写完整信息');
        openSettings();
        return;
    }

    if (!prompt) {
        showToast('请输入提示词');
        return;
    }

    const profile = imageApiProfiles.getImageApiProfile(sequence.model);
    if (!pendingMaskEdit && sequence.references.length > profile.maxReferences) {
        showToast(`当前模型最多支持 ${profile.maxReferences} 张参考图`);
        return;
    }

    // 默认档位是 4K，但有的模型根本没有这一档（Gemini 2.5 Flash Image 只有 1K、
    // grok-imagine 只有 1K/2K）。界面上 renderSelectOptions 已回落到首项，可序列里
    // 存的仍是用户自己的偏好——切回支持的模型还能还原，所以这里不动序列，只在
    // 提交这一刻收敛到模型支持的档位。imageSize 是原样发给上游的，发一个模型不
    // 支持的档位就是一次注定失败的请求。
    // 该模型没有分辨率选项时（解析结果为空串）保持原样，不改变既有行为。
    // 刻意放在 try 之外：try 里的异常一律被当作"入队结果未确认（可能已扣费）"，
    // 而这里万一失败纯粹是本地问题，不该冒充一次可能已经计费的上游请求。
    const imageSize = imageApiProfiles.resolveImageSizePreference(sequence.imageSize, profile.imageSizeOptions)
        || sequence.imageSize;

    let generationConfig;
    try {
        generationConfig = buildGenerationConfig(sequence);
        if (generationConfig.xaiStorage && !generationConfig.xaiStorage.filename) {
            throw new Error('启用 xAI Files 存储时必须填写文件名');
        }
    } catch (error) {
        showToast(error.message);
        return;
    }

    const submission = startBatch(sequence, count);
    const batch = submission.batch;
    let submissionRejected = false;
    let submissionUncertain = false;
    setSequenceStatus(sequence, `加入队列 ${count} 张`);
    updateActionState();
    try {
        const response = await fetch(`${state.serverUrl}/api/tasks/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sequenceId: sequence.id,
                sequenceName: getSequenceTitle(sequence),
                batchId: batch.id,
                batchTotal: submission.batchTotal,
                batchIndex: submission.startIndex,
                count,
                providerId: preset.id,
                providerName: preset.name,
                model: sequence.model,
                operation: pendingMaskEdit ? 'mask-edit' : 'generate',
                prompt,
                ratio: sequence.ratio,
                imageSize,
                referenceImages: orderedReferences.map(ref => ({ base64: ref.base64, mimeType: ref.mimeType })),
                maskImage: pendingMaskEdit ? pendingMaskEdit.maskImage : null,
                generationConfig
            })
        });
        const result = await response.json();
        if (!response.ok) {
            submissionRejected = true;
            throw new Error(result.error || '入队失败');
        }
        if (!Array.isArray(result.taskIds) || result.taskIds.length !== count) {
            throw new Error('任务回执不完整，请查看队列；不会自动重复提交');
        }
        if (pendingMaskEdit && state.pendingMaskEdits.get(sequence.id) === pendingMaskEdit) { state.pendingMaskEdits.delete(sequence.id); renderPendingMaskEdit(); }
        for (const taskId of result.taskIds) {
            // Completion can arrive over websocket before the POST response.
            trackBatchTask(sequence, batch, taskId, 'pending');
            if (!isTerminalTaskStatus(batch.taskStates.get(taskId))) sequence.runningTasks.add(taskId);
        }
    } catch (error) {
        // The request may already have been accepted. Preserve tasks delivered by
        // websocket and never retry a possibly paid submission automatically.
        submissionUncertain = !submissionRejected;
        if (submissionRejected) {
            for (let i = 0; i < count; i++) {
                trackBatchTask(sequence, batch, `enqueue_failed_${batch.id}_${submission.startIndex + i}`, 'failed');
            }
        }
        showToast(`批量入队未确认: ${error.message}`);
    }

    finishBatchSubmission(sequence, batch);

    if (submissionUncertain) {
        setSequenceStatus(sequence, '入队结果待确认，请查看队列');
    } else if (sequence.runningTasks.size === 0) {
        setSequenceStatus(sequence, '就绪');
    } else {
        setSequenceStatus(sequence, `等待生成 ${sequence.runningTasks.size} 张`);
    }
    updateActionState();
}

async function stopCurrentSequence() {
    const sequence = getCurrentSequence();
    setSequenceStatus(sequence, '正在停止');
    updateActionState();

    try {
        const response = await fetch(`${state.serverUrl}/api/tasks?sequenceId=${encodeURIComponent(sequence.id)}`, {
            method: 'DELETE'
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '停止失败');
        await syncTasks();
        setSequenceStatus(sequence, sequence.runningTasks.size
            ? `剩余 ${sequence.runningTasks.size} 个任务正在完成` : '已停止');
        showToast(`已取消 ${result.cancelled || 0} 个任务`);
    } catch (error) {
        showToast(`停止失败: ${error.message}`);
    } finally {
        updateActionState();
    }
}

function connectWebSocket() {
    if (state.ws) state.ws.close();

    const wsUrl = state.serverUrl.replace(/^http/, 'ws');
    state.ws = new WebSocket(wsUrl);

    state.ws.addEventListener('open', () => {
        setConnectionStatus(true);
        syncTasks();
        if (el.settingsOverlay && !el.settingsOverlay.hidden) refreshProviderHealth();
    });

    state.ws.addEventListener('message', async (event) => {
        try {
            const message = JSON.parse(event.data);
            await handleSocketMessage(message.type, message.data);
        } catch (error) {
            console.error('WS message error:', error);
            reportRendererError({
                title: '实时消息处理失败',
                message: error.message,
                stack: error.stack || '',
                operation: 'websocket-message'
            });
        }
    });

    state.ws.addEventListener('close', () => {
        setConnectionStatus(false);
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(connectWebSocket, 1200);
    });

    state.ws.addEventListener('error', () => setConnectionStatus(false));
}

async function syncTasks() {
    const startedRevision = state.queueRevision;
    state.queueSnapshotsInFlight += 1;
    try {
        const response = await fetch(`${state.serverUrl}/api/tasks?status=running,pending,completed,failed,cancelled`);
        if (!response.ok) return;
        const tasks = await response.json();
        const latest = new Map((Array.isArray(tasks) ? tasks : []).map(task => [String(task.id), task]));
        for (const [id, change] of state.queueChanges) {
            if (change.revision > startedRevision && change.latest) latest.set(id, change.latest);
        }
        const synchronizedTasks = [...latest.values()];
        applyQueueSnapshot(synchronizedTasks, startedRevision);
        const completed = [];
        // Apply the entire snapshot synchronously before awaiting result hydration.
        // Otherwise newer websocket terminal events can be overwritten mid-loop.
        for (const sequence of state.sequences) {
            ensureSequenceRuntime(sequence);
            const hadRunningTasks = sequence.runningTasks.size > 0;
            const sequenceTasks = synchronizedTasks.filter(task => task.sequenceId === sequence.id);
            sequence.runningTasks.clear();
            for (const task of sequenceTasks) {
                updateBatchFromTask(sequence, task);
                const knownStatus = sequence.batch?.taskStates.get(task.id);
                if ((task.status === 'running' || task.status === 'pending') && !isTerminalTaskStatus(knownStatus)) {
                    sequence.runningTasks.add(task.id);
                    if (task.progress) sequence.taskProgress.set(task.id, task.progress);
                } else {
                    sequence.taskProgress.delete(task.id);
                    if (task.status === 'completed' && !state.savedImageTaskIds.has(task.id)) completed.push(task);
                }
            }
            for (const taskId of sequence.taskProgress.keys()) {
                if (!sequence.runningTasks.has(taskId)) sequence.taskProgress.delete(taskId);
            }
            if (sequence.runningTasks.size > 0) setSequenceStatus(sequence, '正在生成');
            else if (hadRunningTasks) checkSequenceDone(sequence);
        }
        updateActionState();
        for (const task of completed) {
            const full = task.result?.filePath || task.result?.url ? task : await fetchTask(task.id);
            if (full) await persistCompletedTask(full);
        }
    } catch {
        // Sync is best effort.
    } finally {
        state.queueSnapshotsInFlight -= 1;
        if (!state.queueSnapshotsInFlight) state.queueChanges.clear();
    }
}

async function handleSocketMessage(type, task) {
    if (type === 'provider:status') {
        applyProviderHealth(task);
        if (el.routingRanking && !el.routingRanking.hidden && el.concurrencySettingsPanel && !el.concurrencySettingsPanel.hidden) refreshRoutingRanking();
        return;
    }
    if (type === 'provider:failover-config') {
        applyProviderRoutingConfig(task || {});
        return;
    }
    if (!task) return;
    if (type.startsWith('task:')) applyQueueTask(task);

    const sequence = state.sequences.find(item => item.id === task.sequenceId);
    if (!sequence) return;

    ensureSequenceRuntime(sequence);
    updateBatchFromTask(sequence, task);

    if (type === 'task:started' || type === 'task:created') {
        sequence.runningTasks.add(task.id);
        if (type === 'task:created') sequence.taskProgress.delete(task.id);
        setSequenceStatus(sequence, type === 'task:started' ? '正在生成' : '等待生成');
        updateActionState();
        return;
    }

    if (type === 'task:routed') {
        sequence.runningTasks.add(task.id);
        setSequenceStatus(sequence, `${task.providerName || 'API'} · ${task.protocol || 'auto'}`);
        updateActionState();
        return;
    }

    if (type === 'task:progress') {
        sequence.runningTasks.add(task.id);
        if (task.progress) {
            sequence.taskProgress.set(task.id, task.progress);
        }
        markBatchTaskStatus(sequence, task.id, 'running');
        const progressText = progressPhaseText(task.progress);
        setSequenceStatus(sequence, progressText || '正在生成');
        updateActionState();
        return;
    }

    if (type === 'task:completed') {
        sequence.runningTasks.delete(task.id);
        sequence.taskProgress.delete(task.id);
        if (task.result?.base64 || task.result?.filePath || task.result?.url) {
            await persistCompletedTask(task);
        } else {
            const full = await fetchTask(task.id);
            if (full) await persistCompletedTask(full);
        }
        checkSequenceDone(sequence);
        return;
    }

    if (type === 'task:failed') {
        sequence.runningTasks.delete(task.id);
        sequence.taskProgress.delete(task.id);
        const explanation = ux.explainError({ ...task, message: task.error });
        showToast(`${explanation.title}：${explanation.advice}`, 'error');
        checkSequenceDone(sequence);
        return;
    }

    if (type === 'task:cancelled') {
        sequence.runningTasks.delete(task.id);
        sequence.taskProgress.delete(task.id);
        checkSequenceDone(sequence);
    }
}

async function fetchTask(taskId) {
    try {
        const response = await fetch(`${state.serverUrl}/api/tasks/${encodeURIComponent(taskId)}`);
        if (!response.ok) return null;
        return response.json();
    } catch {
        return null;
    }
}

async function persistCompletedTask(task) {
    if (!task.result || state.savedImageTaskIds.has(task.id)) return;
    if (state.savingImageTasks.has(task.id)) return state.savingImageTasks.get(task.id);
    const operation = (async () => {
        let record = task.result;
        if (!record.filePath && !record.url) {
            if (!record.base64) return;
            record = await window.picgenDesktop.saveGeneratedImage({
                id: task.id,
                base64: record.base64,
                mimeType: record.mimeType || 'image/png',
                prompt: task.prompt || '', ratio: task.ratio || '1:1',
                model: task.model || '', providerName: task.providerName || '',
                createdAt: task.completedAt || Date.now()
            });
        }
        mergeHistoryRecord({
            id: task.id, prompt: task.prompt || '', ratio: task.ratio || '1:1',
            model: task.model || '', providerName: task.providerName || '',
            createdAt: task.completedAt || Date.now(), ...record
        });
        state.savedImageTaskIds.add(task.id);
        showToast('图片已生成，可直接拖拽到 PS / AI');
    })();
    state.savingImageTasks.set(task.id, operation);
    try { return await operation; }
    finally { state.savingImageTasks.delete(task.id); }
}

function mergeHistoryRecord(record) {
    const id = historyImageKey(record);
    if (!id) return;
    const previous = state.recentImages.find(image => historyImageKey(image) === id);
    if (previous && JSON.stringify(previous) === JSON.stringify({ ...previous, ...record })) return;
    if (previous) Object.assign(previous, record);
    else state.recentImages.unshift(record);
    state.historyRevision += 1;
    state.historyChanges.set(id, { revision: state.historyRevision, record: previous || record });
    state.historyDirty = true;
    if (state.historyRenderFrame) return;
    state.historyRenderFrame = requestAnimationFrame(() => {
        state.historyRenderFrame = 0;
        renderRecentImages();
        if (state.activeView === 'history') reconcileHistoryImages();
    });
}

// --- Usage counters (v3.1 WP12, usage design §6) --------------------------------------------------
// dragCount (taking the image out of PicGen: native drag-outs, 复制图片 and 另存为, all counted by main
// after they succeeded) and referenceCount (in-app AI-input uses, counted here after the use succeeded)
// arrive as absolute values, so a repeated push is harmless. A used image is "protected": deleting a
// multi-selection keeps it unless the user explicitly includes it.
const HISTORY_USAGE_FIELDS = ['dragCount', 'referenceCount', 'lastUsedAt', 'lastUsedKind'];
// lucide hand-grab, inlined: a badge must never be an <img> or trigger a per-item icon pass.
const HISTORY_USAGE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M18 11.5V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1.4"/><path d="M14 10V8a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/>'
    + '<path d="M10 9.9V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v5"/><path d="M6 14a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/>'
    + '<path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8 2 2 0 1 1 4 0"/></svg>';

// Read lazily: the vm harness in renderer-performance.test.js loads desktop.js without this global.
function historyUsageApi() {
    return window.PicGenHistoryUsage || null;
}

function historyUsageKey(image) {
    const api = historyUsageApi();
    if (api?.usageKey) return api.usageKey(image);
    const name = String(image?.fileName || String(image?.filePath || '').split(/[\\/]/).pop()).toLowerCase();
    return name ? `${name}|${Number(image?.fileSize) || 0}` : '';
}

function historyUsageTotal(image) {
    return (Number(image?.dragCount) || 0) + (Number(image?.referenceCount) || 0);
}

function historyUsageTooltip(image) {
    const api = historyUsageApi();
    if (api?.formatUsageTooltip) return api.formatUsageTooltip(image);
    const total = historyUsageTotal(image);
    return total > 0 ? `已使用 ${total} 次\n批量删除时默认保留` : '';
}

function historyUsageSummary(image) {
    const drags = Number(image?.dragCount) || 0;
    const references = Number(image?.referenceCount) || 0;
    if (drags + references <= 0) return '未使用';
    const parts = [];
    if (drags) parts.push(`拖出/复制/另存 ${drags} 次`);
    if (references) parts.push(`参考图 ${references} 次`);
    const last = Number(image?.lastUsedAt) || 0;
    if (last) parts.push(`最近 ${formatHistoryFullDate(last)}`);
    return parts.join(' · ');
}

// An in-app use as an AI input (drop onto the reference band, 发送到参考图, 发送到图片工作台 / 局部编辑). Fire-and-forget:
// counting never blocks or undoes the use itself. 复制图片 / 另存为 are not counted here: main counts them as a drag-out.
function noteHistoryImageUse(image, source) {
    const record = window.picgenDesktop?.recordHistoryUsage;
    if (!image?.filePath || typeof record !== 'function') return;
    Promise.resolve()
        .then(() => record({ filePath: image.filePath, kind: 'reference', source }))
        .then(result => {
            if (result?.ok && result.usage) applyHistoryUsage({ usageKey: result.usageKey, filePath: image.filePath, usage: result.usage });
        })
        .catch(() => {});
}

// Patches every record sharing the usage key (stale duplicates may), then the badges in place. Never
// re-renders the strip or the gallery; the history change log keeps an in-flight refresh from reverting it.
function applyHistoryUsage(update) {
    const usage = update?.usage;
    if (!usage || typeof usage !== 'object') return;
    const key = String(update.usageKey || '');
    const pathKey = String(update.filePath || '').replace(/\//g, '\\').toLowerCase();
    let matches = key ? state.recentImages.filter(image => historyUsageKey(image) === key) : [];
    if (!matches.length && pathKey) {
        matches = state.recentImages.filter(image => String(image.filePath || '').replace(/\//g, '\\').toLowerCase() === pathKey);
    }
    const changed = matches.filter(image => HISTORY_USAGE_FIELDS.some(field => field in usage && (image[field] ?? null) !== (usage[field] ?? null)));
    if (!changed.length) return;
    state.historyRevision += 1;
    const byId = new Map();
    for (const image of changed) {
        for (const field of HISTORY_USAGE_FIELDS) if (field in usage) image[field] = usage[field];
        const id = historyImageKey(image);
        byId.set(id, image);
        state.historyChanges.set(id, { revision: state.historyRevision, record: image });
    }
    for (const item of el.historyImages?.querySelectorAll('.history-item') || []) {
        const image = byId.get(item.dataset.historyId);
        if (!image) continue;
        renderUsageBadge(item.querySelector('.history-thumb'), image);
        setHistoryItemLabel(item, image);
    }
    // 主页最近图条同样就地更新角标（不重建图条，避免缩略图重载闪烁；轮播模式下图块在 track 里，同样命中）
    for (const item of el.recentImages?.querySelectorAll('.recent-item') || []) {
        const image = byId.get(item.dataset.historyId);
        if (!image) continue;
        renderUsageBadge(item, image);
        setHistoryItemLabel(item, image);
    }
    // The group chip and the cover depend on usage: re-project the cached snapshot (no IPC, rows patched).
    if (similarViewVisible()) applySimilarProjection({ reorder: false });
    if (byId.has(state.historyActiveImageId) && !el.historyDetailDrawer?.hidden) renderHistoryDetail();
}

window.picgenDesktop.onHistoryUsageUpdated?.(applyHistoryUsage);

// Idempotent: creates, updates or removes the bottom-left badge of one history thumbnail.
function renderUsageBadge(thumb, image) {
    if (!thumb) return;
    let badge = thumb.querySelector('.history-usage-badge');
    const total = historyUsageTotal(image);
    if (total <= 0) {
        badge?.remove();
        return;
    }
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'history-usage-badge';
        badge.innerHTML = HISTORY_USAGE_ICON;
        badge.appendChild(document.createElement('b'));
        thumb.appendChild(badge);
    }
    setElementText(badge.querySelector('b'), String(total));
    const title = historyUsageTooltip(image);
    if (badge.title !== title) badge.title = title;
}

function setHistoryItemLabel(item, image) {
    const total = historyUsageTotal(image);
    // 操作说明放 aria-label 而不是 title：Windows 把 title 渲染成系统级信息提示，层级高于
    // 置顶的悬浮预览窗，悬停约一秒后弹出并遮挡预览。文件名由 .history-file-name 展示。
    const label = `${image.fileName || '历史图片'}，点击查看详情，拖到参考图按钮那一行可加为参考图，拖到 PS / AI 可直接使用，Ctrl+点击可多选${total > 0 ? `，已使用 ${total} 次` : ''}`;
    if (item.getAttribute('aria-label') !== label) item.setAttribute('aria-label', label);
}

function reconcileHistoryImages() {
    if (!el.historyImages || state.activeView !== 'history') return;
    renderHistoryFilterControls();
    if (state.similarFind) { renderFindSimilarView(); return; }
    // History changes (a finished generation, a refresh) patch the similar rows; they never reorder them.
    if (state.historyLayout === 'similar') { renderSimilarHistory({ reorder: false }); return; }
    if (state.historyHostMode !== 'items') { renderHistoryImages(); return; }
    const images = getFilteredHistoryImages();
    const previousScrollTop = el.historyImages.scrollTop;
    const existing = new Map([...el.historyImages.querySelectorAll('.history-item')]
        .map(item => [item.dataset.historyId, item]));
    const inserted = images.slice(0, state.historyRenderedCount)
        .filter(image => !existing.has(historyImageKey(image))).length;
    const visibleCount = Math.min(images.length, Math.max(HISTORY_RENDER_BATCH_SIZE, state.historyRenderedCount + inserted));
    const shown = images.slice(0, visibleCount);
    const viewportTop = el.historyImages.getBoundingClientRect?.().top;
    const anchor = previousScrollTop > 0 && Number.isFinite(viewportTop)
        ? [...existing.values()].find(item => item.getBoundingClientRect().bottom > viewportTop) : null;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const shownIds = new Set(shown.map(historyImageKey));
    for (const [id, item] of existing) {
        if (!shownIds.has(id)) {
            const preview = item.querySelector('img');
            if (preview) state.historyThumbnailObserver?.unobserve(preview);
            item.remove();
        }
    }
    el.historyImages.querySelector('.history-empty')?.remove();
    if (!images.length) {
        renderHistoryImages();
        return;
    }
    shown.forEach((image, index) => {
        const item = existing.get(historyImageKey(image)) || createHistoryItem(image);
        if (el.historyImages.children[index] !== item) el.historyImages.insertBefore(item, el.historyImages.children[index] || null);
    });
    state.historyRenderedCount = visibleCount;
    setElementText(el.historyCount, images.length === state.recentImages.length
        ? `${state.recentImages.length} 张` : `${images.length} / ${state.recentImages.length} 张`);
    el.historyImages.scrollTop = previousScrollTop + (anchor?.parentNode
        ? anchor.getBoundingClientRect().top - anchorTop : 0);
    state.historyDirty = false;
    updateHistorySelectionUi();
}

function checkSequenceDone(sequence) {
    ensureSequenceRuntime(sequence);
    if (sequence.runningTasks.size === 0) {
        sequence.taskProgress.clear();
        setSequenceStatus(sequence, '完成');
    } else {
        setSequenceStatus(sequence, `剩余 ${sequence.runningTasks.size} 张`);
    }
    updateActionState();
}

async function refreshRecentImages(options = {}) {
    const startedRevision = state.historyRevision;
    const full = options.full === true || state.historyLoaded;
    const images = full && window.picgenDesktop.listHistoryImages
        ? await window.picgenDesktop.listHistoryImages()
        : await window.picgenDesktop.listRecentImages({ limit: 10 });
    if (!full && state.historyLoaded) return state.recentImages;
    const next = new Map((Array.isArray(images) ? images : []).map(image => [historyImageKey(image), image]));
    for (const [id, change] of state.historyChanges) {
        if (change.revision > startedRevision) next.set(id, change.record);
        else state.historyChanges.delete(id);
    }
    // A snapshot that was in flight when images were trashed must not bring them back.
    for (const [id, revision] of state.historyRemovals) {
        if (revision > startedRevision) next.delete(id);
        else state.historyRemovals.delete(id);
    }
    state.recentImages = [...next.values()];
    state.historyDirty = true;
    if (full) {
        state.historyLoaded = true;
        state.savedImageTaskIds = new Set(state.recentImages.map(image => image.id).filter(Boolean));
        const availableIds = new Set(state.recentImages.map(historyImageKey));
        state.historySelectedIds = new Set(
            [...state.historySelectedIds].filter(id => availableIds.has(id))
        );
        if (state.historyActiveImageId && !availableIds.has(state.historyActiveImageId)) {
            state.historyActiveImageId = null;
        }
    } else {
        for (const image of images) {
            if (image.id) state.savedImageTaskIds.add(image.id);
        }
    }
    renderRecentImages();
    if (state.activeView === 'history') reconcileHistoryImages();
    return state.recentImages;
}

function ensureHistoryThumbnailObserver() {
    if (state.historyThumbnailObserver || !('IntersectionObserver' in window)) {
        return state.historyThumbnailObserver;
    }
    state.historyThumbnailObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            state.historyThumbnailObserver.unobserve(entry.target);
            loadHistoryThumbnail(entry.target._picgenHistoryImage, entry.target);
        }
    }, {
        root: el.historyImages,
        rootMargin: '400px 0px'
    });
    return state.historyThumbnailObserver;
}

async function loadHistoryThumbnail(image, element) {
    if (!image || !element) return;
    if (!window.picgenDesktop.getHistoryThumbnail) {
        if (!element._thumbnailOnly) element.src = image.url;
        return;
    }
    try {
        const thumbnail = await window.picgenDesktop.getHistoryThumbnail({ filePath: image.filePath });
        if (element.isConnected && thumbnail?.url) element.src = thumbnail.url;
    } catch {
        if (element.isConnected && !element._thumbnailOnly) element.src = image.url;
    }
}

function attachHistoryThumbnail(image, element, options = {}) {
    element._picgenHistoryImage = image;
    if (options.eager) {
        loadHistoryThumbnail(image, element);
        return;
    }
    const observer = ensureHistoryThumbnailObserver();
    if (observer) observer.observe(element);
    else loadHistoryThumbnail(image, element);
}

// No resize listener: the display mode is manual (grid10 / carousel20 via the
// header toggle) and both layouts are fully CSS-driven — the grid reflows on its
// own and the carousel uses scroll-snap with live clientWidth reads. Re-rendering
// on resize only rebuilds the <img> nodes and reloads thumbnails, which flickers.

function renderRecentImages() {
    if (!el.recentImages) return;
    const hint = document.querySelector?.('.recent-hint');
    const display = recentDisplaySettings();
    const images = [...state.recentImages]
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
        .slice(0, display.count);
    if (!images.length) {
        el.recentImages.classList.remove('carousel-mode');
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '暂无图片';
        el.recentImages.replaceChildren(empty);
        if (hint) hint.textContent = '最近 20 张';
        return;
    }

    const buildItem = image => {
        const item = document.createElement('div');
        item.className = 'recent-item';
        item.draggable = true;
        item.tabIndex = 0;
        // 说明放 aria-label 而不是 title：Windows 会把 title 渲染成系统级信息提示，
        // 层级高于置顶的悬浮预览窗，悬停一秒后弹出并遮挡预览。
        item.setAttribute('aria-label', `${image.fileName || '未命名图片'}，点击查看详情；拖到参考图按钮那一行可加为参考图，拖到其他软件可直接使用`);
        const preview = document.createElement('img');
        preview.alt = image.fileName || '';
        preview.loading = 'lazy';
        preview.decoding = 'async';
        attachHistoryThumbnail(image, preview, { eager: true });
        item.appendChild(preview);
        // 主页图条也显示使用次数（与历史页同一角标），applyHistoryUsage 按 data-history-id 就地更新
        item.dataset.historyId = historyImageKey(image);
        renderUsageBadge(item, image);
        setHistoryItemLabel(item, image);
        item.addEventListener('click', () => {
            showHistoryView();
            state.historySelectedIds.clear();
            setHistoryImageSelected(image, true, { openDetail: true });
        });
        item.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            item.click();
        });
        item.addEventListener('mouseenter', event => showImageHoverPreview(image, event));
        item.addEventListener('mousemove', queueImageHoverPreviewPosition);
        item.addEventListener('mouseleave', event => {
            if (event.relatedTarget?.closest?.('#historyImages, #recentImages')) return;
            hideImageHoverPreview();
        });
        item.addEventListener('contextmenu', event => showImageContextMenu(image, event));
        item.addEventListener('dragstart', event => {
            rememberDraggedRecentImage(image);
            event.preventDefault();
            beginRecentImageDrag(image);
        });
        item.addEventListener('dragend', clearDraggedRecentImage);
        return item;
    };

    // 展示模式由 recentDisplaySettings 决定（手动开关）：10 张网格预览 / 20 张轮播。
    const items = images.map(buildItem);
    el.recentImages.classList.remove('carousel-mode');
    el.recentImages.replaceChildren(...items);
    if (display.mode === 'carousel') {
        el.recentImages.classList.add('carousel-mode');
        mountRecentCarousel(items);
    }
    if (hint) hint.textContent = display.mode === 'carousel' ? `最近 ${images.length} 张 · 轮播` : `最近 ${images.length} 张`;
}

// 历史图片展示模式（手动开关，不随窗口高度自动变）：
//   'grid10'      → 固定 10 张网格同时预览（默认）
//   'carousel20'  → 20 张轮播（每屏 RECENT_CAROUSEL_PER_VIEW 张）
function recentDisplaySettings() {
    return state.recentViewMode === 'carousel20'
        ? { count: 20, mode: 'carousel' }
        : { count: 10, mode: 'grid' };
}
function toggleRecentViewMode() {
    state.recentViewMode = state.recentViewMode === 'carousel20' ? 'grid10' : 'carousel20';
    try { localStorage.setItem('picgen.recentViewMode', state.recentViewMode); } catch { /* storage unavailable */ }
    updateRecentViewToggle();
    renderRecentImages();
}
function updateRecentViewToggle() {
    const btn = el.recentViewToggleBtn;
    if (!btn) return;
    const carousel = state.recentViewMode === 'carousel20';
    btn.title = carousel ? '切换：10 张预览' : '切换：20 张轮播';
    btn.innerHTML = carousel ? '<i data-lucide="layout-grid"></i>' : '<i data-lucide="gallery-horizontal-end"></i>';
    refreshLucideIcons(btn);
}

// The home "历史图片" strip as an Appica-style carousel: a paged horizontal snap
// track with prev/next buttons and page dots. Reuses the already-built item
// nodes (moved into the track). Built in the controller because #recentImages is
// a controller-owned host; a page is RECENT_CAROUSEL_PER_VIEW thumbnails wide and
// each nav/dot scrolls the viewport by one page (native scroll-snap aligns them).
const RECENT_CAROUSEL_PER_VIEW = 3;
function mountRecentCarousel(items) {
    const host = el.recentImages;
    const makeNav = dir => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `recent-carousel-nav recent-carousel-${dir}`;
        button.setAttribute('aria-label', dir === 'prev' ? '上一页' : '下一页');
        button.innerHTML = `<i data-lucide="${dir === 'prev' ? 'chevron-left' : 'chevron-right'}"></i>`;
        return button;
    };
    const prev = makeNav('prev');
    const next = makeNav('next');
    const viewport = document.createElement('div');
    viewport.className = 'recent-carousel-viewport';
    const track = document.createElement('div');
    track.className = 'recent-carousel-track';
    track.append(...items);
    viewport.appendChild(track);
    const dots = document.createElement('div');
    dots.className = 'recent-carousel-dots';
    const pages = Math.max(1, Math.ceil(items.length / RECENT_CAROUSEL_PER_VIEW));
    for (let page = 0; page < pages; page++) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'recent-carousel-dot';
        dot.setAttribute('aria-label', `第 ${page + 1} 页`);
        dot.addEventListener('click', () => viewport.scrollTo({ left: page * viewport.clientWidth, behavior: 'smooth' }));
        dots.appendChild(dot);
    }
    host.replaceChildren(prev, viewport, next, dots);

    const syncNav = () => {
        const width = Math.max(1, viewport.clientWidth);
        const page = Math.round(viewport.scrollLeft / width);
        [...dots.children].forEach((dot, index) => dot.classList.toggle('is-active', index === page));
        prev.disabled = viewport.scrollLeft <= 1;
        next.disabled = viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 1;
    };
    prev.addEventListener('click', () => viewport.scrollBy({ left: -viewport.clientWidth, behavior: 'smooth' }));
    next.addEventListener('click', () => viewport.scrollBy({ left: viewport.clientWidth, behavior: 'smooth' }));
    viewport.addEventListener('scroll', syncNav, { passive: true });
    // Vertical wheel drives the horizontal strip (mirrors the supplier carousel);
    // the CSS `scroll-snap-type: x mandatory` snaps to a thumbnail per notch.
    viewport.addEventListener('wheel', event => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        if (viewport.scrollWidth <= viewport.clientWidth) return;
        event.preventDefault();
        viewport.scrollLeft += event.deltaY;
    }, { passive: false });
    (window.refreshLucideIcons || (root => window.lucide?.createIcons?.({ root })))(host);
    requestAnimationFrame(syncNav);
}

function historyImageKey(image) {
    return String(image?.id || image?.filePath || image?.fileName || '');
}

// Read lazily: the vm harness in renderer-performance.test.js loads desktop.js without this global.
function historySearchApi() {
    return window.PicGenHistorySearch || null;
}

// Normalised search text per image, rebuilt only when one of its fields changes.
const historySearchTextCache = new WeakMap();

function historySearchFields(image) {
    const ratio = getHistoryRatio(image);
    const width = Number(image.width || 0);
    const height = Number(image.height || 0);
    return [image.fileName, image.prompt, image.model, ratio === '—' ? '' : ratio, width > 0 && height > 0 ? `${width}x${height}` : ''];
}

function historyImageMatchesSearch(image, parsed, api) {
    const fields = historySearchFields(image);
    const raw = fields.join('\n');
    let cached = historySearchTextCache.get(image);
    if (!cached || cached.raw !== raw) {
        cached = { raw, text: api.haystack(fields) };
        historySearchTextCache.set(image, cached);
    }
    return api.matches(cached.text, parsed);
}

// Read lazily, like historySearchApi().
function historyFiltersApi() {
    return window.PicGenHistoryFilters || null;
}

const HISTORY_SORT_KEY = 'picgen.historySort';
const HISTORY_FILTERS_EXPANDED_KEY = 'picgen.historyFiltersExpanded';

// Sort and the panel's open state survive a restart; the filters themselves do not, so the list never
// opens narrowed without the user knowing why.
function loadHistoryFilterPreferences() {
    const api = historyFiltersApi();
    state.historyFilters = api ? api.normalize(null) : null;
    try {
        state.historySort = api ? api.normalizeSort(localStorage.getItem(HISTORY_SORT_KEY)) : 'newest';
        state.historyFiltersExpanded = localStorage.getItem(HISTORY_FILTERS_EXPANDED_KEY) === '1';
    } catch {
        state.historySort = 'newest';
        state.historyFiltersExpanded = false;
    }
}

function saveHistoryFilterPreference(key, value) {
    try { localStorage.setItem(key, value); } catch { /* per-viewer convenience only */ }
}

function getFilteredHistoryImages() {
    const searchApi = historySearchApi();
    const filtersApi = historyFiltersApi();
    const rawQuery = el.historySearchInput.value;
    const parsedQuery = searchApi ? searchApi.parseQuery(rawQuery) : null;
    const query = searchApi ? '' : rawQuery.trim().toLocaleLowerCase('zh-CN');
    const hasQuery = searchApi ? !searchApi.isEmptyQuery(parsedQuery) : !!query;
    const filters = filtersApi ? filtersApi.normalize(state.historyFilters) : null;
    const now = Date.now();
    const bounds = filters ? filtersApi.dateBounds(filters.date, now) : null;
    const filtered = state.recentImages.filter(image => {
        if (filters && !filtersApi.matches(image, filters, { now, bounds, usageTotal: historyUsageTotal })) return false;
        if (!hasQuery) return true;
        if (searchApi) return historyImageMatchesSearch(image, parsedQuery, searchApi);
        return [image.fileName, image.prompt, image.model]
            .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
    });
    const compare = filtersApi
        ? filtersApi.comparator(state.historySort, { usageTotal: historyUsageTotal })
        : (left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0);
    filtered.sort(compare);
    return filtered;
}

// A search or filter change: images it hides leave the selection, so 全选 / 反选 / 移到回收站 only ever
// act on what is on screen.
function applyHistoryFilters() {
    pruneHistorySelectionToVisible();
    renderHistoryImages();
}

function pruneHistorySelectionToVisible() {
    if (!state.historySelectedIds.size) return;
    const visible = new Set(getFilteredHistoryImages().map(historyImageKey));
    for (const id of [...state.historySelectedIds]) if (!visible.has(id)) state.historySelectedIds.delete(id);
    if (state.historyActiveImageId && !state.historySelectedIds.has(state.historyActiveImageId)) state.historyActiveImageId = null;
}

function setHistoryFilters(next) {
    const api = historyFiltersApi();
    if (!api) return;
    state.historyFilters = api.normalize(next);
    applyHistoryFilters();
}

function clearHistoryFilters() {
    el.historySearchInput.value = '';
    el.historySearchClearBtn.hidden = true;
    const api = historyFiltersApi();
    if (api) state.historyFilters = api.normalize(null);
    applyHistoryFilters();
}

function setHistorySort(sort) {
    const api = historyFiltersApi();
    state.historySort = api ? api.normalizeSort(sort) : 'newest';
    saveHistoryFilterPreference(HISTORY_SORT_KEY, state.historySort);
    renderHistoryImages();
}

function setHistoryFiltersExpanded(expanded) {
    state.historyFiltersExpanded = !!expanded;
    saveHistoryFilterPreference(HISTORY_FILTERS_EXPANDED_KEY, state.historyFiltersExpanded ? '1' : '0');
    renderHistoryFilterControls();
}

// The React filter controls (frontend/HistoryFilters.jsx) are a pure view of state.historyFilters:
// re-rendered on every filter, sort or history change.
function renderHistoryFilterControls() {
    const api = historyFiltersApi();
    const render = window.PicGenAppica?.renderHistoryFilters;
    if (!api || typeof render !== 'function') return;
    render({
        catalog: api,
        filters: api.normalize(state.historyFilters),
        sort: state.historySort,
        // Similar groups follow 分组排序 and 查找相似 ranks by similarity: the date/name sort means nothing there.
        sortHidden: state.historyLayout === 'similar' || !!state.similarFind,
        expanded: state.historyFiltersExpanded,
        vendors: api.vendorCounts(state.recentImages),
        onChange: setHistoryFilters,
        onSortChange: setHistorySort,
        onExpandedChange: setHistoryFiltersExpanded,
        onClear: clearHistoryFilters,
        onRemoveChip: chip => setHistoryFilters(api.remove(state.historyFilters, chip))
    });
}

// --- Similar images (v3.1, plan §2.14) ------------------------------------------------------------
// desktop.js owns everything inside #historyImages; React owns the toolbar hosts
// (#historySimilarToolbar …), the drawer button and the context-menu entries.
// Rows are <details class="similar-group"> keyed by the snapshot's stable group id. A push or a history
// change patches them in place: existing rows are never rebuilt or reordered, an open group stays
// open and scrollTop is kept. Filters, the sort and the singles switch only re-project the cached
// snapshot (similarProjection.js), with no IPC. Pages of 30 rows come from a sentinel observer.
const SIMILAR_PAGE_ROWS = 30;
const SIMILAR_GROUP_PAGE = 24;
const SIMILAR_SINGLES_PAGE = 60;
const SIMILAR_STRIP_CELLS = 5;
const SIMILAR_NEIGHBOR_LIMIT = 60;
const SIMILAR_PRESETS = ['strict', 'standard', 'loose'];
const SIMILAR_STORAGE_KEYS = { preset: 'picgen.similarPreset', sort: 'picgen.similarSort', singles: 'picgen.similarShowSingles' };
// §2.2 mode reasons, shown as the tooltip of 「基础模式」.
const SIMILAR_MODE_REASONS = {
    'ort-unavailable': '推理运行库加载失败',
    'model-missing': '模型文件缺失',
    'model-size': '模型文件大小不符',
    'session-failed': '推理会话创建失败',
    'self-test-failed': '模型自检失败',
    disabled: '已按启动参数关闭',
    unstable: '相似分析进程多次异常退出',
    'run-failed': '推理连续失败'
};
const SIMILAR_GROUP_ACTIONS = [
    ['select', '选中本组', '选中本组当前可见的图片'],
    ['find', '查找相似', '查找与本组封面相似的图片'],
    ['collapse', '收起', '收起本组']
];

// Read lazily: the vm harness in renderer-performance.test.js loads desktop.js without these globals.
function similarProjectionApi() {
    return window.PicGenSimilarProjection || null;
}

function similarNumber(value) {
    return (Number(value) || 0).toLocaleString('en-US');
}

function loadSimilarPreferences() {
    const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
    const preset = read(SIMILAR_STORAGE_KEYS.preset);
    state.similarPreset = SIMILAR_PRESETS.includes(preset) ? preset : 'standard';
    state.similarSort = read(SIMILAR_STORAGE_KEYS.sort) === 'size' ? 'size' : 'recent';
    state.showSingles = read(SIMILAR_STORAGE_KEYS.singles) === '1';
    syncSimilarToolbarControls();
}

function writeSimilarPreference(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function syncSimilarToolbarControls() {
    for (const [select, value] of [[el.historySimilarPreset, state.similarPreset], [el.historySimilarSort, state.similarSort]]) {
        if (!select || select.value === value) continue;
        select.value = value;
        refreshModernSelect(select);
    }
    if (el.historySimilarSingles) el.historySimilarSingles.checked = state.showSingles;
}

function syncSimilarToolbar() {
    if (el.historySimilarToolbar) el.historySimilarToolbar.hidden = state.historyLayout !== 'similar' || !!state.similarFind;
}

function similarViewVisible() {
    return state.activeView === 'history' && state.historyLayout === 'similar' && !state.similarFind && !!state.similarDom;
}

function setSimilarPreset(value) {
    const preset = SIMILAR_PRESETS.includes(value) ? value : 'standard';
    if (preset === state.similarPreset) return;
    state.similarPreset = preset;
    writeSimilarPreference(SIMILAR_STORAGE_KEYS.preset, preset);
    syncSimilarToolbarControls();
    if (similarViewVisible()) void fetchSimilarSnapshot({ reorder: true, force: true });
}

function setSimilarSort(value) {
    const sort = value === 'size' ? 'size' : 'recent';
    if (sort === state.similarSort) return;
    state.similarSort = sort;
    writeSimilarPreference(SIMILAR_STORAGE_KEYS.sort, sort);
    syncSimilarToolbarControls();
    if (similarViewVisible()) applySimilarProjection({ reorder: true });
}

function setShowSingles(on) {
    state.showSingles = Boolean(on);
    writeSimilarPreference(SIMILAR_STORAGE_KEYS.singles, state.showSingles ? '1' : '0');
    syncSimilarToolbarControls();
    if (!similarViewVisible()) return;
    renderSimilarSingles();
    updateHistorySelectionUi();
}

// Pushes (≤ 2/s) only say that something changed. Refetch only while the view is visible and the
// revision moved; otherwise remember it and refetch when the view is shown again.
function handleSimilarityUpdated(summary) {
    if (!summary || typeof summary !== 'object') return;
    if (state.similarSnapshot && summary.revision === state.similarSnapshot.revision) return;
    if (!similarViewVisible()) {
        state.similarStale = true;
        // showHistoryView only reconciles a dirty view; the reconcile then refetches.
        if (state.historyLayout === 'similar') state.historyDirty = true;
        return;
    }
    void fetchSimilarSnapshot({ reorder: false });
}

window.picgenDesktop.onSimilarityUpdated?.(handleSimilarityUpdated);

async function fetchSimilarSnapshot(options = {}) {
    const request = window.picgenDesktop?.getSimilarityGroups;
    if (typeof request !== 'function') return null;
    if (state.similarFetching && !options.force) {
        state.similarRefetch = true;
        return null;
    }
    const seq = ++state.similarFetchSeq;
    state.similarFetching = true;
    state.similarStale = false;
    const preset = state.similarPreset;
    const current = state.similarSnapshot;
    const query = { foreground: true, preset };
    if (current && current.preset === preset && Number.isFinite(current.revision)) query.since = current.revision;
    try {
        const snapshot = await request(query);
        if (seq !== state.similarFetchSeq) return null;
        if (snapshot && !snapshot.notModified) applySimilaritySnapshot(snapshot, options);
        return state.similarSnapshot;
    } catch (error) {
        if (seq === state.similarFetchSeq) {
            state.similarError = error.message;
            updateSimilarStatus();
        }
        return null;
    } finally {
        if (seq === state.similarFetchSeq) {
            state.similarFetching = false;
            if (state.similarRefetch) {
                state.similarRefetch = false;
                if (similarViewVisible()) void fetchSimilarSnapshot({ reorder: false });
                else state.similarStale = true;
            }
        }
    }
}

// The one entry point for a new snapshot (a get, a push-driven refetch, or a smoke check that forces
// revisions). Without reorder the rows are patched in place.
function applySimilaritySnapshot(snapshot, options = {}) {
    if (!snapshot || !Array.isArray(snapshot.groups)) return false;
    state.similarSnapshot = snapshot;
    state.similarError = '';
    if (!similarViewVisible()) {
        if (state.historyLayout === 'similar') state.historyDirty = true;
        updateSimilarStatus();
        return false;
    }
    applySimilarProjection({ reorder: options.reorder === true });
    return true;
}

function renderSimilarHistory(options = {}) {
    if (!el.historyImages) return;
    state.historyDirty = false;
    syncSimilarToolbar();
    const entered = enterSimilarHost('similar');
    const snapshot = state.similarSnapshot;
    if (!snapshot || snapshot.preset !== state.similarPreset) {
        if (!snapshot) {
            showSimilarEmpty('正在整理相似图片…');
            updateSimilarStatus();
        } else applySimilarProjection({ reorder: true });
        void fetchSimilarSnapshot({ reorder: true, force: true });
        return;
    }
    applySimilarProjection({ reorder: entered || options.reorder !== false });
    // Opening the view is a foreground get (the host boosts its lanes); `since` makes it cheap.
    if (entered || state.similarStale) void fetchSimilarSnapshot({ reorder: false });
}

// #historyImages holds either plain items (grid/list), similar rows or find-similar results.
// Switching what it holds clears it once; updates within a mode never do.
function enterSimilarHost(mode, force = false) {
    const host = el.historyImages;
    if (!force && state.historyHostMode === mode && (mode !== 'similar' || state.similarDom)) return false;
    state.historyThumbnailObserver?.disconnect();
    resetSimilarHost();
    host.innerHTML = '';
    host.scrollTop = 0;
    host.classList.remove('grid-layout', 'list-layout', 'similar-layout', 'find-similar-layout');
    host.classList.add(mode === 'find' ? 'find-similar-layout' : 'similar-layout');
    state.historyHostMode = mode;
    if (mode === 'similar') buildSimilarScaffold();
    return true;
}

function resetSimilarHost() {
    state.similarPagerObserver?.disconnect();
    state.similarPagerObserver = null;
    state.similarDom = null;
    state.similarParked = null;
    state.similarRows.clear();
    if (state.similarFind) state.similarFind.dom = null;
}

function buildSimilarScaffold() {
    const make = (tag, className) => {
        const node = document.createElement(tag);
        node.className = className;
        return node;
    };
    const pill = make('button', 'similar-new-pill');
    pill.type = 'button';
    pill.hidden = true;
    pill.addEventListener('click', showDeferredSimilarGroups);
    const empty = make('p', 'similar-empty');
    empty.hidden = true;
    const rows = make('div', 'similar-rows');
    const footer = make('div', 'similar-singles-footer');
    footer.hidden = true;
    const footerText = make('span', 'similar-singles-text');
    const footerButton = make('button', 'similar-link-button');
    footerButton.type = 'button';
    footerButton.addEventListener('click', () => setShowSingles(!state.showSingles));
    footer.append(footerText, footerButton);
    const singles = make('div', 'similar-group-grid similar-singles-grid');
    singles.hidden = true;
    const sentinel = make('div', 'similar-sentinel');
    sentinel.setAttribute('aria-hidden', 'true');
    // One display:contents wrapper, so 查找相似 can park the whole list (hidden, not destroyed) and ✕
    // brings back the same rows at the same scroll position.
    const root = make('div', 'similar-view');
    root.append(pill, empty, rows, footer, singles, sentinel);
    el.historyImages.append(root);
    state.similarDom = { root, pill, empty, rows, footer, footerText, footerButton, singles, sentinel };
    state.similarOrder = [];
    if ('IntersectionObserver' in window) {
        state.similarPagerObserver = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) appendSimilarPage();
        }, { root: el.historyImages, rootMargin: '600px 0px' });
        state.similarPagerObserver.observe(sentinel);
    }
}

function applySimilarProjection({ reorder = false } = {}) {
    const api = similarProjectionApi();
    if (!state.similarDom) return;
    if (!api) {
        showSimilarEmpty('相似图片模块未加载');
        return;
    }
    const images = getFilteredHistoryImages();
    const recordsByKey = new Map(state.recentImages.map(image => [historyImageKey(image), image]));
    const previous = state.similarGroups;
    const projected = api.project(state.similarSnapshot, images, { sort: state.similarSort, keyOf: historyImageKey, recordsByKey });
    state.similarGroups = projected.groups;
    state.similarSingles = projected.singles;
    state.similarMissing = projected.missing;
    state.similarGrouped = projected.grouped;
    state.similarVisibleTotal = images.length;
    renderSimilarRows(previous, reorder);
    updateSimilarStatus();
    updateHistorySelectionUi();
}

function renderSimilarRows(previousGroups, reorder) {
    const api = similarProjectionApi();
    const host = el.historyImages;
    const groups = state.similarGroups;
    const byId = new Map(groups.map(group => [group.id, group]));
    remapOpenSimilarRows(api, previousGroups, groups);
    const anchor = reorder ? null : captureSimilarAnchor();
    let order;
    if (reorder) {
        order = groups.map(group => group.id);
        state.similarDeferred = [];
    } else {
        // New groups gather behind the pill once the user has scrolled or opened a group.
        const deferNew = state.similarOrder.length > 0 && (host.scrollTop > 8 || state.similarOpenIds.size > 0);
        const diff = api.keyedDiff(state.similarOrder, groups, { deferNew });
        order = diff.order;
        const placed = new Set(order);
        state.similarDeferred = [...new Set([...state.similarDeferred, ...diff.deferred])]
            .filter(id => byId.has(id) && !placed.has(id));
    }
    state.similarRendered = similarRenderedCount(order, reorder);
    state.similarOrder = order;
    syncSimilarRowsDom(byId);
    renderSimilarPill();
    renderSimilarSingles();
    showSimilarEmpty(similarEmptyText());
    restoreSimilarAnchor(anchor);
}

// How many rows of `order` are in the DOM: a page, grown to keep every rendered row that survives
// (rows inserted above them appear) and every open group.
function similarRenderedCount(order, reorder) {
    let lastOpen = -1;
    order.forEach((id, index) => { if (state.similarOpenIds.has(id)) lastOpen = index; });
    const page = Math.min(order.length, SIMILAR_PAGE_ROWS);
    if (reorder) return Math.min(order.length, Math.max(page, state.similarRendered, lastOpen + 1));
    if (!state.similarOrder.length) return Math.max(page, lastOpen + 1);
    const shown = new Set(state.similarOrder.slice(0, state.similarRendered));
    let last = -1;
    order.forEach((id, index) => { if (shown.has(id)) last = index; });
    const complete = state.similarRendered >= state.similarOrder.length;
    const wanted = complete ? last + 1 + SIMILAR_PAGE_ROWS : last + 1;
    return Math.min(order.length, Math.max(page, wanted, lastOpen + 1));
}

function syncSimilarRowsDom(byId) {
    const container = state.similarDom.rows;
    const shown = state.similarOrder.slice(0, state.similarRendered).filter(id => byId.has(id));
    const keep = new Set(shown);
    for (const [id, row] of [...state.similarRows]) {
        if (keep.has(id)) continue;
        releaseSimilarRow(row);
        state.similarRows.delete(id);
    }
    shown.forEach((id, index) => {
        const group = byId.get(id);
        let row = state.similarRows.get(id);
        if (row) patchSimilarGroupRow(row, group);
        else {
            row = createSimilarGroupRow(group);
            state.similarRows.set(id, row);
        }
        if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
    });
}

function releaseSimilarRow(row) {
    for (const image of row.querySelectorAll('img')) state.historyThumbnailObserver?.unobserve(image);
    row.remove();
}

// An open group whose id is gone reopens as the group holding most of its members (plan §3.1).
function remapOpenSimilarRows(api, previousGroups, groups) {
    if (!state.similarOpenIds.size || !previousGroups?.length) return;
    const map = api.remapOpen([...state.similarOpenIds], previousGroups, groups);
    for (const oldId of [...state.similarOpenIds]) {
        const newId = map.get(oldId);
        if (newId === oldId) continue;
        state.similarOpenIds.delete(oldId);
        if (!newId) continue;
        state.similarOpenIds.add(newId);
        const row = state.similarRows.get(oldId);
        if (!row) continue;
        const target = state.similarRows.get(newId);
        if (target) {
            // Merged into a group that already has a row: open that one; the old row leaves with the diff.
            if (!target.open) target.open = true;
        } else if (!state.similarOrder.includes(newId)) {
            // Split or re-anchored: the row takes the new id, keeps its place and stays open.
            state.similarRows.delete(oldId);
            state.similarRows.set(newId, row);
            row.dataset.groupId = newId;
            state.similarOrder = state.similarOrder.map(id => (id === oldId ? newId : id));
        }
    }
}

function captureSimilarAnchor() {
    const host = el.historyImages;
    const anchor = { scrollTop: host.scrollTop };
    if (!(host.scrollTop > 0) || typeof host.getBoundingClientRect !== 'function') return anchor;
    const top = host.getBoundingClientRect().top;
    for (const row of state.similarDom.rows.children) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > top) return { ...anchor, row, offset: rect.top };
    }
    return anchor;
}

function restoreSimilarAnchor(anchor) {
    if (!anchor) return;
    const host = el.historyImages;
    const target = anchor.row?.isConnected
        ? anchor.scrollTop + (anchor.row.getBoundingClientRect().top - anchor.offset)
        : anchor.scrollTop;
    if (Math.abs(host.scrollTop - target) >= 1) host.scrollTop = target;
}

function renderSimilarPill() {
    const pill = state.similarDom.pill;
    const count = state.similarDeferred.length;
    pill.hidden = count === 0;
    setElementText(pill, count ? `${count} 个新分组 · 查看` : '');
}

function showDeferredSimilarGroups() {
    state.similarDeferred = [];
    applySimilarProjection({ reorder: true });
    el.historyImages.scrollTop = 0;
}

function similarEmptyText() {
    if (state.similarGroups.length) return '';
    const snapshot = state.similarSnapshot;
    if (!snapshot) return '正在整理相似图片…';
    if (!state.recentImages.length) return '暂无历史图片';
    if (!state.similarVisibleTotal) return '没有匹配的图片';
    if (snapshot.stage !== 'final') return '正在分析相似图片，分组稍后出现';
    return '没有找到相似的图片';
}

function showSimilarEmpty(text) {
    const empty = state.similarDom?.empty;
    if (!empty) return;
    empty.hidden = !text;
    setElementText(empty, text || '');
}

function createSimilarGroupRow(group) {
    const make = (tag, className) => {
        const node = document.createElement(tag);
        node.className = className;
        return node;
    };
    const row = make('details', 'similar-group');
    row.dataset.groupId = group.id;
    const summary = document.createElement('summary');
    const head = make('div', 'similar-group-head');
    const title = make('span', 'similar-group-title');
    // How many members were dragged out or used as a reference (kept by default when deleting a selection).
    const used = make('span', 'similar-group-used');
    used.hidden = true;
    used.innerHTML = HISTORY_USAGE_ICON;
    used.appendChild(document.createElement('b'));
    const count = make('span', 'similar-group-count');
    const time = make('span', 'similar-group-time');
    head.append(title, used, count, time);
    const meta = make('div', 'similar-group-meta');
    const strip = make('div', 'similar-strip');
    summary.append(head, meta, strip);
    row.append(summary);
    row._similar = { head, title, used, count, time, meta, strip, body: null, stripKey: '', bodyKey: '', shown: SIMILAR_GROUP_PAGE };
    row.addEventListener('toggle', () => handleSimilarRowToggle(row));
    patchSimilarGroupRow(row, group);
    if (state.similarOpenIds.has(group.id)) {
        row.open = true;
        renderSimilarGroupBody(row);
    }
    return row;
}

// Writes only what changed, so a revision with the same content touches nothing.
function patchSimilarGroupRow(row, group) {
    const parts = row._similar;
    row._similarGroup = group;
    if (row.dataset.groupId !== group.id) row.dataset.groupId = group.id;
    const cover = similarCoverRecord(group);
    const prompt = String(cover?.prompt || '').trim();
    const titleText = prompt ? prompt.replace(/\s+/g, ' ').slice(0, 160) : `无提示词 · ${cover?.model || '未知模型'}`;
    setElementText(parts.title, titleText);
    setSimilarProperty(parts.title, 'title', prompt ? prompt.slice(0, 600) : titleText);
    const usedCount = Number(group.usedCount) || 0;
    if (parts.used.hidden !== !usedCount) parts.used.hidden = !usedCount;
    setElementText(parts.used.querySelector('b'), String(usedCount));
    setSimilarProperty(parts.used, 'title', usedCount ? `本组 ${usedCount} 张被拖出、复制、另存或用作参考图，批量删除时默认保留` : '');
    setElementText(parts.count, `${group.members.length} 张`);
    setSimilarProperty(parts.count, 'title', group.hiddenCount ? `另有 ${group.hiddenCount} 张被筛选隐藏` : `本组 ${group.members.length} 张`);
    setElementText(parts.time, formatHistoryRelativeDate(group.latestAt));
    setElementText(parts.meta, similarGroupMeta(group));
    if (row.hasAttribute('data-provisional') !== group.provisional) row.toggleAttribute('data-provisional', group.provisional);
    renderSimilarStrip(row, group);
    if (parts.body) syncSimilarGroupMembers(row);
}

function setSimilarProperty(node, name, value) {
    if (node[name] !== value) node[name] = value;
}

function similarCoverRecord(group) {
    return group.members.find(member => historyImageKey(member) === group.cover) || group.members[0] || null;
}

// The optional meta line ("16:9 · 1:1 · 3 个提示词"): empty, and hidden, for a plain group, which keeps
// the collapsed row at ~116 px (a ~124 px pitch).
function similarGroupMeta(group) {
    const parts = [];
    if (group.ratios.length > 1) parts.push(group.ratios.slice(0, 3).join(' · ') + (group.ratios.length > 3 ? ' …' : ''));
    if (group.promptVariants > 1) parts.push(`${group.promptVariants} 个提示词`);
    if (group.parts) parts.push(`${group.parts.length} 个子组`);
    if (group.provisional) parts.push('暂按提示词分组');
    return parts.join(' · ');
}

// Five ~68 px cells, starting with the cover: 5 thumbnails, or 4 plus "+N".
function renderSimilarStrip(row, group) {
    const parts = row._similar;
    const cover = group.coverVisible ? similarCoverRecord(group) : null;
    const ordered = cover ? [cover, ...group.members.filter(member => member !== cover)] : group.members;
    const overflow = ordered.length > SIMILAR_STRIP_CELLS ? ordered.length - (SIMILAR_STRIP_CELLS - 1) : 0;
    const shown = ordered.slice(0, overflow ? SIMILAR_STRIP_CELLS - 1 : SIMILAR_STRIP_CELLS);
    const key = shown.map(historyImageKey).join('\n') + (overflow ? `\n+${overflow}` : '');
    if (key === parts.stripKey) return;
    parts.stripKey = key;
    const reuse = new Map();
    for (const cell of parts.strip.children) if (cell._similarKey) reuse.set(cell._similarKey, cell);
    const cells = shown.map(image => reuse.get(historyImageKey(image)) || createSimilarStripCell(image));
    if (overflow) {
        const more = document.createElement('span');
        more.className = 'similar-strip-more';
        more.textContent = `+${overflow}`;
        cells.push(more);
    }
    syncSimilarChildren(parts.strip, cells, node => {
        const image = node.querySelector('img');
        if (image) state.historyThumbnailObserver?.unobserve(image);
    });
}

function createSimilarStripCell(image) {
    const cell = document.createElement('span');
    cell.className = 'similar-strip-cell';
    cell._similarKey = historyImageKey(image);
    const preview = document.createElement('img');
    preview.alt = '';
    preview.decoding = 'async';
    preview.draggable = false;
    // Strip cells may only load bounded thumbnail files, including on error.
    preview._thumbnailOnly = true;
    attachHistoryThumbnail(image, preview);
    cell.append(preview);
    // 右键：统一图片菜单（在 .similar-group 里，设为封面 / 移出此组可用）。格子按 key 复用，右键时再取最新记录
    cell.addEventListener('contextmenu', event => showImageContextMenu(liveHistoryRecord(image), event));
    return cell;
}

// Places `nodes` as the exact children of `parent`, moving only what is out of place.
function syncSimilarChildren(parent, nodes, onRemove = null) {
    const keep = new Set(nodes);
    for (const child of [...parent.children]) {
        if (keep.has(child)) continue;
        onRemove?.(child);
        child.remove();
    }
    nodes.forEach((node, index) => {
        if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
    });
}

function handleSimilarRowToggle(row) {
    const id = row.dataset.groupId;
    if (row.open) {
        state.similarOpenIds.add(id);
        renderSimilarGroupBody(row);
    } else {
        state.similarOpenIds.delete(id);
    }
}

function renderSimilarGroupBody(row) {
    const parts = row._similar;
    if (!parts.body) {
        const body = document.createElement('div');
        body.className = 'similar-group-body';
        const actions = document.createElement('div');
        actions.className = 'similar-group-actions';
        for (const [action, label, title] of SIMILAR_GROUP_ACTIONS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'similar-action';
            button.dataset.action = action;
            button.textContent = label;
            button.title = title;
            button.addEventListener('click', () => runSimilarGroupAction(row, action));
            actions.append(button);
        }
        const content = document.createElement('div');
        content.className = 'similar-group-content';
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'similar-action similar-more';
        more.hidden = true;
        more.addEventListener('click', () => {
            parts.shown += SIMILAR_GROUP_PAGE;
            syncSimilarGroupMembers(row);
        });
        body.append(actions, content, more);
        row.append(body);
        Object.assign(parts, { body, actions, content, more });
    }
    syncSimilarGroupMembers(row);
}

// Members render with createHistoryItem (selection, drag, hover preview, context menu and the drawer
// keep working), 24 at a time, in "子组 n · k 张" sections plus "其余" when the group has parts.
function syncSimilarGroupMembers(row) {
    const group = row._similarGroup;
    const parts = row._similar;
    const sections = group.parts
        ? [...group.parts.map((members, index) => ({ label: `子组 ${index + 1} · ${members.length} 张`, members })),
            ...(group.rest.length ? [{ label: `其余 · ${group.rest.length} 张`, members: group.rest }] : [])]
        : [{ label: '', members: group.members }];
    const total = sections.reduce((sum, section) => sum + section.members.length, 0);
    let budget = Math.min(total, Math.max(SIMILAR_GROUP_PAGE, parts.shown));
    const plan = [];
    for (const section of sections) {
        if (budget <= 0) break;
        const members = section.members.slice(0, budget);
        budget -= members.length;
        plan.push({ label: section.label, members });
    }
    const shownCount = plan.reduce((sum, section) => sum + section.members.length, 0);
    const key = plan.map(section => `${section.label}:${section.members.map(historyImageKey).join(',')}`).join('|');
    if (key !== parts.bodyKey) {
        parts.bodyKey = key;
        const reuse = new Map([...parts.content.querySelectorAll('.history-item')].map(item => [item.dataset.historyId, item]));
        const existing = [...parts.content.children];
        const nodes = plan.map((section, index) => {
            const node = existing[index] || createSimilarSection();
            setElementText(node._title, section.label);
            node._title.hidden = !section.label;
            syncSimilarChildren(node._grid, section.members.map(image => reuse.get(historyImageKey(image)) || createHistoryItem(image)));
            return node;
        });
        syncSimilarChildren(parts.content, nodes);
        updateHistorySelectionUi();
    }
    parts.more.hidden = shownCount >= total;
    setElementText(parts.more, shownCount < total ? `展开更多（还有 ${total - shownCount} 张）` : '');
}

function createSimilarSection() {
    const section = document.createElement('section');
    section.className = 'similar-part';
    const title = document.createElement('h4');
    title.className = 'similar-part-title';
    const grid = document.createElement('div');
    grid.className = 'similar-group-grid';
    section.append(title, grid);
    section._title = title;
    section._grid = grid;
    return section;
}

function runSimilarGroupAction(row, action) {
    const group = row._similarGroup;
    if (!group) return;
    if (action === 'select') {
        for (const member of group.members) state.historySelectedIds.add(historyImageKey(member));
        updateHistorySelectionUi();
    } else if (action === 'find') {
        openFindSimilar(similarCoverRecord(group));
    } else if (action === 'collapse') {
        row.open = false;
        state.similarOpenIds.delete(group.id);
        row.scrollIntoView?.({ block: 'nearest' });
    }
}

function renderSimilarSingles() {
    const dom = state.similarDom;
    if (!dom) return;
    const singles = state.similarSingles;
    const complete = state.similarRendered >= state.similarOrder.length;
    dom.footer.hidden = !singles.length || !complete;
    setElementText(dom.footerText, state.showSingles ? `单张 ${similarNumber(singles.length)} 张 ·` : `另有 ${similarNumber(singles.length)} 张没有相似图片 ·`);
    setElementText(dom.footerButton, state.showSingles ? '隐藏' : '显示');
    const show = state.showSingles && complete && singles.length > 0;
    dom.singles.hidden = !show;
    if (!show) {
        if (dom.singles.children.length) syncSimilarChildren(dom.singles, []);
        state.similarSinglesRendered = 0;
        return;
    }
    const count = Math.min(singles.length, Math.max(SIMILAR_SINGLES_PAGE, state.similarSinglesRendered));
    state.similarSinglesRendered = count;
    const reuse = new Map([...dom.singles.children].map(item => [item.dataset.historyId, item]));
    syncSimilarChildren(dom.singles, singles.slice(0, count).map(image => reuse.get(historyImageKey(image)) || createHistoryItem(image)));
}

function appendSimilarPage() {
    const dom = state.similarDom;
    if (!dom || state.similarFind || state.historyLayout !== 'similar' || state.activeView !== 'history') return;
    if (state.similarRendered < state.similarOrder.length) {
        state.similarRendered = Math.min(state.similarOrder.length, state.similarRendered + SIMILAR_PAGE_ROWS);
        syncSimilarRowsDom(new Map(state.similarGroups.map(group => [group.id, group])));
        renderSimilarSingles();
    } else if (state.showSingles && state.similarSinglesRendered < state.similarSingles.length) {
        state.similarSinglesRendered += SIMILAR_SINGLES_PAGE;
        renderSimilarSingles();
    } else return;
    updateHistorySelectionUi();
    // Re-arm the sentinel: it fires again if it is still inside the margin after this page.
    const observer = state.similarPagerObserver;
    if (observer) {
        observer.unobserve(dom.sentinel);
        observer.observe(dom.sentinel);
    }
}

function updateSimilarStatus() {
    const snapshot = state.similarSnapshot;
    const error = state.similarError || snapshot?.error || '';
    let text;
    if (!snapshot) text = error ? `相似分析出错（${error}）` : '正在整理相似图片…';
    else if (snapshot.stage === 'final') {
        text = `${similarNumber(state.similarGroups.length)} 组 · ${similarNumber(state.similarGrouped)} 张`;
        if (state.similarSingles.length) text += ` · 另有 ${similarNumber(state.similarSingles.length)} 张单张`;
        if (error) text += `（${error}）`;
    } else if (error) text = `相似分析出错，已按提示词分组（${error}）`;
    else text = `分析中 ${similarNumber(snapshot.analyzed)}/${similarNumber(snapshot.total)} · 未分析的图片暂按提示词分组`;
    const basic = snapshot?.mode === 'h';
    if (basic) text += ' · 基础模式';
    const status = el.historySimilarStatus;
    if (status) {
        setElementText(status, text);
        setSimilarProperty(status, 'title', basic
            ? `视觉模型未加载：${SIMILAR_MODE_REASONS[snapshot.modeReason] || snapshot.modeReason || '原因未知'}`
            : text);
    }
    const progress = el.historySimilarProgress;
    if (progress) {
        const total = Number(snapshot?.total) || 0;
        const done = Math.min(total, (Number(snapshot?.analyzed) || 0) + (Number(snapshot?.failed) || 0));
        progress.hidden = !snapshot || snapshot.stage === 'final' || !total;
        progress.style.setProperty?.('--p', `${total ? Math.round(done / total * 100) : 0}%`);
    }
    if (el.historyCount && state.historyLayout === 'similar' && !state.similarFind && state.similarDom) {
        setElementText(el.historyCount, `${similarNumber(state.similarVisibleTotal)} 张 · ${similarNumber(state.similarGroups.length)} 组相似`);
    }
}

// --- 查找相似: a transient results view over #historyImages; ✕ restores the layout and scroll. -----
// 参考图卡按文件名找回历史记录（从历史发出的卡片沿用历史文件名）；回收站 / 反推图没有可查的记录。
// 从全屏预览发起时先关预览，否则遮罩会盖在结果上。
async function findSimilarFromContext() {
    const target = takeImageContextTarget();
    if (!target) return;
    let record = target.kind === 'history' ? target.record : null;
    if (target.kind === 'reference') {
        await ensureFullHistoryLoaded().catch(() => {});
        record = historyRecordForReference(target.reference);
    }
    if (!record) {
        showToast('只能为历史图片查找相似图片');
        return;
    }
    closeHistoryPreview();
    openFindSimilar(record);
}

function openFindSimilar(image) {
    const key = historyImageKey(image);
    if (!key) return;
    hideImageHoverPreview();
    const previous = state.similarFind;
    const returnScroll = previous ? previous.returnScroll : (state.activeView === 'history' ? el.historyImages.scrollTop : 0);
    releaseFindSimilarPreview(previous);
    state.similarFind = {
        key, image, returnScroll,
        // An outside image's picture-only search does not carry its toggles over.
        samePromptOnly: (!previous?.external && previous?.samePromptOnly) || false,
        visual: (!previous?.external && previous?.visual) || false,
        loading: true, result: null, seq: 0, dom: null, nodes: new Map()
    };
    if (state.activeView !== 'history') showHistoryView();
    renderHistoryImages();
    void loadFindSimilarResults();
}

// 以图搜图: an image from outside the library (picked, dropped on the search box or pasted into it) is
// compared by picture only; the results reuse the 查找相似 view. Nothing about the image is kept.
const IMAGE_SEARCH_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/tiff']);
const IMAGE_SEARCH_NAME = /\.(?:png|jpe?g|webp|gif|avif|tiff?)$/i;

function bindHistoryImageSearch() {
    el.historyImageSearchBtn?.addEventListener('click', event => {
        event.preventDefault();
        el.historyImageSearchInput?.click();
    });
    el.historyImageSearchInput?.addEventListener('change', () => {
        const [file] = getImageFilesFromList(el.historyImageSearchInput.files);
        el.historyImageSearchInput.value = '';
        if (file) openFindSimilarByImageFile(file);
    });
    const box = el.historySearchInput?.closest('.history-search');
    if (!box) return;
    const accepts = event => hasDraggedImage(event.dataTransfer) && !state.draggedReferenceCard;
    for (const type of ['dragenter', 'dragover']) {
        box.addEventListener(type, event => {
            if (!accepts(event)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            box.classList.add('image-drop-active');
        });
    }
    box.addEventListener('dragleave', event => {
        if (!box.contains(event.relatedTarget)) box.classList.remove('image-drop-active');
    });
    box.addEventListener('drop', event => {
        box.classList.remove('image-drop-active');
        const [file] = extractDroppedImageFiles(event);
        if (!file) return;
        event.preventDefault();
        event.stopPropagation();
        openFindSimilarByImageFile(file);
    });
    // Ctrl+V of an image searches by it; text pastes as usual. Office copies put a bitmap of the text
    // beside it, so any text on the clipboard wins.
    el.historySearchInput.addEventListener('paste', event => {
        if (event.clipboardData?.getData('text/plain')?.trim()) return;
        const [file] = getImageFilesFromList(event.clipboardData?.files);
        if (!file) return;
        event.preventDefault();
        openFindSimilarByImageFile(file);
    });
}

function sameHistoryFilePath(left, right) {
    const key = value => String(value || '').replace(/[\\/]+/g, '\\').toLowerCase();
    return !!left && key(left) === key(right);
}

function openFindSimilarByImageFile(file) {
    if (!file) return;
    if (!IMAGE_SEARCH_TYPES.has(String(file.type || '').toLowerCase()) && !IMAGE_SEARCH_NAME.test(file.name || '')) {
        showToast('以图搜图只支持 PNG、JPG、WebP、GIF、AVIF、TIFF 图片');
        return;
    }
    const filePath = getFilePathFromDropFile(file);
    // An image that is already in the library gets the regular 查找相似 (picture + prompt).
    const known = filePath ? state.recentImages.find(image => sameHistoryFilePath(image.filePath, filePath)) : null;
    if (known) {
        openFindSimilar(known);
        return;
    }
    hideImageHoverPreview();
    const previous = state.similarFind;
    const returnScroll = previous ? previous.returnScroll : (state.activeView === 'history' ? el.historyImages.scrollTop : 0);
    releaseFindSimilarPreview(previous);
    state.similarFind = {
        key: '', image: null, returnScroll,
        external: { file, filePath, name: file.name || '粘贴的图片', previewUrl: URL.createObjectURL(file) },
        // 包含相同元素 by default: a product shot should find the scenes it was placed in.
        match: previous?.external ? previous.match : 'element',
        samePromptOnly: false, visual: true,
        loading: true, result: null, seq: 0, dom: null, nodes: new Map()
    };
    if (state.activeView !== 'history') showHistoryView();
    renderHistoryImages();
    void loadFindSimilarResults();
}

function releaseFindSimilarPreview(find) {
    if (find?.external?.previewUrl) URL.revokeObjectURL(find.external.previewUrl);
}

function imageSearchErrorText(error) {
    return String(error?.message || error || '未知错误').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function closeFindSimilar(options = {}) {
    const find = state.similarFind;
    if (!find) return;
    state.similarFind = null;
    releaseFindSimilarPreview(find);
    const parked = state.similarParked;
    state.similarParked = null;
    if (parked && state.similarDom && !options.discard && state.historyLayout === 'similar') {
        unparkSimilarList(find, parked, options);
        return;
    }
    // The host holds the results; the next render rebuilds the layout underneath.
    state.historyHostMode = null;
    state.historyDirty = true;
    if (options.render === false) return;
    renderHistoryImages();
    restoreHistoryScroll(find.returnScroll);
}

// Results over the similar list: the list is parked (hidden, rows and open groups intact) instead of
// cleared, so ✕ shows the very same rows at the very same scroll position. Anywhere else the host is
// cleared as before; a second 查找相似 replaces only the previous results.
function enterFindHost() {
    const host = el.historyImages;
    if (state.historyHostMode === 'find') {
        removeFindSimilarViews();
        return;
    }
    const dom = state.similarDom;
    if (state.historyHostMode === 'similar' && dom?.root) {
        state.similarParked = { scrollTop: host.scrollTop };
        dom.root.hidden = true;
        host.classList.remove('similar-layout');
        host.classList.add('find-similar-layout');
        state.historyHostMode = 'find';
        host.scrollTop = 0;
        return;
    }
    enterSimilarHost('find', true);
}

function removeFindSimilarViews() {
    for (const node of [...el.historyImages.children]) {
        if (!node.classList?.contains('similar-find-view')) continue;
        for (const image of node.querySelectorAll('img')) state.historyThumbnailObserver?.unobserve(image);
        node.remove();
    }
}

function unparkSimilarList(find, parked, options) {
    const host = el.historyImages;
    removeFindSimilarViews();
    state.similarDom.root.hidden = false;
    host.classList.remove('find-similar-layout');
    host.classList.add('similar-layout');
    state.historyHostMode = 'similar';
    syncSimilarToolbar();
    if (options.render === false) {
        state.historyDirty = true;
        return;
    }
    host.scrollTop = parked.scrollTop;
    // A push or a filter change while the results were up patches the rows in place, keeping the anchor.
    renderSimilarHistory({ reorder: false });
}

function restoreHistoryScroll(top) {
    const host = el.historyImages;
    if (!(top > 0)) return;
    if (state.historyLayout !== 'similar') {
        const images = getFilteredHistoryImages();
        for (let guard = 0; guard < 50 && host.scrollHeight < top + host.clientHeight && state.historyRenderedCount < images.length; guard++) {
            appendHistoryImages(images);
        }
    }
    host.scrollTop = top;
}

async function loadFindSimilarResults() {
    const find = state.similarFind;
    if (!find) return;
    const external = find.external;
    const request = external ? window.picgenDesktop?.getSimilarNeighborsOfImage : window.picgenDesktop?.getSimilarNeighbors;
    const seq = ++find.seq;
    find.loading = true;
    renderFindSimilarView();
    let result;
    if (typeof request !== 'function') result = { items: [], analyzed: false, error: '当前版本不支持查找相似图片' };
    else {
        try {
            if (external) {
                // Main checks a path by its extension; anything else (.jfif, a browser drag) goes as bytes.
                const source = external.filePath && IMAGE_SEARCH_NAME.test(external.filePath)
                    ? { filePath: external.filePath }
                    : { bytes: await external.file.arrayBuffer(), mimeType: external.file.type };
                result = await request({ ...source, limit: SIMILAR_NEIGHBOR_LIMIT, match: find.match || 'whole' });
            } else {
                result = await request({ key: find.key, preset: state.similarPreset, limit: SIMILAR_NEIGHBOR_LIMIT,
                    mode: find.visual ? 'visual' : 'combined', samePromptOnly: find.samePromptOnly });
            }
        } catch (error) {
            result = { items: [], analyzed: false, error: imageSearchErrorText(error) };
        }
    }
    if (state.similarFind !== find || find.seq !== seq) return;
    find.loading = false;
    find.result = result && Array.isArray(result.items) ? result : { items: [], analyzed: false };
    renderFindSimilarView();
}

function renderFindSimilarView() {
    const find = state.similarFind;
    if (!find || !el.historyImages) return;
    state.historyDirty = false;
    syncSimilarToolbar();
    if (state.historyHostMode !== 'find' || !find.dom) {
        enterFindHost();
        find.dom = buildFindSimilarScaffold(find);
    }
    const dom = find.dom;
    // Filters apply to the results too; images no longer in history are skipped.
    const visible = new Map(getFilteredHistoryImages().map(image => [historyImageKey(image), image]));
    const items = (find.result?.items || []).filter(item => item.key !== find.key && visible.has(item.key));
    setElementText(dom.title, find.loading && !find.result ? '正在查找相似图片…' : `与此图相似 · ${items.length} 张`);
    for (const [button, on] of [[dom.samePrompt, find.samePromptOnly], [dom.visual, find.visual]]) {
        button.setAttribute('aria-pressed', String(on));
        button.classList.toggle('active', on);
    }
    const result = find.result;
    let note = '';
    if (result?.error) note = `查找失败：${result.error}`;
    else if (result && !result.analyzed) note = find.external ? '相似分析暂不可用，请稍后再试' : '这张图还没分析完，暂时只列出同提示词的图片';
    else if (result && !items.length) note = find.samePromptOnly ? '没有同提示词的相似图片' : '没有找到相似的图片';
    if (result?.mode === 'h' && !result.error) {
        const basic = find.external ? '基础模式：按颜色和构图比较' : '基础模式：按提示词和颜色比较';
        note = note ? `${note} · 基础模式` : basic;
    }
    if (find.external && find.match === 'element' && result && !result.error && result.mode !== 'h') {
        if (result.element === false) note = note ? `${note} · 局部比对暂不可用，已按整图比较` : '局部比对暂不可用，已按整图比较';
        else if (result.element && result.indexed > result.cropped) {
            const progress = `局部特征分析中（${similarNumber(result.cropped)} / ${similarNumber(result.indexed)} 张），结果可能不全`;
            note = note ? `${note} · ${progress}` : progress;
        }
    }
    if (dom.element) {
        for (const [button, value] of [[dom.element, 'element'], [dom.whole, 'whole']]) {
            const on = find.match === value;
            button.setAttribute('aria-pressed', String(on));
            button.classList.toggle('active', on);
        }
    }
    setElementText(dom.note, note);
    dom.note.hidden = !note;
    syncSimilarChildren(dom.grid, items.map(item => findSimilarResultItem(find, visible.get(item.key), item)));
    if (el.historyCount) setElementText(el.historyCount, `${similarNumber(items.length)} 张相似`);
    updateHistorySelectionUi();
}

function buildFindSimilarScaffold(find) {
    const make = (tag, className, text = '') => {
        const node = document.createElement(tag);
        node.className = className;
        if (text) node.textContent = text;
        return node;
    };
    const head = make('div', 'similar-find-head');
    const thumb = make('img', 'similar-find-thumb');
    thumb.alt = '';
    thumb.draggable = false;
    thumb._thumbnailOnly = true;
    if (find.external) {
        thumb.src = find.external.previewUrl;
    } else {
        attachHistoryThumbnail(find.image, thumb, { eager: true });
        thumb.addEventListener('contextmenu', event => showImageContextMenu(liveHistoryRecord(find.image), event));
    }
    const title = make('span', 'similar-find-title');
    const samePrompt = make('button', 'similar-toggle', '仅同提示词');
    samePrompt.type = 'button';
    samePrompt.title = '只列出提示词相同的图片';
    const visual = make('button', 'similar-toggle', '只比画面');
    visual.type = 'button';
    visual.title = '忽略提示词，只按画面比较';
    const close = make('button', 'similar-find-close', '✕');
    close.type = 'button';
    close.title = '关闭相似结果';
    close.setAttribute('aria-label', '关闭相似结果');
    // An outside image has no prompt: it is always compared by picture only, either for a shared element
    // (the subject against every part of each image) or as a whole picture.
    samePrompt.hidden = visual.hidden = !!find.external;
    let element = null;
    let whole = null;
    if (find.external) {
        element = make('button', 'similar-toggle', '包含相同元素');
        element.type = 'button';
        element.title = '找出画面里出现这件商品或元素的图片（适合白底商品图找场景图）';
        whole = make('button', 'similar-toggle', '整图相似');
        whole.type = 'button';
        whole.title = '按整张画面的构图和风格比较';
        for (const [button, value] of [[element, 'element'], [whole, 'whole']]) {
            button.dataset.match = value;
            button.addEventListener('click', () => {
                if (find.match === value) return;
                find.match = value;
                void loadFindSimilarResults();
            });
        }
    }
    head.append(thumb, title, ...(find.external ? [element, whole] : [samePrompt, visual]), close);
    const note = make('p', 'similar-find-note');
    note.hidden = true;
    const grid = make('div', 'similar-group-grid similar-find-grid');
    samePrompt.addEventListener('click', () => {
        find.samePromptOnly = !find.samePromptOnly;
        void loadFindSimilarResults();
    });
    visual.addEventListener('click', () => {
        find.visual = !find.visual;
        void loadFindSimilarResults();
    });
    close.addEventListener('click', () => closeFindSimilar());
    const root = make('div', 'similar-find-view');
    root.append(head, note, grid);
    el.historyImages.append(root);
    return { root, head, thumb, title, samePrompt, visual, element, whole, close, note, grid };
}

function findSimilarResultItem(find, image, item) {
    let node = find.nodes.get(item.key);
    if (!node) {
        node = createHistoryItem(image);
        const score = document.createElement('span');
        score.className = 'similar-score';
        node.querySelector('.history-thumb')?.append(score);
        const chips = document.createElement('span');
        chips.className = 'similar-chips';
        node.querySelector('.history-item-copy')?.append(chips);
        node._similarScore = score;
        node._similarChips = chips;
        node._similarChipKey = '';
        find.nodes.set(item.key, node);
    }
    const scored = typeof item.similarity === 'number' && Number.isFinite(item.similarity);
    setElementText(node._similarScore, scored ? `${item.similarity}%` : '');
    node._similarScore.hidden = !scored;
    const labels = [item.samePrompt ? '同提示词' : item.nearPrompt ? '近似提示词' : '', item.sameGroup ? '本组' : ''].filter(Boolean);
    const chipKey = labels.join('|');
    if (chipKey !== node._similarChipKey) {
        node._similarChipKey = chipKey;
        syncSimilarChildren(node._similarChips, labels.map(label => {
            const chip = document.createElement('span');
            chip.className = 'similar-chip';
            chip.textContent = label;
            return chip;
        }));
    }
    return node;
}

// 设为封面 / 移出此组 (Phase C2) act on the group the image was right-clicked in.
async function applySimilarOverrideFromContext(op) {
    const target = takeImageContextTarget();
    const image = target?.record;
    const groupId = target?.groupId;
    if (!image || !groupId || typeof window.picgenDesktop?.setSimilarityOverride !== 'function') return;
    try {
        await window.picgenDesktop.setSimilarityOverride({ op, key: historyImageKey(image), groupId, preset: state.similarPreset });
        showToast(op === 'setCover' ? '已设为本组封面' : '已移出此组，之后不会再和本组合并');
        if (similarViewVisible()) await fetchSimilarSnapshot({ reorder: false, force: true });
        else state.similarStale = true;
    } catch (error) {
        showToast(`调整相似分组失败：${error.message}`, 'error');
    }
}

// --- The Recycle-Bin trash (v3.1 WP12, usage design §6.4) -----------------------------------------
// Deleting a selection always goes through 移到回收站 → the in-app confirm dialog → main's trash IPC
// (Recycle Bin + tombstones); selection works the same in every layout.
const HISTORY_TRASH_RESULT_HIDE_MS = 15000;

let historyRecordsCache = null;
function historyRecordsByKey() {
    const images = state.recentImages;
    const cache = historyRecordsCache;
    if (cache && cache.images === images && cache.length === images.length && cache.revision === state.historyRevision) return cache.map;
    const map = new Map(images.map(image => [historyImageKey(image), image]));
    historyRecordsCache = { images, length: images.length, revision: state.historyRevision, map };
    return map;
}

// What 移到回收站 would do with the current selection. Protected images go only with the switch on.
function historyTrashPlan() {
    const records = historyRecordsByKey();
    const selected = [...state.historySelectedIds].map(id => records.get(id)).filter(record => record?.filePath);
    const protectedSelected = selected.filter(record => historyUsageTotal(record) > 0);
    const items = state.historyTrashIncludeProtected ? selected : selected.filter(record => historyUsageTotal(record) <= 0);
    return { selected, protectedSelected, items, keptProtected: selected.length - items.length };
}

function syncHistoryTrashControls() {
    const plan = historyTrashPlan();
    const count = state.historySelectedIds.size;
    const used = plan.protectedSelected.length;
    if (el.historyTrashProtectedToggle && el.historyTrashProtectedToggle.hidden !== !used) el.historyTrashProtectedToggle.hidden = !used;
    setElementText(el.historyTrashProtectedText, `同时删除拖用过的 (${used})`);
    if (el.historyTrashIncludeProtected && el.historyTrashIncludeProtected.checked !== state.historyTrashIncludeProtected) {
        el.historyTrashIncludeProtected.checked = state.historyTrashIncludeProtected;
    }
    let meta;
    if (used) {
        meta = `已选择 ${count} 张（含 ${used} 张拖用过，${state.historyTrashIncludeProtected ? '将一并删除' : '默认保留'}）`;
    } else meta = `已选择 ${count} 张`;
    setElementText(el.historySelectionMeta, meta);
    const progress = state.historyTrashProgress;
    const label = state.historyTrashBusy
        ? `正在移到回收站${progress?.total ? ` ${progress.done}/${progress.total}` : ''}…`
        : `移到回收站 (${plan.items.length})`;
    if (el.historyTrashBtn) {
        setElementText(el.historyTrashBtn.querySelector('span') || el.historyTrashBtn, label);
        const disabled = state.historyTrashBusy || plan.items.length === 0;
        if (el.historyTrashBtn.disabled !== disabled) el.historyTrashBtn.disabled = disabled;
    }
}

// askConfirm resolves true when no dialog exists; deleting must never happen without one.
function askConfirmStrict(message, options = {}) {
    if (typeof window.PicGenAppica?.confirm === 'function') return window.PicGenAppica.confirm(message, options);
    if (!document.getElementById?.('confirmOverlay')) return Promise.resolve(false);
    return askConfirm(message, options);
}

async function confirmTrash() {
    if (state.historyTrashBusy) return;
    const plan = historyTrashPlan();
    if (!plan.items.length) {
        if (plan.selected.length) showToast('选中的图片都拖用过，默认保留；要删除请勾选「同时删除拖用过的」');
        return;
    }
    state.historyTrashBusy = true;
    try {
        const included = plan.items.filter(record => historyUsageTotal(record) > 0);
        const facts = {
            count: plan.items.length,
            bytes: plan.items.reduce((sum, record) => sum + (Number(record.fileSize) || 0), 0),
            keptProtected: plan.keptProtected,
            includedProtected: included.length
        };
        const api = historyUsageApi();
        const message = api?.buildTrashConfirmText ? api.buildTrashConfirmText(facts) : `将 ${facts.count} 张图片移到回收站。`;
        const confirmed = await askConfirmStrict(message, { title: '移到回收站', okText: '移到回收站', danger: true });
        if (!confirmed) return;
        await runHistoryTrash(plan.items.map(record => ({ id: record.id || historyImageKey(record), filePath: record.filePath })), {
            includeProtected: included.length > 0,
            confirmProtected: included.map(record => record.id || historyImageKey(record)),
            reason: 'selection'
        });
    } finally {
        state.historyTrashBusy = false;
        updateHistorySelectionUi();
    }
}

// 重试 resends only the failed items of the last result, with the same confirmation context.
async function retryHistoryTrash() {
    const retry = state.historyTrashRetry;
    if (!retry?.items.length || state.historyTrashBusy) return;
    state.historyTrashBusy = true;
    try {
        await runHistoryTrash(retry.items, retry.context);
    } finally {
        state.historyTrashBusy = false;
        updateHistorySelectionUi();
    }
}

async function runHistoryTrash(items, context) {
    const request = window.picgenDesktop?.trashHistoryImages;
    if (typeof request !== 'function') {
        showToast('当前版本不支持移到回收站', 'error');
        return null;
    }
    state.historyTrashProgress = { done: 0, total: items.length };
    syncHistoryTrashControls();
    let result;
    try {
        result = await request({
            requestId: `trash_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            items,
            includeProtected: !!context.includeProtected,
            confirmProtected: (context.confirmProtected || []).filter(id => items.some(item => item.id === id)),
            reason: context.reason,
            ...(context.groupId ? { groupId: context.groupId } : {})
        });
    } catch (error) {
        showToast(`移到回收站失败：${error.message}`, 'error');
        return null;
    } finally {
        state.historyTrashProgress = null;
    }
    state.historyTrashUndo = (result?.trashed || []).map(entry => entry.filePath).filter(Boolean);
    applyHistoryTrashResult(result || {}, context);
    return result;
}

function applyHistoryTrashResult(result, context) {
    const list = value => (Array.isArray(value) ? value : []);
    const trashed = list(result.trashed);
    const missing = list(result.missing);
    const failed = list(result.failed);
    const skipped = list(result.skipped);
    removeHistoryRecordsLocally([...trashed, ...missing].map(entry => entry.id));
    // Failed images are still in history and stay selected, so 重试 or another try is one click away.
    const records = historyRecordsByKey();
    for (const entry of failed) if (records.has(entry.id)) state.historySelectedIds.add(entry.id);
    state.historyTrashRetry = failed.length ? { items: failed.map(({ id, filePath }) => ({ id, filePath })), context } : null;
    // Including protected images is a per-request decision; the switch starts off again.
    state.historyTrashIncludeProtected = false;
    showHistoryTrashResult({
        trashed: trashed.length,
        missing: missing.length,
        failed: failed.length,
        protectedSkipped: skipped.filter(entry => entry.reason === 'protected').length,
        otherSkipped: skipped.filter(entry => entry.reason !== 'protected').length
    });
    updateHistorySelectionUi();
}

// Drops trashed records from the renderer at once: the strip, the gallery (grid/list reconcile, or a
// local re-projection of the similar snapshot) and the drawer. historyRemovals keeps a refresh that was
// already in flight from bringing them back.
function removeHistoryRecordsLocally(ids) {
    const removed = new Set(Array.from(ids || [], String).filter(Boolean));
    if (!removed.size) return;
    const present = state.recentImages.filter(image => removed.has(historyImageKey(image)));
    if (!present.length) return;
    state.recentImages = state.recentImages.filter(image => !removed.has(historyImageKey(image)));
    for (const id of removed) {
        state.historySelectedIds.delete(id);
        state.historyChanges.delete(id);
        state.historyRevision += 1;
        state.historyRemovals.set(id, state.historyRevision);
    }
    if (state.historyActiveImageId && removed.has(state.historyActiveImageId)) {
        state.historyActiveImageId = null;
        if (el.historyDetailDrawer) el.historyDetailDrawer.hidden = true;
        closeHistoryPreview();
    }
    state.historyDirty = true;
    renderRecentImages();
    if (state.activeView === 'history') reconcileHistoryImages();
}

function showHistoryTrashResult(summary) {
    const parts = [];
    if (summary.failed && summary.trashed) parts.push(`已移到回收站 ${summary.trashed} 张；${summary.failed} 张未能移动（无法读取文件）`);
    else if (summary.failed) parts.push(`${summary.failed} 张未能移到回收站（无法读取文件）`);
    else if (summary.trashed) parts.push(`已移到回收站 ${summary.trashed} 张。`);
    if (summary.missing) parts.push(`清除了 ${summary.missing} 条文件已不存在的记录`);
    if (summary.protectedSkipped) parts.push(`${summary.protectedSkipped} 张在确认后被使用过，已保留`);
    if (summary.otherSkipped) parts.push(`${summary.otherSkipped} 张未处理（已不在历史中或正在处理）`);
    if (!parts.length) parts.push('没有图片被移到回收站');
    setElementText(el.historyTrashResultText, parts.join(' '));
    if (el.historyTrashRetryBtn) el.historyTrashRetryBtn.hidden = !summary.failed;
    if (el.historyTrashOpenBinBtn) el.historyTrashOpenBinBtn.hidden = !summary.trashed;
    if (el.historyTrashUndoBtn) el.historyTrashUndoBtn.hidden = !(summary.trashed && state.historyTrashUndo?.length);
    if (el.historyTrashResult) el.historyTrashResult.hidden = false;
    clearTimeout(state.historyTrashResultTimer);
    state.historyTrashResultTimer = null;
    if (!summary.failed && !summary.protectedSkipped && !summary.otherSkipped) {
        state.historyTrashResultTimer = setTimeout(hideHistoryTrashResult, HISTORY_TRASH_RESULT_HIDE_MS);
        state.historyTrashResultTimer?.unref?.();
    }
}

function hideHistoryTrashResult() {
    clearTimeout(state.historyTrashResultTimer);
    state.historyTrashResultTimer = null;
    if (el.historyTrashResult) el.historyTrashResult.hidden = true;
}

function dismissHistoryTrashResult() {
    hideHistoryTrashResult();
    state.historyTrashRetry = null;
}

function openHistoryRecycleBin() {
    hideHistoryTrashResult();
    void showHistoryBinView();
}

// 撤销刚才那一批：从应用内回收站还原。
async function undoHistoryTrash() {
    const paths = state.historyTrashUndo || [];
    state.historyTrashUndo = null;
    hideHistoryTrashResult();
    if (paths.length) await restoreHistoryBin(paths, { quiet: true });
}

// Main pushes history changes it made on its own: images restored from the Recycle Bin come back
// (tombstone revival), and a trash phase that finished (possibly before the invoke resolved).
function handleHistoryChanged(change) {
    if (!change || typeof change !== 'object') return;
    const removedIds = Array.isArray(change.removedIds) ? change.removedIds : [];
    const addedIds = Array.isArray(change.addedIds) ? change.addedIds : [];
    if (removedIds.length) removeHistoryRecordsLocally(removedIds);
    if (addedIds.length || change.reason === 'revived' || change.reason === 'restored') {
        refreshRecentImages({ full: state.historyLoaded }).catch(() => {});
    }
    if (change.reason === 'revived' && addedIds.length) showToast(`已找回 ${addedIds.length} 张从回收站还原的图片`);
}

// --- In-app recycle bin --------------------------------------------------------------------------------
// Main keeps binned images out of history (files stay on disk); restore brings the records back, and
// 永久删除 / 清空 deletes the files for good. desktop.js owns #historyBinImages.
function updateHistoryBinBadge() {
    const total = Math.max(0, Number(state.historyBin.total) || 0);
    if (!el.historyBinBadge) return;
    el.historyBinBadge.hidden = total === 0;
    el.historyBinBadge.textContent = total > 99 ? '99+' : String(total);
    el.historyBinBadge.setAttribute('aria-label', `回收站 ${total} 张`);
}

function applyHistoryBinTotal(total) {
    state.historyBin.total = Math.max(0, Number(total) || 0);
    updateHistoryBinBadge();
    // The open bin re-reads its list; a closed one does so when it is next shown.
    if (state.activeView === 'bin') void refreshHistoryBin();
    else state.historyBin.loaded = false;
}

async function refreshHistoryBinCount() {
    try {
        const result = await window.picgenDesktop?.getHistoryBinCount?.();
        if (result) applyHistoryBinTotal(result.total);
    } catch (error) {
        console.warn('[HistoryBin] count failed:', error.message);
    }
}

async function showHistoryBinView() {
    if (state.historyLayout === 'similar' && state.activeView === 'history') state.historyDirty = true;
    if (state.similarFind) closeFindSimilar({ render: false });
    state.activeView = 'bin';
    hideSettingsPage();
    el.tabsBar.hidden = true;
    el.mainContentScroll.hidden = true;
    el.historyPage.hidden = true;
    el.queuePage.hidden = true;
    el.reversePromptPage.hidden = true;
    if (el.workspacePage) el.workspacePage.hidden = true;
    el.errorLogsPage.hidden = true;
    if (el.historyBinPage) el.historyBinPage.hidden = false;
    setSidebarActive(el.historyBinBtn);
    hideMentionMenu();
    hideImageHoverPreview();
    closeHistoryPreview();
    await refreshHistoryBin();
}

async function refreshHistoryBin() {
    const request = window.picgenDesktop?.listHistoryBin;
    if (typeof request !== 'function') return;
    try {
        const result = await request();
        const items = Array.isArray(result?.items) ? result.items : [];
        state.historyBin.items = items;
        state.historyBin.loaded = true;
        state.historyBin.total = Number(result?.total ?? items.length) || 0;
        const present = new Set(items.map(item => item.filePath));
        for (const filePath of [...state.historyBin.selected]) if (!present.has(filePath)) state.historyBin.selected.delete(filePath);
        updateHistoryBinBadge();
        renderHistoryBin();
    } catch (error) {
        showToast(`回收站读取失败：${error.message}`, 'error');
    }
}

function renderHistoryBin() {
    const host = el.historyBinImages;
    if (!host) return;
    const items = state.historyBin.items;
    setElementText(el.historyBinCount, `${items.length} 张`);
    host.replaceChildren();
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        const icon = document.createElement('i');
        icon.dataset.lucide = 'trash-2';
        const text = document.createElement('span');
        text.textContent = '回收站是空的';
        empty.append(icon, text);
        host.append(empty);
        refreshLucideIcons(empty);
    } else {
        const fragment = document.createDocumentFragment();
        for (const item of items) fragment.append(createHistoryBinItem(item));
        host.append(fragment);
    }
    setHistoryBinBusy(state.historyBin.busy);
}

function formatBinnedAt(time) {
    const value = Number(time) || 0;
    return value ? `删除于 ${formatHistoryRelativeDate(value)}` : '';
}

function createHistoryBinItem(image) {
    const item = document.createElement('article');
    item.className = 'history-item history-bin-item';
    item.dataset.binPath = image.filePath;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    // 说明放 aria-label 而不是 title：Windows 的系统信息提示会盖住置顶的悬浮预览窗。
    item.setAttribute('aria-label', `${image.fileName || '未命名图片'}，点击选择，可还原或永久删除`);
    const thumb = document.createElement('div');
    thumb.className = 'history-thumb';
    const preview = document.createElement('img');
    preview.alt = image.fileName || '';
    preview.loading = 'lazy';
    preview.decoding = 'async';
    attachHistoryBinThumbnail(image, preview);
    thumb.append(preview);
    renderUsageBadge(thumb, image);
    const copy = document.createElement('div');
    copy.className = 'history-item-copy';
    const fileName = document.createElement('span');
    fileName.className = 'history-file-name';
    fileName.textContent = image.fileName || '未命名图片';
    const meta = document.createElement('span');
    meta.className = 'history-item-meta';
    meta.textContent = [image.model || '', formatBinnedAt(image.binnedAt)].filter(Boolean).join(' · ');
    copy.append(fileName, meta);
    item.append(thumb, copy);
    const toggle = () => toggleHistoryBinItem(image.filePath);
    item.addEventListener('click', toggle);
    item.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
    });
    // 右键：统一图片菜单（不改选择；回收站里的图不计使用，查找相似要先还原）
    item.addEventListener('contextmenu', event => showImageContextMenu({ kind: 'bin', record: image, filePath: image.filePath,
        name: image.fileName || '图片.png', mimeType: image.mimeType || '' }, event));
    return item;
}

// The history observer is rooted at #historyImages, so bin tiles get their own lazy loader.
function attachHistoryBinThumbnail(image, element) {
    element._picgenHistoryImage = image;
    if (!('IntersectionObserver' in window) || !el.historyBinImages) {
        loadHistoryThumbnail(image, element);
        return;
    }
    if (!state.historyBinThumbnailObserver) {
        state.historyBinThumbnailObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                state.historyBinThumbnailObserver.unobserve(entry.target);
                loadHistoryThumbnail(entry.target._picgenHistoryImage, entry.target);
            }
        }, { root: el.historyBinImages, rootMargin: '400px 0px' });
    }
    state.historyBinThumbnailObserver.observe(element);
}

function toggleHistoryBinItem(filePath) {
    const selected = state.historyBin.selected;
    if (selected.has(filePath)) selected.delete(filePath);
    else selected.add(filePath);
    updateHistoryBinSelectionUi();
}

function selectAllHistoryBinItems() {
    for (const item of state.historyBin.items) state.historyBin.selected.add(item.filePath);
    updateHistoryBinSelectionUi();
}

function clearHistoryBinSelection() {
    state.historyBin.selected.clear();
    updateHistoryBinSelectionUi();
}

function updateHistoryBinSelectionUi() {
    const selected = state.historyBin.selected;
    for (const item of el.historyBinImages?.querySelectorAll('.history-bin-item') || []) {
        const on = selected.has(item.dataset.binPath);
        item.classList.toggle('selected', on);
        item.setAttribute('aria-pressed', String(on));
    }
    if (el.historyBinSelectionBar) el.historyBinSelectionBar.hidden = selected.size === 0;
    setElementText(el.historyBinSelectionMeta, `已选择 ${selected.size} 张`);
    const busy = state.historyBin.busy;
    for (const button of [el.historyBinRestoreBtn, el.historyBinDeleteBtn]) if (button) button.disabled = busy || !selected.size;
}

function setHistoryBinBusy(busy) {
    state.historyBin.busy = busy;
    const empty = !state.historyBin.items.length;
    if (el.historyBinRestoreAllBtn) el.historyBinRestoreAllBtn.disabled = busy || empty;
    if (el.historyBinEmptyBtn) el.historyBinEmptyBtn.disabled = busy || empty;
    updateHistoryBinSelectionUi();
}

// paths: file paths to restore, or null for everything in the bin.
async function restoreHistoryBin(paths, options = {}) {
    const request = window.picgenDesktop?.restoreHistoryBin;
    if (typeof request !== 'function' || state.historyBin.busy) return null;
    if (Array.isArray(paths) && !paths.length) return null;
    setHistoryBinBusy(true);
    try {
        const result = await request({ paths: Array.isArray(paths) ? paths : null });
        const restored = Array.isArray(result?.restored) ? result.restored.length : 0;
        const missing = Array.isArray(result?.missing) ? result.missing.length : 0;
        const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
        const parts = [];
        if (restored) parts.push(options.quiet ? `已撤销，${restored} 张图片回到历史` : `已还原 ${restored} 张`);
        if (missing) parts.push(`${missing} 张文件已不存在，已移出回收站`);
        if (failed) parts.push(`${failed} 张还原失败`);
        if (parts.length) showToast(parts.join('，'), failed ? 'error' : undefined);
        for (const filePath of Array.isArray(paths) ? paths : state.historyBin.items.map(item => item.filePath)) state.historyBin.selected.delete(filePath);
        state.historyDirty = true;
        return result;
    } catch (error) {
        showToast(`还原失败：${error.message}`, 'error');
        return null;
    } finally {
        setHistoryBinBusy(false);
        if (state.activeView === 'bin') await refreshHistoryBin();
    }
}

// paths: file paths to delete for good, or null to empty the bin. Always asks first.
async function purgeHistoryBin(paths) {
    const request = window.picgenDesktop?.purgeHistoryBin;
    if (typeof request !== 'function' || state.historyBin.busy) return null;
    const all = !Array.isArray(paths);
    const count = all ? state.historyBin.items.length : paths.length;
    if (!count) return null;
    const message = all
        ? `将永久删除回收站中的全部 ${count} 张图片。\n文件会从磁盘删除，无法找回。`
        : `将永久删除选中的 ${count} 张图片。\n文件会从磁盘删除，无法找回。`;
    const confirmed = await askConfirmStrict(message, { title: all ? '清空回收站' : '永久删除', okText: '永久删除', danger: true });
    if (!confirmed) return null;
    setHistoryBinBusy(true);
    try {
        const result = await request({ paths: all ? null : paths });
        const deleted = Array.isArray(result?.deleted) ? result.deleted.length : 0;
        const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
        if (failed) showToast(`已删除 ${deleted} 张，${failed} 张删除失败（文件可能被占用）`, 'error');
        else showToast(`已永久删除 ${deleted} 张`);
        for (const filePath of all ? state.historyBin.items.map(item => item.filePath) : paths) state.historyBin.selected.delete(filePath);
        return result;
    } catch (error) {
        showToast(`删除失败：${error.message}`, 'error');
        return null;
    } finally {
        setHistoryBinBusy(false);
        if (state.activeView === 'bin') await refreshHistoryBin();
    }
}

window.picgenDesktop.onHistoryBinChanged?.(change => applyHistoryBinTotal(change?.total));
void refreshHistoryBinCount();

window.picgenDesktop.onHistoryChanged?.(handleHistoryChanged);
window.picgenDesktop.onHistoryTrashProgress?.(progress => {
    if (!state.historyTrashBusy || !progress) return;
    state.historyTrashProgress = { done: Number(progress.done) || 0, total: Number(progress.total) || 0 };
    syncHistoryTrashControls();
});

function renderHistoryImages() {
    if (!el.historyImages) return;
    syncSimilarToolbar();
    renderHistoryFilterControls();
    if (state.similarFind) { renderFindSimilarView(); return; }
    if (state.historyLayout === 'similar') { renderSimilarHistory({ reorder: true }); return; }
    resetSimilarHost();
    state.historyHostMode = 'items';
    el.historyImages.classList.remove('similar-layout', 'find-similar-layout');
    state.historyDirty = false;
    const images = getFilteredHistoryImages();
    state.historyThumbnailObserver?.disconnect();
    el.historyImages.innerHTML = '';
    el.historyImages.scrollTop = 0;
    el.historyImages.classList.toggle('grid-layout', state.historyLayout === 'grid');
    el.historyImages.classList.toggle('list-layout', state.historyLayout === 'list');
    el.historyCount.textContent = images.length === state.recentImages.length
        ? `${state.recentImages.length} 张`
        : `${images.length} / ${state.recentImages.length} 张`;

    if (!images.length) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        const icon = document.createElement('i');
        icon.dataset.lucide = state.recentImages.length ? 'search-x' : 'images';
        const text = document.createElement('span');
        text.textContent = state.recentImages.length ? '没有匹配的图片' : '暂无历史图片';
        empty.append(icon, text);
        el.historyImages.appendChild(empty);
        refreshLucideIcons(el.historyImages);
        updateHistorySelectionUi();
        return;
    }

    state.historyRenderedCount = 0;
    appendHistoryImages(images);
    updateHistorySelectionUi();
}

function appendHistoryImages(filteredImages = null) {
    if (state.similarFind) return;
    // The similar view pages through its sentinel; this scroll fallback only runs without IntersectionObserver.
    if (state.historyLayout === 'similar') { if (!state.similarPagerObserver) appendSimilarPage(); return; }
    if (!el.historyImages || state.activeView !== 'history') return;
    const images = filteredImages || getFilteredHistoryImages();
    const start = state.historyRenderedCount;
    if (start >= images.length) return;
    const end = Math.min(images.length, start + HISTORY_RENDER_BATCH_SIZE);
    const fragment = document.createDocumentFragment();
    for (const image of images.slice(start, end)) fragment.appendChild(createHistoryItem(image));
    el.historyImages.appendChild(fragment);
    state.historyRenderedCount = end;
    updateHistorySelectionUi();
}

function createHistoryItem(image) {
    const id = historyImageKey(image);
    const item = document.createElement('article');
    item.className = 'history-item';
    item.dataset.historyId = id;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    setHistoryItemLabel(item, image);
    item.draggable = true;

    const thumb = document.createElement('div');
    thumb.className = 'history-thumb';
    const preview = document.createElement('img');
    preview.alt = image.fileName || '';
    preview.loading = 'lazy';
    preview.decoding = 'async';
    attachHistoryThumbnail(image, preview);
    const ratio = document.createElement('span');
    ratio.className = 'history-ratio-badge';
    ratio.textContent = getHistoryRatio(image);
    thumb.append(preview, ratio);
    renderUsageBadge(thumb, image);

    const copy = document.createElement('div');
    copy.className = 'history-item-copy';
    const fileName = document.createElement('span');
    fileName.className = 'history-file-name';
    fileName.textContent = image.fileName || '未命名图片';
    const meta = document.createElement('span');
    meta.className = 'history-item-meta';
    meta.textContent = [image.model || '未知模型', formatHistoryRelativeDate(image.createdAt)].filter(Boolean).join(' · ');
    const size = document.createElement('span');
    size.className = 'history-item-size';
    size.textContent = formatHistoryDimensions(image);
    copy.append(fileName, meta, size);
    item.append(thumb, copy);

    preview.addEventListener('load', () => {
        if (!image.width || !image.height) {
            image.width = preview.naturalWidth;
            image.height = preview.naturalHeight;
            size.textContent = formatHistoryDimensions(image);
            ratio.textContent = getHistoryRatio(image);
            if (state.historyActiveImageId === id) renderHistoryDetail();
        }
    });
    // Ctrl+click (or Ctrl+Enter / Ctrl+Space) is the multi-select gesture, shown by the blue border; like
    // the old checkbox it only toggles, it does not open the detail drawer.
    const select = additive => {
        if (!additive) state.historySelectedIds.clear();
        const selected = additive ? !state.historySelectedIds.has(id) : true;
        setHistoryImageSelected(image, selected, { openDetail: !additive });
    };
    item.addEventListener('click', event => select(event.ctrlKey || event.metaKey));
    item.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        select(event.ctrlKey || event.metaKey);
    });
    item.addEventListener('dblclick', () => {
        state.historyActiveImageId = id;
        previewActiveHistoryImage();
    });
    item.addEventListener('mouseenter', event => showImageHoverPreview(image, event));
    item.addEventListener('mousemove', queueImageHoverPreviewPosition);
    item.addEventListener('mouseleave', event => {
        // Moving directly between tiles should keep the native preview window
        // alive so only its content changes and its animation is not replayed.
        if (event.relatedTarget?.closest?.('#historyImages, #recentImages')) return;
        hideImageHoverPreview();
    });
    item.addEventListener('contextmenu', event => showImageContextMenu(image, event));
    item.addEventListener('dragstart', event => {
        rememberDraggedRecentImage(image);
        event.preventDefault();
        beginRecentImageDrag(image);
    });
    item.addEventListener('dragend', clearDraggedRecentImage);
    return item;
}

function setHistoryLayout(layout) {
    if (state.similarFind) closeFindSimilar({ render: false, discard: true });
    state.historyLayout = ['list', 'similar'].includes(layout) ? layout : 'grid';
    const isGrid = state.historyLayout === 'grid';
    el.historyGridBtn.classList.toggle('active', isGrid);
    el.historyListBtn.classList.toggle('active', layout === 'list');
    el.historySimilarBtn.classList.toggle('active', layout === 'similar');
    el.historySimilarBtn.setAttribute('aria-pressed', String(layout === 'similar'));
    el.historyGridBtn.setAttribute('aria-pressed', String(isGrid));
    el.historyListBtn.setAttribute('aria-pressed', String(layout === 'list'));
    renderHistoryImages();
}

function setHistoryImageSelected(image, selected, options = {}) {
    const id = historyImageKey(image);
    if (selected) state.historySelectedIds.add(id);
    else state.historySelectedIds.delete(id);
    if (options.openDetail && selected) {
        state.historyActiveImageId = id;
        state.historyDetailTab = 'details';
    } else if (!selected && state.historyActiveImageId === id) {
        state.historyActiveImageId = null;
    }
    updateHistorySelectionUi();
}

function updateHistorySelectionUi() {
    for (const item of el.historyImages.querySelectorAll('.history-item')) {
        const id = item.dataset.historyId;
        const selected = state.historySelectedIds.has(id);
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
    }
    const selectedCount = state.historySelectedIds.size;
    // Just viewing one image: the drawer has its own 移到回收站, so the selection bar stays out of the way.
    const viewingOne = selectedCount === 1 && !!state.historyActiveImageId && state.historySelectedIds.has(state.historyActiveImageId);
    el.historySelectionBar.hidden = selectedCount === 0 || viewingOne;
    if (el.historyPage?.dataset) el.historyPage.dataset.selectionBar = el.historySelectionBar.hidden ? 'hidden' : 'shown';
    syncHistoryTrashControls();
    if (!selectedCount) {
        state.historyActiveImageId = null;
        el.historyDetailDrawer.hidden = true;
        return;
    }
    renderHistoryDetail();
}

function selectAllVisibleHistoryImages() {
    for (const image of getFilteredHistoryImages()) state.historySelectedIds.add(historyImageKey(image));
    updateHistorySelectionUi();
}

function invertVisibleHistorySelection() {
    for (const image of getFilteredHistoryImages()) {
        const id = historyImageKey(image);
        if (state.historySelectedIds.has(id)) state.historySelectedIds.delete(id);
        else state.historySelectedIds.add(id);
    }
    if (state.historyActiveImageId && !state.historySelectedIds.has(state.historyActiveImageId)) {
        state.historyActiveImageId = null;
    }
    updateHistorySelectionUi();
}

function clearHistorySelection() {
    state.historySelectedIds.clear();
    state.historyActiveImageId = null;
    updateHistorySelectionUi();
}

function getActiveHistoryImage() {
    return state.recentImages.find(image => historyImageKey(image) === state.historyActiveImageId) || null;
}

function closeHistoryDetail() {
    state.historyActiveImageId = null;
    el.historyDetailDrawer.hidden = true;
}

function setHistoryDetailTab(tab) {
    state.historyDetailTab = ['details', 'prompt', 'metadata'].includes(tab) ? tab : 'details';
    renderHistoryDetail();
}

const HISTORY_DETAIL_EXPANDED_KEY = 'picgen.historyDetailExpanded';

function setHistoryDetailExpanded(expanded) {
    state.historyDetailExpanded = !!expanded;
    try { localStorage.setItem(HISTORY_DETAIL_EXPANDED_KEY, expanded ? '1' : '0'); } catch { /* storage unavailable */ }
    renderHistoryDetail();
}

// Compact drawer head: a draggable thumbnail, the file name and one summary line.
function renderHistoryDetailSummary(image) {
    const host = el.historyDetailSummary;
    if (!host) return;
    const used = historyUsageTotal(image);
    const summary = [
        image.model || '未知模型',
        `${formatHistoryDimensions(image)} (${getHistoryRatio(image)})`,
        formatHistoryFileSize(image.fileSize),
        used ? `已使用 ${used} 次` : ''
    ].filter(Boolean).join(' · ');
    // Re-rendered on every selection change: keep the nodes (and the loaded thumbnail) when nothing changed.
    const signature = `${historyImageKey(image)}\n${image.fileName || ''}\n${summary}`;
    if (host.dataset.signature === signature && host.children.length) return;
    host.dataset.signature = signature;
    const thumb = document.createElement('img');
    thumb.className = 'history-detail-summary-thumb';
    thumb.alt = image.fileName || '';
    thumb.draggable = true;
    thumb.addEventListener('dragstart', event => {
        event.preventDefault();
        rememberDraggedRecentImage(image);
        beginRecentImageDrag(image);
    });
    thumb.addEventListener('dragend', clearDraggedRecentImage);
    thumb.addEventListener('dblclick', previewActiveHistoryImage);
    // 摘要只在内容变化时重建：右键时再按 key 取最新记录
    thumb.addEventListener('contextmenu', event => showImageContextMenu(liveHistoryRecord(image), event));
    attachHistoryThumbnail(image, thumb, { eager: true });
    const copy = document.createElement('div');
    copy.className = 'history-detail-summary-copy';
    const name = document.createElement('strong');
    name.textContent = image.fileName || '未命名图片';
    name.title = image.fileName || '';
    const meta = document.createElement('span');
    meta.textContent = summary;
    meta.title = summary;
    copy.append(name, meta);
    host.replaceChildren(thumb, copy);
}

// The drawer's own 移到回收站: just this image, no dialog (the result banner offers 撤销, and the bin restores).
async function trashActiveHistoryImage() {
    const image = getActiveHistoryImage();
    if (!image?.filePath || state.historyTrashBusy) return;
    const id = image.id || historyImageKey(image);
    const used = historyUsageTotal(image) > 0;
    state.historyTrashBusy = true;
    try {
        await runHistoryTrash([{ id, filePath: image.filePath }], { includeProtected: used, confirmProtected: used ? [id] : [], reason: 'selection' });
    } finally {
        state.historyTrashBusy = false;
        updateHistorySelectionUi();
    }
}

function renderHistoryDetail() {
    const image = getActiveHistoryImage();
    if (!image) {
        el.historyDetailDrawer.hidden = true;
        return;
    }
    el.historyDetailDrawer.hidden = false;
    const expanded = !!state.historyDetailExpanded;
    if (el.historyDetailDrawer.dataset) el.historyDetailDrawer.dataset.mode = expanded ? 'expanded' : 'compact';
    if (el.historyDetailExpandBtn) {
        el.historyDetailExpandBtn.setAttribute('aria-expanded', String(expanded));
        el.historyDetailExpandBtn.title = expanded ? '收起详情' : '展开详情';
        el.historyDetailExpandBtn.setAttribute('aria-label', el.historyDetailExpandBtn.title);
    }
    if (!expanded) {
        renderHistoryDetailSummary(image);
        el.historyDetailBody.innerHTML = '';
        return;
    }
    for (const button of el.historyDetailDrawer.querySelectorAll('[data-history-tab]')) {
        const active = button.dataset.historyTab === state.historyDetailTab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
    }
    el.historyDetailBody.innerHTML = '';

    if (state.historyDetailTab === 'prompt') {
        const prompt = document.createElement('pre');
        prompt.className = 'history-detail-text';
        prompt.textContent = image.prompt || '未记录提示词';
        el.historyDetailBody.appendChild(prompt);
        return;
    }
    if (state.historyDetailTab === 'metadata') {
        const metadata = document.createElement('pre');
        metadata.className = 'history-detail-text metadata';
        metadata.textContent = JSON.stringify({
            id: image.id || '',
            model: image.model || '',
            ratio: getHistoryRatio(image),
            width: Number(image.width || 0) || null,
            height: Number(image.height || 0) || null,
            mimeType: image.mimeType || '',
            fileSize: Number(image.fileSize || 0) || null,
            createdAt: new Date(Number(image.createdAt || 0)).toISOString(),
            filePath: image.filePath || '',
            dragCount: Number(image.dragCount) || 0,
            referenceCount: Number(image.referenceCount) || 0,
            lastUsedAt: Number(image.lastUsedAt) ? new Date(Number(image.lastUsedAt)).toISOString() : null
        }, null, 2);
        el.historyDetailBody.appendChild(metadata);
        return;
    }

    const overview = document.createElement('div');
    overview.className = 'history-detail-overview';
    const preview = document.createElement('img');
    preview.className = 'history-detail-image';
    preview.src = image.url;
    preview.alt = image.fileName || '';
    // Same native drag as the gallery, so a drag-out from the drawer is counted too.
    preview.draggable = true;
    preview.addEventListener('dragstart', event => {
        event.preventDefault();
        rememberDraggedRecentImage(image);
        beginRecentImageDrag(image);
    });
    preview.addEventListener('dragend', clearDraggedRecentImage);
    preview.addEventListener('contextmenu', event => showImageContextMenu(image, event));
    const list = document.createElement('dl');
    list.className = 'history-detail-list';
    appendHistoryDetailRow(list, '文件名', image.fileName || '未命名图片');
    appendHistoryDetailRow(list, '模型', image.model || '未知模型');
    appendHistoryDetailRow(list, '生成时间', formatHistoryFullDate(image.createdAt));
    appendHistoryDetailRow(list, '尺寸', `${formatHistoryDimensions(image)} (${getHistoryRatio(image)})`);
    appendHistoryDetailRow(list, '文件大小', formatHistoryFileSize(image.fileSize));
    appendHistoryDetailRow(list, '使用记录', historyUsageSummary(image));
    appendHistoryDetailRow(list, '保存路径', image.filePath || '');
    overview.append(preview, list);
    el.historyDetailBody.appendChild(overview);
}

function appendHistoryDetailRow(list, label, value) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    detail.title = value;
    list.append(term, detail);
}

function previewActiveHistoryImage() {
    const image = getActiveHistoryImage();
    if (!image) return;
    hideImageHoverPreview();
    el.historyPreviewImage.src = image.url;
    el.historyPreviewImage.alt = image.fileName || '';
    el.historyPreviewOverlay.hidden = false;
}

function closeHistoryPreview() {
    if (!el.historyPreviewOverlay) return;
    el.historyPreviewOverlay.hidden = true;
    el.historyPreviewImage.removeAttribute('src');
    el.historyPreviewImage.alt = '';
}

function runActiveHistoryAction(action) {
    const image = getActiveHistoryImage();
    if (!image) return;
    state.imageContextTarget = image;
    return action();
}

function formatHistoryDimensions(image) {
    const width = Number(image?.width || 0);
    const height = Number(image?.height || 0);
    return width > 0 && height > 0 ? `${width} × ${height}` : '尺寸读取中';
}

function getHistoryRatio(image) {
    const explicit = String(image?.ratio || '').trim();
    if (/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(explicit)) return explicit;
    const width = Number(image?.width || 0);
    const height = Number(image?.height || 0);
    if (!(width > 0 && height > 0)) return '—';
    const ratio = width / height;
    const common = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '21:9'];
    let nearest = common[0];
    let delta = Infinity;
    for (const value of common) {
        const [left, right] = value.split(':').map(Number);
        const nextDelta = Math.abs(ratio - left / right);
        if (nextDelta < delta) {
            nearest = value;
            delta = nextDelta;
        }
    }
    return nearest;
}

function formatHistoryRelativeDate(value) {
    const timestamp = Number(value || 0);
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const today = new Date();
    const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dayDifference = Math.round((startToday - startDate) / (24 * 60 * 60 * 1000));
    if (dayDifference === 0) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (dayDifference === 1) return '昨天';
    if (dayDifference > 1 && dayDifference < 7) return `${dayDifference} 天前`;
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatHistoryFullDate(value) {
    const timestamp = Number(value || 0);
    if (!timestamp) return '未知';
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function formatHistoryFileSize(value) {
    const bytes = Number(value || 0);
    if (!(bytes > 0)) return '未知';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function openOutputFolder() {
    hideImageHoverPreview();
    hideImageContextMenu();

    try {
        await window.picgenDesktop.openOutputFolder();
    } catch (error) {
        showToast(`打开输出文件夹失败: ${error.message}`);
    }
}

// --- 统一图片右键菜单 ---------------------------------------------------------------------------------
// 整个 app 只有一个 #imageContextMenu。目标 kind：history（历史记录，所有历史图入口）/ bin（应用内回收站）/
// reference（当前序列的参考图卡片）/ data（只有像素的图，如提示词反推的待分析图片）。
// 详情抽屉按钮和冒烟脚本直接把历史记录放进 state.imageContextTarget，这里统一包装。
const IMAGE_CONTEXT_KINDS = new Set(['history', 'bin', 'reference', 'data']);

function toImageContextTarget(value) {
    if (!value) return null;
    if (IMAGE_CONTEXT_KINDS.has(value.kind)) return value;
    return { kind: 'history', record: value, filePath: value.filePath || '', name: value.fileName || '图片.png', mimeType: value.mimeType || '' };
}

function referenceContextTarget(sequenceId, reference) {
    return { kind: 'reference', sequenceId, reference, filePath: reference.filePath || '', name: reference.name || '参考图片.png', mimeType: reference.mimeType || 'image/png' };
}

// 从历史发出的参考图卡片沿用历史文件名（名字里带任务 id，不会重名）
function historyRecordForReference(reference) {
    const name = String(reference?.name || '').toLowerCase();
    return name ? state.recentImages.find(image => String(image.fileName || '').toLowerCase() === name) || null : null;
}

// 图块会被复用、闭包里的记录可能已过时：右键时再按 key 取最新的历史记录
function liveHistoryRecord(image) {
    return historyRecordsByKey().get(historyImageKey(image)) || image;
}

// 这张图做不了的项：禁用并在行尾写原因（按"最全功能"对齐，不隐藏）
function imageContextBlocked(target) {
    const kind = target?.kind;
    return {
        sendReferenceActiveBtn: kind === 'reference' ? '已在本序列' : '',
        findSimilarImageBtn: kind === 'bin' ? '还原后可用'
            : kind === 'data' ? '仅限历史图片'
            // 历史还没全量加载时保持可用，点击时再查
            : kind === 'reference' && state.historyLoaded && !historyRecordForReference(target.reference) ? '仅限历史图片' : ''
    };
}

function showImageContextMenu(value, event) {
    event.preventDefault();
    event.stopPropagation();
    hideImageHoverPreview();
    const target = toImageContextTarget(value);
    state.imageContextTarget = target;
    // 设为封面 / 移出此组 only for a history image right-clicked inside a similar group.
    const groupRow = target.kind === 'history' && state.historyLayout === 'similar' && !state.similarFind ? event.target?.closest?.('.similar-group') : null;
    state.imageContextGroupId = groupRow?.dataset.groupId || null;

    const native = window.picgenDesktop?.showImageContextMenu;
    if (typeof native === 'function') {
        // A native menu: it opens at the cursor and may extend past the window. The target is kept here
        // because the window's blur (the menu taking focus) clears state.imageContextTarget.
        const groupId = state.imageContextGroupId;
        Promise.resolve(native(imageContextMenuItems(groupId))).then(choice => {
            if (!choice) return;
            state.imageContextTarget = target;
            state.imageContextGroupId = groupId;
            runImageContextAction(choice);
        }).catch(error => showToast(`右键菜单打开失败：${error.message}`));
        return;
    }
    if (el.setCoverImageBtn) el.setCoverImageBtn.hidden = !state.imageContextGroupId;
    if (el.detachImageBtn) el.detachImageBtn.hidden = !state.imageContextGroupId;
    // 禁用按钮 pointer-events:none，title 悬停不出来：原因写进 data-hint，由 CSS 显示在行尾
    for (const [id, reason] of Object.entries(imageContextBlocked(target))) {
        const button = el[id];
        if (!button) continue;
        button.disabled = !!reason;
        button.title = reason ? `不可用：${reason}` : '';
        if (reason) button.dataset.hint = reason;
        else delete button.dataset.hint;
    }

    placeContextMenu(el.imageContextMenu, event);
}

// 右键菜单定位：跟随指针，收在面板内
function placeContextMenu(menu, event) {
    const panelRect = el.desktopPanel.getBoundingClientRect();
    menu.hidden = false;
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const margin = 8;
    const left = Math.min(
        Math.max(margin, event.clientX - panelRect.left),
        panelRect.width - menuWidth - margin
    );
    const top = Math.min(
        Math.max(margin, event.clientY - panelRect.top),
        panelRect.height - menuHeight - margin
    );

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

// 参考图卡片右键：同一个图片菜单（发送到图片工作台时，带工作台文档的卡片回到原画布）
function showReferenceContextMenu(sequenceId, reference, event) {
    showImageContextMenu(referenceContextTarget(sequenceId, reference), event);
}

// The same entries as the in-page fallback menu (#imageContextMenu), in its order.
function imageContextMenuItems(groupId) {
    const items = [
        { id: 'reference-active', label: '发送到参考图（活动序列）' },
        { id: 'reference-new', label: '发送到参考图（新建序列）' },
        { id: 'workspace', label: '发送到图片工作台' },
        { type: 'separator' },
        { id: 'copy', label: '复制图片' },
        { id: 'copy-prompt', label: '复制提示词' },
        { id: 'save-as', label: '另存为…' },
        { type: 'separator' },
        { id: 'find-similar', label: '查找相似图片' }
    ];
    if (groupId) items.push({ type: 'separator' }, { id: 'set-cover', label: '设为封面' }, { id: 'detach', label: '移出此组' });
    return items;
}

function runImageContextAction(id) {
    const actions = {
        copy: copyContextImage,
        'copy-prompt': copyPromptFromContextImage,
        'reference-active': () => sendContextImageToReference(false),
        'reference-new': () => sendContextImageToReference(true),
        workspace: () => openWorkspaceFromContextImage('annotate'),
        'save-as': saveContextImageAs,
        'find-similar': findSimilarFromContext,
        'set-cover': () => applySimilarOverrideFromContext('setCover'),
        detach: () => applySimilarOverrideFromContext('detach')
    };
    const action = actions[id];
    if (!action) {
        hideImageContextMenu();
        return;
    }
    void Promise.resolve(action()).catch(error => showToast(error.message));
}

// The eye next to the pin: hover previews on or off, remembered per machine.
const HOVER_PREVIEW_KEY = 'picgen.hoverPreview';

function hoverPreviewEnabled() {
    return state.hoverPreviewEnabled !== false;
}

function bindHoverPreviewToggle() {
    try {
        state.hoverPreviewEnabled = localStorage.getItem(HOVER_PREVIEW_KEY) !== 'off';
    } catch {
        state.hoverPreviewEnabled = true;
    }
    const button = document.getElementById('hoverPreviewToggleBtn');
    if (!button) return;
    const paint = () => {
        const on = hoverPreviewEnabled();
        button.setAttribute('aria-pressed', String(on));
        button.title = on ? '关闭鼠标悬停预览' : '开启鼠标悬停预览';
        button.innerHTML = on ? '<i data-lucide="eye"></i>' : '<i data-lucide="eye-off"></i>';
        refreshLucideIcons(button);
    };
    button.addEventListener('click', () => {
        state.hoverPreviewEnabled = !hoverPreviewEnabled();
        try { localStorage.setItem(HOVER_PREVIEW_KEY, state.hoverPreviewEnabled ? 'on' : 'off'); } catch { /* per-machine convenience */ }
        if (!state.hoverPreviewEnabled) hideImageHoverPreview();
        paint();
        showToast(state.hoverPreviewEnabled ? '已开启鼠标悬停预览' : '已关闭鼠标悬停预览');
    });
    paint();
}

function hideImageContextMenu() {
    if (!el.imageContextMenu) return;
    el.imageContextMenu.hidden = true;
    state.imageContextTarget = null;
    state.imageContextGroupId = null;
}

// 取走当前目标并收起菜单（分组 id 一并带走：收起时会清掉）
function takeImageContextTarget() {
    const target = toImageContextTarget(state.imageContextTarget);
    const groupId = state.imageContextGroupId;
    hideImageContextMenu();
    return target ? { ...target, groupId } : null;
}

// 目标 → 图片数据 {name, base64, mimeType}（发送到参考图 / 工作台共用）。参考图不带 workspace：
// 工作台原图缓存随卡片删除，两张卡片共用一份会误删
async function loadContextImageData(target) {
    if (target.kind === 'reference') return { name: target.name, ...(await referenceImageData(target.reference)) };
    if (target.kind === 'data') return { name: target.name, base64: target.base64, mimeType: target.mimeType || 'image/png' };
    if (!target.filePath) throw new Error('找不到图片文件');
    const loaded = await window.picgenDesktop.loadCachedImage({ filePath: target.filePath, mimeType: target.record?.mimeType || '' });
    if (!loaded?.base64) throw new Error('图片读取为空');
    return { name: target.name, base64: loaded.base64, mimeType: loaded.mimeType || 'image/png' };
}

// 复制 / 另存的载荷：有文件给路径（主进程校验、历史图计一次带出），否则给像素
function contextImageFilePayload(target) {
    if (target.filePath) return { filePath: target.filePath };
    return { base64: target.base64 || target.reference?.base64 || '', mimeType: target.mimeType || 'image/png' };
}

async function sendContextImageToReference(newSequence = false, source = '') {
    const image = takeImageContextTarget();
    // 参考图卡片只能发到新序列：活动序列就是它自己所在的序列（按钮已禁用，这里兜底）
    if (!image || state.sendingReference || (!newSequence && image.kind === 'reference')) return;
    state.sendingReference = true;
    saveCurrentSequenceFromForm();
    const target = getCurrentSequence();
    const limit = imageApiProfiles.getImageApiProfile(target.model).maxReferences;
    try {
        await hydrateSequenceReferences([target]);
        if (!limit) { showToast('当前模型不支持参考图，请先切换支持图片输入的模型'); return; }
        if (!newSequence && target.references.length >= limit) { showToast(`当前模型最多支持 ${limit} 张参考图`); return; }
        const loaded = await loadContextImageData(image);
        const reference = await persistReferenceImage({ id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: loaded.name || '参考图片.png', mimeType: loaded.mimeType, base64: loaded.base64 });
        if (!state.sequences.includes(target)) { await deleteReferenceImageCache(reference); return; }
        let destination = target;
        if (newSequence) {
            destination = createSequence({ providerId: target.providerId, model: target.model, ratio: target.ratio,
                imageSize: target.imageSize, advanced: target.advanced, count: '1', prompt: '' });
            state.sequences.push(destination); normalizeSequenceNames();
        } else if (target.references.length >= imageApiProfiles.getImageApiProfile(target.model).maxReferences) {
            await deleteReferenceImageCache(reference); showToast('参考图已满，请移除一张后再试'); return;
        }
        reference.alias = uniqueReferenceAlias(reference, destination.references);
        if (getCurrentSequence() !== destination) saveCurrentSequenceFromForm();
        destination.references.push(reference);
        state.currentSequenceId = destination.id;
        // 只有历史图计使用（回收站、参考图卡、反推图都不是历史记录）
        if (image.kind === 'history') noteHistoryImageUse(image.record, source || (newSequence ? 'menu-new-sequence' : 'menu'));
        saveSequences(); renderSequenceTabs(); loadCurrentSequenceToForm(); showGenerationView();
        showToast(newSequence ? '已新建序列并添加参考图' : '已添加到活动序列参考图');
    } catch (error) { showToast(`添加参考图失败：${error.message}`, 'error'); }
    finally { state.sendingReference = false; }
}

// 复制图片：主进程解码后写入系统剪贴板（历史图计一次"带出"，由主进程在写入成功后计）
async function copyContextImage() {
    const target = takeImageContextTarget();
    if (!target) return;
    // 上一张还在解码：别悄悄丢掉这次点击，否则用户会把上一张当成这张粘贴出去
    if (state.copyingImage) {
        showToast('正在复制上一张图片，请稍候');
        return;
    }
    state.copyingImage = true;
    try {
        const result = await window.picgenDesktop.copyImage(contextImageFilePayload(target));
        if (result?.usage) applyHistoryUsage({ usageKey: result.usageKey, filePath: target.filePath, usage: result.usage });
        showToast('已复制图片', 'success');
    } catch (error) { showToast(`复制图片失败：${error.message}`, 'error'); }
    finally { state.copyingImage = false; }
}

// 另存为：系统保存对话框，原样复制（格式与内嵌提示词保留）；取消不计数
async function saveContextImageAs() {
    const target = takeImageContextTarget();
    if (!target || state.savingImageAs) return;
    state.savingImageAs = true;
    try {
        const result = await window.picgenDesktop.saveImageAs({ ...contextImageFilePayload(target), fileName: target.name });
        if (!result || result.cancelled) return;
        // 在对话框里选中了原图自己：什么都没存，也不计数
        if (result.sameFile) {
            showToast('选中的就是原图，没有另存');
            return;
        }
        if (result.usage) applyHistoryUsage({ usageKey: result.usageKey, filePath: target.filePath, usage: result.usage });
        showToast(`已另存为 ${result.fileName || target.name}`, 'success');
    } catch (error) { showToast(`另存失败：${error.message}`, 'error'); }
    finally { state.savingImageAs = false; }
}

// 复制提示词（原「读取提示词」）：直接进剪贴板，不再新建序列、不切视图。
// 先用历史记录里的提示词，没有再让主进程读文件内嵌的元数据 / 按历史索引找（只有像素的图读 base64 内嵌元数据）
async function copyPromptFromContextImage() {
    const target = takeImageContextTarget();
    if (!target) return;
    try {
        let prompt = String(target.record?.prompt || '').trim();
        if (!prompt) {
            const result = await window.picgenDesktop.getGeneratedImagePrompt(target.filePath
                ? { filePath: target.filePath, fileName: target.name }
                : { base64: target.base64 || target.reference?.base64 || '' });
            prompt = String(result?.prompt || '').trim();
        }
        if (!prompt) {
            showToast('这张图片没有记录提示词');
            return;
        }
        await window.picgenDesktop.copyText(prompt);
        showToast('已复制提示词', 'success');
    } catch (error) { showToast(`复制提示词失败：${error.message}`, 'error'); }
}

function createSequenceFromImagePrompt(prompt) {
    saveCurrentSequenceFromForm();
    const source = getCurrentSequence();
    const preset = getSequencePreset(source);
    const sequence = createSequence({
        name: `序列${state.sequences.length + 1}`,
        prompt,
        providerId: source.providerId,
        model: source.model,
        ratio: source.ratio,
        count: '1',
        imageSize: source.imageSize,
        advanced: source.advanced
    });
    if (!preset?.models?.includes(sequence.model)) sequence.model = preset?.models?.[0] || '';
    state.sequences.push(sequence);
    normalizeSequenceNames();
    state.currentSequenceId = sequence.id;
    saveSequences();
    renderSequenceTabs();
    loadCurrentSequenceToForm();
}

function renderPendingMaskEdit() {
    const panel = document.getElementById('pendingMaskPanel');
    if (!panel) return;
    const pending = state.pendingMaskEdits.get(state.currentSequenceId);
    panel.hidden = !pending;
    const thumb = document.getElementById('pendingMaskThumb');
    if (pending) thumb.src = pending.preview;
    else thumb.removeAttribute('src');
    document.getElementById('cancelMaskEditBtn').onclick = () => {
        state.pendingMaskEdits.delete(state.currentSequenceId);
        renderPendingMaskEdit();
        setSequenceStatus(getCurrentSequence(), '已取消局部编辑');
    };
}

// 可悬停预览的图块：主页最近图条、历史网格、参考图卡。
const HOVER_PREVIEW_SOURCES = '.recent-item, .history-item, .reference-item-image';

// 按下图片（准备拖拽）就收起并取消悬停预览：80ms 意图定时器和主进程的异步显示都可能在按下之后
// 才落地，否则拖拽越过阈值之前大图会闪一下甚至一直挂着。
function handleImagePointerDown(event) {
    if (event.button !== 0 || !event.target?.closest?.(HOVER_PREVIEW_SOURCES)) return;
    state.imagePointerPressed = true;
    hideImageHoverPreview();
}

function handleImagePointerRelease() {
    state.imagePointerPressed = false;
}

// 拖拽结束后的"真实移动闸门"：补发的悬停（遮罩收起、图条重建、滚动、切换视图）只派发
// mouseover/mouseenter，从不派发 mousemove。同一次输入里边界事件先于 mousemove，
// 所以落点下那张图要移出再移入才会预览。
// OLE 拖拽结束释放鼠标捕获时，系统可能在落点补发一条原地 WM_MOUSEMOVE：第一条 mousemove 只记基准点，
// 离开基准 ≥2px 才算真实移动（真实移动一次就有多条 mousemove，几乎无感）。
function handleHoverPreviewRealMove(event) {
    if (!state.hoverPreviewNeedsMove) return;
    const x = Number(event?.screenX);
    const y = Number(event?.screenY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        state.hoverPreviewNeedsMove = false;
        return;
    }
    const from = state.hoverPreviewMoveFrom;
    if (!from) {
        state.hoverPreviewMoveFrom = { x, y };
        return;
    }
    if (Math.abs(x - from.x) + Math.abs(y - from.y) < 2) return;
    state.hoverPreviewNeedsMove = false;
    state.hoverPreviewMoveFrom = null;
}

// 闸门上锁统一走这里：基准点跟着清空
function armHoverPreviewMoveGate() {
    state.hoverPreviewNeedsMove = true;
    state.hoverPreviewMoveFrom = null;
}

// 外部文件拖入（资源管理器等）：松手位置同样会补发悬停，按拖拽结束处理
function handleForeignDragEnter() {
    if (!state.imageDragPreviewGuard) hideImageHoverPreview();
    armHoverPreviewMoveGate();
}

function hoverPreviewBlocked() {
    // 图片右键菜单开着时也不弹：大图会压在菜单上
    const menuOpen = !!(el.imageContextMenu && !el.imageContextMenu.hidden);
    return !!(state.imageDragPreviewGuard || state.imagePointerPressed || state.hoverPreviewNeedsMove || menuOpen);
}

function showImageHoverPreview(image, event) {
    if (!el.imageHoverPreview || !el.imageHoverPreviewImg) return;
    if (!hoverPreviewEnabled()) return;
    // 拖拽中 / 按键按在图片上 / 拖拽结束后还没真实移动过：一律不弹
    if (hoverPreviewBlocked()) return;
    const point = { clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY };
    const anchor = event.anchor || event.currentTarget || null;
    const switchingNativeImage = state.hoverPreviewNative && state.hoverPreviewImage;
    if (switchingNativeImage) {
        clearTimeout(state.hoverPreviewTimer);
        state.hoverPreviewTimer = 0;
        state.hoverPreviewImage = image;
        state.hoverPreviewPoint = point;
        state.hoverPreviewAnchor = anchor;
        openImageHoverPreview(image, point);
        return;
    }
    hideImageHoverPreview();
    state.hoverPreviewImage = image;
    state.hoverPreviewPoint = point;
    state.hoverPreviewAnchor = anchor;
    // Short intent guard prevents accidental popups while keeping the UI responsive.
    state.hoverPreviewTimer = setTimeout(() => {
        state.hoverPreviewTimer = 0;
        if (state.hoverPreviewImage === image && !hoverPreviewBlocked()) openImageHoverPreview(image, state.hoverPreviewPoint);
    }, 80);
}

// 预览锚点：发起预览的图块在页面里的矩形（CSS px），主进程换算到屏幕后核对真实光标。
function previewAnchorRect(anchor) {
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) return null;
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function openImageHoverPreview(image, event) {
    // 图条/网格已重建，发起预览的图块不在了：光标下已是别的东西，不弹
    if (state.hoverPreviewAnchor && state.hoverPreviewAnchor.isConnected === false) {
        hideImageHoverPreview();
        return;
    }
    const canUseNativePreview = window.picgenDesktop.showImagePreview && (image?.filePath || image?.base64 || image?.dataUrl);
    state.hoverPreviewNative = !!canUseNativePreview;
    if (canUseNativePreview) {
        el.imageHoverPreview.hidden = true;
        el.imageHoverPreviewImg.removeAttribute('src');
        window.picgenDesktop.showImagePreview({
            anchor: previewAnchorRect(state.hoverPreviewAnchor),
            filePath: image.filePath,
            fileName: image.fileName,
            model: image.model,
            providerName: image.providerName,
            mimeType: image.mimeType,
            base64: image.filePath ? undefined : image.base64,
            dataUrl: image.filePath || image.base64 ? undefined : image.dataUrl,
            width: image.width,
            height: image.height,
            x: event.screenX,
            y: event.screenY,
            // 'above'：锚定弹出（参考图卡）——底边对齐锚点上方、不跟随光标。
            placement: image.previewPlacement
        });
        return;
    }

    el.imageHoverPreviewImg.src = image.url || image.dataUrl || '';
    el.imageHoverPreviewImg.alt = image.fileName || '';
    const width = Number(image.width || 0);
    const height = Number(image.height || 0);
    el.imageHoverPreviewDimensions.textContent = `尺寸: ${width && height ? `${width} x ${height}` : '-'}`;
    el.imageHoverPreviewModel.textContent = `模型: ${image.model || (image.filePath ? '未知模型' : '参考图')}`;
    el.imageHoverPreviewProvider.textContent = `供应商: ${image.providerName || (image.filePath ? '未知供应商' : '本地上传')}`;
    el.imageHoverPreview.hidden = false;
    queueImageHoverPreviewPosition(event);
}

function queueImageHoverPreviewPosition(event) {
    if (!event) return;
    // 锚定式预览（参考图卡，placement:'above'）不跟随光标：mousemove 若覆盖坐标，
    // 80ms 意图定时器就会拿光标位置定位，预览会压到条带上。
    if (state.hoverPreviewImage?.previewPlacement === 'above') return;
    state.hoverPreviewPoint = {
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY
    };
    if (state.hoverPreviewTimer || !state.hoverPreviewImage || state.hoverPreviewPositionFrame) return;
    state.hoverPreviewPositionFrame = requestAnimationFrame(() => {
        state.hoverPreviewPositionFrame = 0;
        const point = state.hoverPreviewPoint;
        if (point) positionImageHoverPreview(point);
    });
}

function positionImageHoverPreview(event) {
    if (state.hoverPreviewNative && window.picgenDesktop.moveImagePreview) {
        // Keep the native preview still while the pointer remains on this tile.
        return;
    }

    if (!el.imageHoverPreview || el.imageHoverPreview.hidden) return;

    const panelRect = el.desktopPanel.getBoundingClientRect();
    const previewRect = el.imageHoverPreview.getBoundingClientRect();
    const previewWidth = previewRect.width || 260;
    const previewHeight = previewRect.height || 260;
    const margin = 8;
    const offset = 14;

    let left = event.clientX - panelRect.left + offset;
    let top = event.clientY - panelRect.top - previewHeight - offset;

    if (left + previewWidth > panelRect.width - margin) {
        left = panelRect.width - previewWidth - margin;
    }
    if (top < margin) {
        top = event.clientY - panelRect.top + offset;
    }
    if (top + previewHeight > panelRect.height - margin) {
        top = panelRect.height - previewHeight - margin;
    }

    el.imageHoverPreview.style.left = `${Math.max(margin, left)}px`;
    el.imageHoverPreview.style.top = `${Math.max(margin, top)}px`;
}

function hideImageHoverPreview() {
    clearTimeout(state.hoverPreviewTimer);
    state.hoverPreviewTimer = 0;
    if (state.hoverPreviewPositionFrame) {
        cancelAnimationFrame(state.hoverPreviewPositionFrame);
        state.hoverPreviewPositionFrame = 0;
    }
    state.hoverPreviewImage = null;
    state.hoverPreviewPoint = null;
    state.hoverPreviewAnchor = null;
    if (state.hoverPreviewNative && window.picgenDesktop.hideImagePreview) {
        window.picgenDesktop.hideImagePreview();
    }
    state.hoverPreviewNative = false;
    if (!el.imageHoverPreview || !el.imageHoverPreviewImg) return;
    el.imageHoverPreview.hidden = true;
    el.imageHoverPreviewImg.removeAttribute('src');
    el.imageHoverPreviewImg.alt = '';
    el.imageHoverPreviewDimensions.textContent = '尺寸: -';
    el.imageHoverPreviewModel.textContent = '模型: -';
    el.imageHoverPreviewProvider.textContent = '供应商: -';
}

function setSequenceStatus(sequence, status) {
    sequence.status = status;
    if (sequence.id === state.currentSequenceId) {
        el.taskStatus.textContent = status;
    }
}

function updateActionState() {
    const sequence = getCurrentSequence();
    const isRunning = sequence.runningTasks.size > 0;
    el.generateBtn.disabled = false;
    el.stopBtn.disabled = !isRunning;
    if (sequence.id === state.currentSequenceId) {
        el.taskStatus.textContent = sequence.status || '就绪';
    }
    updateBatchProgress();
}

function setConnectionStatus(_online) {
    // The local server connection is internal to the desktop app; no visible status is needed.
}

function showToast(message, kind = '') {
    if (window.PicGenAppica?.showToast) {
        // Keep the legacy node synchronized for existing smoke scripts while all
        // visible feedback is rendered by Appica's centered Toast portal.
        if (el.toast) {
            el.toast.textContent = String(message ?? '');
            el.toast.hidden = true;
        }
        return window.PicGenAppica.showToast(message, kind);
    }
    clearTimeout(state.toastTimer);
    el.toast.textContent = message;
    if (kind === 'error') {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = '查看错误日志';
        button.addEventListener('click', () => { el.toast.hidden = true; openErrorLogs(); }); el.toast.appendChild(button);
    }
    el.toast.hidden = false;
    state.toastTimer = setTimeout(() => {
        el.toast.hidden = true;
    }, kind === 'error' ? 10000 : 2600);
}

// Electron 的原生 confirm() 会阻塞渲染进程，无边框窗口下会让整个界面失去响应。
function askConfirm(message, options = {}) {
    if (window.PicGenAppica) return window.PicGenAppica.confirm(message, options);
    const overlay = document.getElementById('confirmOverlay');
    if (!overlay) return Promise.resolve(true);

    const okBtn = document.getElementById('confirmOkBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');
    document.getElementById('confirmMessage').textContent = message;
    document.getElementById('confirmTitle').textContent = options.title || '确认操作';
    const iconEl = document.getElementById('confirmIcon');
    iconEl.textContent = options.danger ? '!' : '?';
    iconEl.classList.toggle('is-danger', !!options.danger);
    okBtn.textContent = options.okText || '确定';
    okBtn.classList.toggle('is-danger', !!options.danger);

    overlay.hidden = false;
    okBtn.focus();

    return new Promise(resolve => {
        const finish = (value) => {
            overlay.hidden = true;
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKey);
            resolve(value);
        };
        const onOk = () => finish(true);
        const onCancel = () => finish(false);
        const onBackdrop = (event) => {
            if (event.target === overlay) finish(false);
        };
        const onKey = (event) => {
            if (event.key === 'Escape') finish(false);
            if (event.key === 'Enter') finish(true);
        };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey);
    });
}

function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

