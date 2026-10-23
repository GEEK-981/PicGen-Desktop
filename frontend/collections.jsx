import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Tabs, TabsList, TabsTrigger } from '@appica/ui-react/tabs';
import { Slider } from '@appica/ui-react/slider';
import { Spinner } from '@appica/ui-react/spinner';
import { ImagePlus, Trash2, X, WandSparkles } from 'lucide-react';
import BorderGlow from './BorderGlow';
import './annotation/annotation.css';

const roots = new WeakMap();
export function renderInto(host, component) {
  if (!roots.has(host)) roots.set(host, createRoot(host));
  // Controller callers read DOM immediately after changing sequences or lists.
  flushSync(() => roots.get(host).render(component));
}

function SequenceTabs({ items, currentId, select, close }) {
  return <Tabs value={currentId} onValueChange={select} size="sm" className="picgen-sequence-tabs">
    <TabsList activateOnFocus aria-label="生成序列" className="picgen-sequence-list">
      {items.map(item => <TabsTrigger key={item.id} value={item.id}
        className={`tab-button ${currentId === item.id ? 'active' : ''}`} title={item.title}>
        <span className="tab-name">{item.title}</span>
        <span className="tab-close" role="button" tabIndex={0} title="关闭序列" aria-label={`关闭${item.title}`}
          onClick={event => { event.stopPropagation(); close(item.id); }}
          onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); close(item.id); } }}>
          <X size={12} />
        </span>
      </TabsTrigger>)}
    </TabsList>
  </Tabs>;
}

// 旧的横向 chip 列表（ReferenceList）已被 ReferenceStack 取代并移除。

