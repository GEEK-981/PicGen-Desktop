import React from 'react';
import { Action } from '../components';

// In-app recycle bin. React owns the structure; desktop.js owns #historyBinImages (tiles) and
// every text/hidden state below.
export function HistoryBinPage() { return (
<section id="historyBinPage" className="history-page history-bin-page" aria-labelledby="historyBinTitle" hidden>
<header className="history-header">
<div className="history-title-copy">
<h1 id="historyBinTitle">
{"回收站"}
</h1>
<span id="historyBinCount" className="history-count">
{"0 张"}
</span>
</div>
</header>
<div className="history-bin-toolbar">
<p className="history-bin-hint">
{"这里的图片不会出现在历史和相似分组中。清空后文件会被永久删除，无法找回。"}
</p>
<div className="history-bin-actions">
<Action id="historyBinRestoreAllBtn" type="button" markup={"<i data-lucide=\"undo-2\"></i><span>全部还原</span>"} />
<Action id="historyBinEmptyBtn" className="danger" type="button" markup={"<i data-lucide=\"trash-2\"></i><span>清空回收站</span>"} />
</div>
</div>
<div id="historyBinImages" className="history-gallery grid-layout history-bin-gallery">

</div>
<footer id="historyBinSelectionBar" className="history-selection-bar" hidden>
<span id="historyBinSelectionMeta">
{"已选择 0 张"}
</span>
<div className="history-selection-actions">
<Action id="historyBinSelectAllBtn" type="button" markup={"全选"} />
<Action id="historyBinClearSelectionBtn" type="button" markup={"清除"} />
<Action id="historyBinRestoreBtn" type="button" markup={"<i data-lucide=\"undo-2\"></i><span>还原</span>"} />
<Action id="historyBinDeleteBtn" className="danger" type="button" markup={"<i data-lucide=\"trash-2\"></i><span>永久删除</span>"} />
</div>
</footer>
</section>
); }
