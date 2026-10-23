import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ThemeProvider } from '@appica/ui-react/providers/theme-provider';
import { ToastProvider, Toaster, createToastManager } from '@appica/ui-react/toast';
import { App } from './App';
import { NativePreview } from './PreviewCard';
import { PrefsWindow } from './PrefsWindow';
import { ConfirmDialog, confirmAction } from './ConfirmDialog';
import { mountSelects, refreshSelect, closeSelects, disposeSelects } from './selectBridge';
import { renderSequenceTabs, renderReferenceStack, renderOptionSlider, renderOptimizeIcon } from './collections';
import { renderGlobalPrompt } from './GlobalPrompt';
import { startPromptStream, fetchPromptStream } from './promptStreaming';
import { SupplierManager } from './SupplierManager';
import { HistoryFilters } from './HistoryFilters';
import { Workspace } from './workspace/Workspace.jsx';
import './appica-native.css';
import './refinements.css';

const toastManager = createToastManager();
let supplierManagerRoot;
// sync=true（默认）用 flushSync：打开设置/增删改后 smoke 脚本会立刻断言 DOM。
// 健康 dot 推送（WS provider:status）传 sync=false 走普通调度——它可能落在折叠
// 动画的 0.28s 窗口内，flushSync 的同步全树重渲会直接在动画中间插一个长帧。
function renderSupplierManager(props, { sync = true } = {}) {
  const host = document.getElementById('unifiedSupplierList');
  if (!host) return;
  if (!supplierManagerRoot) supplierManagerRoot = createRoot(host);
  if (sync) flushSync(() => supplierManagerRoot.render(<SupplierManager {...props} />));
  else supplierManagerRoot.render(<SupplierManager {...props} />);
}
// History filters: desktop.js owns the filter state and re-renders on every change (sync, so the
// list it renders right after sees the same chips).
let historyFiltersRoot;
function renderHistoryFilters(props) {
  const host = document.getElementById('historyFilterControls');
  if (!host) return;
  if (!historyFiltersRoot) historyFiltersRoot = createRoot(host);
  flushSync(() => historyFiltersRoot.render(<HistoryFilters {...props} />));
}
// 图片工作台：挂在 #workspaceRoot 上的 React 子根（React 完全拥有），desktop.js 只传会话和回调
let workspaceRoot;
function renderWorkspace(host, props) {
  if (!host) return;
  if (!workspaceRoot) workspaceRoot = createRoot(host);
  flushSync(() => workspaceRoot.render(<Workspace {...props} />));
}
const repeatedErrorToasts = new Map();
let launcherNotificationCount = 0;
let launcherNotificationKind = 'info';

function updateLauncherNotificationBadge() {
  const badge = document.getElementById('collapsedNotificationBadge');
  if (!badge) return;
  const collapsed = document.body?.classList.contains('collapsed');
  badge.hidden = !collapsed || launcherNotificationCount === 0;
  badge.textContent = launcherNotificationCount > 99 ? '99+' : String(launcherNotificationCount);
  badge.dataset.kind = launcherNotificationKind;
  badge.setAttribute('aria-label', `${launcherNotificationCount} 条新通知`);
}

function clearLauncherNotificationBadge() {
  launcherNotificationCount = 0;
  launcherNotificationKind = 'info';
  updateLauncherNotificationBadge();
}

function registerLauncherNotification(kind) {
  launcherNotificationCount = Math.min(999, launcherNotificationCount + 1);
  launcherNotificationKind = kind;
  updateLauncherNotificationBadge();
}

function toastTitleContent(message, count = 1) {
  return React.createElement('span', { className: 'picgen-toast-title-content' },
    React.createElement('span', { className: 'picgen-toast-title-copy' }, String(message ?? '')),
    count > 1 ? React.createElement('span', {
      className: 'picgen-toast-repeat-badge',
      'aria-label': `重复 ${count} 次`
    }, count > 99 ? '99+' : String(count)) : null
  );
}

