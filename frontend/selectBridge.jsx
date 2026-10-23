import React, { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
} from '@appica/ui-react/select';

const records = new Map();
let nextId = 0;

function RatioValue({ value, label }) {
  if (String(value) === 'reference') {
    return <span className="appica-ratio-value"><span className="appica-ratio-icon appica-ratio-reference-icon" aria-hidden="true">↗</span><span className="appica-ratio-label">{label}</span></span>;
  }
  const match = String(value).match(/^(\d+)[:x](\d+)$/i);
  const scale = match ? Math.min(20 / Number(match[1]), 16 / Number(match[2])) : 0;
  return <span className="appica-ratio-value"><span className="appica-ratio-icon" aria-hidden="true">{match && <span className="appica-ratio-shape"
    style={{ width: Math.max(3, Number(match[1]) * scale), height: Math.max(3, Number(match[2]) * scale) }} />}</span><span className="appica-ratio-label">{label}</span></span>;
}

function ModelValue({ value, label }) {
  const normalized = String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
  const google = normalized.includes('gemini') || normalized.includes('nanobanana');
  const openai = normalized.includes('gpt') || normalized.includes('dalle');
  const grok = normalized.includes('grok');
  // Seedance/Seedream are ByteDance image models; LobeHub provides the
  // official Doubao mark for that model family.
  const doubao = normalized.includes('seedance') || normalized.includes('seedream') || normalized.includes('doubao');
  const brand = google ? 'google' : openai ? 'openai' : grok ? 'grok' : doubao ? 'doubao' : '';
  const icon = google ? 'gemini-color' : openai ? 'openai' : grok ? 'grok' : 'doubao-color';
  return <span className={`model-value${brand ? ` model-brand-${brand}` : ''}`}>
    {brand && <img className={`model-brand-mark model-brand-${brand}-mark`} src={`assets/model-icons/${icon}.svg`} alt="" aria-hidden="true" />}
    <span>{label}</span>
  </span>;
}

function ratioOrientation(value) {
  const match = String(value || '').match(/^(\d+)[:x](\d+)$/i);
  if (!match) return 'horizontal';
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width === height) return 'square';
  return width > height ? 'horizontal' : 'vertical';
}

function RatioOptions({ options }) {
  const groups = {
    square: options.filter(option => ratioOrientation(option.value) === 'square'),
    horizontal: options.filter(option => option.value !== 'reference' && ratioOrientation(option.value) === 'horizontal'),
    vertical: options.filter(option => ratioOrientation(option.value) === 'vertical'),
    special: options.filter(option => option.value === 'reference'),
  };
  const renderOption = (option, index) => (
    <SelectItem
      key={`${option.value}-${index}`}
      className="modern-select-option appica-select-option"
      value={option.value}
      disabled={option.disabled}
      data-modern-value={option.value}
    >
      <RatioValue value={option.value} label={option.label} />
    </SelectItem>
  );
  return <>
    {groups.special.length > 0 && <SelectGroup className="ratio-picker-group ratio-picker-group-special">
      <SelectGroupLabel>参考图</SelectGroupLabel>
      {groups.special.map(renderOption)}
    </SelectGroup>}
    {groups.square.length > 0 && <SelectGroup className="ratio-picker-group ratio-picker-group-square">
      <SelectGroupLabel>方形</SelectGroupLabel>
      {groups.square.map(renderOption)}
    </SelectGroup>}
    {groups.horizontal.length > 0 && <SelectGroup className="ratio-picker-group ratio-picker-group-horizontal">
      <SelectGroupLabel>横向</SelectGroupLabel>
      {groups.horizontal.map(renderOption)}
    </SelectGroup>}
    {groups.vertical.length > 0 && <SelectGroup className="ratio-picker-group ratio-picker-group-vertical">
      <SelectGroupLabel>竖向</SelectGroupLabel>
      {groups.vertical.map(renderOption)}
    </SelectGroup>}
  </>;
}

