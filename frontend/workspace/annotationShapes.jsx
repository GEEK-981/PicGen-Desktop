import React from 'react';
import { Rect, Ellipse, Arrow, Path, Circle, Text, Group } from 'react-konva';
import { getStroke } from 'perfect-freehand';
import { badgeAnchor } from '../annotation/annotationModel.mjs';

// 标注形状在 Konva 里的画法（工作台画布用）；导出时 workspaceExport 用同样的几何在 2D canvas 上重画。

export function freehandOutline(points, size) {
  const pairs = [];
  for (let i = 0; i < points.length; i += 2) pairs.push([points[i], points[i + 1]]);
  return getStroke(pairs, { size, thinning: 0.4, smoothing: 0.6, streamline: 0.5 });
}

export function freehandPath(points, size) {
  const outline = freehandOutline(points, size);
  if (!outline.length) return '';
  const [first, ...rest] = outline;
  return `M${first[0]} ${first[1]}${rest.map(([x, y]) => `L${x} ${y}`).join('')}Z`;
}

export function badgeTextColor(hex) {
  return String(hex).toUpperCase() === '#FF00FF' ? '#FFFFFF' : '#111111';
}

export function Badge({ item, color, stroke }) {
  if (item.pin == null) return null;
  const { x, y } = badgeAnchor(item);
  const r = stroke * 4.2;
  return <Group x={x} y={y} listening={false}>
    <Circle radius={r} fill={color} stroke="#111111" strokeWidth={stroke * 0.35} />
    <Text text={String(item.pin)} fontSize={r * 1.25} fontStyle="bold" fill={badgeTextColor(color)}
      width={r * 2} height={r * 2} offsetX={r} offsetY={r} align="center" verticalAlign="middle" />
  </Group>;
}

export function Shape({ item, color, stroke, selected, draggable, onSelect, onMoved }) {
  const common = {
    stroke: color, strokeWidth: stroke, draggable, hitStrokeWidth: stroke * 4,
    shadowColor: selected ? '#000000' : undefined, shadowBlur: selected ? stroke * 2 : 0, shadowOpacity: selected ? 0.8 : 0,
    onMouseDown: onSelect, onTap: onSelect,
    onDragEnd: event => {
      const node = event.target;
      const dx = node.x() - (item.points ? 0 : (item.type === 'ellipse' ? item.x + item.w / 2 : item.x));
      const dy = node.y() - (item.points ? 0 : (item.type === 'ellipse' ? item.y + item.h / 2 : item.y));
      onMoved?.(dx, dy);
      if (item.points) node.position({ x: 0, y: 0 });
    },
  };
  switch (item.type) {
    case 'rect': return <Rect {...common} x={item.x} y={item.y} width={item.w} height={item.h} />;
    case 'ellipse': return <Ellipse {...common} x={item.x + item.w / 2} y={item.y + item.h / 2} radiusX={item.w / 2} radiusY={item.h / 2} />;
    case 'arrow': return <Arrow {...common} points={item.points} fill={color} pointerLength={stroke * 4} pointerWidth={stroke * 4} />;
    case 'pen': return <Path {...common} data={freehandPath(item.points, stroke * 1.6)} fill={color} strokeWidth={0} hitStrokeWidth={stroke * 4} />;
    case 'pin': return <Circle {...common} x={item.x} y={item.y} radius={stroke * 1.2} fill={color} />;
    case 'text': return <Text {...common} x={item.x} y={item.y} text={item.text || '文字'} opacity={item.text ? 1 : 0.45} fontSize={stroke * 7} fontStyle="bold"
      fill={color} stroke="#111111" strokeWidth={stroke * 0.3} fillAfterStrokeEnabled />;
    default: return null;
  }
}
