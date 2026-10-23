import React from 'react';
import { Input } from '@appica/ui-react/input';
import { Textarea } from '@appica/ui-react/textarea';
import { Action, NativeSelect } from '../components';

export function GenerationWorkspace() { return (
<section id="generatorWorkspace" className="workspace">
<div className="prompt-shell">
<div className="sequence-head">
<label htmlFor="promptInput">
{"提示词"}
</label>
<div className="sequence-tools">
<span id="taskStatus" className="task-status">
{"就绪"}
</span>
<Action id="clearPromptBtn" className="icon-button" type="button" title="清空提示词和参考图" aria-label="清空提示词和参考图" markup={"<i data-lucide=\"trash-2\"></i>"} />
{/* 图标是空的控制器宿主：优化进行中要换成 Appica Spinner，而 React 不该重新
    协调这块子树（`Action` 的 markup 是常量，见 components.jsx 的说明）。
    #optimizePromptIcon 由 desktop.js 通过 renderOptimizeIcon 挂子根填充。 */}
{/* 全局提示词开关的空宿主：desktop.js 通过 renderGlobalPrompt 挂 React 子根。 */}
<span id="globalPromptHost" className="global-prompt-host"></span>
<Action id="optimizePromptBtn" className="secondary-button compact-button" type="button" markup={"<span id=\"optimizePromptIcon\" class=\"optimize-prompt-icon\"></span><span id=\"optimizePromptLabel\">优化</span>"} />
</div>
</div>
<div className="prompt-input-row">
<div id="promptInput" className="prompt-input" contentEditable={true} role="textbox" aria-multiline="true" aria-label="当前序列提示词" data-placeholder="输入要生成的画面描述，输入 @ 引用已上传参考图..." spellCheck={false}>

</div>
{/* 参考图组：提示词右下角的照片堆（上传按钮 + 压叠缩略图，点开横向展开）。
    宿主由 desktop.js 控制，React 子根（renderReferenceStack）负责内部渲染。 */}
<div id="referenceRail" className="reference-corner">
<div id="referenceStack" className="reference-stack-host">

</div>
<input id="referenceFileInput" type="file" accept="image/*" multiple hidden />
</div>
{/* 拖图提示层（上下两区，整行宽）：上=读图片里的提示词，底部带=加参考图。分界线由
    desktop.js 的 promptDropBandTop 算出、写进 --prompt-drop-band，命中判定用的是同一条线。
    pointer-events:none，事件落在下面的 promptInput / referenceRail 上。 */}
<div id="promptDropOverlay" className="prompt-drop-overlay" hidden>
<div className="prompt-drop-zone prompt-drop-zone-prompt">
<span className="prompt-drop-hint prompt-drop-hint-prompt">
<i data-lucide="scan-text"></i>
{"松手读取图片提示词"}
</span>
</div>
<div className="prompt-drop-zone prompt-drop-zone-reference">
<span className="prompt-drop-hint prompt-drop-hint-reference">
<i data-lucide="image-plus"></i>
{"松手添加为参考图"}
</span>
</div>
</div>
</div>
<div id="mentionMenu" className="mention-menu" role="listbox" hidden>

</div>
</div>
{/* 提示词优化不再有自己的结果面板：结果直接就地覆盖 #promptInput。
    `.prompt-stream-panel` 样式保留给反推页的 #reversePromptStream。 */}
<div id="pendingMaskPanel" className="pending-mask-panel" hidden>
<img id="pendingMaskThumb" alt="待局部编辑的图片与涂抹区域" />
<div><strong>局部编辑</strong><span>填写修改要求后点击生成 · 每次 1 张</span></div>
<Action id="cancelMaskEditBtn" type="button" className="compact-button" markup="取消" />
</div>

{/* 设置浮层面板。常驻 DOM（仅 hidden 切换），保证 desktop.js 在 init 时能按 id
    缓存并桥接这些 select。供应商+模型已并入画面面板。 */}
<div id="prefsPanelImage" className="generation-prefs-panel" role="dialog" aria-label="供应商与画面" hidden>
<div className="prefs-section">
<div className="prefs-field-row">
<label className="prefs-stack-field">
<span className="prefs-section-label">{"供应商"}</span>
<NativeSelect id="providerSelect" aria-label="生图供应商">

</NativeSelect>
</label>
<label className="prefs-stack-field">
<span className="prefs-section-label">{"模型"}</span>
<NativeSelect id="modelSelect">

</NativeSelect>
</label>
</div>
</div>
<div className="prefs-section">
<span className="prefs-section-label">{"选择比例"}</span>
{/* 内联比例网格（Tabs 样式）。由 desktop.js 从隐藏的 #ratioSelect 选项渲染，
    点击写回 #ratioSelect 并触发既有逻辑。 */}
<div id="ratioGrid" className="ratio-grid" role="group" aria-label="图片比例"></div>
<div id="ratioField" className="ratio-field">
<span id="ratioLabelWrap" className="main-field-label" title="图片宽高比">
<span id="ratioLabel">
{"比例"}
</span>
</span>
<NativeSelect id="ratioSelect" aria-label="图片比例">
<option value="1:1">
{"1:1"}
</option>
<option value="1:4">
{"1:4"}
</option>
<option value="1:8">
{"1:8"}
</option>
<option value="2:3">
{"2:3"}
</option>
<option value="3:2">
{"3:2"}
</option>
<option value="3:4">
{"3:4"}
</option>
<option value="4:1">
{"4:1"}
</option>
<option value="4:3">
{"4:3"}
</option>
<option value="4:5">
{"4:5"}
</option>
<option value="5:4">
{"5:4"}
</option>
<option value="8:1">
{"8:1"}
</option>
<option value="9:16">
{"9:16"}
</option>
<option value="16:9">
{"16:9"}
</option>
<option value="21:9">
{"21:9"}
</option>
</NativeSelect>
</div>
</div>
<div className="prefs-section">
{/* 分辨率 + 数量 并排，均为 Appica Slider（由 desktop.js 从隐藏的原生 select 渲染）。 */}
<div className="prefs-slider-row">
<div className="prefs-slider-field" id="imageSizeSliderField">
<span className="prefs-field-label">{"分辨率"}</span>
<div id="imageSizeSliderHost" className="option-slider-host"></div>
</div>
<div className="prefs-slider-field">
<span className="prefs-field-label">{"数量"}</span>
<div id="countSliderHost" className="option-slider-host"></div>
</div>
</div>
{/* 隐藏的原生下拉，仅供 desktop.js 读写/持久化。 */}
<label id="imageSizeField" className="prefs-hidden-field">
<NativeSelect id="imageSizeSelect">
<option value="1K">{"1K"}</option>
<option value="2K">{"2K"}</option>
<option value="4K">{"4K"}</option>
</NativeSelect>
</label>
<label className="prefs-hidden-field">
<NativeSelect id="countSelect">
<option value="1">{"1"}</option>
<option value="2">{"2"}</option>
<option value="4">{"4"}</option>
<option value="5">{"5"}</option>
</NativeSelect>
</label>
{/* 自定义分辨率：仅当分辨率选“自定义”时出现（可见性由 updateAdvancedSettingsVisibility
    按 data-api-control="customSize" 控制）。输入后自动取最接近的 16 倍数。 */}
<div className="custom-size-row">
<label data-api-control="customSize" className="prefs-slider-field">
<span className="prefs-field-label">{"自定义宽"}</span>
<Input inputSize="sm" id="gptImageWidthInput" type="number" min="256" max="3840" step="16" placeholder="16 的倍数" />
</label>
<label data-api-control="customSize" className="prefs-slider-field">
<span className="prefs-field-label">{"自定义高"}</span>
<Input inputSize="sm" id="gptImageHeightInput" type="number" min="256" max="3840" step="16" placeholder="16 的倍数" />
</label>
</div>
</div>
</div>

<div id="prefsPanelAdvanced" className="generation-prefs-panel" role="dialog" aria-label="高级设置" hidden>
<details className="advanced-settings" open>
<summary>
<span className="advanced-summary-label">
<i data-lucide="sliders-horizontal">

</i>
<span>
{"高级设置"}
</span>
</span>
<span className="advanced-summary-hint">
{"模型支持的可选参数"}
</span>
</summary>
<div className="advanced-grid">
<label data-api-control="outputFormat">
<span>
{"输出格式"}
</span>
<NativeSelect id="outputMimeSelect">
<option value="">
{"默认"}
</option>
<option value="image/png">
{"PNG"}
</option>
<option value="image/jpeg">
{"JPEG"}
</option>
<option value="image/webp">
{"WebP"}
</option>
</NativeSelect>
</label>
<label data-api-control="compression">
<span>
{"压缩"}
<b id="imageCompressionValue">
{"80"}
</b>
</span>
<input id="imageCompressionRange" type="range" min="0" max="100" step="1" defaultValue="80" />
</label>
<label data-api-control="quality">
<span>
{"质量"}
</span>
<NativeSelect id="gptQualitySelect">
<option value="auto">
{"auto"}
</option>
<option value="low">
{"low"}
</option>
<option value="medium">
{"medium"}
</option>
<option value="high">
{"high"}
</option>
</NativeSelect>
</label>
<label data-api-control="background">
<span>
{"背景"}
</span>
<NativeSelect id="gptBackgroundSelect">
<option value="auto">
{"auto"}
</option>
<option value="opaque">
{"opaque"}
</option>
<option value="transparent">
{"transparent"}
</option>
</NativeSelect>
</label>
<label data-api-control="moderation">
<span>
{"审核"}
</span>
<NativeSelect id="openAIModerationSelect">
<option value="auto">
{"auto"}
</option>
<option value="low">
{"low"}
</option>
</NativeSelect>
</label>
<label data-api-control="responseFormat">
<span>
{"响应格式"}
</span>
<NativeSelect id="nativeResponseFormatSelect">
<option value="">
{"默认"}
</option>
<option value="url">
{"URL"}
</option>
<option value="b64_json">
{"Base64"}
</option>
</NativeSelect>
</label>
<label data-api-control="style">
<span>
{"风格"}
</span>
<NativeSelect id="openAIStyleSelect">
<option value="">
{"默认"}
</option>
<option value="vivid">
{"vivid"}
</option>
<option value="natural">
{"natural"}
</option>
</NativeSelect>
</label>
<label data-api-control="inputFidelity">
<span>
{"参考图保真"}
</span>
<NativeSelect id="inputFidelitySelect">
<option value="">
{"默认"}
</option>
<option value="low">
{"low"}
</option>
<option value="high">
{"high"}
</option>
</NativeSelect>
</label>
<label data-api-control="apiUser">
<span>
{"用户标识"}
</span>
<Input inputSize="sm" id="apiUserInput" type="text" maxLength="128" placeholder="可选 user" />
</label>
<label data-api-control="responseModalities">
<span>
{"响应"}
</span>
<NativeSelect id="responseModalitiesSelect">
<option value="TEXT_IMAGE">
{"TEXT + IMAGE"}
</option>
<option value="IMAGE">
{"IMAGE only"}
</option>
</NativeSelect>
</label>
<label data-api-control="thinkingLevel">
<span>
{"思考级别"}
</span>
<NativeSelect id="thinkingLevelSelect">
<option value="default">
{"默认"}
</option>
<option value="minimal">
{"Minimal"}
</option>
<option value="high">
{"High"}
</option>
</NativeSelect>
</label>
<label className="checkbox-field" data-api-control="includeThoughts">
<input id="includeThoughtsToggle" type="checkbox" />
<span>
{"输出思考"}
</span>
</label>
<label data-api-control="temperature">
<span>
{"Temperature"}
</span>
<Input inputSize="sm" id="temperatureInput" type="number" min="0" max="2" step="0.1" placeholder="默认" />
</label>
<label data-api-control="topP">
<span>
{"Top P"}
</span>
<Input inputSize="sm" id="topPInput" type="number" min="0" max="1" step="0.05" placeholder="默认" />
</label>
<label data-api-control="topK">
<span>
{"Top K"}
</span>
<Input inputSize="sm" id="topKInput" type="number" min="1" max="100" step="1" placeholder="默认" />
</label>
<label className="checkbox-field" data-api-control="googleSearch">
<input id="googleSearchToggle" type="checkbox" />
<span>
{"Google 网页搜索"}
</span>
</label>
<label className="checkbox-field" data-api-control="imageSearch">
<input id="imageSearchToggle" type="checkbox" />
<span>
{"Google 图片搜索"}
</span>
</label>
<label className="checkbox-field" data-api-control="xaiStorage">
<input id="xaiStoreToggle" type="checkbox" />
<span>
{"存入 xAI Files"}
</span>
</label>
<label data-api-control="xaiStorageOption">
<span>
{"存储文件名"}
</span>
<Input inputSize="sm" id="xaiFilenameInput" type="text" maxLength="255" placeholder="generated-image.jpg" />
</label>
<label data-api-control="xaiStorageOption">
<span>
{"过期秒数"}
</span>
<Input inputSize="sm" id="xaiExpiresAfterInput" type="number" min="1" max="2592000" step="1" placeholder="永久" />
</label>
<label className="checkbox-field" data-api-control="xaiStorageOption">
<input id="xaiPublicUrlToggle" type="checkbox" />
<span>
{"创建公开 URL"}
</span>
</label>
</div>
</details>
</div>

<div id="referenceRatioPicker" className="reference-ratio-picker" role="dialog" aria-label="选择参考图比例" hidden>
<div className="reference-ratio-picker-head">
<strong>选择参考图比例</strong>
<button id="referenceRatioPickerClose" type="button" aria-label="关闭参考图比例选择">×</button>
</div>
<p className="reference-ratio-picker-hint">选择一张参考图，自动匹配最接近的可用比例</p>
<div id="referenceRatioOptions" className="reference-ratio-options"></div>
<p id="referenceRatioEmpty" className="reference-ratio-empty" hidden>请先上传参考图</p>
</div>
{/* 三个横向设置入口（Appica Menubar 样式）：供应商&模型 / 比例&分辨率&数量 / 高级设置。
    位于参考图下方、生图按钮上方。供应商/画面显示当前值、悬停自动弹出；高级点击打开。 */}
<div className="prompt-tools-row" role="menubar" aria-label="生成设置">
{/* 供应商已整合进画面：该按钮显示当前供应商，打开供应商+模型+比例+分辨率+数量。 */}
<Action id="prefsBtnImage" className="prefs-tab" type="button" role="menuitem" title="供应商 / 模型 / 比例 / 分辨率 / 数量" aria-haspopup="dialog" markup={"<i data-lucide=\"server\"></i><b class=\"prefs-tab-value\" id=\"prefsValueProvider\"></b>"} />
<Action id="prefsBtnAdvanced" className="prefs-tab prefs-tab-icononly" type="button" role="menuitem" title="高级设置" aria-haspopup="dialog" markup={"<i data-lucide=\"sliders-horizontal\"></i><span class=\"prefs-tab-label\">高级</span>"} />
</div>
<div className="action-row">
<Action id="generateBtn" className="primary-button" type="button" markup={"<i data-lucide=\"sparkles\"></i><span>生成</span>"} />
<Action id="stopBtn" className="secondary-button" type="button" disabled markup={"<i data-lucide=\"square\"></i><span>停止</span>"} />
</div>
<div className="batch-progress" aria-label="生成进度">
<div className="batch-progress-head">
<span id="batchProgressText">
{"当前无任务"}
</span>
<span id="batchProgressCount">
{"0 / 0"}
</span>
</div>
<div className="batch-progress-track">
<div id="batchProgressBar" className="batch-progress-bar">

</div>
</div>
</div>
</section>
); }
