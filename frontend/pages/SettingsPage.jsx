import React from 'react';
import { Input } from '@appica/ui-react/input';
import { Textarea } from '@appica/ui-react/textarea';
import { Action, NativeSelect } from '../components';

export function SettingsPage() { return (
<section id="settingsOverlay" className="settings-page" aria-label="API 设置" hidden>
<section className="settings-sheet" aria-label="API 设置">
<div className="settings-mode-tabs" role="tablist" aria-label="API 设置类型">
<Action id="imageSettingsTab" className="settings-mode-tab active" type="button" role="tab" markup={"<i data-lucide=\"server\"></i><span>API 提供商</span>"} />
<Action id="concurrencySettingsTab" className="settings-mode-tab" type="button" role="tab" markup={"<i data-lucide=\"git-branch\"></i><span>并发策略</span>"} />
<Action id="chatSettingsTab" className="settings-mode-tab" type="button" role="tab" markup={"<i data-lucide=\"wand-sparkles\"></i><span>提示词优化</span>"} />
<Action id="networkSettingsTab" className="settings-mode-tab" type="button" role="tab" markup={"<i data-lucide=\"network\"></i><span>网络设置</span>"} />
<Action id="outputSettingsTab" className="settings-mode-tab" type="button" role="tab" markup={"<i data-lucide=\"folder-cog\"></i><span>保存目录</span>"} />
</div>
{/* Hover-expand table of contents rail; desktop.js fills it from the visible
    panel's [data-toc-title] sections. */}
<div id="settingsToc" className="settings-toc" aria-label="快速定位" hidden>

</div>
<div id="imageSettingsPanel" className="settings-panel">
<NativeSelect id="settingsPresetSelect" hidden>

</NativeSelect>
<section id="unifiedSupplierWorkspace" className="unified-supplier-workspace" aria-label="供应商与配置组" data-toc-title="供应商与配置组" data-toc-icon="server">
{/* React sub-root host: main.jsx renderSupplierManager owns everything inside. */}
<div id="unifiedSupplierList" className="unified-supplier-list">

</div>
</section>
<div className="settings-section-heading provider-list-heading">
<div>
<strong>
{"生图 API 提供商"}
</strong>
<span>
{"拖动提供商可调整相同条件下的选择顺序"}
</span>
</div>
<i data-lucide="grip-horizontal" aria-hidden="true">

</i>
</div>
<div id="settingsProviderList" className="settings-provider-list" aria-label="生图 API 配置列表（可拖拽排序）">

</div>
<div className="settings-form">
<div className="settings-form-head">
<div className="settings-form-heading-copy">
<strong id="settingsFormTitle">
{"编辑 API"}
</strong>
<span>
{"连接信息与可用模型"}
</span>
</div>
<Action id="deleteProviderBtn" className="secondary-button compact-button danger-button" type="button" markup={"<i data-lucide=\"trash-2\"></i><span>删除</span>"} />
</div>
<div className="settings-form-grid provider-identity-grid">
<label>
<span>
{"提供商名称"}
</span>
<Input inputSize="sm" id="presetNameInput" type="text" autoComplete="off" placeholder="我的 API" />
</label>
<label className="provider-enabled-field">
<span>
{"服务状态"}
</span>
<span className="switch-line">
<input id="providerEnabledToggle" type="checkbox" defaultChecked />
<span>
{"启用此提供商"}
</span>
</span>
</label>
<label className="full-field">
<span>
{"Base URL"}
</span>
<Input inputSize="sm" id="baseUrlInput" type="text" autoComplete="off" placeholder="https://api.example.com" />
</label>
<label className="full-field">
<span>
{"API Key"}
</span>
<Input inputSize="sm" id="apiKeyInput" type="password" autoComplete="off" placeholder="sk-..." />
</label>
</div>
<div className="model-section">
<div className="settings-section-heading model-section-heading">
<div>
<strong>
{"模型设置"}
</strong>
<span>
{"配置模型名称、单次价格与实际请求格式"}
</span>
</div>
<div className="model-section-heading-actions" role="group" aria-label="模型连接操作">
<Action id="testProviderBtn" className="secondary-button compact-button" type="button" markup={"<i data-lucide=\"activity\"></i><span>测试连接</span>"} />
<Action id="discoverProviderBtn" className="secondary-button compact-button" type="button" markup={"<i data-lucide=\"scan-search\"></i><span>发现模型</span>"} />
</div>
</div>
<div className="model-editor">
<div id="discoveredModelPicker" className="model-discovery-picker" hidden>
<NativeSelect id="discoveredModelSelect" aria-label="已发现模型" title="从发现结果选择模型；下方模型名称仍可手动填写">

</NativeSelect>
</div>
<div className="model-grid-head" aria-hidden="true">
<span>
{"模型"}
</span>
<span>
{"价格/张"}
</span>
<span>
{"请求格式"}
</span>
<span>

</span>
</div>
<div id="modelRows" className="model-rows">

</div>
<Action id="addModelRowBtn" className="secondary-button compact-button model-add-button" type="button" markup={"<i data-lucide=\"plus\"></i><span>新增模型</span>"} />
</div>
</div>
<div className="settings-actions">
<Action id="savePresetBtn" className="primary-button save-provider-button" type="button" markup={"<i data-lucide=\"save\"></i><span>保存提供商</span>"} />
</div>
</div>
</div>
<div id="concurrencySettingsPanel" className="settings-panel" hidden>
<div className="settings-scroll-panel">
<section className="settings-form strategy-form" data-toc-title="请求分配策略" data-toc-icon="git-branch">
<div className="settings-form-head">
<div className="settings-form-heading-copy">
<strong>
{"请求分配策略"}
</strong>
<span>
{"决定存在多个兼容提供商时如何选择请求线路"}
</span>
</div>
</div>
<NativeSelect id="providerStrategySelect" hidden>
<option value="order">
{"按顺序使用"}
</option>
<option value="priority">
{"优先级优先"}
</option>
<option value="balanced">
{"负载均衡"}
</option>
<option value="fixed">
{"指定提供商"}
</option>
<option value="price">
{"价格优先"}
</option>
<option value="speed">
{"速度优先"}
</option>
</NativeSelect>
<div className="strategy-choice-grid" role="radiogroup" aria-label="并发策略">
<label className="strategy-choice">
<input type="radio" name="providerStrategy" defaultValue="priority" />
<i data-lucide="arrow-up-wide-narrow">

</i>
<span>
<strong>
{"优先级优先"}
</strong>
<small>
{"按优先级，满载顺延"}
</small>
</span>
</label>
<label className="strategy-choice">
<input type="radio" name="providerStrategy" defaultValue="order" />
<i data-lucide="list-ordered">

</i>
<span>
<strong>
{"按顺序使用"}
</strong>
<small>
{"按列表顺序，满载顺延"}
</small>
</span>
</label>
<label className="strategy-choice">
<input type="radio" name="providerStrategy" defaultValue="balanced" />
<i data-lucide="scale">

</i>
<span>
<strong>
{"负载均衡"}
</strong>
<small>
{"选空闲组，同占用按优先级"}
</small>
</span>
</label>
<label className="strategy-choice">
<input type="radio" name="providerStrategy" defaultValue="fixed" />
<i data-lucide="pin">

</i>
<span>
<strong>
{"指定提供商"}
</strong>
<small>
{"固定一个组，满载排队"}
</small>
</span>
</label>
<label className="strategy-choice">
<input type="radio" name="providerStrategy" defaultValue="price" />
<i data-lucide="badge-dollar-sign">

</i>
<span>
<strong>
{"价格优先"}
</strong>
<small>
{"低价优先，未标价排后"}
</small>
</span>
</label>
<label className="strategy-choice">
<input type="radio" name="providerStrategy" defaultValue="speed" />
<i data-lucide="zap">

</i>
<span>
<strong>
{"速度优先"}
</strong>
<small>
{"耗时短优先，初始按顺序"}
</small>
</span>
</label>
</div>
<label id="fixedProviderField" className="full-field fixed-provider-field" hidden>
<span>
{"提供商 / 生图配置组"}
</span>
<NativeSelect id="fixedProviderSelect">

</NativeSelect>
</label>
<div id="routingRanking" className="routing-ranking" hidden aria-live="polite">

</div>
<div className="settings-form-grid concurrency-limit-grid">
<label className="full-field">
<span className="settings-field-label">
<span>
{"全局最大并发"}
</span>
<Action className="settings-help-icon" type="button" title="限制所有序列合计同时运行的任务数量" aria-label="全局最大并发说明" markup={"<i data-lucide=\"circle-help\"></i>"} />
</span>
<Input inputSize="sm" id="maxGlobalConcurrentInput" type="number" min="1" max="64" step="1" defaultValue="12" />
<small>
{"限制所有序列合计同时运行的任务数量"}
</small>
</label>
</div>
</section>
<section id="providerCapacityPanel" className="settings-form provider-capacity-form" data-toc-title="配置组并发容量" data-toc-icon="gauge">
<div className="settings-form-head">
<div className="settings-form-heading-copy">
<strong>
{"配置组并发容量"}
</strong>
<span>
{"限制每个配置组同时处理的请求数，所有策略均遵守此上限"}
</span>
</div>
</div>
<div className="settings-form-grid">
<label className="full-field">
<span>
{"提供商"}
</span>
<NativeSelect id="strategyProviderSelect">

</NativeSelect>
</label>
<label>
<span className="settings-field-label">
<span>
{"最大并发"}
</span>
<Action className="settings-help-icon" type="button" title="该提供商允许同时处理的请求数量" aria-label="提供商最大并发说明" markup={"<i data-lucide=\"circle-help\"></i>"} />
</span>
<Input inputSize="sm" id="providerConcurrencyInput" type="number" min="1" max="8" step="1" defaultValue="1" />
</label>
<label id="providerPriorityField">
<span>
{"优先级（1 为最高）"}
</span>
<Input inputSize="sm" id="providerPriorityInput" type="number" min="1" max="100" step="1" defaultValue="1" />
</label>
</div>
</section>
<section className="settings-form failover-form" data-toc-title="失败处理" data-toc-icon="shield-alert">
<div className="settings-form-head">
<div className="settings-form-heading-copy">
<strong>
{"失败处理"}
</strong>
<span>
{"请求失败后，按当前策略选择其他兼容配置组；指定提供商时不切换"}
</span>
</div>
</div>
<div className="settings-form-grid">
<label className="full-field checkbox-field">
<input id="failoverEnabledToggle" type="checkbox" defaultChecked />
<span>
{"开启失败自动换供应商"}
</span>
</label>
<label>
<span className="settings-field-label">
<span>
{"最多尝试"}
</span>
<Action className="settings-help-icon" type="button" title="单次请求失败时最多切换并尝试的提供商数量" aria-label="最多尝试次数说明" markup={"<i data-lucide=\"circle-help\"></i>"} />
</span>
<Input inputSize="sm" id="failoverMaxAttemptsInput" type="number" min="1" max="10" step="1" defaultValue="3" />
</label>
<label>
<span className="settings-field-label">
<span>
{"连续失败冷却阈值"}
</span>
<Action className="settings-help-icon" type="button" title="连续失败达到此次数后，暂时冷却该提供商" aria-label="连续失败冷却阈值说明" markup={"<i data-lucide=\"circle-help\"></i>"} />
</span>
<Input inputSize="sm" id="failoverThresholdInput" type="number" min="1" max="20" step="1" defaultValue="3" />
</label>
</div>
</section>
</div>
</div>
<div id="chatSettingsPanel" className="settings-panel" hidden>
<div className="settings-scroll-panel">
{/* Legacy chat-provider ids kept hidden so desktop.js bindings stay valid. */}
<NativeSelect id="chatSettingsPresetSelect" hidden></NativeSelect>
<div id="chatProviderList" hidden></div>
<Input id="chatProviderNameInput" type="text" hidden />
<Input id="chatProviderBaseUrlInput" type="text" hidden />
<Input id="chatProviderApiKeyInput" type="password" hidden />
<div id="chatModelRows" hidden></div>
<Action id="newChatProviderBtn" type="button" hidden markup={""} />
<Action id="deleteChatProviderBtn" type="button" hidden markup={""} />
<Action id="addChatModelRowBtn" type="button" hidden markup={""} />
<Action id="testChatProviderBtn" type="button" hidden markup={""} />
<Action id="saveChatProviderBtn" type="button" hidden markup={""} />
<strong id="chatSettingsFormTitle" hidden></strong>

<div className="settings-form" data-toc-title="提示词优化" data-toc-icon="wand-sparkles">
<div className="settings-form-head">
<div className="settings-form-heading-copy">
<strong>{"提示词优化"}</strong>
<span>{"为生图提示词自动补充主体、构图、光线、材质与风格（参考 OpenAI 图像提示指南）"}</span>
</div>
</div>
<div className="settings-form-grid">
<label className="full-field switch-row">
<span className="switch-line">
<input id="promptOptimizeEnabledToggle" type="checkbox" defaultChecked />
<span>{"启用提示词优化"}</span>
</span>
<small>{"开启后，生成区提示词框旁会出现“优化”按钮，点击即用下方系统提示词改写提示词"}</small>
</label>
<label className="full-field">
<span>{"优化使用的对话模型"}</span>
<NativeSelect id="promptOptimizeProviderSelect"></NativeSelect>
<small>{"从“API 提供商”里用途为“对话 / 提示词优化”的配置组中选择"}</small>
</label>
<label className="full-field">
<span>{"系统提示词"}</span>
<Textarea id="promptOptimizeSystemInput" rows="9" spellCheck={false} />
</label>
</div>
<div className="settings-actions">
<Action id="promptOptimizeResetBtn" className="secondary-button" type="button" markup={"<i data-lucide=\"rotate-ccw\"></i><span>恢复默认</span>"} />
<Action id="promptOptimizeSaveBtn" className="primary-button" type="button" markup={"<i data-lucide=\"save\"></i><span>保存</span>"} />
</div>
</div>
</div>
</div>
<div id="networkSettingsPanel" className="settings-panel" hidden>
<div className="settings-scroll-panel">
<div className="settings-form network-form">
<div className="settings-form-head">
<div className="settings-form-heading-copy">
<strong>
<i data-lucide="network" aria-hidden="true">

</i>
{"连接方式"}
</strong>
<span id="proxyActiveHint" className="settings-hint">

</span>
</div>
</div>
<NativeSelect id="proxyModeSelect" hidden>
<option value="direct">
{"直连"}
</option>
<option value="system">
{"系统代理"}
</option>
<option value="custom">
{"自定义代理"}
</option>
</NativeSelect>
<div className="proxy-mode-grid" role="radiogroup" aria-label="连接方式">
<label className="proxy-mode-choice">
<input type="radio" name="proxyMode" defaultValue="direct" />
<i data-lucide="unplug">

</i>
<span>
<strong>
{"直连"}
</strong>
<small>
{"绕过系统代理直接连接 API"}
</small>
</span>
</label>
<label className="proxy-mode-choice">
<input type="radio" name="proxyMode" defaultValue="system" />
<i data-lucide="monitor-cog">

</i>
<span>
<strong>
{"系统代理"}
</strong>
<small>
{"使用 Windows 当前代理设置"}
</small>
</span>
</label>
<label className="proxy-mode-choice">
<input type="radio" name="proxyMode" defaultValue="custom" />
<i data-lucide="route">

</i>
<span>
<strong>
{"自定义代理"}
</strong>
<small>
{"通过指定的 HTTP 或 SOCKS 代理连接"}
</small>
</span>
</label>
</div>
<div className="settings-form-grid">
<label className="full-field" id="proxyCustomField" hidden>
<span className="settings-field-label">
<span>
{"代理地址"}
</span>
<Action className="settings-help-icon" type="button" title="支持 HTTP 或 SOCKS 代理地址，例如 http://127.0.0.1:7890" aria-label="代理地址说明" markup={"<i data-lucide=\"circle-help\"></i>"} />
</span>
<Input inputSize="sm" id="proxyCustomInput" type="text" placeholder="http://127.0.0.1:7890" spellCheck={false} />
</label>
</div>
<div className="settings-actions">
<Action id="testProxyBtn" className="secondary-button" type="button" markup={"<i data-lucide=\"activity\"></i><span>测试连接</span>"} />

</div>
</div>
</div>
</div>
<div id="outputSettingsPanel" className="settings-panel" hidden>
<div className="settings-scroll-panel">
<div className="settings-form output-directory-form">
<div className="settings-form-head">
<div className="settings-form-heading-copy">
<strong>
{"默认保存目录"}
</strong>
<span id="outputDirectoryMode">
{"应用默认目录"}
</span>
</div>
</div>
<div className="settings-form-grid">
<label className="full-field">
<span className="settings-field-label">
<span>
{"当前目录"}
</span>
<Action className="settings-help-icon" type="button" title="生成的图片默认保存到此目录" aria-label="当前保存目录说明" markup={"<i data-lucide=\"circle-help\"></i>"} />
</span>
<Input inputSize="sm" id="outputDirectoryInput" type="text" readOnly spellCheck={false} />
</label>
</div>
<div className="settings-actions output-directory-actions">
<Action id="resetOutputDirectoryBtn" className="secondary-button" type="button" markup={"<i data-lucide=\"rotate-ccw\"></i><span>恢复默认</span>"} />
<Action id="openConfiguredOutputDirectoryBtn" className="secondary-button" type="button" markup={"<i data-lucide=\"folder-open\"></i><span>打开目录</span>"} />
<Action id="chooseOutputDirectoryBtn" className="primary-button" type="button" markup={"<i data-lucide=\"folder-search\"></i><span>选择目录</span>"} />
</div>
</div>
</div>
</div>
</section>
</section>
); }
