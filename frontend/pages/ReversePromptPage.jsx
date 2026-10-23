import React from 'react';
import { Input } from '@appica/ui-react/input';
import { Textarea } from '@appica/ui-react/textarea';
import { Action, NativeSelect } from '../components';

export function ReversePromptPage() { return (
<section id="reversePromptPage" className="reverse-prompt-page" aria-labelledby="reversePromptTitle" hidden>
<header className="reverse-prompt-header">
<div className="reverse-prompt-title-copy">
<h1 id="reversePromptTitle">
{"提示词反推"}
</h1>
<span>
{"使用提示词优化供应商分析图片"}
</span>
</div>
</header>
<div className="reverse-prompt-scroll">
<section className="reverse-prompt-section reverse-prompt-source">
<div className="reverse-prompt-section-head">
<div>
<strong>
{"待分析图片"}
</strong>
<span>
{"支持拖拽、点击或 Ctrl+V 粘贴上传一张图片"}
</span>
</div>
<Action id="reversePromptClearImageBtn" className="reverse-prompt-link-button" type="button" hidden markup={"移除"} />
</div>
<div id="reversePromptDrop" className="reverse-prompt-drop" role="button" tabIndex="0" aria-label="拖拽、粘贴或点击上传待反推图片">
<input id="reversePromptFileInput" type="file" accept="image/*" hidden />
<div id="reversePromptEmpty" className="reverse-prompt-empty">
<span className="reverse-prompt-drop-icon">
<i data-lucide="image-up">

</i>
</span>
<strong>
{"上传待分析图片"}
</strong>
<span>
{"拖入、粘贴图片或点击选择"}
</span>
</div>
<div id="reversePromptPreview" className="reverse-prompt-preview" hidden>
<img id="reversePromptPreviewImage" alt="待分析图片预览" />
<div className="reverse-prompt-image-meta">
<strong id="reversePromptImageName">

</strong>
<span id="reversePromptImageMeta">

</span>
</div>
</div>
</div>
<label className="reverse-prompt-field" htmlFor="reversePromptInstructionInput">
<span>
{"分析要求"}
</span>
<Textarea id="reversePromptInstructionInput" rows="3" spellCheck={false} placeholder="例如：重点描述构图、光线、材质和画面风格" defaultValue={"请分析这张图片，并反推出能够复现主体、构图、光线、材质和风格的生图提示词。"} />
</label>
</section>
<section className="reverse-prompt-section reverse-prompt-output">
<div className="reverse-prompt-section-head">
<div>
<strong>
{"反推结果"}
</strong>
<span id="reversePromptStatus">
{"等待上传图片"}
</span>
</div>
</div>
<div className="reverse-prompt-provider-grid">
<label className="reverse-prompt-field" htmlFor="reversePromptProviderSelect">
<span>
{"提示词优化供应商"}
</span>
<NativeSelect id="reversePromptProviderSelect">

</NativeSelect>
</label>
<label className="reverse-prompt-field" htmlFor="reversePromptModelSelect">
<span>
{"模型"}
</span>
<NativeSelect id="reversePromptModelSelect">

</NativeSelect>
</label>
</div>
<small id="reversePromptProviderMeta">
{"进入页面后加载供应商配置"}
</small>
<label className="reverse-prompt-field reverse-prompt-result-field" htmlFor="reversePromptResultInput">
<span>
{"生图提示词"}
</span>
<div id="reversePromptStream" className="prompt-stream-panel" hidden />
<Textarea id="reversePromptResultInput" rows="10" spellCheck={false} placeholder="反推结果会显示在这里" />
</label>
<div className="reverse-prompt-actions">
<Action id="reversePromptRunBtn" className="primary-button" type="button" disabled markup={"<i data-lucide=\"scan-search\"></i><span>开始反推</span>"} />
<Action id="reversePromptCopyBtn" className="secondary-button" type="button" disabled title="复制提示词" markup={"<i data-lucide=\"copy\"></i><span>复制</span>"} />
<Action id="reversePromptCreateSequenceBtn" className="secondary-button" type="button" disabled markup={"<i data-lucide=\"file-plus\"></i><span>新建序列</span>"} />
</div>
</section>
</div>
</section>
); }
