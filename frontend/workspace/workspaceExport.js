// 工作台导出：全部在 2D canvas 上按"画框像素"合成，与屏幕上的缩放/平移无关。
// 输出：干净原图、比例版面、标注图（可叠红色涂抹）、OpenAI 格式蒙版、涂抹范围。
import { badgeAnchor } from '../annotation/annotationModel.mjs';
import { freehandOutline, badgeTextColor } from './annotationShapes.jsx';

const LAYOUT_BACKGROUND = '#C4C4C4';
const PAINT = 'rgba(239,68,68,0.6)';

function canvasFor(frame) {
  const canvas = document.createElement('canvas');
  canvas.width = frame.w;
  canvas.height = frame.h;
  return canvas;
}

// 比例版面只负责锁位置和大小（外观看"原图"那张）：把照片里接近白色的背景抠成透明，
// 免得模型把白底当成一块白板画进场景
function keyOutWhite(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = pixels.data;
  for (let i = 0; i < d.length; i += 4) {
    const low = Math.min(d[i], d[i + 1], d[i + 2]);
    if (low > 244) d[i + 3] = 0;
    else if (low > 232) d[i + 3] = Math.round(d[i + 3] * (244 - low) / 12);
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

function drawImages(ctx, doc, images, { keyWhite = false } = {}) {
  for (const item of doc.images) {
    const img = images[item.id] && keyWhite ? keyOutWhite(images[item.id]) : images[item.id];
    if (!img) continue;
    ctx.save();
    ctx.translate(item.x + item.w / 2, item.y + item.h / 2);
    ctx.rotate(((item.rotation || 0) * Math.PI) / 180);
    ctx.drawImage(img, -item.w / 2, -item.h / 2, item.w, item.h);
    ctx.restore();
  }
}

// 对比物体和图片一样可以缩放、旋转（绕中心）
function drawAnchors(ctx, doc, anchorImages) {
  for (const item of doc.anchors) {
    const img = anchorImages[item.anchorId];
    if (!img) continue;
    ctx.save();
    ctx.translate(item.x + item.w / 2, item.y + item.h / 2);
    ctx.rotate(((item.rotation || 0) * Math.PI) / 180);
    ctx.drawImage(img, -item.w / 2, -item.h / 2, item.w, item.h);
    ctx.restore();
  }
}

function arrowHead(ctx, x1, y1, x2, y2, size) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 7), y2 - size * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 7), y2 - size * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