// 参考图组——复刻即梦 reference-group（-hover-trigger）的结构与参数：
// 条目 48×64 竖版卡、gap 4px；收起时整组 scale(0.65625) 并把所有条目叠在同一原点、
// 交替 ±8deg 旋转成一摞照片堆（上传块反向旋转回正、恒为 index 0 最顶层）；
// 悬停（或点击）横向展开：条目按 (宽+gap)×index 位移排开（我们锚在右下角故向左展开），
// 展开条目 hover 上浮 -8px + 放大 1.125、按下 0.98；过渡 0.3s cubic-bezier(.4,0,.2,1)。
// 上传按钮点击直接弹文件选择框；展开后每张带移除按钮与悬停大图预览；离开/点外部收起。
function ReferenceStack({ sequenceId, references, maxReferences = 0, remove, onContextMenu, onUpload, preview, previewMove, previewHide, draggingId = null, onDragStart, onDragEnd, onDropTrash }) {
  const [open, setOpen] = useState(false);
  const [overTrash, setOverTrash] = useState(false);
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const leaveTimer = useRef(null);
  // 移除一张图后其 DOM 消失，指针可能瞬间"落到组外"触发 mouseleave——在一小段
  // 抑制窗口内忽略收起，让用户能连续点移除。
  const suppressLeaveUntil = useRef(0);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  // 点击组件外部收起（capture 阶段，避免被内部 stopPropagation 挡住）。
  useEffect(() => {
    if (!open) return undefined;
    const onDown = event => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  useEffect(() => { if (!references.length) setOpen(false); }, [references.length]);
  // 展开条带超宽时（滚动条带），滚轮横向滚动浏览。
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !open) return undefined;
    const onWheel = event => {
      if (node.scrollWidth <= node.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      node.scrollLeft -= event.deltaY; // rtl 滚动口：向左浏览更多
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [open]);
  // 左缘渐隐：窗体边缘的固定处理——只要条带内容溢出（条带被 100vw 上限压到
  // 贴近窗口左边），viewport 左缘就恒定挂渐变遮罩，与滚动位置无关（滚到最左端
  // 也不取消，之前"到头自动关"被用户视为渐隐失效）。用 React 状态声明式挂类，
  // 任何重渲染都不会抹掉；窗口宽度变化（上限随 100vw 变）时重新判定。
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !open) { setClipped(false); return undefined; }
    // 解析式判定（与 CSS 宽度公式 min(track+12, 100vw-64) 保持同式）：
    // 用轨道元素自身的 offsetWidth（纯布局值）——scrollWidth 在 rtl 滚动口里
    // 会被过渡中的 clientWidth 顶托、clientWidth 又是过渡中的旧宽度，
    // 两者都会让遮罩开关在删除后短暂判错。
    const update = () => {
      const track = node.querySelector('.reference-group-track');
      setClipped((track?.offsetWidth || 0) > window.innerWidth - 64);
    };
    const raf = requestAnimationFrame(update);
    const settle = setTimeout(update, 420);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
      window.removeEventListener('resize', update);
    };
  }, [open, references.length]);
  const full = maxReferences > 0 && references.length >= maxReferences;
  const total = references.length + 1; // 上传块 + 图片
  // 正在拖拽参考图时强制保持展开（原生拖拽期间鼠标事件被抑制，hover 判定不可靠）。
  const isOpen = open || !!draggingId;
  const enter = () => { clearTimeout(leaveTimer.current); if (references.length) setOpen(true); };
  const leave = () => {
    if (draggingId || Date.now() < suppressLeaveUntil.current) return;
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => { previewHide(); setOpen(false); }, 160);
  };
  return (
    <div ref={rootRef} className={`reference-group${isOpen ? ' is-open' : ''}`}
      style={{ '--ref-count': total }} data-count={references.length}
      onMouseEnter={enter} onMouseLeave={leave}>
      <div className="reference-group-glow" aria-hidden="true" />
      {/* viewport：不滚动的外层，渐隐遮罩挂在它上——遮罩相对界面可见区固定，
          不随滚动容器的内容坐标漂移（mask 挂滚动容器上会跟着内容走）。 */}
      <div className={`reference-group-viewport${clipped ? ' is-clipped' : ''}`}>
      <div className="reference-group-content" ref={scrollRef}>
        <div className="reference-group-track">
        {/* index 0 恒为上传块：收起时在照片堆最顶层，点击直接弹文件选择框。
            BorderGlow 只做"发光外框"这一层装饰（它自身不 spread 额外 props，所以
            可交互语义全部留在内层 button 上，无需改动组件源码）。 */}
        <div className="reference-item" style={{ '--idx': 0, '--rot': '8deg', zIndex: total }}>
          <BorderGlow
            className="reference-upload-glow"
            backgroundColor="#fafbfc"
            borderRadius={4}
            glowRadius={7}
            glowIntensity={1.2}
            edgeSensitivity={22}
            coneSpread={30}
            glowColor="264 88 68"
            colors={['#6366f1', '#8b5cf6', '#38bdf8']}
          >
            <button type="button" className="reference-upload" disabled={full}
              title={full ? `最多 ${maxReferences} 张参考图` : '上传参考图（也可 Ctrl+V 粘贴）'} aria-label="上传参考图"
              onClick={onUpload}>
              <ImagePlus size={18} />
            </button>
          </BorderGlow>
        </div>
        {references.map((reference, index) => {
          const dataUrl = `data:${reference.mimeType || 'image/png'};base64,${reference.base64}`;
          return (
            <div key={reference.id} className="reference-item reference-item-image"
              style={{ '--idx': index + 1, '--rot': `${index % 2 ? -8 : 8}deg`, zIndex: total - index - 1 }}
              data-reference-id={reference.id} role="group" aria-label={`参考图 ${index + 1}：${reference.name}`}
              draggable={open}
              onDragStart={event => {
                // 原生文件拖拽（同历史图模式）：preventDefault 取消 HTML5 拖拽，
                // 由主进程 startDrag 携带真实文件——可拖出程序给其它应用，
                // 拖回本窗口的垃圾桶落区则按删除处理（controller 记录被拖的是谁）。
                event.preventDefault();
                previewHide();
                onDragStart?.(reference);
              }}
              onDragEnd={() => { setOverTrash(false); onDragEnd?.(); }}
              onClick={open ? undefined : () => setOpen(true)}
              // 右键：弹出全局统一的图片菜单（desktop.js 按参考图卡禁用做不到的项）
              onContextMenu={onContextMenu ? event => { event.preventDefault(); event.stopPropagation(); previewHide(); onContextMenu(sequenceId, reference, event); } : undefined}
              onMouseEnter={open ? event => {
                // 锚定上弹：以整个参考图容器（viewport 条带）顶部中央为锚点——预览
                // 固定弹在容器上方，跨卡浏览时只换图不挪位，不遮挡条带。
                // 锚点用"最终布局几何"计算：展开时组上有 350ms scale 过渡，此刻量
                // viewport 的 rect 会偏低（顶边还没升到位）导致预览压住卡片；
                // .reference-corner 不受 transform 影响，viewport 的布局宽与 top 偏移
                // 也与过渡进度无关，据此推出过渡结束后的真实顶边。
                const group = event.currentTarget.closest('.reference-group');
                const corner = group?.closest('.reference-corner');
                const viewport = group?.querySelector('.reference-group-viewport');
                let rect;
                if (corner && viewport) {
                  const cornerRect = corner.getBoundingClientRect();
                  const viewportTopOffset = parseFloat(getComputedStyle(viewport).top) || 0; // 开启态为 -28px
                  const width = viewport.offsetWidth;
                  rect = {
                    left: cornerRect.right - width,
                    top: cornerRect.top + viewportTopOffset,
                    width
                  };
                } else {
                  rect = event.currentTarget.getBoundingClientRect();
                }
                preview({
                  fileName: reference.name || '', model: '参考图', providerName: '本地上传',
                  mimeType: reference.mimeType || 'image/png', base64: reference.base64,
                  dataUrl, url: dataUrl, filePath: reference.filePath,
                  previewPlacement: 'above',
                }, {
                  clientX: rect.left + rect.width / 2,
                  clientY: rect.top,
                  screenX: window.screenX + rect.left + rect.width / 2,
                  screenY: window.screenY + rect.top - 16,
                  // 预览锚点是这张卡本身（弹出位置仍按上面的条带顶边）：主进程据它核对真实光标在卡上
                  anchor: event.currentTarget,
                });
              } : undefined}
              onMouseLeave={open ? previewHide : undefined}>
              <img src={dataUrl} alt="" draggable={false} />
              {open && (
                <button type="button" className="reference-group-remove" title="移除"
                  aria-label={`移除参考图 ${reference.name}`}
                  onClick={event => {
                    event.stopPropagation();
                    // 连续移除：删除后 DOM 变化会触发一次假性 mouseleave，抑制 800ms。
                    suppressLeaveUntil.current = Date.now() + 800;
                    clearTimeout(leaveTimer.current);
                    previewHide();
                    remove(sequenceId, reference.id);
                  }}>
                  <X size={10} />
                </button>
              )}
            </div>
          );
        })}
        </div>
      </div>
      </div>
      {/* 垃圾桶：拖拽期间出现的独立悬浮层，锚定在组右缘（不进滚动口，位置固定，
          不随条带滑动）。删除判定由主进程回传的拖拽落点做矩形命中检测。 */}
      {draggingId && (
        <div className={`reference-trash${overTrash ? ' is-over' : ''}`}
          role="button" aria-label="拖到此处删除参考图" title="拖到此处删除"
          onDragEnter={event => { event.preventDefault(); setOverTrash(true); }}
          onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOverTrash(true); }}
          onDragLeave={() => setOverTrash(false)}
          onDrop={event => { event.preventDefault(); event.stopPropagation(); setOverTrash(false); onDropTrash?.(); }}>
          <Trash2 size={18} />
        </div>
      )}
      {!open && references.length > 0 && <span className="reference-group-count">{references.length}</span>}
    </div>
  );
}

