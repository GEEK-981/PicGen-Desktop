import React from 'react';
import { Input } from '@appica/ui-react/input';
import { Textarea } from '@appica/ui-react/textarea';
import { Action, NativeSelect } from '../components';

export function ErrorLogsPage() { return (
<section id="errorLogsPage" className="error-logs-page" aria-labelledby="errorLogsTitle" hidden>
<header className="error-logs-header">
<div className="error-logs-title-copy">
<h1 id="errorLogsTitle">
{"错误日志"}
</h1>
<span id="errorLogsMeta" className="error-logs-count">
{"最近 7 天 · 0 条"}
</span>
</div>
<div className="error-logs-header-actions">
<Action id="refreshErrorLogsBtn" className="error-log-toolbar-button" type="button" title="刷新日志" markup={"\n                                <i data-lucide=\"refresh-cw\"></i><span>刷新</span>\n                            "} />
<Action id="clearErrorLogsBtn" className="error-log-toolbar-button danger" type="button" title="清空日志" markup={"\n                                <i data-lucide=\"trash-2\"></i><span>清空</span>\n                            "} />
</div>
</header>
<div className="error-logs-toolbar">
<label className="error-logs-search" htmlFor="errorLogsSearchInput">
<i data-lucide="search">

</i>
<Input inputSize="sm" id="errorLogsSearchInput" type="search" placeholder="搜索错误、模型或任务 ID" autoComplete="off" />
<Action id="errorLogsSearchClearBtn" type="button" title="清空搜索" aria-label="清空搜索" hidden markup={"<i data-lucide=\"x\"></i>"} />
</label>
<div className="error-logs-filter-row">
<NativeSelect id="errorLogsSourceFilter" aria-label="按错误来源筛选">
<option value="">
{"全部来源"}
</option>
<option value="generation">
{"图片生成"}
</option>
<option value="provider">
{"API 提供商"}
</option>
<option value="prompt">
{"提示词优化"}
</option>
<option value="network">
{"网络"}
</option>
<option value="storage">
{"本地存储"}
</option>
<option value="renderer">
{"界面"}
</option>
<option value="system">
{"系统"}
</option>
</NativeSelect>
<NativeSelect id="errorLogsTimeFilter" aria-label="按时间筛选">
<option value="24h">
{"最近 24 小时"}
</option>
<option value="7d">
{"最近 7 天"}
</option>
<option value="all">
{"全部保留日志"}
</option>
</NativeSelect>
</div>
</div>
<section className="error-logs-stats" aria-label="错误日志统计">
<div>
<small>
{"24 小时"}
</small>
<strong id="errorLogsDayCount">
{"0"}
</strong>
</div>
<div>
<small>
{"错误条目"}
</small>
<strong id="errorLogsTotalCount">
{"0"}
</strong>
</div>
<div>
<small>
{"重复次数"}
</small>
<strong id="errorLogsRepeatCount">
{"0"}
</strong>
</div>
</section>
<div id="errorLogsList" className="error-logs-list" aria-live="polite">
<div className="error-logs-empty">
<i data-lucide="circle-check-big">

</i>
<strong>
{"最近没有错误"}
</strong>
<span>
{"运行异常会自动记录在这里"}
</span>
</div>
</div>
</section>
); }
