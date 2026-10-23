const { createParser } = require('eventsource-parser');
const { StringDecoder } = require('node:string_decoder');

// The providers share SSE framing, but their text and terminal events differ.
async function readPromptStream(body, mode, onDelta) {
    let text = '', ended = false, failure = null;
    const parser = createParser({ onEvent({ data }) {
        if (data === '[DONE]') { ended = true; return; }
        if (!data || ended || failure) return;
        try {
            const event = JSON.parse(data);
            if (event.error || event.type === 'error') throw new Error(event.error?.message || event.message || '供应商流式响应失败');
            let delta = '';
            if (mode === 'gemini') {
                const candidate = event.candidates?.[0];
                delta = (candidate?.content?.parts || []).filter(part => !part.thought).map(part => part.text || '').join('');
                if (candidate?.finishReason) {
                    if (!['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) throw new Error(`供应商终止输出：${candidate.finishReason}`);
                    ended = true;
                }
            } else if (mode === 'claude') {
                if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') delta = event.delta.text || '';
                if (event.type === 'content_block_start' && event.content_block?.type === 'text') delta = event.content_block.text || '';
                if (event.type === 'message_stop') ended = true;
            } else {
                const choice = event.choices?.[0];
                const content = choice?.delta?.content;
                delta = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text || '').join('') : '';
                if (choice?.finish_reason) {
                    if (choice.finish_reason === 'content_filter') throw new Error('供应商内容过滤中止了输出');
                    ended = true;
                }
            }
            if (delta) {
                text += delta;
                if (text.length > 1000000) throw new Error('提示词输出超过长度限制');
                onDelta(delta);
            }
        } catch (error) { failure = error; }
    }, onError(error) { failure = error; }, maxBufferSize: 2000000 });
    const decoder = new StringDecoder('utf8');
    for await (const chunk of body) {
        parser.feed(decoder.write(chunk));
        if (failure) throw failure;
    }
    parser.feed(decoder.end());
    if (failure) throw failure;
    if (!ended) throw new Error('连接在输出完成前中断，请重试；已输出内容保留在预览中');
    if (!text.trim()) throw new Error('对话模型没有返回文本');
    return { text };
}

function createPromptResponse(req, res) {
    const controller = new AbortController();
    const streaming = req.body.stream === true;
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    const send = (type, value) => {
        if (res.destroyed || res.writableEnded) return;
        if (!res.headersSent) {
            res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
            res.flushHeaders();
        }
        res.write(`data: ${JSON.stringify({ type, ...value })}\n\n`);
    };
    return {
        signal: controller.signal,
        onDelta: streaming ? delta => send('delta', { delta }) : undefined,
        done(text) {
            if (res.destroyed) return;
            if (streaming) { send('done', { prompt: text }); res.end(); }
            else res.json({ prompt: text });
        },
        error(error) {
            if (res.destroyed) return;
            if (res.headersSent) { send('error', { error: error.message }); res.end(); }
            else res.status(400).json({ error: error.message });
        },
        dispose() { res.off('close', disconnect); }
    };
}
module.exports = { readPromptStream, createPromptResponse };
