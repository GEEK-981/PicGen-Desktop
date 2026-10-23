import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { Input } from '@appica/ui-react/input';
import { Toggle } from '@appica/ui-react/toggle';
import { ToggleGroup } from '@appica/ui-react/toggle-group';
import { Slider } from '@appica/ui-react/slider';
import { Switch } from '@appica/ui-react/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@appica/ui-react/select';
import {
  MousePointer2, Square, Circle as CircleIcon, MoveUpRight, Pencil, MapPin, Type, Undo2, Redo2, Trash2, PenLine, Ruler, Brush,
  Eraser, Eye, EyeOff, FlipHorizontal2, Send, Download, ChevronDown, ZoomIn, ZoomOut, Maximize2, Sparkles, Lightbulb, ImagePlus, X, Check, BrushCleaning
} from 'lucide-react';
import { WorkspaceCanvas } from './WorkspaceCanvas.jsx';
import {
  RATIOS, frameForRatio, createWorkspaceDoc, addImage, placeAnchor, removeItem, setFrameRatio, frameShift,
  isBlankDoc, blankWorkspaceDoc, templateForModel, planOutputs, groupModelsByFamily, modelFamily
} from './workspaceModel.mjs';
import { buildWorkspacePrompt } from './workspacePrompt.mjs';
import { exportWorkspace, maskBounds } from './workspaceExport.js';
import { adaptiveStroke, pickAnnotationColor, circledNumber, positionLabel, removeItem as removeAnnotation, annotationWarnings } from '../annotation/annotationModel.mjs';
import './workspace.css';

// 图片工作台（React 完全拥有这个子根）。desktop.js 只负责：打开时给图片、发送时接住结果。
// 界面不出现任何格式/协议细节：用户按种类选模型（不跟随序列的默认模型），输出格式按模型自动匹配。
// 发送和"输出到参考图"都进入当前活动序列；发送时把所选模型设到这个序列上。

const HISTORY_LIMIT = 60;
const MASK_HISTORY_LIMIT = 8;
const ALIAS = { layout: '__WS_LAYOUT__', original: '__WS_ORIGINAL__', annotated: '__WS_ANNOTATED__' };
const ROLE_NAMES = { layout: '比例版面', original: '原图', annotated: '标注图' };
const SHAPE_NAMES = { rect: '框', ellipse: '圈', arrow: '箭头', pen: '涂画', pin: '标记点', text: '文字' };
const ANNOTATE_TOOLS = [
  ['select', '选择 / 移动', MousePointer2], ['rect', '框', Square], ['ellipse', '圈', CircleIcon], ['arrow', '箭头', MoveUpRight],
  ['pen', '画笔', Pencil], ['pin', '编号', MapPin], ['text', '文字', Type]
];
const MODES = [['annotate', '标注', PenLine], ['scale', '比例', Ruler], ['mask', '蒙版', Brush]];
const CLEARED_NOTICE = '已清空工作台 · 撤销（Ctrl+Z）可恢复';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = src;
  });
}

function recolorSvg(svg, fill, background = 'transparent') {
  return svg.replace(/#000000/gi, fill).replace(/#FFFFFF/gi, background === 'transparent' ? '#F5F5F4' : background);
}
const svgUrl = svg => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

function sampleColor(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 64, 64);
  return pickAnnotationColor(ctx.getImageData(0, 0, 64, 64).data, 4);
}

// 产品在照片里的实际范围：去掉接近白色/透明的背景边（缩到 256 像素内估算，够比例用）
function detectContent(img) {
  const k = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w; let minY = h; let maxX = -1; let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 16 || Math.min(data[i], data[i + 1], data[i + 2]) > 236) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 1, h: 1 };
  const box = { x: minX / w, y: minY / h, w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h };
  // 几乎整张都是内容（复杂背景）就当整张
  return box.w * box.h > 0.97 ? { x: 0, y: 0, w: 1, h: 1 } : box;
}

function friendlyPrompt(text) {
  return text.replace(/@\{__WS_(LAYOUT|ORIGINAL|ANNOTATED)__\}/g, (_, role) => `@${ROLE_NAMES[role.toLowerCase()]}`);
}

