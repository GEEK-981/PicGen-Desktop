import React, { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import Konva from 'konva';
import { Stage, Layer, Rect, Image as KonvaImage, Transformer, Text, Circle } from 'react-konva';
import { addItem, normalizeRect, translateItem } from '../annotation/annotationModel.mjs';
import { Shape, Badge } from './annotationShapes.jsx';
import { updateImage, updateAnchor } from './workspaceModel.mjs';

// 图片工作台画布。坐标一律为"画框像素"；Stage 的 scale/position 只是视图（缩放、平移）。
// 画布只负责交互，数据变化都通过 onChange(updater, coalesceKey) 交给上层（上层管撤销）。
// 拖动画布：按住鼠标中键（或空格 + 左键）；滚轮缩放。左键始终是编辑（选中/移动/绘制/涂抹）。

// Konva 默认中键也能拖动图形；中键留给拖动画布，只允许左键拖动图形
Konva.dragButtons = [0];

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 6;
const MIN_DRAG = 4;

function useSize(ref) {
  const [size, setSize] = useState({ w: 400, h: 300 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const update = () => setSize({ w: Math.max(200, node.clientWidth), h: Math.max(180, node.clientHeight) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

const WorkspaceCanvas = forwardRef(function WorkspaceCanvas({
  doc, mode, tool, selectedId, onSelect, onChange, images, anchorImages, anchorMeta,
  maskCanvas, maskVisible = true, maskVersion, brushSize, maskTool, onMaskStroke, onDropAnchor, onDropFiles, background = '#FFFFFF'
}, ref) {
  const wrapRef = useRef(null);
  const stageRef = useRef(null);
  const transformerRef = useRef(null);
  const nodeRefs = useRef({});
  const maskImageRef = useRef(null);
  const size = useSize(wrapRef);
  const [view, setView] = useState(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const endPanRef = useRef(null);
  useEffect(() => () => endPanRef.current?.(), []);
  const [cursor, setCursor] = useState(null);
  const draftRef = useRef(null);
  const [draft, setDraftState] = useState(null);
  const setDraft = next => { draftRef.current = next; setDraftState(next); };
  const paintRef = useRef(null);

  const fitView = useCallback(() => {
    const pad = 20;
    const scale = Math.min((size.w - pad * 2) / doc.frame.w, (size.h - pad * 2) / doc.frame.h);
    setView({ scale, x: (size.w - doc.frame.w * scale) / 2, y: (size.h - doc.frame.h * scale) / 2 });
  }, [size.w, size.h, doc.frame.w, doc.frame.h]);
  useEffect(() => { fitView(); }, [fitView]);
  // 以画布中心为基准缩放（按钮用）
  const zoomBy = useCallback(factor => setView(v => {
    if (!v) return v;
    const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.scale * factor));
    const c = { x: (size.w / 2 - v.x) / v.scale, y: (size.h / 2 - v.y) / v.scale };
    return { scale, x: size.w / 2 - c.x * scale, y: size.h / 2 - c.y * scale };
  }), [size.w, size.h]);
  // toClient：画框坐标 → 屏幕坐标（只读，冒烟测试用真实鼠标点中画布上的物体）
  const toClient = useCallback(p => {
    const rect = wrapRef.current?.getBoundingClientRect();
    return rect && view ? { x: rect.left + view.x + p.x * view.scale, y: rect.top + view.y + p.y * view.scale } : null;
  }, [view]);
  useImperativeHandle(ref, () => ({ fitView, zoomBy, toClient, zoom: () => view?.scale || 1 }), [fitView, zoomBy, toClient, view]);

  // 中键拖动画布：在 window 上跟踪，拖出画布也不断；中键按下时阻止浏览器自动滚动
  const startPan = event => {
    if (event.button !== 1 || !view) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    setPanning(true);
    const up = () => {
      setPanning(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('blur', up);
      endPanRef.current = null;
    };
    // 松开中键的 mouseup 丢了（切窗口、弹框）也要收尾：移动时中键已不在按下状态就结束
    const move = e => {
      if (!(e.buttons & 4)) { up(); return; }
      setView(v => ({ ...v, x: start.vx + e.clientX - start.x, y: start.vy + e.clientY - start.y }));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('blur', up);
    endPanRef.current = up;
  };

  // 空格按住 = 拖动画布（输入框里不拦截）
  useEffect(() => {
    const down = event => {
      if (event.code !== 'Space' || event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
      if (!wrapRef.current || wrapRef.current.closest('[hidden]')) return;
      event.preventDefault();
      setSpaceDown(true);
    };
    const up = event => { if (event.code === 'Space') setSpaceDown(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // Transformer 只挂在选中的图片上
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    const node = nodeRefs.current[selectedId];
    const resizable = doc.images.some(item => item.id === selectedId) || doc.anchors.some(item => item.id === selectedId);
    tr.nodes(node && resizable && tool === 'select' && mode !== 'mask' ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, doc.images, doc.anchors, tool, mode]);

  useEffect(() => { maskImageRef.current?.getLayer()?.batchDraw(); }, [maskVersion]);

  if (!view) return <div ref={wrapRef} className="ws-canvas" />;

  const framePointer = () => {
    const pos = stageRef.current.getRelativePointerPosition();
    return pos ? { x: pos.x, y: pos.y } : { x: 0, y: 0 };
  };
  const clampToFrame = p => ({ x: Math.min(doc.frame.w, Math.max(0, p.x)), y: Math.min(doc.frame.h, Math.max(0, p.y)) });
  const style = doc.annotationStyle || { color: '#FF00FF', stroke: 8 };
  const newId = () => `a_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const onWheel = event => {
    event.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage.getPointerPosition();
    const factor = event.evt.deltaY > 0 ? 1 / 1.1 : 1.1;
    const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.scale * factor));
    const anchor = { x: (pointer.x - view.x) / view.scale, y: (pointer.y - view.y) / view.scale };
    setView({ scale, x: pointer.x - anchor.x * scale, y: pointer.y - anchor.y * scale });
  };

  // ── 涂抹 ──
  const paintTo = (from, to) => {
    const ctx = maskCanvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = maskTool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#EF4444';
    ctx.lineWidth = brushSize / view.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x + 0.01, to.y);
    ctx.stroke();
    ctx.restore();
    maskImageRef.current?.getLayer()?.batchDraw();
  };

  const onDown = event => {
    if (spaceDown || panning || event.evt.button > 0) return;
    const target = event.target;
    const onEmpty = target === target.getStage() || target.name() === 'frame';
    if (mode === 'mask') {
      const p = framePointer();
      onMaskStroke?.('start');
      paintRef.current = p;
      paintTo(p, p);
      return;
    }
    if (tool === 'select') { if (onEmpty) onSelect(null); return; }
    if (mode !== 'annotate') return;
    const p = clampToFrame(framePointer());
    if (tool === 'pin') { onChange(d => ({ ...d, annotations: addItem(d.annotations, { id: newId(), type: 'pin', x: p.x, y: p.y, instruction: '' }) })); return; }
    if (tool === 'text') {
      const id = newId();
      onChange(d => ({ ...d, annotations: addItem(d.annotations, { id, type: 'text', x: p.x, y: p.y, text: '', instruction: '' }) }));
      onSelect(id);
      requestAnimationFrame(() => document.querySelector(`[data-annotation-text="${id}"]`)?.focus());
      return;
    }
    setDraft({ type: tool, start: p, points: tool === 'pen' ? [p.x, p.y] : [p.x, p.y, p.x, p.y] });
  };
  const onMove = () => {
    if (panning) return;
    if (mode === 'mask') {
      const p = framePointer();
      setCursor(p);
      if (paintRef.current) { paintTo(paintRef.current, p); paintRef.current = p; }
      return;
    }
    const current = draftRef.current;
    if (!current) return;
    const p = clampToFrame(framePointer());
    setDraft(current.type === 'pen'
      ? { ...current, points: [...current.points, p.x, p.y] }
      : { ...current, points: [current.start.x, current.start.y, p.x, p.y] });
  };
  const onUp = () => {
    if (paintRef.current) { paintRef.current = null; onMaskStroke?.('end'); return; }
    const current = draftRef.current;
    if (!current) return;
    setDraft(null);
    const [x1, y1] = current.points;
    const x2 = current.points[current.points.length - 2];
    const y2 = current.points[current.points.length - 1];
    if (current.type !== 'pen' && Math.hypot(x2 - x1, y2 - y1) < MIN_DRAG / view.scale) return;
    if (current.type === 'pen' && current.points.length < 6) return;
    const item = current.type === 'rect' || current.type === 'ellipse'
      ? { id: newId(), type: current.type, ...normalizeRect(x1, y1, x2, y2), instruction: '' }
      : { id: newId(), type: current.type, points: current.points, instruction: '' };
    onChange(d => ({ ...d, annotations: addItem(d.annotations, item) }));
  };

  const draftItem = draft && (draft.type === 'rect' || draft.type === 'ellipse'
    ? { id: 'draft', type: draft.type, ...normalizeRect(draft.points[0], draft.points[1], draft.points[2], draft.points[3]) }
    : { id: 'draft', type: draft.type, points: draft.points });

  const selectable = tool === 'select' && mode !== 'mask' && !spaceDown;
  const labelSize = 12 / view.scale;

  const onDrop = event => {
    event.preventDefault();
    const stage = stageRef.current;
    stage.setPointersPositions(event);
    const p = stage.getRelativePointerPosition();
    const anchorId = event.dataTransfer.getData('application/x-picgen-anchor');
    if (anchorId) { onDropAnchor?.(anchorId, p); return; }
    const files = [...(event.dataTransfer.files || [])].filter(file => file.type.startsWith('image/'));
    if (files.length) onDropFiles?.(files);
  };

  return (
    <div ref={wrapRef} className={`ws-canvas${spaceDown ? ' is-panning' : ''}${panning ? ' is-panning is-grabbing' : ''}`} data-mode={mode} data-tool={tool}
      onMouseDownCapture={startPan} onAuxClick={event => event.preventDefault()}
      onDragOver={event => event.preventDefault()} onDrop={onDrop} onMouseLeave={() => setCursor(null)}>
      <Stage ref={stageRef} width={size.w} height={size.h} scaleX={view.scale} scaleY={view.scale} x={view.x} y={view.y}
        draggable={spaceDown} onDragEnd={event => { if (event.target === stageRef.current) setView(v => ({ ...v, x: event.target.x(), y: event.target.y() })); }}
        onWheel={onWheel} onMouseDown={onDown} onTouchStart={onDown} onMouseMove={onMove} onTouchMove={onMove} onMouseUp={onUp} onTouchEnd={onUp}>
        <Layer>
          <Rect name="frame" x={0} y={0} width={doc.frame.w} height={doc.frame.h} fill={background}
            shadowColor="#0F172A" shadowOpacity={0.12} shadowBlur={16 / view.scale} />
          {doc.images.map(item => (
            <KonvaImage key={item.id} ref={node => { nodeRefs.current[item.id] = node; }} image={images[item.id]}
              x={item.x + item.w / 2} y={item.y + item.h / 2} width={item.w} height={item.h} offsetX={item.w / 2} offsetY={item.h / 2}
              rotation={item.rotation || 0} draggable={selectable}
              onMouseDown={event => { if (selectable && event.evt.button === 0) onSelect(item.id); }} onTap={() => { if (selectable) onSelect(item.id); }}
              onDragEnd={event => onChange(d => updateImage(d, item.id, { x: event.target.x() - item.w / 2, y: event.target.y() - item.h / 2 }))}
              onTransformEnd={event => {
                const node = event.target;
                const w = item.w * node.scaleX();
                const h = item.h * node.scaleY();
                node.scaleX(1); node.scaleY(1);
                onChange(d => updateImage(d, item.id, { w, h, x: node.x() - w / 2, y: node.y() - h / 2, rotation: node.rotation() }));
              }} />
          ))}
          {doc.anchors.map(item => {
            const meta = anchorMeta[item.anchorId] || {};
            // 对比物体与图片一样：任意拖动、等比缩放、旋转（绕中心），不再锁在地面线上
            return <React.Fragment key={item.id}>
              <KonvaImage ref={node => { nodeRefs.current[item.id] = node; }} image={anchorImages[item.anchorId]}
                x={item.x + item.w / 2} y={item.y + item.h / 2} width={item.w} height={item.h} offsetX={item.w / 2} offsetY={item.h / 2}
                rotation={item.rotation || 0} draggable={selectable}
                onMouseDown={event => { if (selectable && event.evt.button === 0) onSelect(item.id); }} onTap={() => { if (selectable) onSelect(item.id); }}
                onDragEnd={event => onChange(d => updateAnchor(d, item.id, { x: event.target.x() - item.w / 2, y: event.target.y() - item.h / 2 }))}
                onTransformEnd={event => {
                  const node = event.target;
                  const w = item.w * node.scaleX();
                  const h = item.h * node.scaleY();
                  node.scaleX(1); node.scaleY(1);
                  onChange(d => updateAnchor(d, item.id, { w, h, x: node.x() - w / 2, y: node.y() - h / 2, rotation: node.rotation() }));
                }} />
              <Text x={item.x} y={item.y - labelSize * 1.6} text={item.renderable ? meta.short || '' : `${meta.short || ''} · 仅参照`}
                fontSize={labelSize} fill={item.renderable ? '#047857' : '#6B7280'} listening={false} />
            </React.Fragment>;
          })}
          <Transformer ref={transformerRef} keepRatio rotateEnabled enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
            anchorSize={10} borderStroke="#2563EB" anchorStroke="#2563EB" rotationSnaps={[0, 90, 180, 270]} />
        </Layer>
        <Layer>
          {doc.annotations.map(item => (
            <Shape key={item.id} item={item} color={style.color} stroke={style.stroke} selected={item.id === selectedId}
              draggable={selectable && mode === 'annotate'}
              onSelect={event => { if (selectable && (event?.evt?.button ?? 0) === 0) onSelect(item.id); }}
              onMoved={(dx, dy) => onChange(d => ({ ...d, annotations: d.annotations.map(a => (a.id === item.id ? translateItem(a, dx, dy) : a)) }))} />
          ))}
          {draftItem && <Shape item={draftItem} color={style.color} stroke={style.stroke} />}
          {doc.annotations.map(item => <Badge key={`b_${item.id}`} item={item} color={style.color} stroke={style.stroke} />)}
        </Layer>
        <Layer listening={false}>
          <KonvaImage ref={maskImageRef} image={maskCanvas} x={0} y={0} width={doc.frame.w} height={doc.frame.h} opacity={!maskVisible ? 0 : mode === 'mask' ? 0.5 : 0.28} />
          {mode === 'mask' && cursor && (
            <>
              <Circle x={cursor.x} y={cursor.y} radius={brushSize / 2 / view.scale} stroke="#FFFFFF" strokeWidth={2} strokeScaleEnabled={false} />
              <Circle x={cursor.x} y={cursor.y} radius={brushSize / 2 / view.scale} stroke="#111111" strokeWidth={1} strokeScaleEnabled={false} dash={[3, 3]} />
            </>
          )}
        </Layer>
        <Layer listening={false}>
          <Rect x={0} y={0} width={doc.frame.w} height={doc.frame.h} stroke="#2563EB" strokeWidth={1.2} strokeScaleEnabled={false} dash={[6, 5]} />
        </Layer>
      </Stage>
    </div>
  );
});

export { WorkspaceCanvas };
