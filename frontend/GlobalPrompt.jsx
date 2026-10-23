import React, { useEffect, useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { ButtonGroup } from '@appica/ui-react/button-group';
import { Popover, PopoverTrigger, PopoverContent, PopoverTitle, PopoverDescription, PopoverClose } from '@appica/ui-react/popover';
import { Textarea } from '@appica/ui-react/textarea';
import { Switch } from '@appica/ui-react/switch';
import { renderInto } from './collections';

// 「优化」旁的全局提示词开关：左边的点切换开/关（绿=开，灰=关），右边「全局」打开
// 编辑浮层。状态与持久化归 desktop.js（localStorage），这里只渲染并回调。
function GlobalPrompt({ enabled = false, text = '', onToggle, onSave }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(text);
  const [draftEnabled, setDraftEnabled] = useState(enabled);
  useEffect(() => {
    if (!open) return;
    setDraft(text);
    // 首次填写时默认勾上，保存即生效；已有内容时沿用当前开关。
    setDraftEnabled(text ? enabled : true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = enabled ? '已开启' : '已关闭';
  const save = () => {
    onSave?.({ text: draft.trim(), enabled: draftEnabled });
    setOpen(false);
  };
  return (
    <ButtonGroup size="sm" variant="outline" className="global-prompt-group">
      <Button id="globalPromptToggleBtn" type="button" className="global-prompt-toggle"
        aria-pressed={enabled} aria-label={`全局提示词${state}，点击${enabled ? '关闭' : '开启'}`}
        title={`全局提示词${state}（点击切换）`} onClick={() => onToggle?.(!enabled)}>
        <span className="global-prompt-dot" data-on={enabled ? 'true' : 'false'} aria-hidden="true" />
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button id="globalPromptBtn" type="button" className="global-prompt-edit"
          title={text ? `全局提示词：${text}` : '设置全局提示词'} />}>
          {'全局'}
        </PopoverTrigger>
        <PopoverContent className="global-prompt-popover" side="bottom" align="end" collisionPadding={8}>
          <PopoverTitle>{'全局提示词'}</PopoverTitle>
          <PopoverDescription>{'开启后，每次生成任务都会把这段文字附加到提示词末尾。'}</PopoverDescription>
          <Textarea id="globalPromptInput" rows={5} spellCheck={false} value={draft}
            placeholder="例如：无水印，无多余文字" onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) save(); }} />
          <label className="global-prompt-switch-row">
            <Switch id="globalPromptEnabledSwitch" size="sm" checked={draftEnabled} onCheckedChange={setDraftEnabled} />
            <span>{'附加到每次任务'}</span>
          </label>
          <div className="global-prompt-actions">
            <PopoverClose render={<Button type="button" size="sm" variant="ghost" />}>{'取消'}</PopoverClose>
            <Button id="globalPromptSaveBtn" type="button" size="sm" variant="primary" onClick={save}>{'保存'}</Button>
          </div>
        </PopoverContent>
      </Popover>
    </ButtonGroup>
  );
}

export function renderGlobalPrompt(host, props) { renderInto(host, <GlobalPrompt {...props} />); }
