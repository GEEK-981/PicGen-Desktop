import React, { useState } from 'react';
import { flushSync } from 'react-dom';
import { Card, CardMedia, CardHeader, CardDescription } from '@appica/ui-react/card';

export function ImageCard({ native = false, data = {} }) {
  const id = suffix => native ? `preview${suffix}` : `imageHoverPreview${suffix}`;
  return <Card className="picgen-preview-card" inset>
    <CardMedia className="picgen-preview-media"><img id={native ? 'previewImage' : 'imageHoverPreviewImg'} src={data.src || undefined} alt="图片预览" /></CardMedia>
    <CardHeader className="picgen-preview-caption"><CardDescription className="picgen-preview-meta">
      <span id={id('Dimensions')}>尺寸: {data.dimensions || '-'}</span>
      <span id={id('Model')}>模型: {data.model || '-'}</span>
      <span id={id('Provider')}>供应商: {data.providerName || '-'}</span>
    </CardDescription></CardHeader>
  </Card>;
}
export function NativePreview() {
  const [data, setData] = useState({});
  const revision = React.useRef(0);
  window.applyPreview = async next => {
    const request = ++revision.current;
    if (next.src) { const image = new Image(); image.src = next.src; await image.decode(); }
    if (request !== revision.current) return;
    flushSync(() => setData(next));
  };
  return <ImageCard native data={data} />;
}
