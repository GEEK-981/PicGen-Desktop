'use strict';

// ToAPIs (toapis.com / toapis.cn) serves every image model through one async
// endpoint: POST /v1/images/generations returns a task id, and the result is
// polled from GET /v1/images/generations/{id} until `completed`, when the image
// URLs are in `result.data[].url`. The generation endpoint no longer accepts
// base64, so reference images and masks are uploaded first through
// POST /v1/uploads/images. Each model family names its fields differently; the
// per-model rules below follow the ToAPIs model pages (docs.toapis.com).

function normalizeBaseUrl(value = '') {
    return String(value || '').trim().replace(/\/+$/, '')
        .replace(/\/v1\/images\/generations(?:\/.*)?$/i, '')
        .replace(/\/v1$/i, '');
}

function isToapisProvider(provider = '') {
    try {
        const host = new URL(normalizeBaseUrl(provider)).hostname.toLowerCase();
        return /(^|\.)toapis\.(com|cn)$/.test(host);
    } catch {
        return /(^|[/.])toapis\.(com|cn)(\/|:|$)/i.test(String(provider || ''));
    }
}

function modelKey(model = '') {
    return String(model || '').trim().toLowerCase().replace(/^.*\//, '');
}

function isGptModel(model = '') { return modelKey(model).startsWith('gpt-image') || modelKey(model) === 'gpt-4o-image'; }
function isGeminiModel(model = '') { return modelKey(model).startsWith('gemini-') && modelKey(model).includes('image') || modelKey(model).startsWith('gemini-nano-banana'); }
function isModel(model = '') { return isGptModel(model) || isGeminiModel(model); }

// Only take over the routes PicGen would pick on its own (or that point at the
// same OpenAI-style images endpoint); an explicit chat route stays untouched.
function shouldUse(provider, model, protocol = '') {
    const p = String(protocol || '').toLowerCase();
    return isToapisProvider(provider) && isModel(model)
        && (!p || ['auto', 'openai-images', 'gemini-native'].includes(p));
}

function generateUrl(provider) { return `${normalizeBaseUrl(provider)}/v1/images/generations`; }
function taskUrl(provider, id) { return `${normalizeBaseUrl(provider)}/v1/images/generations/${encodeURIComponent(String(id || ''))}`; }
function uploadUrl(provider) { return `${normalizeBaseUrl(provider)}/v1/uploads/images`; }

// Model rules. `refs`: how reference URLs are sent. `sizeMode`: 'ratio' sends
// an aspect ratio in `size`, 'pixels' sends WxH. `resolution`: 'top' (GPT) or
// 'metadata' (Gemini) or false. `maxRefs` is the documented input limit.
function modelRules(model = '') {
    const key = modelKey(model);
    if (isGeminiModel(key)) {
        // Official channels and Nano Banana 2.1 take plain URL strings; the
        // regular / VIP channels take [{url}] objects.
        const plainUrls = key.endsWith('-official') || key.startsWith('gemini-nano-banana');
        const smallRefLimit = key === 'gemini-3.1-flash-image-preview' || key === 'gemini-3-pro-image-preview';
        return {
            family: 'gemini',
            refs: plainUrls ? 'image_urls' : 'image_urls_objects',
            sizeMode: 'ratio',
            resolution: key === 'gemini-2.5-flash-image-official' ? false : 'metadata',
            maxRefs: smallRefLimit ? 6 : 14,
            quality: false,
            background: [],
            outputFormat: false,
            mask: false,
            maxCount: 1
        };
    }
    const official = key.endsWith('-official');
    if (key.startsWith('gpt-image-2.6')) {
        // 2.6 official 同时接受比例和像素尺寸（两边 16 的倍数，最长边 ≤3840）
        return { family: 'gpt', refs: 'image_urls', sizeMode: 'ratio', acceptsPixels: true, resolution: 'top', maxRefs: 16,
            quality: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], background: ['transparent', 'opaque'],
            outputFormat: true, mask: true, maxCount: 4 };
    }
    if (key.startsWith('gpt-image-2.5') && official) {
        // The 2.5 official channel only understands pixel sizes.
        return { family: 'gpt', refs: 'image_urls', sizeMode: 'pixels', resolution: false, maxRefs: 16,
            quality: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], background: ['transparent'],
            outputFormat: false, mask: false, maxCount: 1 };
    }
    if (key.startsWith('gpt-image-2.5')) {
        // Regular 2.5 always renders at high quality; other values are ignored upstream.
        return { family: 'gpt', refs: 'reference_images', sizeMode: 'ratio', resolution: 'top', maxRefs: 16,
            quality: false, background: ['transparent'], outputFormat: false, mask: false, maxCount: 1 };
    }
    if (key === 'gpt-image-2-official') {
        return { family: 'gpt', refs: 'image_urls', sizeMode: 'ratio', resolution: 'top', maxRefs: 16,
            quality: ['low', 'medium', 'high'], background: ['transparent', 'opaque'],
            outputFormat: true, mask: true, maxCount: 4 };
    }
    if (key === 'gpt-image-2-vip') {
        return { family: 'gpt', refs: 'reference_images', sizeMode: 'ratio', resolution: 'top', maxRefs: 16,
            quality: ['low', 'medium', 'high'], background: ['transparent', 'opaque'],
            outputFormat: false, mask: false, maxCount: 1 };
    }
    return { family: 'gpt', refs: 'reference_images', sizeMode: 'ratio', resolution: 'top', maxRefs: 16,
        quality: false, background: ['transparent', 'opaque'], outputFormat: false, mask: false, maxCount: 1 };
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