function toastIcon(kind = '') {
  const palette = {
    error: { color: '#dc2626', path: 'M12 8v4m0 4h.01M10.3 3.9 2.9 17a2 2 0 0 0 1.75 3h14.7a2 2 0 0 0 1.75-3L13.7 3.9a2 2 0 0 0-3.4 0Z' },
    warning: { color: '#d97706', path: 'M12 8v4m0 4h.01M10.3 3.9 2.9 17a2 2 0 0 0 1.75 3h14.7a2 2 0 0 0 1.75-3L13.7 3.9a2 2 0 0 0-3.4 0Z' },
    success: { color: '#16a34a', path: 'm5 12 4 4L19 6' },
    info: { color: '#2563eb', path: 'M12 16v-4m0-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
  };
  const { color, path } = palette[kind] || palette.info;
  return React.createElement('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, React.createElement('path', { d: path }));
}

function showToast(message, kind = '') {
  const normalizedKind = kind === 'error' ? 'error' : kind === 'warning' ? 'warning' : kind === 'success' ? 'success' : 'info';
  const collapsed = document.body?.classList.contains('collapsed');
  if (collapsed) registerLauncherNotification(normalizedKind);
  else clearLauncherNotificationBadge();
  // The collapsed launcher is only a handle; notifications belong to the
  // expanded workspace and must never cover the floating icon.
  if (collapsed) return null;
  const text = String(message ?? '');
  const groupKey = `${normalizedKind}:${text}`;
  if (normalizedKind === 'error') {
    const existing = repeatedErrorToasts.get(groupKey);
    if (existing) {
      existing.count += 1;
      toastManager.update(existing.id, { title: toastTitleContent(text, existing.count) });
      clearTimeout(existing.cleanupTimer);
      existing.cleanupTimer = setTimeout(() => repeatedErrorToasts.delete(groupKey), existing.timeout + 500);
      return existing.id;
    }
  }
  const options = {
    title: toastTitleContent(text),
    timeout: normalizedKind === 'error' ? 10000 : 5000,
    data: { icon: toastIcon(normalizedKind) },
  };
  if (normalizedKind === 'error') {
    options.actionProps = {
      children: '查看错误日志',
      onClick: () => {
        toastManager.close();
        window.dispatchEvent(new CustomEvent('picgen:open-error-logs'));
      },
    };
  }
  const id = toastManager.add(options);
  if (normalizedKind === 'error') {
    const timeout = options.timeout;
    repeatedErrorToasts.set(groupKey, {
      id,
      count: 1,
      timeout,
      cleanupTimer: setTimeout(() => repeatedErrorToasts.delete(groupKey), timeout + 500),
    });
  }
  return id;
}

window.PicGenAppica = { startPromptStream, fetchPromptStream, mountSelects, refreshSelect, closeSelects, disposeSelects, renderSequenceTabs, renderReferenceStack, renderOptionSlider, renderOptimizeIcon, renderGlobalPrompt, renderSupplierManager, renderHistoryFilters, renderWorkspace, confirm: confirmAction, toastManager, showToast, dismissToasts: () => { repeatedErrorToasts.clear(); toastManager.close(); }, clearLauncherNotificationBadge, updateLauncherNotificationBadge, version: '1.1.0' };
// Mount before the deferred domain-controller script caches its DOM contracts.
flushSync(() => createRoot(document.getElementById('root')).render(
  <ThemeProvider forcedTheme="light" enableSystem={false} storageKey="picgen_ui_theme">
    <ToastProvider toastManager={toastManager} limit={6}>
      {document.body.dataset.preview === 'true' ? <NativePreview />
        : document.body.dataset.panel === 'prefs' ? <PrefsWindow />
        : <><App /><ConfirmDialog /></>}
      <Toaster position="bottom-center" className="picgen-toast-viewport" progress timeout={5000} />
    </ToastProvider>
  </ThemeProvider>
));
document.documentElement.dataset.frontend = 'appica-react';
