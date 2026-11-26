'use strict';

// 光脉 Photontide (https://ai.photontide.cn/docs) unified image gateway adapter.
//
// Photontide exposes image generation synchronously on `POST /v1/images/generations`
// (`application/json`, returning `{ created, model, data: [{ url, b64_json, ... }] }`):
//   - Seedream (`doubao_seedream_5_5_261028`, `doubao_seedream_5_0_pro_260628`,
//     `doubao_seedream_5_0_260128`, `doubao-seedream-*`):
//       Uses top-level `prompt`, `size` (`1K` / `1.5K` / `2K` or `WxH` on 5.5 & 5.0 Pro;
//       `2K` / `3K` / `4K` on 5.0 Lite/Flash; `auto` on `layer_decomposition`),
//       `output_format` (`png` / `jpeg`), `background` (`opaque` / `transparent`),
//       `layer_decomposition`, `optimize_prompt_options`, `watermark`, `response_format`.
//       Reference images go in `image` (single URL string or URL array) and MUST be
//       public HTTP(S) URLs — Data URIs are rejected with `image must be a public HTTP URL`.
//   - GPT Image / DALL-E (`gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, ...):
//       Uses `POST /v1/images/generations` JSON (Photontide has no OpenAI multipart
//       `/v1/images/edits` — `/v1/images/edits` on Photontide is Qwen-only).
//       Top-level `prompt`, half-width `size` (`1024x1536`), `quality` (`auto` / `low` /
//       `medium` / `high`; `standard` / `hd` for `dall-e-3`), `n`, `response_format`
//       (`gpt-image-2` supports `url` only), `watermark`, `background`, `output_format`,
//       and `images` (`string[]`) for reference images.
//   - Nano Banana / Gemini Image on `/v1/images/generations` (`openai-images` route):
//       Top-level `prompt`, `aspectRatio` (e.g. `9:16`), `imageSize` (`1K` / `2K` / `4K`),
//       `images` (`string[]`), `response_format`. (Explicit `gemini-native` stays on
//       Photontide's `/v1beta/models/{model}:generateContent` route.)
//   - Qwen Image (`qwen-image*`):
//       Nested `{ model, input: { messages }, parameters }` on `/v1/images/generations`
//       (text-to-image) or `/v1/images/edits` (when reference images are provided).
//
// Photontide `/v1/files` is unimplemented (HTTP 501) and `/v1/files/upload` is audio-only,
// so local base64 reference images are uploaded to PicGen's public image host first.

const imageApiProfiles = require('../imageApiProfiles');
const doubaoSeedream = require('./doubaoSeedream');

const PROVIDER_KIND = 'photontide-image';

function normalizeBaseUrl(value = '') {
    return String(value || '').trim().replace(/\/+$/, '')
        .replace(/\/v1\/images\/(?:generations|edits)(?:\/.*)?$/i, '')
        .replace(/\/v1beta(?:\/.*)?$/i, '')
        .replace(/\/v1$/i, '');
}

function isPhotontideProvider(provider = '') {
    try {
        const host = new URL(normalizeBaseUrl(provider)).hostname.toLowerCase();
        return /(^|\.)photontide\.(cn|com)$/.test(host);
    } catch {
        return /(^|[/.])photontide\.(cn|com)(\/|:|$)/i.test(String(provider || ''));
    }
}

function endpointUrl(provider = '', endpoint = 'generations') {
    return `${normalizeBaseUrl(provider)}/v1/images/${endpoint}`;
}