// PicGen hands over either an aspect ratio ("16:9", "auto") or a pixel size
// ("1536x1024", used by local edits). Ratio-mode models get a reduced ratio.
function toRatio(ratio = '1:1') {
    const value = String(ratio || '1:1').trim();
    const pixels = value.match(/^(\d+)\s*[xX*]\s*(\d+)$/);
    if (!pixels) return value || '1:1';
    const width = Number(pixels[1]);
    const height = Number(pixels[2]);
    const divisor = gcd(width, height) || 1;
    return `${width / divisor}:${height / divisor}`;
}

function normalizeTier(imageSize = '1K') {
    const value = String(imageSize || '1K').trim().toUpperCase();
    if (value === '512' || value === '0.5K') return '0.5K';
    return ['1K', '2K', '4K'].includes(value) ? value : '1K';
}

function outputFormatFor(mimeType = '') {
    const value = String(mimeType || '').toLowerCase();
    if (value.includes('jpeg') || value.includes('jpg')) return 'jpeg';
    if (value.includes('webp')) return 'webp';
    if (value.includes('png')) return 'png';
    return '';
}

/**
 * Builds the JSON body for POST /v1/images/generations.
 * @param {object} options
 * @param {string[]} options.referenceUrls  already-uploaded reference image URLs
 * @param {string} [options.maskUrl]        already-uploaded mask URL (models with mask support)
 * @param {Function} [options.resolvePixelSize] (ratio, model, generationConfig, imageSize) => "WxH"
 */