export function drawAnnotations(ctx, items, style) {
  const color = style.color || '#FF00FF';
  const stroke = style.stroke || 6;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = stroke;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const item of items) {
    if (item.type === 'rect') ctx.strokeRect(item.x, item.y, item.w, item.h);
    else if (item.type === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(item.x + item.w / 2, item.y + item.h / 2, Math.max(1, item.w / 2), Math.max(1, item.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (item.type === 'arrow') {
      const p = item.points;
      const x2 = p[p.length - 2]; const y2 = p[p.length - 1];
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      arrowHead(ctx, p[0], p[1], x2, y2, stroke * 4);
    } else if (item.type === 'pen') {
      const outline = freehandOutline(item.points, stroke * 1.6);
      if (outline.length) {
        ctx.beginPath();
        ctx.moveTo(outline[0][0], outline[0][1]);
        for (const [x, y] of outline.slice(1)) ctx.lineTo(x, y);
        ctx.closePath();
        ctx.fill();
      }
    } else if (item.type === 'pin') {
      ctx.beginPath();
      ctx.arc(item.x, item.y, stroke * 1.2, 0, Math.PI * 2);
      ctx.fill();
    } else if (item.type === 'text' && item.text) {
      ctx.font = `bold ${stroke * 7}px "Microsoft YaHei", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineWidth = stroke * 0.6;
      ctx.strokeStyle = '#111111';
      ctx.strokeText(item.text, item.x, item.y);
      ctx.fillText(item.text, item.x, item.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = stroke;
    }
  }
  // 编号徽标画在最上层
  for (const item of items) {
    if (item.pin == null) continue;
    const { x, y } = badgeAnchor(item);
    const r = stroke * 4.2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = stroke * 0.35;
    ctx.strokeStyle = '#111111';
    ctx.stroke();
    ctx.fillStyle = badgeTextColor(color);
    ctx.font = `bold ${r * 1.25}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(item.pin), x, y + r * 0.05);
    ctx.textAlign = 'start';
    ctx.lineWidth = stroke;
    ctx.strokeStyle = color;
  }
  ctx.restore();
}

// 涂抹画布：被涂的像素 alpha>0
export function maskBounds(maskCanvas) {
  if (!maskCanvas) return null;
  const { width, height } = maskCanvas;
  const data = maskCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const toBase64 = canvas => canvas.toDataURL('image/png').split(',')[1];

// 涂抹区域取成纯色红（固定透明度），叠在别的画面上
function paintTint(frame, maskCanvas) {
  const tint = canvasFor(frame);
  const tctx = tint.getContext('2d');
  tctx.drawImage(maskCanvas, 0, 0);
  tctx.globalCompositeOperation = 'source-in';
  tctx.fillStyle = PAINT;
  tctx.fillRect(0, 0, frame.w, frame.h);
  return tint;
}

// composite：画面上看到的一切合成一张（输出到参考图 / 另存为用）
export function exportWorkspace({ doc, images, anchorImages, maskCanvas, background = '#FFFFFF', paintMask = false, composite = false }) {
  const { frame } = doc;
  const out = {};

  const clean = canvasFor(frame);
  const cctx = clean.getContext('2d');
  cctx.fillStyle = background;
  cctx.fillRect(0, 0, frame.w, frame.h);
  drawImages(cctx, doc, images);
  out.original = toBase64(clean);

  if (doc.anchors.length) {
    const layout = canvasFor(frame);
    const lctx = layout.getContext('2d');
    lctx.fillStyle = LAYOUT_BACKGROUND;
    lctx.fillRect(0, 0, frame.w, frame.h);
    drawImages(lctx, doc, images, { keyWhite: true });
    drawAnchors(lctx, doc, anchorImages);
    out.layout = toBase64(layout);
  }

  const bounds = maskBounds(maskCanvas);
  if (doc.annotations.length || (bounds && paintMask)) {
    const annotated = canvasFor(frame);
    const actx = annotated.getContext('2d');
    actx.drawImage(clean, 0, 0);
    if (bounds && paintMask) {
      actx.drawImage(paintTint(frame, maskCanvas), 0, 0);
    }
    drawAnnotations(actx, doc.annotations, doc.annotationStyle || {});
    out.annotated = toBase64(annotated);
  }

  if (bounds) {
    // OpenAI 格式：不透明白色 = 保留，alpha=0 = 修改
    const mask = canvasFor(frame);
    const mctx = mask.getContext('2d');
    mctx.fillStyle = '#FFFFFF';
    mctx.fillRect(0, 0, frame.w, frame.h);
    mctx.globalCompositeOperation = 'destination-out';
    mctx.drawImage(maskCanvas, 0, 0);
    out.mask = toBase64(mask);
    out.maskBounds = bounds;
    // 给界面看的修改区域预览：原图 + 红色涂抹
    const preview = canvasFor(frame);
    const pctx = preview.getContext('2d');
    pctx.drawImage(clean, 0, 0);
    pctx.drawImage(paintTint(frame, maskCanvas), 0, 0);
    out.maskPreview = toBase64(preview);
  }

  if (composite) {
    const all = canvasFor(frame);
    const x = all.getContext('2d');
    x.drawImage(clean, 0, 0);
    drawAnchors(x, doc, anchorImages);
    if (bounds && paintMask) x.drawImage(paintTint(frame, maskCanvas), 0, 0);
    drawAnnotations(x, doc.annotations, doc.annotationStyle || {});
    out.composite = toBase64(all);
  }
  return out;
}
