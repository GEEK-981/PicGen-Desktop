'use strict';

// Grsai exposes GPT Image 2/2.5 through a vendor-specific endpoint. The
// request uses `images` and `aspectRatio`, and asynchronous jobs are queried
// from /v1/api/result instead of OpenAI's /v1/images/* endpoints.

function normalizeBaseUrl(value = '') {
    return String(value || '').trim().replace(/\/+$/, '').replace(/\/v1\/api\/(?:generate|result)$/i, '').replace(/\/v1$/i, '');
}

function isGrsaiProvider(provider = '') {
    const value = String(provider || '').toLowerCase();
    return value.includes('grsai');
}

function isModel(model = '') {
    const value = String(model || '').toLowerCase().replace(/[\s_\/-]/g, '');
    return value === 'gptimage2' || value === 'gptimage2vip'
        || value === 'gptimage2.5' || value === 'gptimage2.5flare'
        || value === 'gptimage2.5sunburst' || value.includes('gptimage25');
}

function shouldUse(provider, model, protocol = '') {
    const p = String(protocol || '').toLowerCase();
    return (p === 'auto' || !p || p === 'openai-images') && isGrsaiProvider(provider) && isModel(model);
}

function generateUrl(provider) { return `${normalizeBaseUrl(provider)}/v1/api/generate`; }
function resultUrl(provider, id) { return `${normalizeBaseUrl(provider)}/v1/api/result?id=${encodeURIComponent(String(id || ''))}`; }

function asDataUrl(ref = {}) {
    if (ref.filePath && !ref.base64) return ref.filePath;
    const mime = ref.mimeType || 'image/png';
    return String(ref.base64 || '').startsWith('data:') ? ref.base64 : `data:${mime};base64,${ref.base64 || ''}`;
}

function modelNeedsPixels(model = '') {
    const value = String(model || '').toLowerCase();
    return value.includes('2.5') || value.includes('vip');
}

// `background` is a Grsai-side extension over the OpenAI field: it accepts only
// `transparent`, and only the VIP / 2.5 Flare / 2.5 Sunburst models honour it.
// `auto` and `opaque` need no field at all — omitting it already yields a
// provider-chosen or opaque background, so those are dropped rather than sent.
function supportsTransparentBackground(model = '') {
    const value = String(model || '').toLowerCase().replace(/[\s_\/-]/g, '');
    // A vendor prefix survives normalization (`openai/gpt-image-2.5-flare` →
    // `openaigptimage2.5flare`), so anchor on the tail instead of comparing whole
    // strings — exact equality would silently reject the prefixed spelling.
    return ['gptimage2vip', 'gptimage2.5flare', 'gptimage2.5sunburst'].some(name => value.endsWith(name));
}

function resolveBackground(model, generationConfig = {}) {
    const background = String(generationConfig.gptBackground || '').trim().toLowerCase();
    if (!background || background === 'auto' || background === 'opaque') return '';
    if (background !== 'transparent') throw new Error(`Grsai 背景参数不支持: ${background}`);
    if (!supportsTransparentBackground(model)) {
        throw new Error(`Grsai 模型不支持透明背景: ${model}（仅 gpt-image-2-vip、gpt-image-2.5-flare、gpt-image-2.5-sunburst）`);
    }
    return background;
}