export function renderSequenceTabs(host, props) { renderInto(host, <SequenceTabs {...props} />); }
export function renderReferenceStack(host, props) { renderInto(host, <ReferenceStack key={props.sequenceId} {...props} />); }

// 优化按钮左侧的图标：空闲是魔杖，进行中换成 Appica Spinner。
// 走 React 子根而不是命令式塞 markup —— 后者会被 `Action` 的 innerHTML 重写冲掉
// （正是「点一下图标就消失」的根因）。两者都随 currentColor，跟按钮文字同色。
function OptimizeIcon({ busy = false }) {
  return busy
    ? <Spinner className="optimize-prompt-spinner" currentColor aria-label="正在优化" />
    : <WandSparkles className="optimize-prompt-wand" size={16} aria-hidden="true" />;
}
export function renderOptimizeIcon(host, props = {}) { renderInto(host, <OptimizeIcon {...props} />); }

// 离散档位（分辨率 1K/2K/4K…、数量 1/2/4/5）用 Appica Slider 表示。onChange 回传
// 档位索引，控制器据此写回隐藏的原生 <select> 并派发 change，沿用既有逻辑。
function OptionSlider({ options = [], index = 0, ariaLabel = '', onChange }) {
  const max = Math.max(0, options.length - 1);
  const clamped = Math.min(Math.max(0, index), max);
  if (options.length <= 1) {
    return <div className="option-slider option-slider-single">{options[0]?.label || '—'}</div>;
  }
  return (
    <div className="option-slider">
      <Slider
        value={clamped}
        min={0}
        max={max}
        step={1}
        tooltipVisibility="never"
        thumbAriaLabel={ariaLabel}
        onValueChange={value => onChange?.(Array.isArray(value) ? value[0] : value)}
      />
      <div className="option-slider-marks">
        {options.map((option, i) => (
          <button
            type="button"
            key={option.value}
            className={`option-slider-mark${i === clamped ? ' is-active' : ''}`}
            onClick={() => onChange?.(i)}
          >{option.label}</button>
        ))}
      </div>
    </div>
  );
}
export function renderOptionSlider(host, props) { renderInto(host, <OptionSlider {...props} />); }
