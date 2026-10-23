import React from 'react';
import { Input } from '@appica/ui-react/input';
import { Textarea } from '@appica/ui-react/textarea';
import { Action, NativeSelect } from '../components';

export function HistoryPage() { return (
<section id="historyPage" className="history-page" aria-labelledby="historyTitle" hidden>
<header className="history-header">
<div className="history-title-copy">
<h1 id="historyTitle">
{"历史图片"}
</h1>
<span id="historyCount" className="history-count">
{"0 张"}
</span>
</div>
<Action id="openOutputFolderBtn" className="history-icon-button" type="button" title="打开输出文件夹" aria-label="打开输出文件夹" markup={"\n                            <i data-lucide=\"folder-open\"></i>\n                        "} />
</header>
<div className="history-toolbar">
<label className="history-search" htmlFor="historySearchInput">
<i data-lucide="search">

</i>
<Input inputSize="sm" id="historySearchInput" type="search" placeholder="搜索提示词、文件名、模型、比例" title={"空格分隔：同时包含多个词\n\"引号\"：按整句匹配\n-词：排除包含该词的图片"} autoComplete="off" />
<Action id="historySearchClearBtn" type="button" title="清空搜索" aria-label="清空搜索" hidden markup={"<i data-lucide=\"x\"></i>"} />
<Action id="historyImageSearchBtn" type="button" title={"以图搜图：选择一张图片，或把图片拖到搜索框、在搜索框里粘贴"} aria-label="以图搜图" markup={"<i data-lucide=\"image-up\"></i>"} />
</label>
<input id="historyImageSearchInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/tiff" hidden />
<div id="historyFilterControls" className="history-filter-controls-host"></div>
<div className="history-layout-toggle" role="group" aria-label="布局方式">
<Action id="historyGridBtn" className="icon-button active" type="button" title="网格视图" aria-label="网格视图" aria-pressed="true" markup={"<i data-lucide=\"layout-grid\"></i>"} />
<Action id="historyListBtn" className="icon-button" type="button" title="列表视图" aria-label="列表视图" aria-pressed="false" markup={"<i data-lucide=\"list\"></i>"} />
<Action id="historySimilarBtn" className="icon-button" type="button" title="相似图片（提示词＋画面）" aria-label="相似图片" aria-pressed="false" markup={"<i data-lucide=\"group\"></i>"} />
</div>
<div id="historyFilterPanel" className="history-filter-panel-host"></div>
<div id="historySimilarToolbar" className="history-similar-toolbar" hidden>
<NativeSelect id="historySimilarPreset" aria-label="相似程度" defaultValue="standard">
<option value="strict">
{"严格"}
</option>
<option value="standard">
{"标准"}
</option>
<option value="loose">
{"宽松"}
</option>
</NativeSelect>
<NativeSelect id="historySimilarSort" aria-label="分组排序">
<option value="recent">
{"最近活动"}
</option>
<option value="size">
{"数量"}
</option>
</NativeSelect>
<label className="similar-singles-switch" htmlFor="historySimilarSingles">
<input id="historySimilarSingles" type="checkbox" />
<span>
{"显示单张"}
</span>
</label>
<p id="historySimilarStatus" className="similar-status" aria-live="polite"></p>
<div id="historySimilarProgress" className="similar-progress" hidden>
<span></span>
</div>
</div>
</div>
<div id="historyImages" className="history-gallery grid-layout">
<div className="history-empty">
<i data-lucide="images">

</i>
<span>
{"暂无历史图片"}
</span>
</div>
</div>
<div id="historyDragTrash" className="history-drag-trash" aria-hidden="true" hidden>
<i data-lucide="trash-2"></i>
<span>
{"松手放入回收站"}
</span>
</div>
<div id="historyTrashResult" className="history-trash-result" role="status" hidden>
<span id="historyTrashResultText" className="history-trash-result-text"></span>
<Action id="historyTrashUndoBtn" type="button" hidden markup={"撤销"} />
<Action id="historyTrashOpenBinBtn" type="button" markup={"打开回收站"} />
<Action id="historyTrashRetryBtn" type="button" hidden markup={"重试"} />
<Action id="historyTrashDismissBtn" className="history-icon-button" type="button" title="关闭" aria-label="关闭" markup={"<i data-lucide=\"x\"></i>"} />
</div>
<footer id="historySelectionBar" className="history-selection-bar" hidden>
<span id="historySelectionMeta">
{"已选择 0 张"}
</span>
<div className="history-selection-actions">
<label id="historyTrashProtectedToggle" className="history-trash-protected" htmlFor="historyTrashIncludeProtected" hidden>
<input id="historyTrashIncludeProtected" type="checkbox" />
<span id="historyTrashProtectedText">
{"同时删除拖用过的"}
</span>
</label>
<Action id="historySelectAllBtn" type="button" markup={"全选"} />
<Action id="historyInvertBtn" type="button" markup={"反选"} />
<Action id="historyClearSelectionBtn" type="button" markup={"清除"} />
<Action id="historyTrashBtn" className="danger" type="button" title="移到回收站（可在左侧回收站中还原）" markup={"<i data-lucide=\"trash-2\"></i><span>移到回收站</span>"} />
</div>
</footer>
<section id="historyDetailDrawer" className="history-detail-drawer" aria-label="图片详情" data-mode="compact" hidden>
<header className="history-detail-head">
<div id="historyDetailSummary" className="history-detail-summary">

</div>
<div className="history-detail-tabs" role="tablist" aria-label="详情分类">
<Action className="active" type="button" role="tab" data-history-tab="details" aria-selected="true" markup={"详情"} />
<Action type="button" role="tab" data-history-tab="prompt" aria-selected="false" markup={"提示词"} />
<Action type="button" role="tab" data-history-tab="metadata" aria-selected="false" markup={"元数据"} />
</div>
<Action id="historyDetailExpandBtn" className="history-icon-button" type="button" title="展开详情" aria-label="展开详情" aria-expanded="false" markup={"<i data-lucide=\"chevron-up\"></i>"} />
<Action id="historyDetailCloseBtn" className="history-icon-button" type="button" title="关闭详情" aria-label="关闭详情" markup={"<i data-lucide=\"x\"></i>"} />
</header>
<div id="historyDetailBody" className="history-detail-body">

</div>
<div className="history-detail-actions">
<Action id="historyReferenceBtn" type="button" title="发送到参考图" markup={"<i data-lucide=\"image-plus\"></i><span>发送到参考图</span>"} />
<Action id="historySaveBtn" type="button" title="另存为…" markup={"<i data-lucide=\"download\"></i><span>另存为…</span>"} />
<Action id="historyReverseBtn" type="button" title="复制提示词" markup={"<i data-lucide=\"clipboard-type\"></i><span>复制提示词</span>"} />
<Action id="historyEditBtn" type="button" title="局部编辑" markup={"<i data-lucide=\"scan-line\"></i><span>局部编辑</span>"} />
<Action id="historyFindSimilarBtn" type="button" title="查找与这张图相似的图片" markup={"<i data-lucide=\"scan-search\"></i><span>查找相似</span>"} />
<Action id="historyDetailTrashBtn" className="danger" type="button" title="移到回收站（可撤销）" markup={"<i data-lucide=\"trash-2\"></i><span>移到回收站</span>"} />
</div>
</section>
</section>
); }