function SelectControl({ record }) {
  const snapshot = useSyncExternalStore(record.subscribe, record.getSnapshot);
  const selected = snapshot.options.find(item => item.value === snapshot.value);
  return <Select size="sm" value={snapshot.value} disabled={snapshot.disabled} open={snapshot.open}
    alignItemWithTrigger={false} onOpenChange={record.setOpen}
    onValueChange={(value, details) => {
      if (value === null) return;
      // Forward genuine user commits only. When options churn (e.g. a selected
      // model row is renamed out of the list), Base UI emits a programmatic
      // correction with reason 'none' — writing that back would silently change
      // the setting. User selections carry item-press/keyboard reasons.
      if (details?.reason === 'none') return;
      record.select.value = String(value);
      record.select.dispatchEvent(new Event('change', { bubbles: true }));
    }}>
    <SelectTrigger className="modern-select-trigger appica-select-trigger" title={selected?.label || '暂无选项'}
      aria-label={`${record.label}：${selected?.label || '暂无选项'}`}>
      <SelectValue><span className="appica-select-value">{record.select.id === 'ratioSelect' ? <RatioValue value={snapshot.value} label={selected?.label || '暂无选项'} /> : /model.*select$/i.test(record.select.id) ? <ModelValue value={snapshot.value} label={selected?.label || '暂无选项'} /> : (selected?.label || '暂无选项')}</span></SelectValue>
    </SelectTrigger>
    <SelectContent id={`${record.select.id}ModernMenu`} className={`modern-select-menu appica-select-menu${record.select.id === 'ratioSelect' ? ' ratio-picker-menu' : ''}`}
      sideOffset={5} align="start" positionerProps={{ className: 'appica-select-positioner' }}>
      {record.select.id === 'ratioSelect' ? <RatioOptions options={snapshot.options} /> : snapshot.options.map((option, index) => <SelectItem key={`${option.value}-${index}`}
        className="modern-select-option appica-select-option" value={option.value}
        disabled={option.disabled} data-modern-value={option.value}>{/model.*select$/i.test(record.select.id) ? <ModelValue value={option.value} label={option.label} /> : option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}

function createRecord(select, label) {
  let wrapper = select.parentElement;
  if (!wrapper.classList.contains('appica-select-field')) {
    wrapper = document.createElement('div');
    wrapper.className = 'modern-select appica-select-field';
    select.before(wrapper);
    wrapper.append(select);
    wrapper.append(document.createElement('div'));
    wrapper.lastElementChild.className = 'appica-select-host';
  }
  wrapper.dataset.selectId = select.id;
  select.classList.add('modern-select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const listeners = new Set();
  const record = {
    select, label, wrapper, snapshot: null, open: false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot() { return record.snapshot; },
    setOpen(open) {
      if (open) closeSelects(select);
      record.open = open;
      record.refresh();
    },
    refresh() {
      const snapshot = {
        value: select.value, disabled: select.disabled, open: record.open && !select.disabled,
        options: Array.from(select.options, option => ({ value: option.value, label: option.textContent, disabled: option.disabled })),
      };
      if (JSON.stringify(snapshot) === JSON.stringify(record.snapshot)) return;
      record.snapshot = snapshot;
      listeners.forEach(listener => listener());
    },
  };
  // Native property writes do not emit DOM events; retain their native semantics
  // while publishing changes to React. Option mutations use MutationObserver.
  for (const key of ['value', 'selectedIndex']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, key);
    Object.defineProperty(select, key, {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) { descriptor.set.call(this, value); record.refresh(); },
    });
  }
  select.addEventListener('change', record.refresh);
  record.observer = new MutationObserver(record.refresh);
  record.observer.observe(select, { attributes: true, childList: true, subtree: true });
  record.refresh();
  // A previously bridged host may still be owned by a root whose unmount is
  // queued in the disposal drain below; createRoot on the same container would
  // clash, so hand every mount a fresh host node.
  let host = wrapper.querySelector('.appica-select-host');
  if (host.dataset.bridged) {
    const fresh = host.cloneNode(false);
    host.replaceWith(fresh);
    host = fresh;
  }
  host.dataset.bridged = 'true';
  record.root = createRoot(host);
  record.root.render(<SelectControl record={record} />);
  return record;
}

export function mountSelects(root = document, labels = {}) {
  for (const select of root.querySelectorAll('select')) {
    if (select.hidden || records.has(select)) continue;
    if (!select.id) select.id = `appicaSelect-${++nextId}`;
    const label = labels[select.id] || select.getAttribute('aria-label')
      || select.closest('label')?.querySelector(':scope > span')?.textContent?.trim() || '选择选项';
    records.set(select, createRecord(select, label));
  }
}
export function refreshSelect(select) { records.get(select)?.refresh(); }
export function closeSelects(except) {
  for (const [select, record] of records) {
    if (select !== except && record.open) record.setOpen(false);
  }
}
// root.unmount() 是 dispose 里唯一昂贵的一步：一张折叠中的配置卡会同时销毁 6~7 个
// 桥接 select，若在同一个微任务里连续同步 unmount，正好在收起动画结束帧后制造一次
// 主线程长任务（用户可见的"顿一下"）。此时 DOM 已被 React 摘离文档，延迟卸载对用户
// 完全不可见——把 unmount 推入队列，在空闲片里每次只处理少量，直至清空。
const rootDisposalQueue = [];
let rootDisposalScheduled = false;
function scheduleRootDisposal() {
  if (rootDisposalScheduled || !rootDisposalQueue.length) return;
  rootDisposalScheduled = true;
  const run = deadline => {
    rootDisposalScheduled = false;
    const hasTime = () => typeof deadline?.timeRemaining !== 'function' || deadline.timeRemaining() > 4;
    let done = 0;
    while (rootDisposalQueue.length && done < 2 && hasTime()) {
      try { rootDisposalQueue.shift().unmount(); } catch { /* 已卸载/宿主异常时忽略 */ }
      done++;
    }
    scheduleRootDisposal();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 200 });
  else setTimeout(run, 50);
}

export function disposeSelects(root) {
  for (const select of root.querySelectorAll('select')) {
    const record = records.get(select);
    if (!record) continue;
    // 便宜的簿记同步完成：同一元素随后立刻重新 mount 也不会和旧 record 冲突。
    record.observer.disconnect();
    select.removeEventListener('change', record.refresh);
    delete select.value;
    delete select.selectedIndex;
    records.delete(select);
    rootDisposalQueue.push(record.root);
  }
  scheduleRootDisposal();
}
