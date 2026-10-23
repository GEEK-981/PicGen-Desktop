import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { TextAnimate } from '@appica/ui-react/text-animate';
import { Button } from '@appica/ui-react/button';
import { createParser } from 'eventsource-parser';

const streams = new Map();
function StreamText({ text }) {
  const [shown, setShown] = useState(0);
  const [chunk, setChunk] = useState('');
  useEffect(() => {
    if (chunk || shown >= text.length) return;
    setChunk(text.slice(shown, shown + 100));
  }, [text, shown, chunk]);
  useEffect(() => {
    if (!chunk) return;
    const timer = setTimeout(() => { setShown(n => n + chunk.length); setChunk(''); }, 130);
    return () => clearTimeout(timer);
  }, [chunk]);
  return <div className="stream-text" aria-label={text}>
    <span>{text.slice(0, shown)}</span>
    {chunk && <TextAnimate key={shown} effect="typewriter" duration={0.12}>{chunk}</TextAnimate>}
  </div>;
}
function StreamPanel({ record }) {
  const snapshot = useSyncExternalStore(record.subscribe, record.snapshot);
  return <>
    <div className="prompt-stream-heading"><strong>{snapshot.title}</strong>
      {snapshot.busy ? <Button size="sm" variant="ghost" onClick={record.cancel}>停止</Button> : <Button size="sm" variant="ghost" onClick={() => { record.host.hidden = true; }}>收起</Button>}
    </div>
    {snapshot.text ? <StreamText text={snapshot.text} /> : <span className="stream-waiting">等待模型输出…</span>}
    <div className="prompt-stream-footer" role="status">{snapshot.status}
      {snapshot.text && !snapshot.busy && <Button size="sm" variant="ghost" onClick={() => window.picgenDesktop.copyText(snapshot.text)}>复制</Button>}
      {snapshot.apply && <Button size="sm" onClick={snapshot.apply}>应用到原序列</Button>}
    </div>
  </>;
}
export function startPromptStream(id, title) {
  const host = document.getElementById(id);
  const old = streams.get(id);
  old?.cancel(); old?.root.unmount();
  const controller = new AbortController();
  const listeners = new Set();
  let state = { text: '', busy: true, title, status: '正在连接模型' };
  const record = { host, root: createRoot(host), cancel: () => controller.abort(),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: () => state };
  const update = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  streams.set(id, record); host.hidden = false;
  record.root.render(<StreamPanel record={record} />);
  return { signal: controller.signal, cancel: record.cancel,
    delta: delta => update({ text: state.text + delta, status: '正在输出…' }),
    complete: (text, status = '已完成', apply = null) => update({ text, busy: false, status, apply }),
    fail: error => update({ busy: false, status: error.name === 'AbortError' ? '已停止，已输出内容可复制' : `输出未完成：${error.message}` }) };
}

export async function fetchPromptStream(url, payload, stream) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...payload, stream: true }), signal: stream.signal });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败');
    if (!result.prompt?.trim()) throw new Error('模型没有返回提示词');
    stream.delta(result.prompt);
    return result.prompt;
  }
  let complete = null, failure = null;
  const parser = createParser({ onEvent({ data }) {
    try {
      const event = JSON.parse(data);
      if (event.type === 'delta') stream.delta(event.delta);
      if (event.type === 'done') complete = event.prompt;
      if (event.type === 'error') failure = new Error(event.error || '流式输出失败');
    } catch (error) { failure = error; }
  }, onError(error) { failure = error; }, maxBufferSize: 2000000 });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      if (failure) throw failure;
    }
    parser.feed(decoder.decode());
    if (failure) throw failure;
    if (!complete?.trim()) throw new Error('输出连接中断，已显示内容保留供复制');
    return complete;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
