'use strict';

// Grsai's Nano Banana endpoint is an asynchronous API and is intentionally
// kept separate from the synchronous Gemini/OpenAI response parsers.

const GRSAI_PROTOCOL = 'grsai-nano-banana';

function normalizeBaseUrl(value = '') {
    return String(value || '').trim()
        .replace(/\/+$/, '')
        .replace(/\/v1\/draw\/(?:nano-banana|result)$/i, '')
        .replace(/\/v1$/i, '');
}

function isGrsaiProvider(provider = '') {
    const value = String(provider || '').toLowerCase();
    return value.includes('grsai');
}

function isGrsaiNanoBananaModel(model = '') {
    return /^nano[-_ ]?banana(?:[-_ ].*)?$/i.test(String(model || '').trim())
        || String(model || '').toLowerCase().includes('nano-banana');
}

function shouldUse(provider, model, protocol = '') {
    const normalizedProtocol = String(protocol || '').toLowerCase();
    return normalizedProtocol === GRSAI_PROTOCOL
        || ((!normalizedProtocol || normalizedProtocol === 'auto')
            && isGrsaiProvider(provider)
            && isGrsaiNanoBananaModel(model));
}

function drawUrl(provider) {
    return `${normalizeBaseUrl(provider)}/v1/draw/nano-banana`;
}

function resultUrl(provider) {
    return `${normalizeBaseUrl(provider)}/v1/draw/result`;
}

function asDataUrl(reference = {}) {
    const mimeType = reference.mimeType || 'image/png';
    const base64 = String(reference.base64 || '').replace(/^data:[^,]+,/, '');
    return `data:${mimeType};base64,${base64}`;
}

function normalizeRatio(value = '1:1') {
    const ratio = String(value || '1:1').trim();
    return /^\d+(?::\d+)$/.test(ratio) ? ratio : '1:1';
}

function normalizeImageSize(value = '1K') {
    const size = String(value || '1K').trim().toUpperCase();
    return ['1K', '2K', '4K'].includes(size) ? size : '1K';
}

function buildDrawRequest({ provider = '', model, prompt, ratio = '1:1', imageSize = '1K', referenceImages = [] } = {}) {
    return {
        url: drawUrl(provider),
        body: {
            model: String(model || '').trim(),
            prompt: String(prompt || '').trim(),
            urls: referenceImages.map(asDataUrl),
            aspectRatio: normalizeRatio(ratio),
            imageSize: normalizeImageSize(imageSize),
            webHook: '-1'
        }
    };
}

function buildResultRequest(provider, taskId) {
    return {
        url: resultUrl(provider),
        body: { id: String(taskId || '').trim() }
    };
}

function firstDefined(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function extractTaskId(payload = {}) {
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    if (typeof payload.data === 'string') return payload.data.trim();
    return firstDefined(
        payload.taskId,
        payload.task_id,
        payload.id,
        data.taskId,
        data.task_id,
        data.id,
        data.task?.id
    ) || '';
}

function resultState(payload = {}) {
    const data = Array.isArray(payload.data)
        ? (payload.data[0] || payload)
        : (payload.data && typeof payload.data === 'object' ? payload.data : payload);
    const raw = firstDefined(data.status, data.state, payload.status, payload.state);
    if (typeof raw === 'number') {
        if (raw === 0) return 'queued';
        if (raw === 1) return 'running';
        if (raw === 2) return 'succeeded';
        if (raw >= 3) return 'failed';
    }
    return String(raw || '').trim().toLowerCase();
}

function extractResultUrl(payload = {}) {
    const data = Array.isArray(payload.data)
        ? (payload.data[0] || payload)
        : (payload.data && typeof payload.data === 'object' ? payload.data : payload);
    const results = Array.isArray(data.results) ? data.results : [];
    for (const result of results) {
        const url = typeof result === 'string' ? result : firstDefined(result?.url, result?.imageUrl, result?.image_url);
        if (typeof url === 'string' && url.trim()) return url.trim();
    }
    const direct = firstDefined(data.url, data.imageUrl, data.image_url, payload.url);
    return typeof direct === 'string' ? direct.trim() : '';
}

function isSuccess(payload = {}) {
    const code = payload.code;
    return code === undefined || code === null || code === 0 || code === '0' || payload.success === true;
}

function isCompletedState(state = '') {
    return ['success', 'succeeded', 'completed', 'complete', 'done', 'finished'].includes(String(state).toLowerCase());
}

function isFailedState(state = '') {
    return ['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected'].includes(String(state).toLowerCase());
}

module.exports = {
    GRSAI_PROTOCOL,
    normalizeBaseUrl,
    isGrsaiProvider,
    isGrsaiNanoBananaModel,
    shouldUse,
    drawUrl,
    resultUrl,
    asDataUrl,
    buildDrawRequest,
    buildResultRequest,
    extractTaskId,
    resultState,
    extractResultUrl,
    isSuccess,
    isCompletedState,
    isFailedState
};
