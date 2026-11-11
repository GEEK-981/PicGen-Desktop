// MiniMax H3-Image official API (https://platform.minimax.cn/docs/guides/image-generation).
//
// Two synchronous JSON endpoints on the OpenAI Images paths:
//   POST /v1/images/generations   text to image
//   POST /v1/images/edits         prompt + 1..16 reference images (images[].image_url, data URIs allowed)
// Unlike OpenAI the size is either `size: "WxH"` OR `aspect_ratio` + `area` (1K/2K/4K) —
// mixing them is a 400. There is no mask parameter; local edits go through maskEdit's
// red guide image like the other non-OpenAI models.
// The server waits up to 600 s and the call is not idempotent: a retry is a second
// paid generation, so PicGen submits once and treats a local timeout as ambiguous.

const MODELS = ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'];
const PROVIDER_KIND = 'minimax-h3-image';
const TIMEOUT_MS = 630000;
const AREA_TIERS = ['1K', '2K', '4K'];
const MIN_PIXELS = 655360;
const MAX_PIXELS = 20000000;
const MAX_REFERENCES = 16;

function modelKey(model = '') {
    return String(model || '').toLowerCase().replace(/^.*\//, '').replace(/[\s_-]+/g, '');
}

function isMinimaxImageModel(model = '') {
    const key = modelKey(model);
    return key.startsWith('minimaxh3image') || key === 'h3image' || key === 'h3imagehighspeed';
}

// The official endpoint only knows the exact casing; a relay's own name (e.g. with a
// vendor/ prefix) is passed through untouched.
function officialModelName(model = '') {
    const name = String(model || '').trim();
    return MODELS.find(official => official.toLowerCase() === name.toLowerCase()) || name;
}

function withinRatio(width, height) {
    return width > 0 && height > 0 && width * 3 >= height && height * 3 >= width;
}

function parseSize(value = '') {
    const match = String(value || '').trim().match(/^(\d+)\s*[xX*×]\s*(\d+)$/);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function parseRatio(value = '') {
    const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    let x = Number(match[1]);
    let y = Number(match[2]);
    // X and Y must be integers in 1..300 (e.g. 9:19.5 → 18:39).
    while ((!Number.isInteger(x) || !Number.isInteger(y)) && x < 300 && y < 300) { x *= 2; y *= 2; }
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1 || x > 300 || y > 300) return null;
    return { x, y, text: `${x}:${y}` };
}

function normalizeArea(imageSize = '') {
    const tier = String(imageSize || '').trim().toUpperCase();
    if (AREA_TIERS.includes(tier)) return tier;
    if (tier === '512' || tier === '0.5K') return '1K';
    if (tier === '3K') return '2K';
    return '';
}

// Returns either { size } or { aspect_ratio, area } — never both (the API rejects that).
function resolveDimensions({ ratio = '', imageSize = '', generationConfig = {} } = {}) {
    let explicit = parseSize(ratio) || parseSize(imageSize);
    const wantsCustom = String(ratio).trim().toLowerCase() === 'custom' || String(imageSize).trim().toLowerCase() === 'custom';
    if (!explicit && wantsCustom) {
        const width = Number(generationConfig.gptImageWidth);
        const height = Number(generationConfig.gptImageHeight);
        if (Number.isInteger(width) && Number.isInteger(height)) explicit = { width, height };
    }
    if (explicit) {
        const { width, height } = explicit;
        const pixels = width * height;
        if (pixels < MIN_PIXELS || pixels > MAX_PIXELS || !withinRatio(width, height)) {
            throw new Error(`MiniMax H3-Image 的自定义尺寸要求面积 ${MIN_PIXELS}～${MAX_PIXELS} 像素、宽高比 1:3～3:1，当前 ${width}x${height}`);
        }
        return { size: `${width}x${height}` };
    }

    const dims = {};
    const ratioText = String(ratio || '').trim().toLowerCase();
    if (ratioText && ratioText !== 'auto') {
        const parsed = parseRatio(ratio);
        if (!parsed || !withinRatio(parsed.x, parsed.y)) {
            throw new Error(`MiniMax H3-Image 只支持 1:3～3:1 之间的宽高比，当前 ${ratio}`);
        }
        dims.aspect_ratio = parsed.text;
    }
    const area = normalizeArea(imageSize);
    if (area) dims.area = area;
    return dims;
}

function outputFormat(generationConfig = {}) {
    const mime = String(generationConfig.outputMimeType || '').toLowerCase();
    if (mime === 'image/png') return 'png';
    if (mime === 'image/webp') return 'webp';
    if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpeg';
    return '';
}

function referenceImage(ref = {}) {
    const mimeType = String(ref.mimeType || 'image/png').split(';')[0].toLowerCase();
    return { image_url: `data:${mimeType};base64,${ref.base64 || ''}` };
}

function buildRequest({ model, prompt, ratio = '', imageSize = '', referenceImages = [], generationConfig = {}, operation = 'generate' } = {}) {
    const refs = (Array.isArray(referenceImages) ? referenceImages : []).filter(ref => ref?.base64);
    const isEdit = refs.length > 0 || operation === 'edit' || operation === 'mask-edit';
    if (isEdit && refs.length === 0) throw new Error('MiniMax H3-Image 图片编辑至少需要一张参考图');
    if (refs.length > MAX_REFERENCES) throw new Error(`MiniMax H3-Image 最多支持 ${MAX_REFERENCES} 张参考图，当前 ${refs.length} 张`);

    const body = {
        model: officialModelName(model),
        prompt: String(prompt || ''),
        n: 1,
        ...resolveDimensions({ ratio, imageSize, generationConfig }),
        // b64_json saves a second download of a 24-hour URL; with n=1 every output
        // area stays under the documented b64 limits (png 20 MP, jpeg/webp 80 MP).
        response_format: 'b64_json',
        aigc_watermark: generationConfig.watermark != null ? !!generationConfig.watermark : false
    };
    const format = outputFormat(generationConfig);
    if (format) body.output_format = format;
    const compression = Number(generationConfig.imageCompression);
    if ((format === 'jpeg' || format === 'webp') && Number.isInteger(compression) && compression >= 0 && compression <= 100) {
        body.output_compression = compression;
    }
    if (isEdit) body.images = refs.map(referenceImage);
    return { endpoint: isEdit ? 'edits' : 'generations', body };
}

const MIME_BY_FORMAT = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' };

function errorMessage(payload = {}) {
    const error = payload?.error || payload?.base_resp || {};
    return String(error.message || error.status_msg || payload?.message || '').trim();
}

// HTTP 200 means at least one image succeeded; failed items carry only `error`.
function extractResult(payload = {}) {
    const items = Array.isArray(payload?.data) ? payload.data : [];
    const success = items.find(item => item && (item.b64_json || item.url));
    if (!success) {
        const failed = items.find(item => item?.error);
        const reason = failed ? `${failed.error.code || ''} ${failed.error.message || ''}`.trim() : errorMessage(payload);
        const error = new Error(`MiniMax H3-Image 没有返回图片${reason ? `：${reason}` : ''}`);
        error.retryable = false;
        error.ambiguous = false;
        throw error;
    }
    const mimeType = MIME_BY_FORMAT[String(payload.output_format || '').toLowerCase()] || 'image/jpeg';
    return {
        base64: success.b64_json || '',
        url: success.b64_json ? '' : success.url,
        mimeType,
        size: success.size || '',
        revisedPrompt: success.revised_prompt || '',
        usageMetadata: payload.usage || null,
        requestId: payload.request_id || ''
    };
}

module.exports = {
    MODELS,
    PROVIDER_KIND,
    TIMEOUT_MS,
    MAX_REFERENCES,
    isMinimaxImageModel,
    officialModelName,
    resolveDimensions,
    buildRequest,
    extractResult,
    errorMessage
};
