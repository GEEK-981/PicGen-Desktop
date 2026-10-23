import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { Badge } from '@appica/ui-react/badge';
// Baked in at build time from the same package.json electron-builder stamps onto
// the EXE, so the badge can never drift from the shipped version.
import { version as appVersion } from '../package.json';

// The controller owns the label/icon subtree (progress, counts, busy labels).
// Appica owns the button primitive and its keyboard/disabled behavior.
//
// CAREFUL: `dangerouslySetInnerHTML` must keep a STABLE object identity.
// React diffs props with `===` on the wrapper object and never compares `__html`
// (react-dom `updateProperties` → `setProp` → `domElement.innerHTML = key`), so a
// fresh `{__html}` literal on every render makes React re-write innerHTML and
// destroy whatever the controller put inside — notably the <svg> that lucide
// replaces `<i data-lucide>` with, which came back as a bare, invisible <i>.
// Any command-driven `disabled` flip (which round-trips through the observer
// below and thus re-renders) used to trigger exactly that. Memoizing the object
// keeps the identity stable so setProp is skipped; the icon effect below is the
// belt-and-braces for the one render where it legitimately does change.
export function Action({ markup = '', className = '', disabled = false, ...props }) {
  const ref = useRef(null);
  const [blocked, setBlocked] = useState(disabled);
  useLayoutEffect(() => {
    const node = ref.current;
    const observer = new MutationObserver(() => setBlocked(node.disabled));
    observer.observe(node, { attributes: true, attributeFilter: ['disabled'] });
    return () => observer.disconnect();
  }, []);
  const innerHtml = useMemo(() => ({ __html: markup }), [markup]);
  // Re-run the icon pass after any render that actually replaced the markup
  // (mount, or a real markup change such as a busy/loading icon swap). When the
  // memo above holds, the svg survives untouched and this finds nothing to do.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!node.querySelector('i[data-lucide]')) return;
    window.lucide?.createIcons?.({ root: node });
    node.querySelectorAll('svg[data-lucide]').forEach(svg => svg.removeAttribute('data-lucide'));
  }, [markup]);
  const icon = /icon-button|sidebar-button|history-icon-button|main-help-icon/.test(className);
  const variant = /primary-button|collapsed-launcher/.test(className) ? 'primary'
    : /danger-button/.test(className) ? 'outline'
    : /secondary-button/.test(className) ? 'outline' : 'ghost';
  return <Button {...props} ref={ref} disabled={blocked} size={icon ? 'icon-sm' : (/compact-button/.test(className) ? 'sm' : 'md')}
    variant={variant} className={`picgen-action ${className}`}
    dangerouslySetInnerHTML={innerHtml} />;
}

// Options/values are updated by the domain controller; the adjacent Appica
// Select is mounted by selectBridge, with explicit ownership of its own host.
export function NativeSelect(props) {
  if (props.hidden) return <select {...props} />;
  return <div className="modern-select appica-select-field" data-select-id={props.id}>
    <select {...props} /><div className="appica-select-host" />
  </div>;
}

export function WindowHeader() {
  return <header className="titlebar">
    <div className="window-drag">
      <span className="app-mark" aria-hidden="true"><img src="assets/picgen-icon.svg" alt="" /></span>
      <div className="app-title">PicGen <span className="app-subtitle">创作空间</span></div>
    </div>
    <Badge variant="soft" size="sm" className="version-badge">{appVersion}</Badge>
    <Action id="hoverPreviewToggleBtn" className="icon-button" type="button" title="关闭鼠标悬停预览" aria-label="鼠标悬停预览" aria-pressed="true"
      markup={'<i data-lucide="eye"></i>'} />
    <Action id="pinWindowBtn" className="icon-button" type="button" title="取消置顶（窗口可被其他窗口覆盖，贴边时自动收起）" aria-label="置顶窗口" aria-pressed="true"
      markup={'<i data-lucide="pin"></i>'} />
    <Action id="closeBtn" className="icon-button" type="button" title="回到浮窗" aria-label="回到浮窗"
      markup={'<i data-lucide="minimize-2"></i>'} />
  </header>;
}

export function Navigation() {
  const items = [
    ['generateNavBtn', 'wand-sparkles', '图片生成', '创作'],
    ['queueBtn', 'list-todo', '队列管理', '任务队列'],
    ['reversePromptNavBtn', 'scan-search', '提示词反推', '提示词反推'],
    ['workspaceNavBtn', 'frame', '图片工作台', '工作台'],
    ['historyBtn', 'images', '历史图片', '资产库'],
    ['errorLogsBtn', 'file-warning', '错误日志', '错误日志'],
    ['historyBinBtn', 'trash-2', '回收站', '回收站'],
    ['apiSettingsBtn', 'settings', 'API 设置', '设置'],
  ];
  return <aside className="sidebar" aria-label="主导航">
    {items.map(([id, icon, title, label], index) => <React.Fragment key={id}>
      {id === 'errorLogsBtn' && <span className="sidebar-spacer" />}
      <Action id={id} type="button" title={title} aria-label={title}
        aria-current={index === 0 ? 'page' : undefined}
        className={`sidebar-button ${index === 0 ? 'active' : ''}`}
        markup={`<i data-lucide="${icon}"></i><span class="sidebar-label">${label}</span>${id === 'errorLogsBtn' ? '<span id="errorLogBadge" class="sidebar-badge" aria-label="未读错误" hidden></span>' : ''}${id === 'historyBinBtn' ? '<span id="historyBinBadge" class="sidebar-badge sidebar-badge-muted" hidden></span>' : ''}`} />
    </React.Fragment>)}
  </aside>;
}
