import React from 'react';
import { Input } from '@appica/ui-react/input';
import { Textarea } from '@appica/ui-react/textarea';
import { Action, NativeSelect } from '../components';

export function QueuePage() { return (
<section id="queuePage" className="queue-page" aria-labelledby="queueTitle" hidden>
<header className="queue-header">
<div className="queue-title-copy">
<h1 id="queueTitle">
{"队列管理"}
</h1>
<span id="queueMeta" className="queue-count">
{"0 个任务"}
</span>
</div>
<div className="queue-header-actions">
<Action id="refreshQueueBtn" className="queue-toolbar-button" type="button" title="刷新队列" markup={"\n                                <i data-lucide=\"refresh-cw\"></i><span>刷新</span>\n                            "} />
<Action id="cancelAllTasksBtn" className="queue-toolbar-button danger" type="button" title="取消全部任务" markup={"\n                                <i data-lucide=\"square-x\"></i><span>全部取消</span>\n                            "} />
</div>
</header>
<section className="queue-stats" aria-label="队列状态统计">
<article className="queue-stat-card running">
<span className="queue-stat-icon">
<i data-lucide="play">

</i>
</span>
<span className="queue-stat-copy">
<small>
{"运行中"}
</small>
<strong id="queueRunningCount">
{"0"}
</strong>
</span>
</article>
<article className="queue-stat-card pending">
<span className="queue-stat-icon">
<i data-lucide="clock-3">

</i>
</span>
<span className="queue-stat-copy">
<small>
{"等待中"}
</small>
<strong id="queuePendingCount">
{"0"}
</strong>
</span>
</article>
</section>
<div className="queue-list-head" aria-hidden="true">
<span>
{"任务信息"}
</span>
<span>
{"状态 / 供应商"}
</span>
<span>
{"操作"}
</span>
</div>
<div id="queueList" className="queue-list" aria-live="polite">
<div className="queue-empty">
<i data-lucide="list-todo">

</i>
<strong>
{"暂无任务"}
</strong>
<span>
{"开始生成图片后，任务将显示在这里"}
</span>
</div>
</div>
</section>
); }