// 上次选的生成模型（只是本机的便利记忆，读写失败就当没有）
const MODEL_KEY = 'picgen.workspace.model';
function readSavedModel() { try { return window.localStorage.getItem(MODEL_KEY) || ''; } catch { return ''; } }
function saveModel(model) { try { window.localStorage.setItem(MODEL_KEY, model); } catch { /* 无痕/禁用存储时忽略 */ } }

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Workspace({ session, models = [], targetName = '', api, onSend }) {
  const [doc, setDocState] = useState(blankWorkspaceDoc);
  const docRef = useRef(doc);
  const setDoc = useCallback(next => { docRef.current = next; setDocState(next); }, []);
  const history = useRef({ past: [], future: [], coalesce: '' });
  const [, setTick] = useState(0);
  const [mode, setMode] = useState(session?.mode || 'annotate');
  const [tool, setTool] = useState('rect');
  const [selectedId, setSelectedId] = useState(null);
  const [images, setImages] = useState({});
  const [catalog, setCatalog] = useState([]);
  const [libraryTab, setLibraryTab] = useState('renderable');
  const [maskTool, setMaskTool] = useState('brush');
  const [brushSize, setBrushSize] = useState(36);
  const [maskVisible, setMaskVisible] = useState(true);
  const [maskVersion, setMaskVersion] = useState(0);
  // 严格保持涂抹区外不变 = 把结果贴回原图。默认关：实测贴回会在模型画出界时硬切、留接缝。
  // OpenAI 原生蒙版总是贴回（中转站只返回涂抹区），所以只对其他模型显示这个开关
  const [keepOutside, setKeepOutside] = useState(false);
  const [maskInstruction, setMaskInstruction] = useState('');
  const [scene, setScene] = useState('');
  const [pickedModel, setPickedModel] = useState(readSavedModel);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const maskCanvasRef = useRef(null);
  const canvasApi = useRef(null);
  const fileInput = useRef(null);
  // 每张图的原始数据（发送时随工作台文档保存，之后可原样恢复继续编辑）
  const sourcesRef = useRef({});

  if (!maskCanvasRef.current) maskCanvasRef.current = document.createElement('canvas');
  const maskCanvas = maskCanvasRef.current;

  // ── 会话初始化：载入图片（或恢复上次的工作台文档）──
  useEffect(() => {
    let alive = true;
    (async () => {
      const sources = session?.images || [];
      const loaded = {};
      sourcesRef.current = {};
      let next = session?.doc ? { ...session.doc } : blankWorkspaceDoc();
      if (session?.doc) {
        for (const [index, item] of next.images.entries()) {
          const src = sources[index];
          if (src) { loaded[item.id] = await loadImage(`data:${src.mimeType || 'image/png'};base64,${src.base64}`); sourcesRef.current[item.id] = src; }
        }
      } else {
        for (const [index, src] of sources.entries()) {
          const img = await loadImage(`data:${src.mimeType || 'image/png'};base64,${src.base64}`);
          const id = `img_${Math.random().toString(36).slice(2, 9)}`;
          if (index === 0) next = { ...createWorkspaceDoc({ ratio: 'original' }), frame: frameForRatio('original', { w: img.naturalWidth, h: img.naturalHeight }) };
          loaded[id] = img;
          sourcesRef.current[id] = { base64: src.base64, mimeType: src.mimeType || 'image/png', name: src.name };
          next = addImage(next, { id, refId: src.refId || '', name: src.name, naturalW: img.naturalWidth, naturalH: img.naturalHeight, content: detectContent(img) });
        }
        const first = Object.values(loaded)[0];
        next.annotationStyle = { color: first ? sampleColor(first) : '#FF00FF', stroke: adaptiveStroke(next.frame.w, next.frame.h) };
      }
      if (!alive) return;
      maskCanvas.width = next.frame.w;
      maskCanvas.height = next.frame.h;
      maskCanvas.getContext('2d').clearRect(0, 0, next.frame.w, next.frame.h);
      history.current = { past: [], future: [], coalesce: '' };
      setImages(loaded);
      setDoc(next);
      setSelectedId(null);
      setMode(session?.mode || 'annotate');
      setTool(session?.mode === 'scale' ? 'select' : 'rect');
      setMaskVersion(v => v + 1);
      setTick(t => t + 1);
    })().catch(error => setNotice(error.message));
    return () => { alive = false; };
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { api?.listAnchors?.().then(list => setCatalog(Array.isArray(list) ? list : [])).catch(() => {}); }, [api]);

  const anchorMeta = useMemo(() => Object.fromEntries(catalog.map(a => [a.id, a])), [catalog]);
  const [anchorImages, setAnchorImages] = useState({ view: {}, layout: {}, thumb: {} });
  useEffect(() => {
    let alive = true;
    (async () => {
      const view = {}; const layout = {}; const thumb = {};
      for (const a of catalog) {
        if (!a.svg) continue;
        view[a.id] = await loadImage(svgUrl(recolorSvg(a.svg, a.renderable ? '#7C8591' : '#A3A9B0')));
        layout[a.id] = await loadImage(svgUrl(recolorSvg(a.svg, '#5F6368', '#C4C4C4')));
        thumb[a.id] = svgUrl(recolorSvg(a.svg, '#6B7280'));
      }
      if (alive) setAnchorImages({ view, layout, thumb });
    })().catch(() => {});
    return () => { alive = false; };
  }, [catalog]);

  // ── 撤销：画布改动与涂抹共用一条时间线 ──
  const pushHistory = entry => {
    const h = history.current;
    h.past = [...h.past, entry].slice(-HISTORY_LIMIT);
    const maskEntries = h.past.filter(e => e.mask);
    if (maskEntries.length > MASK_HISTORY_LIMIT) {
      const oldest = h.past.indexOf(maskEntries[0]);
      // 带画布或文字的一步（清空、换比例）不能从中间抽掉：撤销会越过它、把旧画框套在新尺寸的蒙版上，所以连同更早的一起丢
      if (maskEntries[0].doc || maskEntries[0].fields) h.past = h.past.slice(oldest + 1);
      else h.past.splice(oldest, 1);
    }
    h.future = [];
    setTick(t => t + 1);
  };
  const commit = useCallback((updater, coalesceKey = '') => {
    const current = docRef.current;
    let next;
    try { next = typeof updater === 'function' ? updater(current) : updater; } catch (error) { setNotice(error.message); return; }
    if (!next || next === current) return;
    const h = history.current;
    if (!coalesceKey || h.coalesce !== coalesceKey) pushHistory({ doc: current });
    h.coalesce = coalesceKey;
    setDoc(next);
  }, [setDoc]); // eslint-disable-line react-hooks/exhaustive-deps
  const snapshotMask = () => ({ w: maskCanvas.width, h: maskCanvas.height, data: maskCanvas.getContext('2d').getImageData(0, 0, maskCanvas.width, maskCanvas.height) });
  const applyMask = snap => {
    if (maskCanvas.width !== snap.w || maskCanvas.height !== snap.h) { maskCanvas.width = snap.w; maskCanvas.height = snap.h; }
    maskCanvas.getContext('2d').putImageData(snap.data, 0, 0);
    setMaskVersion(v => v + 1);
  };
  const onMaskStroke = phase => {
    if (phase === 'start') { history.current.coalesce = ''; pushHistory({ mask: snapshotMask() }); }
    else setMaskVersion(v => v + 1);
  };
  // fields：清空时一并清掉的场景 / 修改要求文字，也跟着撤销、重做
  const restore = (entry, into) => {
    into.push({ ...(entry.doc ? { doc: docRef.current } : {}), ...(entry.mask ? { mask: snapshotMask() } : {}),
      ...(entry.fields ? { fields: { scene, maskInstruction } } : {}) });
    if (entry.mask) applyMask(entry.mask);
    if (entry.doc) setDoc(entry.doc);
    if (entry.fields) {
      setScene(entry.fields.scene); setMaskInstruction(entry.fields.maskInstruction);
      setNotice(current => (current === CLEARED_NOTICE ? '' : current));
    }
  };
  const undo = () => {
    const h = history.current;
    const entry = h.past.pop();
    if (!entry) return;
    const redoStack = [];
    restore(entry, redoStack);
    h.future = [...redoStack, ...h.future];
    h.coalesce = '';
    setTick(t => t + 1);
  };
  const redo = () => {
    const h = history.current;
    const entry = h.future.shift();
    if (!entry) return;
    const undoStack = [];
    restore(entry, undoStack);
    h.past = [...h.past, ...undoStack];
    h.coalesce = '';
    setTick(t => t + 1);
  };
  const deleteSelected = () => {
    if (!selectedId) return;
    commit(d => {
      const next = removeItem(d, selectedId);
      return { ...next, annotations: removeAnnotation(d.annotations, selectedId) };
    });
    setSelectedId(null);
  };
  // 清空工作台：一步可撤销，不弹确认。images / sourcesRef 留在内存里供撤销重画（同 deleteSelected）；
  // 不动 desktop.js 的 session：换 session id 会重新初始化并清掉撤销历史
  const clearAll = () => {
    if (isBlankDoc(docRef.current) && !hasMask()) return;
    history.current.coalesce = '';
    pushHistory({ doc: docRef.current, mask: snapshotMask(), fields: { scene, maskInstruction } });
    const next = blankWorkspaceDoc();
    maskCanvas.width = next.frame.w; maskCanvas.height = next.frame.h; // 重设宽度即清空
    setDoc(next); setSelectedId(null); setMenuOpen(false); setSheet(null); setScene(''); setMaskInstruction('');
    setMaskVersion(v => v + 1);
    setNotice(CLEARED_NOTICE);
  };

  // 只读调试入口（冒烟测试断言画布数据用；与 desktop.js 的全局 state 同理）
  useEffect(() => {
    window.PicGenWorkspaceDebug = { doc: () => docRef.current, hasMask: () => hasMask(), history: () => ({ past: history.current.past.length, future: history.current.future.length }),
      toClient: p => canvasApi.current?.toClient(p) || null };
  });
  const pageRef = useRef(null);
  useEffect(() => {
    const onKey = event => {
      if (!pageRef.current || pageRef.current.closest('[hidden]')) return;
      if (event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redo(); }
      else if ((key === 'delete' || key === 'backspace') && selectedId) { event.preventDefault(); deleteSelected(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── 添加图片（空画布 / 拖入 / 选择文件）──
  const addFiles = async files => {
    for (const file of files) {
      const dataUrl = await readFileAsDataUrl(file);
      const img = await loadImage(dataUrl);
      const id = `img_${Math.random().toString(36).slice(2, 9)}`;
      const [head, base64] = dataUrl.split(',');
      sourcesRef.current[id] = { base64, mimeType: (head.match(/data:([^;]+)/) || [])[1] || 'image/png', name: file.name };
      setImages(prev => ({ ...prev, [id]: img }));
      commit(d => {
        const next = addImage(d, { id, name: file.name, naturalW: img.naturalWidth, naturalH: img.naturalHeight, content: detectContent(img) });
        return next.annotationStyle ? next : { ...next, annotationStyle: { color: sampleColor(img), stroke: adaptiveStroke(next.frame.w, next.frame.h) } };
      });
    }
  };

  // ── 尺寸对比物体：任意拖动、缩放，不锁定尺寸 ──
  const dropAnchor = (anchorId, point) => {
    const meta = anchorMeta[anchorId];
    if (!meta) return;
    // 点击：放在产品旁边；拖进画布：以松手处为中心
    commit(d => placeAnchor(d, meta, point ? { cx: point.x, cy: point.y } : {}));
    setNotice('');
  };

  // ── 发送 ──
  // 生成模型：按种类分组；记住的模型已不在列表里就退回第一个种类的第一个
  const families = useMemo(() => groupModelsByFamily(models), [models]);
  const model = models.includes(pickedModel) ? pickedModel : families[0]?.models[0] || '';
  const family = families.find(f => f.id === modelFamily(model));
  const pickModel = value => { if (!value) return; setPickedModel(value); saveModel(value); };
  const template = templateForModel(model);
  const hasMask = () => !!maskBounds(maskCanvas);
  const buildOutgoing = () => {
    const d = docRef.current;
    const painted = hasMask();
    const maskEdit = painted;
    const plan = planOutputs({
      hasImages: d.images.length > 0,
      hasAnnotations: d.annotations.length > 0,
      hasMask: painted,
      hasLayout: d.anchors.length > 0,
      template: maskEdit ? template : 'marked'
    });
    const exported = exportWorkspace({
      doc: d, images, anchorImages: anchorImages.layout, maskCanvas: painted ? maskCanvas : null,
      paintMask: painted && (!maskEdit || template !== 'openai')
    });
    // 比例版面里的产品通常被缩小了：没有局部修改时，"原图"直接给产品原始照片保留细节；
    // 有局部修改时必须用画框渲染（修改区域与它同尺寸）
    if (d.anchors.length > 0 && !maskEdit && d.images[0] && sourcesRef.current[d.images[0].id]) {
      exported.original = sourcesRef.current[d.images[0].id].base64;
      exported.originalMime = sourcesRef.current[d.images[0].id].mimeType;
    }
    // 修改区域要落在"原图"上：有局部修改时原图排第一
    const roles = plan.references.map(r => r.role);
    if (maskEdit) roles.sort((a, b) => (a === 'original' ? -1 : b === 'original' ? 1 : 0));
    const prompt = buildWorkspacePrompt({
      doc: d, anchorMeta, aliases: ALIAS, template: maskEdit ? template : 'marked',
      hasLayout: d.anchors.length > 0, hasMask: painted, maskBounds: exported.maskBounds, maskInstruction, scene
    });
    return {
      plan, roles, prompt, exported,
      mask: maskEdit ? { base64: exported.mask, guideIncluded: template !== 'openai', composite: keepOutside } : null
    };
  };
  const openSend = () => {
    if (!doc.images.length) { setNotice('请先放入一张图片'); return; }
    try { setSheet(buildOutgoing()); } catch (error) { setNotice(error.message); }
  };
  useEffect(() => { if (sheet) setSheet(buildOutgoing()); }, [model, maskInstruction, scene]); // eslint-disable-line react-hooks/exhaustive-deps
  const [keepDoc, setKeepDoc] = useState(true);
  const send = async () => {
    if (!sheet || busy) return;
    setBusy('send');
    try {
      const result = await onSend?.({
        model,
        references: sheet.roles.map(role => ({ role, name: `${ROLE_NAMES[role]}.png`, base64: sheet.exported[role], mimeType: role === 'original' && sheet.exported.originalMime ? sheet.exported.originalMime : 'image/png' })),
        prompt: sheet.prompt,
        aliases: ALIAS,
        mask: sheet.mask,
        workspace: keepDoc ? { doc: docRef.current, sources: docRef.current.images.map(item => sourcesRef.current[item.id]).filter(Boolean) } : null
      });
      if (result !== false) setSheet(null);
    } catch (error) { setNotice(error.message); }
    finally { setBusy(''); }
  };

  // 当前画面（图片 + 对比物体 + 标注 + 涂抹）合成一张图：输出到活动序列的参考图，或另存为文件
  const exportAction = async kind => {
    setMenuOpen(false);
    try {
      const base64 = exportWorkspace({ doc, images, anchorImages: anchorImages.view, maskCanvas: hasMask() ? maskCanvas : null, paintMask: true, composite: true }).composite;
      const name = `工作台-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.png`;
      if (kind === 'reference') {
        const ok = await api?.addToReferences?.({ base64, name });
        if (ok !== false) setNotice(`已添加到「${targetName || '当前序列'}」的参考图`);
      } else {
        const saved = await api?.saveAs?.({ base64, name });
        if (saved?.filePath) setNotice(`已保存：${saved.fileName || saved.filePath}`);
      }
    } catch (error) { setNotice(error.message); }
  };

  const changeRatio = ratio => {
    if (ratio === doc.frame.ratio) return;
    const before = doc.frame;
    const next = setFrameRatio(doc, ratio);
    const { dx, dy } = frameShift(before, next.frame);
    const copy = document.createElement('canvas');
    copy.width = maskCanvas.width; copy.height = maskCanvas.height;
    copy.getContext('2d').drawImage(maskCanvas, 0, 0);
    maskCanvas.width = next.frame.w; maskCanvas.height = next.frame.h;
    maskCanvas.getContext('2d').drawImage(copy, dx, dy);
    history.current.coalesce = '';
    pushHistory({ doc, mask: { w: copy.width, h: copy.height, data: copy.getContext('2d').getImageData(0, 0, copy.width, copy.height) } });
    setDoc(next);
    setMaskVersion(v => v + 1);
    requestAnimationFrame(() => canvasApi.current?.fitView());
  };

  const patchAnnotation = (id, patch) => commit(d => ({ ...d, annotations: d.annotations.map(a => (a.id === id ? { ...a, ...patch } : a)) }),
    `patch:${id}:${Object.keys(patch).join(',')}`);
  const listed = doc.annotations.filter(item => item.pin != null || item.type === 'text').sort((a, b) => (a.pin ?? 999) - (b.pin ?? 999));
  const annColor = doc.annotationStyle?.color || '#FF00FF';
  const warnings = doc.annotations.length ? annotationWarnings({ sourceSize: { w: doc.frame.w, h: doc.frame.h }, items: doc.annotations }) : [];
  const previewPrompt = friendlyPrompt(buildWorkspacePrompt({ doc, anchorMeta, aliases: ALIAS, template, hasLayout: doc.anchors.length > 0, scene }));
  const empty = doc.images.length === 0;
  // 删掉唯一一张图后，涂抹还留在看不见的蒙版画布上：这时「清空」也得能点，否则下一张图会带着旧涂抹去做局部修改。
  // 只在画布空时才扫蒙版（涂抹落笔、清空都会推进 maskVersion）
  const nothingToClear = useMemo(() => isBlankDoc(doc) && !hasMask(), [doc, maskVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const canUndo = history.current.past.length > 0;
  const canRedo = history.current.future.length > 0;

  // 先选种类（Nano Banana / GPT / Grok / Seedream），再在该种类已配置的模型里选一个
  const modelSelect = (id) => (
    <div className="ws-model-picker" id={id}>
      {families.length === 0 ? <p className="ws-hint">先在 API 设置里添加图片模型</p> : <>
        <ToggleGroup value={family ? [family.id] : []} onValueChange={value => { const f = families.find(x => x.id === value[0]); if (f) pickModel(f.models[0]); }}
          className="ws-families" aria-label="模型种类">
          {families.map(f => <Toggle key={f.id} value={f.id} className="ws-family" data-family={f.id}>{f.label}</Toggle>)}
        </ToggleGroup>
        <Select size="sm" value={model} alignItemWithTrigger={false} onValueChange={pickModel}>
          <SelectTrigger className="appica-select-trigger ws-model-trigger" aria-label="生成模型" id={`${id}Select`}>
            <SelectValue>{model}</SelectValue>
          </SelectTrigger>
          <SelectContent className="appica-select-menu" sideOffset={4}>
            {(family?.models || []).map(m => <SelectItem key={m} value={m} className="appica-select-option">{m}</SelectItem>)}
          </SelectContent>
        </Select>
      </>}
    </div>
  );

  return (
    <div className="ws-page" ref={pageRef}>
      <header className="ws-header">
        <div className="ws-title"><h2>图片工作台</h2><p>标注 · 比例参考 · 蒙版，一处完成</p></div>
        <Select size="sm" value={doc.frame.ratio} alignItemWithTrigger={false} onValueChange={value => value && changeRatio(value)}>
          <SelectTrigger className="appica-select-trigger ws-ratio" aria-label="画框比例"><SelectValue>{doc.frame.ratio === 'original' ? '原图' : doc.frame.ratio}</SelectValue></SelectTrigger>
          <SelectContent className="appica-select-menu" sideOffset={4}>
            {RATIOS.map(r => <SelectItem key={r} value={r} className="appica-select-option">{r === 'original' ? '原图' : r}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon-sm" aria-label="撤销" title="撤销 (Ctrl+Z)" disabled={!canUndo} onClick={undo}><Undo2 size={17} /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="重做" title="重做 (Ctrl+Y)" disabled={!canRedo} onClick={redo}><Redo2 size={17} /></Button>
        <Button variant="ghost" size="sm" className="ws-clear" aria-label="清空工作台" title="清空工作台（可撤销）"
          disabled={nothingToClear || !!busy} onClick={clearAll}><BrushCleaning size={15} />清空</Button>
      </header>

      <ToggleGroup value={[mode]} onValueChange={value => { if (value[0]) { setMode(value[0]); setTool(value[0] === 'annotate' ? 'rect' : 'select'); } }} className="ws-modes" aria-label="工作台模式">
        {MODES.map(([id, label, Icon]) => <Toggle key={id} value={id} className="ws-mode" data-mode={id}><Icon size={15} />{label}</Toggle>)}
      </ToggleGroup>

      <div className="ws-toolbar">
        {mode === 'annotate' && <>
          <ToggleGroup value={[tool]} onValueChange={value => { if (value[0]) setTool(value[0]); }} className="ws-tools" aria-label="标注工具">
            {ANNOTATE_TOOLS.map(([id, label, Icon]) => <Toggle key={id} value={id} className="ws-tool" title={label} aria-label={label} data-tool={id}><Icon size={16} /></Toggle>)}
          </ToggleGroup>
          <span className="ws-grow" />
          <span className="ws-color" style={{ background: annColor }} />
          <span className="ws-hint">标注色 · 自动</span>
        </>}
        {mode === 'scale' && <>
          <Toggle pressed className="ws-tool" aria-label="选择 / 移动" data-tool="select"><MousePointer2 size={16} /></Toggle>
          <span className="ws-hint">拖动图片和物体，拖角点调大小</span>
        </>}
        {mode === 'mask' && <>
          <ToggleGroup value={[maskTool]} onValueChange={value => { if (value[0]) setMaskTool(value[0]); }} className="ws-tools" aria-label="涂抹工具">
            <Toggle value="brush" className="ws-tool is-brush" aria-label="画笔" data-tool="brush"><Brush size={16} /></Toggle>
            <Toggle value="eraser" className="ws-tool" aria-label="橡皮" data-tool="eraser"><Eraser size={16} /></Toggle>
          </ToggleGroup>
          <span className="ws-hint">笔刷</span>
          <div className="ws-brush"><Slider value={brushSize} min={8} max={120} step={2} tooltipVisibility="never" thumbAriaLabel="笔刷大小"
            onValueChange={value => setBrushSize(Array.isArray(value) ? value[0] : value)} /></div>
          <span className="ws-brush-value">{brushSize}</span>
          <Button variant="ghost" size="icon-sm" aria-label="反选" title="反选" onClick={() => {
            pushHistory({ mask: snapshotMask() });
            const ctx = maskCanvas.getContext('2d');
            const copy = document.createElement('canvas'); copy.width = maskCanvas.width; copy.height = maskCanvas.height;
            copy.getContext('2d').drawImage(maskCanvas, 0, 0);
            ctx.save(); ctx.fillStyle = '#EF4444'; ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
            ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(copy, 0, 0); ctx.restore();
            setMaskVersion(v => v + 1);
          }}><FlipHorizontal2 size={16} /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={maskVisible ? '隐藏涂抹' : '显示涂抹'} onClick={() => setMaskVisible(v => !v)}>{maskVisible ? <Eye size={16} /> : <EyeOff size={16} />}</Button>
          <Button variant="ghost" size="icon-sm" aria-label="清空涂抹" onClick={() => { pushHistory({ mask: snapshotMask() }); maskCanvas.getContext('2d').clearRect(0, 0, maskCanvas.width, maskCanvas.height); setMaskVersion(v => v + 1); }}><Trash2 size={16} /></Button>
        </>}
      </div>

      <div className="ws-stage">
        {empty ? (
          <div className="ws-empty" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); addFiles([...event.dataTransfer.files].filter(f => f.type.startsWith('image/'))); }}>
            <ImagePlus size={28} />
            <strong>放入一张图片开始</strong>
            <span>拖入图片，或在任意图片上右键「发送到图片工作台」</span>
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>选择图片</Button>
            <input ref={fileInput} type="file" accept="image/*" hidden onChange={event => { addFiles([...event.target.files]); event.target.value = ''; }} />
          </div>
        ) : (
          <WorkspaceCanvas ref={canvasApi} doc={doc} mode={mode} tool={mode === 'mask' ? 'brush' : tool} selectedId={selectedId} onSelect={setSelectedId}
            onChange={commit} images={images} anchorImages={anchorImages.view} anchorMeta={anchorMeta}
            maskCanvas={maskCanvas} maskVisible={maskVisible} maskVersion={maskVersion} brushSize={brushSize} maskTool={maskTool} onMaskStroke={onMaskStroke}
            onDropAnchor={dropAnchor} onDropFiles={addFiles} />
        )}
      </div>
      {!empty && <div className="ws-stage-foot">
        <span>滚轮缩放 · 按住中键拖动画布</span>
        <button type="button" className="ws-fit" aria-label="缩小" title="缩小" onClick={() => canvasApi.current?.zoomBy(1 / 1.25)}><ZoomOut size={13} /></button>
        <button type="button" className="ws-fit" aria-label="放大" title="放大" onClick={() => canvasApi.current?.zoomBy(1.25)}><ZoomIn size={13} /></button>
        <button type="button" className="ws-fit" onClick={() => canvasApi.current?.fitView()}><Maximize2 size={13} />适应画布</button>
      </div>}
      {notice && <div className="ws-notice" role="status">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={13} /></button></div>}

      <section className="ws-panel" aria-label="当前模式设置">
        {mode === 'annotate' && <>
          <div className="ws-panel-head"><h3>标注说明</h3><span>{listed.filter(i => i.pin != null).length} 处编号</span></div>
          <ol className="ws-list">
            {listed.length === 0 && <li className="ws-list-empty">在图上画框、箭头或编号，这里写每处要怎么改。</li>}
            {listed.map(item => (
              <li key={item.id} className={item.id === selectedId ? 'is-selected' : ''} onClick={() => setSelectedId(item.id)}>
                <span className="ws-pin" style={{ background: item.pin != null ? annColor : 'transparent' }}>{item.pin != null ? circledNumber(item.pin) : 'T'}</span>
                <span className="ws-kind">{SHAPE_NAMES[item.type]}·{positionLabel(item, { w: doc.frame.w, h: doc.frame.h })}</span>
                {item.type === 'text'
                  ? <Input inputSize="sm" data-annotation-text={item.id} value={item.text || ''} placeholder="图上显示的文字" onChange={e => patchAnnotation(item.id, { text: e.target.value })} />
                  : <Input inputSize="sm" value={item.instruction || ''} placeholder="这里要怎么改？" onChange={e => patchAnnotation(item.id, { instruction: e.target.value })} />}
                <Button variant="ghost" size="icon-sm" aria-label="删除这处标注" onClick={e => { e.stopPropagation(); commit(d => ({ ...d, annotations: removeAnnotation(d.annotations, item.id) })); }}><Trash2 size={14} /></Button>
              </li>
            ))}
          </ol>
          {warnings.length > 0 && <ul className="ws-warn">{warnings.map(w => <li key={w}>{w}</li>)}</ul>}
          {previewPrompt && <details className="ws-preview"><summary>将写入提示词</summary><p>{previewPrompt}</p></details>}
        </>}
        {mode === 'scale' && <>
          <label className="ws-field">场景（可选）<Input inputSize="sm" id="wsScene" value={scene} placeholder="要放在什么场景？例如：户外草地、木质书桌" onChange={e => setScene(e.target.value)} /></label>
          <div className="ws-panel-head"><h3>尺寸对比素材</h3><span>点击或拖进画布，自由摆放和缩放</span></div>
          <ToggleGroup value={[libraryTab]} onValueChange={value => { if (value[0]) setLibraryTab(value[0]); }} className="ws-tabs">
            <Toggle value="renderable" className="ws-tab">可出现在画面</Toggle>
            <Toggle value="scale" className="ws-tab">仅作参照</Toggle>
          </ToggleGroup>
          {/* 画布上还没有图片时不可放：画布没挂载，放进去的物体看不见 */}
          <div className="ws-library">
            {catalog.filter(a => a.library !== false && (libraryTab === 'renderable') === !!a.renderable).map(a => (
              <button key={a.id} type="button" className="ws-anchor" data-anchor={a.id} disabled={empty} draggable={!empty}
                onDragStart={e => e.dataTransfer.setData('application/x-picgen-anchor', a.id)} onClick={() => dropAnchor(a.id)}>
                {anchorImages.thumb[a.id] && <img src={anchorImages.thumb[a.id]} alt="" />}
                <b>{a.short}</b><em>{(a.label.match(/（(.*)）/) || [])[1] || ''}</em>
              </button>
            ))}
          </div>
        </>}
        {mode === 'mask' && <>
          <div className="ws-panel-head"><h3>修改要求</h3></div>
          <Input inputSize="sm" id="wsMaskInstruction" value={maskInstruction} placeholder="涂抹的地方要改成什么？例如：换成金属拉链" onChange={e => setMaskInstruction(e.target.value)} />
          <div className="ws-panel-head"><h3>生成模型</h3></div>
          {modelSelect('wsMaskModel')}
          <p className="ws-adapt"><Sparkles size={13} />已按所选模型自动适配，无需额外设置</p>
          {template !== 'openai' && <div className="ws-switch"><div><b>严格保持涂抹区外不变</b><span>把结果贴回原图，涂抹区外一个像素都不变；边缘可能出现接缝</span></div>
            <Switch checked={keepOutside} onCheckedChange={setKeepOutside} aria-label="严格保持涂抹区外不变" /></div>}
          <div className="ws-tip"><Lightbulb size={14} /><div><b>涂抹范围贴合要改的地方即可，涂得越大改动越大</b><span>可用橡皮擦修边，Ctrl+Z 撤销</span></div></div>
        </>}
      </section>

      <footer className="ws-footer">
        <div className="ws-menu-wrap">
          <Button variant="outline" size="sm" className="ws-export" onClick={() => setMenuOpen(o => !o)} disabled={empty}><Download size={15} />输出<ChevronDown size={13} /></Button>
          {menuOpen && <div className="ws-menu" role="menu">
            <button type="button" role="menuitem" data-export="reference" onClick={() => exportAction('reference')}>输出到参考图（{targetName || '当前序列'}）</button>
            <button type="button" role="menuitem" data-export="save-as" onClick={() => exportAction('save-as')}>另存为…</button>
          </div>}
        </div>
        <Button variant="primary" size="sm" className="ws-send" id="wsSendBtn" onClick={openSend} disabled={empty}><Send size={15} />发送到生成</Button>
      </footer>

      {sheet && <div className="ws-sheet-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) setSheet(null); }}>
        <div className="ws-sheet" role="dialog" aria-label="发送到生成">
          <div className="ws-sheet-grip" />
          <div className="ws-sheet-head"><h3>发送到生成</h3><Button variant="ghost" size="icon-sm" aria-label="关闭" onClick={() => setSheet(null)}><X size={17} /></Button></div>
          <label className="ws-field">生成模型{modelSelect('wsSendModel')}</label>
          <p className="ws-adapt is-blue"><Sparkles size={13} />已按所选模型匹配参考图和提示词，发送到「{targetName || '当前序列'}」</p>
          <div className="ws-field-row"><span>将添加的参考图</span><span>{sheet.roles.length} 张</span></div>
          <div className="ws-thumbs" data-count={sheet.plan.thumbnails.length}>
            {sheet.plan.thumbnails.map(t => {
              const src = t.role === 'mask' ? sheet.exported.maskPreview : sheet.exported[t.role];
              return <figure key={t.role} data-role={t.role}>
                <div className={`ws-thumb${t.role === 'mask' ? ' is-mask' : ''}`}>{src && <img src={`data:${t.role === 'original' && sheet.exported.originalMime ? sheet.exported.originalMime : 'image/png'};base64,${src}`} alt={t.label} />}</div>
                <figcaption><b>{t.label}</b><span>{t.sub}</span></figcaption>
              </figure>;
            })}
          </div>
          <div className="ws-field-row"><span>追加到提示词</span></div>
          <p className="ws-sheet-prompt" id="wsSendPrompt">{friendlyPrompt(sheet.prompt)}</p>
          <label className="ws-check"><input type="checkbox" checked={keepDoc} onChange={e => setKeepDoc(e.target.checked)} /><Check size={12} />保留编辑内容，之后可在参考图卡片上继续修改</label>
          <div className="ws-sheet-actions">
            <Button variant="outline" size="sm" onClick={() => setSheet(null)} disabled={!!busy}>取消</Button>
            <Button variant="primary" size="sm" id="wsConfirmSend" onClick={send} disabled={!!busy || !model}><Send size={15} />{busy ? '正在发送…' : '发送'}</Button>
          </div>
        </div>
      </div>}
    </div>
  );
}
