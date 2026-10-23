import React, { useEffect, useRef, useState } from 'react';
import { Slider } from '@appica/ui-react/slider';
import { Scan, Scaling } from 'lucide-react';

// 置顶设置窗内容：不持有任何业务逻辑，只按主窗控制器序列化的面板快照渲染，
// 用户改动通过 picgenPrefs.sendChange 回传主窗写回隐藏控件，走既有 change 处理链
// （持久化 / 能力显隐 / 联动），随后主窗回推新快照刷新本窗。
// 因此模型能力规则只有一份（desktop.js），本窗永远是它的镜像。
// snapshot.panel 决定渲染哪套镜像：'advanced'（高级参数网格）或 'image'（画面设置）。

const send = payload => window.picgenPrefs?.sendChange(payload);

// 提交式输入：本地持有草稿，失焦/回车才回传——避免每个键击都触发主窗
// 持久化与取整（比如自定义分辨率输完前就被 16 倍数取整打断）。
function CommitInput({ value, onCommit, ...props }) {
  const [draft, setDraft] = useState(value ?? '');
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value ?? ''); }, [value]);
  return (
    <input {...props} value={draft}
      onFocus={() => { focused.current = true; }}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => { focused.current = false; onCommit(draft); }}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
  );
}

function ControlField({ control }) {
  const sendControl = payload => send({ id: control.id, ...payload });
  if (control.type === 'checkbox') {
    return (
      <label className="checkbox-field" hidden={control.hidden}>
        <input type="checkbox" checked={!!control.checked} onChange={event => sendControl({ checked: event.target.checked })} />
        <span>{control.label}</span>
      </label>
    );
  }
  if (control.type === 'select') {
    return (
      <label hidden={control.hidden}>
        <span>{control.label}</span>
        <select value={control.value ?? ''} onChange={event => sendControl({ value: event.target.value })}>
          {(control.options || []).map(option => (
            <option key={`${option.value}`} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    );
  }
  if (control.type === 'range') {
    return (
      <label hidden={control.hidden}>
        <span>{control.label}{control.valueLabel != null && <b>{control.valueLabel}</b>}</span>
        <input type="range" min={control.min} max={control.max} step={control.step}
          value={control.value ?? control.min ?? 0} onChange={event => sendControl({ value: event.target.value })} />
      </label>
    );
  }
  return (
    <label hidden={control.hidden}>
      <span>{control.label}</span>
      <CommitInput type={control.type === 'number' ? 'number' : 'text'}
        min={control.min} max={control.max} step={control.step}
        maxLength={control.maxLength} placeholder={control.placeholder || ''}
        value={control.value ?? ''} onCommit={value => sendControl({ value })} />
    </label>
  );
}

// 离散档位滑条（分辨率/数量）：复刻主窗 OptionSlider 的结构与类名，值回传档位索引。
function TierSlider({ field, data, ariaLabel }) {
  if (!data || !data.options.length) return null;
  const max = data.options.length - 1;
  const clamped = Math.min(Math.max(0, data.index), max);
  if (data.options.length <= 1) {
    return <div className="option-slider option-slider-single">{data.options[0]?.label || '—'}</div>;
  }
  const commit = index => { if (index !== clamped) send({ panel: 'image', field, value: index }); };
  return (
    <div className="option-slider">
      <Slider value={clamped} min={0} max={max} step={1} tooltipVisibility="never"
        thumbAriaLabel={ariaLabel}
        onValueChange={value => commit(Array.isArray(value) ? value[0] : value)} />
      <div className="option-slider-marks">
        {data.options.map((option, index) => (
          <button type="button" key={option.value}
            className={`option-slider-mark${index === clamped ? ' is-active' : ''}`}
            onClick={() => commit(index)}>{option.label}</button>
        ))}
      </div>
    </div>
  );
}

// 画面设置镜像：供应商/模型下拉、比例宫格（复刻 .ratio-grid 结构）、档位滑条、自定义尺寸。
function ImagePanel({ snapshot }) {
  const selectField = (label, field, data) => (
    <label className="prefs-stack-field">
      <span className="prefs-section-label">{label}</span>
      <select value={data.value ?? ''} onChange={event => send({ panel: 'image', field, value: event.target.value })}>
        {data.options.map(option => (
          <option key={`${option.value}`} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="prefs-native-image">
      <div className="prefs-field-row">
        {selectField('供应商', 'provider', snapshot.provider)}
        {selectField('模型', 'model', snapshot.model)}
      </div>
      {snapshot.ratio.options.length > 0 && (
        <div className="prefs-section">
          <span className="prefs-section-label">选择比例</span>
          <div className="ratio-grid" role="group" aria-label="图片比例">
            {snapshot.ratio.options.map(option => {
              const active = option.value === snapshot.ratio.value;
              return (
                <button key={option.value} type="button" disabled={option.disabled}
                  className={`ratio-grid-item${active ? ' is-active' : ''}`}
                  title={option.title} aria-pressed={active}
                  onClick={() => send({ panel: 'image', field: 'ratio', value: option.value })}>
                  <span className={`ratio-option-visual${option.shape ? '' : ' is-symbolic'}`} aria-hidden="true">
                    {option.shape
                      ? <span className="ratio-shape" style={{ width: option.shape.w, height: option.shape.h }} />
                      : option.symbol === 'scan' ? <Scan size={14} /> : <Scaling size={14} />}
                  </span>
                  <span className="ratio-grid-label">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="prefs-slider-row">
        {snapshot.resolution && (
          <div className="prefs-slider-field">
            <span className="prefs-field-label">分辨率</span>
            <TierSlider field="resolution" data={snapshot.resolution} ariaLabel="分辨率" />
          </div>
        )}
        {snapshot.count && (
          <div className="prefs-slider-field">
            <span className="prefs-field-label">数量</span>
            <TierSlider field="count" data={snapshot.count} ariaLabel="数量" />
          </div>
        )}
      </div>
      {snapshot.customSize?.visible && (
        <div className="custom-size-row">
          <label className="prefs-slider-field">
            <span className="prefs-field-label">自定义宽</span>
            <CommitInput type="number" min={256} max={3840} step={16} placeholder="16 的倍数"
              value={snapshot.customSize.width} onCommit={value => send({ panel: 'image', field: 'customWidth', value })} />
          </label>
          <label className="prefs-slider-field">
            <span className="prefs-field-label">自定义高</span>
            <CommitInput type="number" min={256} max={3840} step={16} placeholder="16 的倍数"
              value={snapshot.customSize.height} onCommit={value => send({ panel: 'image', field: 'customHeight', value })} />
          </label>
        </div>
      )}
    </div>
  );
}

export function PrefsWindow() {
  const [snapshot, setSnapshot] = useState(null);
  // 显隐动画：每次窗口显示 tick+1（key 变化 → 重放入场淡入）；
  // 收窗前主进程发 hide-anim → 播放 150ms 淡出后才真正隐藏。
  const [shownTick, setShownTick] = useState(0);
  const [hiding, setHiding] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => window.picgenPrefs?.onRender(next => setSnapshot(next)), []);
  useEffect(() => window.picgenPrefs?.onShown(() => { setHiding(false); setShownTick(tick => tick + 1); }), []);
  useEffect(() => window.picgenPrefs?.onHideAnim(() => setHiding(true)), []);
  useEffect(() => { window.picgenPrefs?.ready(); }, []);
  // 内容高度上报：主进程据此调整窗口尺寸（可超出主窗，不再被裁剪）。
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      // +32 = body/#root 的 16px 内边距 ×2（阴影衰减空间），窗口高度按整卡内容自适应。
      window.picgenPrefs?.resizeTo(Math.ceil(node.getBoundingClientRect().height) + 32);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [snapshot ? 1 : 0, shownTick]); // shownTick 变化会按 key 重挂载外壳，需重新 observe 新节点
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') window.picgenPrefs?.requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 移出即关：指针离开本窗上报主进程（350ms 宽限，横移回触发按钮可接力取消）。
  // 原生下拉展开（焦点在 select 上）或按住拖动滑条时指针出窗不算离开，防误关。
  useEffect(() => {
    const onLeave = event => {
      if (document.activeElement?.tagName === 'SELECT') return;
      if (event.buttons) return;
      window.picgenPrefs?.pointerLeave();
    };
    const onEnter = () => window.picgenPrefs?.pointerEnter();
    // mouseenter 可能漏发（窗口刚显示在静止的指针下）：指针在窗内一动就补报一次进入
    let reported = false;
    const onOver = () => { if (!reported) { reported = true; onEnter(); } };
    const onOut = event => { if (!event.relatedTarget) reported = false; };
    // 原生下拉展开时选项列表可能画到窗外：告诉主进程别按指针位置收窗
    const onSelectDown = event => { if (event.target?.tagName === 'SELECT') window.picgenPrefs?.selectOpen(true); };
    const onSelectDone = event => { if (event.target?.tagName === 'SELECT') window.picgenPrefs?.selectOpen(false); };
    document.addEventListener('mouseleave', onLeave);
    document.addEventListener('mouseenter', onEnter);
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('mousedown', onSelectDown, true);
    document.addEventListener('change', onSelectDone, true);
    document.addEventListener('focusout', onSelectDone, true);
    return () => {
      document.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('mouseenter', onEnter);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('mousedown', onSelectDown, true);
      document.removeEventListener('change', onSelectDone, true);
      document.removeEventListener('focusout', onSelectDone, true);
    };
  }, []);

  if (!snapshot) return <div className="prefs-native-shell" ref={rootRef} />;
  return (
    <div key={shownTick} className={`prefs-native-shell${hiding ? ' is-hiding' : ''}`} ref={rootRef}>
      <header className="prefs-native-head">
        <strong>{snapshot.title || '设置'}</strong>
        {snapshot.hint && <small>{snapshot.hint}</small>}
      </header>
      {snapshot.panel === 'image'
        ? <ImagePanel snapshot={snapshot} />
        : snapshot.empty
          ? <p className="prefs-native-empty">{snapshot.empty}</p>
          : (
            <div className="advanced-grid prefs-native-grid">
              {(snapshot.controls || []).map(control => <ControlField key={control.id} control={control} />)}
            </div>
          )}
    </div>
  );
}
