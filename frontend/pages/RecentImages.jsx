import React from 'react';
import { Input } from '@appica/ui-react/input';
import { Textarea } from '@appica/ui-react/textarea';
import { Action, NativeSelect } from '../components';

export function RecentImages() { return (
<section id="recentSection" className="recent-section">
<div className="section-head">
<div className="section-title-copy">
<label>
{"历史图片"}
</label>
<span className="recent-hint">
{"最近 10 张"}
</span>
</div>
<div className="recent-head-actions">
<Action id="recentViewToggleBtn" className="icon-button" type="button" title="切换：10 张预览 / 20 张轮播" aria-label="切换历史预览模式" markup={"<i data-lucide=\"gallery-horizontal-end\"></i>"} />
<Action id="openRecentFolderBtn" className="icon-button" type="button" title="打开输出文件夹" aria-label="打开输出文件夹" markup={"<i data-lucide=\"folder-open\"></i>"} />
</div>
</div>
<div id="recentImages" className="recent-images">
<div className="empty-state">
{"暂无图片"}
</div>
</div>
</section>
); }