function buildGenerateBody({ model, prompt, ratio = '1:1', imageSize = '1K', count = 1, referenceUrls = [], maskUrl = '', generationConfig = {}, resolvePixelSize } = {}) {
    const rules = modelRules(model);
    if (referenceUrls.length > rules.maxRefs) {
        throw new Error(`ToAPIs 模型 ${model} 最多支持 ${rules.maxRefs} 张参考图（当前 ${referenceUrls.length} 张）`);
    }
    const body = {
        model: String(model || '').trim(),
        prompt: String(prompt || '').trim(),
        n: Math.max(1, Math.min(rules.maxCount, Math.floor(Number(count) || 1)))
    };
    const tier = normalizeTier(imageSize);

    // 「自定义」画幅：用设置里的宽高；接受像素的模型原样发，其余约成比例
    let requested = String(ratio || '1:1').trim();
    if (requested.toLowerCase() === 'custom') {
        const width = Math.round(Number(generationConfig.gptImageWidth));
        const height = Math.round(Number(generationConfig.gptImageHeight));
        requested = width > 0 && height > 0 ? `${width}x${height}` : '1:1';
    }
    const isPixels = /^\d+\s*[xX*]\s*\d+$/.test(requested);
    if (rules.sizeMode === 'pixels') {
        const pixels = typeof resolvePixelSize === 'function' ? resolvePixelSize(requested, model, generationConfig, imageSize) : '';
        if (pixels && /^\d+x\d+$/i.test(pixels)) body.size = pixels;
    } else if (isPixels && rules.acceptsPixels) {
        body.size = requested.replace(/\s*[X*]\s*/i, 'x');
    } else if (requested.toLowerCase() === 'auto') {
        if (rules.family === 'gpt') body.size = 'auto';
    } else {
        body.size = toRatio(requested);
    }
    if (rules.resolution === 'top') body.resolution = tier === '0.5K' ? '1K' : tier;
    if (rules.resolution === 'metadata') body.metadata = { resolution: tier };

    if (referenceUrls.length) {
        if (rules.refs === 'image_urls_objects') body.image_urls = referenceUrls.map(url => ({ url }));
        else body[rules.refs] = referenceUrls.slice();
    }
    if (maskUrl) {
        if (!rules.mask) throw new Error(`ToAPIs 模型 ${model} 不支持蒙版局部编辑`);
        if (!referenceUrls.length) throw new Error('ToAPIs 蒙版编辑需要原图作为第一张参考图');
        body.mask_url = maskUrl;
    }

    if (rules.quality) {
        const quality = String(generationConfig.gptQuality || generationConfig.quality || '').trim().toLowerCase();
        if (rules.quality.includes(quality)) body.quality = quality;
    }
    const background = String(generationConfig.gptBackground || '').trim().toLowerCase();
    if (background && background !== 'auto') {
        if (!rules.background.includes(background)) {
            throw new Error(`ToAPIs 模型 ${model} 不支持背景参数 ${background}`);
        }
        body.background = background;
    }
    if (rules.outputFormat) {
        const format = outputFormatFor(generationConfig.outputMimeType);
        if (format) body.output_format = format;
        const compression = Number(generationConfig.imageCompression);
        if ((format === 'jpeg' || format === 'webp') && Number.isFinite(compression)) {
            body.output_compression = Math.max(0, Math.min(100, Math.round(compression)));
        }
    }
    return body;
}

function extractTaskId(payload = {}) {
    return String(payload.id || payload.task_id || payload.data?.id || payload.data?.task_id || '');
}
function state(payload = {}) { return String(payload.status || payload.data?.status || '').toLowerCase(); }
function isDone(value) { return ['completed', 'succeeded', 'success'].includes(String(value).toLowerCase()); }
function isFailed(value) { return ['failed', 'cancelled', 'canceled', 'expired', 'error'].includes(String(value).toLowerCase()); }

function extractResultUrls(payload = {}) {
    const rows = Array.isArray(payload.result?.data) ? payload.result.data
        : Array.isArray(payload.data?.result?.data) ? payload.data.result.data
        : Array.isArray(payload.data) ? payload.data : [];
    const urls = rows.map(row => (typeof row === 'string' ? row : row?.url || row?.image_url || '')).filter(Boolean);
    if (!urls.length && payload.url) urls.push(String(payload.url));
    return urls;
}

function errorMessage(payload = {}) {
    const error = payload.error || payload.data?.error;
    if (!error) return '';
    if (typeof error === 'string') return error;
    return [error.code, error.message].filter(Boolean).join(': ') || JSON.stringify(error).slice(0, 240);
}

function extractUploadUrl(payload = {}) {
    return String(payload.data?.url || payload.url || '');
}

module.exports = {
    normalizeBaseUrl, isToapisProvider, isModel, isGptModel, isGeminiModel, shouldUse,
    generateUrl, taskUrl, uploadUrl, modelRules, toRatio, buildGenerateBody,
    extractTaskId, state, isDone, isFailed, extractResultUrls, errorMessage, extractUploadUrl
};
