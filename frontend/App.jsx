import React from 'react';
import { ImageCard } from './PreviewCard';
import { Action, Navigation, WindowHeader } from './components';
import { GenerationWorkspace } from './pages/GenerationWorkspace';
import { RecentImages } from './pages/RecentImages';
import { HistoryPage } from './pages/HistoryPage';
import { QueuePage } from './pages/QueuePage';
import { ReversePromptPage } from './pages/ReversePromptPage';
import { ErrorLogsPage } from './pages/ErrorLogsPage';
import { HistoryBinPage } from './pages/HistoryBinPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() { return (<>

<Action id="collapsedLauncher" className="collapsed-launcher" type="button" title="展开 PicGen" aria-label="展开 PicGen" markup={'<img class="launcher-logo" src="assets/picgen-icon.svg" alt="" draggable="false" /><span id="collapsedNotificationBadge" class="collapsed-notification-badge" hidden aria-live="polite"></span>'} />

<main id="desktopPanel" className="desktop-panel">
<WindowHeader />
<div className="app-shell">
<Navigation />
<div className="main-surface">
<nav className="tabs-bar" aria-label="生成序列">
<div id="sequenceTabs" className="sequence-tabs">

</div>
<Action id="addSequenceBtn" className="icon-button new-tab-button" type="button" title="新建序列" aria-label="新建序列" markup={"<i data-lucide=\"plus\"></i>"} />
</nav>
<div id="mainContentScroll" className="main-content-scroll">
<GenerationWorkspace />
<RecentImages />
</div>
<HistoryPage />
<QueuePage />
<ReversePromptPage />
<ErrorLogsPage />
<HistoryBinPage />
<section id="workspacePage" className="workspace-page" aria-label="图片工作台" hidden><div id="workspaceRoot"></div></section>
</div>
</div>
<div id="imageHoverPreview" className="image-hover-preview" hidden>
<ImageCard />
</div>
{/* 全局唯一的图片右键菜单（历史图、回收站、参考图卡、反推图共用）：做不到的项由 desktop.js 禁用并在行尾写原因 */}
<div id="imageContextMenu" className="image-context-menu" role="menu" hidden>
<Action id="sendReferenceActiveBtn" type="button" role="menuitem" markup={"<i data-lucide=\"image-plus\"></i><span>发送到参考图（活动序列）</span>"} />
<Action id="sendReferenceNewBtn" type="button" role="menuitem" markup={"<i data-lucide=\"file-plus\"></i><span>发送到参考图（新建序列）</span>"} />
<Action id="workspaceImageBtn" type="button" role="menuitem" markup={"<i data-lucide=\"frame\"></i><span>发送到图片工作台</span>"} />
<div className="image-context-separator" role="separator" />
<Action id="copyImageBtn" type="button" role="menuitem" markup={"<i data-lucide=\"copy\"></i><span>复制图片</span>"} />
<Action id="copyPromptImageBtn" type="button" role="menuitem" markup={"<i data-lucide=\"clipboard-type\"></i><span>复制提示词</span>"} />
<Action id="saveImageAsBtn" type="button" role="menuitem" markup={"<i data-lucide=\"download\"></i><span>另存为…</span>"} />
<div className="image-context-separator" role="separator" />
<Action id="findSimilarImageBtn" type="button" role="menuitem" markup={"<i data-lucide=\"scan-search\"></i><span>查找相似图片</span>"} />
<Action id="setCoverImageBtn" type="button" role="menuitem" hidden markup={"<i data-lucide=\"star\"></i><span>设为封面</span>"} />
<Action id="detachImageBtn" type="button" role="menuitem" hidden markup={"<i data-lucide=\"ungroup\"></i><span>移出此组</span>"} />
</div>
<div id="historyPreviewOverlay" className="history-preview-overlay" hidden>
<Action id="historyPreviewCloseBtn" className="history-icon-button" type="button" title="关闭预览" aria-label="关闭预览" markup={"<i data-lucide=\"x\"></i>"} />
<img id="historyPreviewImage" alt="" />
</div>
<SettingsPage />
<div id="toast" className="toast legacy-toast" hidden aria-hidden="true">

</div>
</main>











</>); }