const PIXEL_MAP = {
    '1K': { '1:1': '1024x1024', '16:9': '1280x720', '9:16': '720x1280', '4:3': '1152x864', '3:4': '864x1152', '3:2': '1536x1024', '2:3': '1024x1536', '5:4': '1120x896', '4:5': '896x1120', '21:9': '1456x624', '9:21': '624x1456', '1:3': '688x2048', '3:1': '2048x688', '2:1': '1536x768', '1:2': '768x1536' },
    '2K': { '1:1': '2048x2048', '16:9': '2048x1152', '9:16': '1152x2048', '4:3': '2304x1728', '3:4': '1728x2304', '3:2': '2048x1360', '2:3': '1360x2048', '5:4': '2240x1792', '4:5': '1792x2240', '21:9': '2912x1248', '9:21': '1248x2912', '1:3': '1280x3840', '3:1': '3840x1280', '2:1': '3072x1536', '1:2': '1536x3072' },
    '4K': { '1:1': '2880x2880', '16:9': '3840x2160', '9:16': '2160x3840', '4:3': '3264x2448', '3:4': '2448x3264', '3:2': '3504x2336', '2:3': '2336x3504', '5:4': '3200x2560', '4:5': '2560x3200', '21:9': '3840x1648', '9:21': '1648x3840', '1:3': '1280x3840', '3:1': '3840x1280', '2:1': '3840x1920', '1:2': '1920x3840' }
};

function buildGenerateRequest({ provider = '', model, prompt, ratio = '1:1', imageSize = '1K', referenceImages = [], generationConfig = {}, resolveSize } = {}) {
    let aspectRatio = String(ratio || '1:1').trim();
    if (modelNeedsPixels(model)) {
        const tier = String(imageSize || '1K').toUpperCase();
        aspectRatio = /^\d+x\d+$/i.test(aspectRatio)
            ? aspectRatio
            : PIXEL_MAP[tier]?.[aspectRatio] || PIXEL_MAP['1K'][aspectRatio] || (typeof resolveSize === 'function' ? resolveSize(ratio, model, generationConfig, imageSize) : '1024x1024');
    } else if (!/^\d+(?::\d+)$/.test(aspectRatio) && !/^\d+x\d+$/i.test(aspectRatio)) {
        aspectRatio = '1024x1024';
    }
    const replyType = String(generationConfig.grsaiReplyType || 'json').trim().toLowerCase();
    if (!['json', 'stream', 'async'].includes(replyType)) throw new Error(`Grsai replyType 不支持: ${replyType}`);
    const quality = String(generationConfig.gptQuality || generationConfig.quality || 'auto').trim().toLowerCase();
    const background = resolveBackground(model, generationConfig);
    const body = {
        model: String(model || '').trim(),
        prompt: String(prompt || '').trim(),
        images: referenceImages.map(asDataUrl),
        aspectRatio,
        quality,
        replyType
    };
    // Only present when the caller actually asked for transparency — adding it
    // unconditionally would send `background: "auto"`, which Grsai does not accept.
    if (background) body.background = background;
    return { url: generateUrl(provider), body, replyType };
}

function resolvePixelSize(ratio = '1:1', imageSize = '1K') {
    const value = String(ratio || '1:1').trim();
    if (/^\d+x\d+$/i.test(value)) return value;
    return PIXEL_MAP[String(imageSize || '1K').toUpperCase()]?.[value]
        || PIXEL_MAP['1K'][value]
        || '1024x1024';
}

function extractId(payload = {}) { return payload.id || payload.taskId || payload.task_id || payload.data?.id || ''; }
function state(payload = {}) { return String(payload.status || payload.state || payload.data?.status || '').toLowerCase(); }
function isDone(value) { return ['succeeded', 'success', 'completed', 'complete', 'done', 'finished'].includes(String(value).toLowerCase()); }
function isFailed(value) { return ['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected'].includes(String(value).toLowerCase()); }
function extractResultUrl(payload = {}) {
    const rows = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.data?.results) ? payload.data.results : [];
    for (const row of rows) {
        const url = typeof row === 'string' ? row : row?.url || row?.imageUrl || row?.image_url;
        if (url) return String(url);
    }
    return String(payload.url || payload.imageUrl || payload.data?.url || '');
}

module.exports = { normalizeBaseUrl, isGrsaiProvider, isModel, shouldUse, generateUrl, resultUrl, buildGenerateRequest, resolvePixelSize, extractId, state, isDone, isFailed, extractResultUrl, supportsTransparentBackground, resolveBackground };