function isQwenImageModel(model = '') {
    const bare = String(model || '').trim().toLowerCase().replace(/^.*\//, '');
    return /^qwen[-_.]?image/.test(bare);
}

function modelFamily(model = '') {
    if (doubaoSeedream.isSeedreamModel(model)) return 'seedream';
    if (imageApiProfiles.isOpenAIImageModel(model)) return 'gpt-image';
    if (isQwenImageModel(model)) return 'qwen-image';
    if (imageApiProfiles.isGeminiImageModel(model)) return 'nano-banana';
    return '';
}

function shouldUse(provider = '', model = '', protocol = '') {
    if (!isPhotontideProvider(provider)) return false;
    const family = modelFamily(model);
    if (!family) return false;
    const p = String(protocol || '').trim().toLowerCase();
    if (p === 'openai-chat' || p === 'gemini-native') return false;
    return !p || p === 'auto' || p === 'openai-images';
}

function supportsMask() {
    // Photontide `/v1/images/generations` has no mask field; local edits use maskEdit's red guide image.
    return false;
}

function maxReferencesFor(model = '') {
    const family = modelFamily(model);
    if (family === 'seedream') return doubaoSeedream.capabilities(model).maxReferences;
    if (family === 'gpt-image') return imageApiProfiles.getImageApiProfile(model).maxReferences;
    if (family === 'nano-banana') return imageApiProfiles.getImageApiProfile(model).maxReferences;
    if (family === 'qwen-image') return 4;
    return 8;
}

const GPT_QUALITY_TIERS = ['auto', 'low', 'medium', 'high'];

function resolvePhotontideGptQuality(model = '', generationConfig = {}) {
    const raw = String(generationConfig.gptQuality || generationConfig.quality || '').trim().toLowerCase();
    if (!raw) return '';
    const family = imageApiProfiles.openAIImageFamily(model);
    if (family === 'dall-e-3') {
        return ['standard', 'hd'].includes(raw) ? raw : '';
    }
    if (family === 'dall-e-2') return '';
    if (GPT_QUALITY_TIERS.includes(raw)) return raw;
    if (raw === 'xhigh' || raw === 'max') return 'high';
    return '';
}

function resolvePhotontideOutputFormat(generationConfig = {}) {
    const raw = String(generationConfig.outputMimeType || generationConfig.outputFormat || '').trim().toLowerCase();
    if (raw === 'png' || raw === 'image/png') return 'png';
    if (raw === 'jpeg' || raw === 'jpg' || raw === 'image/jpeg' || raw === 'image/jpg') return 'jpeg';
    if (raw === 'webp' || raw === 'image/webp') return 'webp';
    return '';
}

function normalizeNanoBananaSize(imageSize = '1K') {
    const upper = String(imageSize || '1K').trim().toUpperCase();
    if (upper === '512' || upper === '0.5K') return '1K';
    if (['1K', '2K', '4K'].includes(upper)) return upper;
    if (upper === '1.5K' || upper === '3K') return '2K';
    return '1K';
}

function resolveQwenSize(ratio = '1:1', generationConfig = {}) {
    const explicit = String(ratio || '').trim().match(/^(\d+)\s*[xX*\u00d7]\s*(\d+)$/);
    if (explicit) return `${explicit[1]}*${explicit[2]}`;
    if (String(ratio || '').trim().toLowerCase() === 'custom') {
        const w = Math.round(Number(generationConfig.gptImageWidth));
        const h = Math.round(Number(generationConfig.gptImageHeight));
        if (w > 0 && h > 0) return `${w}*${h}`;
    }
    const map = {
        '1:1': '1328*1328',
        '16:9': '1664*928',
        '9:16': '928*1664',
        '4:3': '1472*1140',
        '3:4': '1140*1472',
        '3:2': '1584*1056',
        '2:3': '1056*1584',
        '21:9': '1664*720'
    };
    return map[String(ratio || '1:1').trim()] || '1328*1328';
}

function buildRequest({
    model,
    prompt = '',
    effectivePrompt = '',
    ratio = '1:1',
    imageSize = '1K',
    referenceUrls = [],
    generationConfig = {},
    resolveOpenAISize,
    resolveGeminiRatio
} = {}) {
    const family = modelFamily(model);
    const urls = (Array.isArray(referenceUrls) ? referenceUrls : []).filter(Boolean);
    const maxRefs = maxReferencesFor(model);
    if (urls.length > maxRefs) {
        throw new Error(`光脉模型 ${model} 最多支持 ${maxRefs} 张参考图（当前 ${urls.length} 张）`);
    }

    if (family === 'seedream') {
        const built = doubaoSeedream.buildRequest({
            model,
            prompt,
            effectivePrompt,
            ratio,
            imageSize,
            referenceUrls: urls,
            generationConfig,
            includeStream: false
        });
        return {
            endpoint: 'generations',
            family,
            size: built.size,
            body: built.body
        };
    }

    if (family === 'qwen-image') {
        const n = Math.max(1, Math.min(4, Math.trunc(Number(generationConfig.n) || 1)));
        const watermark = generationConfig.watermark != null ? !!generationConfig.watermark : false;
        if (urls.length > 0) {
            return {
                endpoint: 'edits',
                family,
                size: ratio || '1:1',
                body: {
                    model: String(model || '').trim(),
                    input: {
                        messages: [{
                            role: 'user',
                            content: [
                                ...urls.map(image => ({ image })),
                                { text: String(prompt || '').trim() }
                            ]
                        }]
                    },
                    parameters: { n, watermark }
                }
            };
        }
        const size = resolveQwenSize(ratio, generationConfig);
        return {
            endpoint: 'generations',
            family,
            size,
            body: {
                model: String(model || '').trim(),
                input: {
                    messages: [{
                        role: 'user',
                        content: [{ text: String(prompt || '').trim() }]
                    }]
                },
                parameters: {
                    size,
                    n,
                    prompt_extend: generationConfig.promptExtend !== false,
                    watermark
                }
            }
        };
    }

    if (family === 'nano-banana') {
        const aspectRatio = typeof resolveGeminiRatio === 'function'
            ? resolveGeminiRatio(ratio, generationConfig)
            : String(ratio || '1:1').trim();
        const normalizedSize = normalizeNanoBananaSize(imageSize);
        const n = Math.max(1, Math.min(10, Math.trunc(Number(generationConfig.n) || 1)));
        const responseFormat = String(generationConfig.responseFormat || 'url').trim();
        if (!['url', 'b64_json'].includes(responseFormat)) {
            throw new Error(`光脉不支持的图片响应格式: ${responseFormat}`);
        }
        const body = {
            model: String(model || '').trim(),
            prompt: String(effectivePrompt || prompt || '').trim(),
            aspectRatio,
            imageSize: normalizedSize,
            n,
            response_format: responseFormat
        };
        if (generationConfig.watermark != null) body.watermark = !!generationConfig.watermark;
        if (urls.length > 0) body.images = urls.slice();
        return {
            endpoint: 'generations',
            family,
            size: `${aspectRatio} ${normalizedSize}`,
            body
        };
    }

    // GPT Image / DALL-E on Photontide's unified `/v1/images/generations`.
    const size = typeof resolveOpenAISize === 'function'
        ? resolveOpenAISize(ratio, model, generationConfig, imageSize)
        : '1024x1024';
    const n = Math.max(1, Math.min(10, Math.trunc(Number(generationConfig.n) || 1)));
    const openAIFamily = imageApiProfiles.openAIImageFamily(model);
    const rawResponseFormat = String(generationConfig.responseFormat || 'url').trim();
    if (!['url', 'b64_json'].includes(rawResponseFormat)) {
        throw new Error(`光脉不支持的图片响应格式: ${rawResponseFormat}`);
    }
    // Photontide docs: `gpt-image-2 仅支持 url，未填写时默认 url`.
    const responseFormat = openAIFamily === 'gpt-image-2' ? 'url' : rawResponseFormat;

    const body = {
        model: String(model || '').trim(),
        prompt: String(effectivePrompt || prompt || '').trim(),
        size,
        n,
        response_format: responseFormat,
        watermark: generationConfig.watermark != null ? !!generationConfig.watermark : false
    };

    const quality = resolvePhotontideGptQuality(model, generationConfig);
    if (quality) body.quality = quality;

    const background = String(generationConfig.gptBackground || generationConfig.background || '').trim().toLowerCase();
    if (background && background !== 'auto') {
        if (!['opaque', 'transparent'].includes(background)) {
            throw new Error(`光脉不支持的背景参数: ${background}`);
        }
        body.background = background;
    }

    const outputFormat = resolvePhotontideOutputFormat(generationConfig);
    if (outputFormat) body.output_format = outputFormat;

    if (urls.length > 0) body.images = urls.slice();

    return {
        endpoint: 'generations',
        family: 'gpt-image',
        size,
        body
    };
}

function errorMessage(payload = {}) {
    const error = payload?.error;
    if (!error) return String(payload?.message || '').trim();
    if (typeof error === 'string') return error.trim();
    return String(error.message || error.code || payload?.message || '').trim();
}

module.exports = {
    PROVIDER_KIND,
    normalizeBaseUrl,
    isPhotontideProvider,
    endpointUrl,
    isQwenImageModel,
    modelFamily,
    shouldUse,
    supportsMask,
    maxReferencesFor,
    resolvePhotontideGptQuality,
    buildRequest,
    errorMessage
};
