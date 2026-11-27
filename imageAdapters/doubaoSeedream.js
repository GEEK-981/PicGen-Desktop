'use strict';

// ByteDance Doubao Seedream (Volcengine Ark / BytePlus ModelArk / Lumi).
//
// Model families and their documented envelopes:
//   - Seedream 5.5 (doubao-seedream-5-5-261028 / doubao_seedream_5_5_261028 / dola-seedream-5-5-261028):
//       size tiers 1K / 1.5K / 2K (default 2K) or custom WxH (921,600..4,624,220 px, ratio 1:16..16:1);
//       up to 10 reference images; native RGBA `background` (auto / opaque / transparent, transparent requires png);
//       `output_format` (png / jpeg); `layer_decomposition` (1 input image, `size` defaults to auto, no `background`);
//       `optimize_prompt_options.mode` ('standard' only); does NOT support `sequential_image_generation`.
//   - Seedream 5.0 Pro (doubao-seedream-5-0-pro-260628 / seedream_50_pro):
//       size tiers 1K / 1.5K / 2K or custom WxH (921,600..4,624,220 px, ratio 1:16..16:1);
//       up to 10 reference images; `background` (opaque / transparent); `output_format` (png / jpeg);
//       `layer_decomposition`; does NOT support `sequential_image_generation`.
//   - Seedream 5.0 Lite / Flash (doubao-seedream-5-0-260128 / doubao-seedream-5-0-flash-260915):
//       size tiers 2K / 3K / 4K or custom WxH; up to 14 reference images; `output_format` (png / jpeg);
//       `sequential_image_generation` and `tools: [{ type: 'web_search' }]`.
//   - Seedream 4.5 / 4.0:
//       4.5 tiers 2K / 4K; 4.0 tiers 1K / 2K / 4K; up to 14 reference images; `sequential_image_generation`.

const PROVIDER_KIND = 'doubao-seedream';

const SEEDREAM_RATIOS = [
    '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4',
    '9:16', '16:9', '21:9', '9:21', '1:2', '2:1',
    '1:3', '3:1', '1:4', '4:1', '1:8', '8:1'
];

function modelKey(model = '') {
    return String(model || '').trim().toLowerCase().replace(/^.*\//, '').replace(/[\s_.-]+/g, '');
}

function isSeedreamModel(model = '') {
    return modelKey(model).includes('seedream');
}

function seedreamFamily(model = '') {
    const key = modelKey(model);
    if (!key.includes('seedream')) return '';
    if (key.includes('seedream55')) return 'seedream-5.5';
    if ((key.includes('seedream50') || key.includes('seedream5')) && key.includes('pro')) return 'seedream-5.0-pro';
    if ((key.includes('seedream50') || key.includes('seedream5')) && key.includes('flash')) return 'seedream-5.0-flash';
    if (key.includes('seedream50') || key.includes('seedream5')) return 'seedream-5.0';
    if (key.includes('seedream45')) return 'seedream-4.5';
    return 'seedream-4.0';
}

function isSeedream55Model(model = '') {
    return seedreamFamily(model) === 'seedream-5.5';
}

function isSeedream50ProModel(model = '') {
    return seedreamFamily(model) === 'seedream-5.0-pro';
}

function isSeedream5Family(model = '') {
    const family = seedreamFamily(model);
    return family === 'seedream-5.5'
        || family === 'seedream-5.0-pro'
        || family === 'seedream-5.0-flash'
        || family === 'seedream-5.0';
}

function capabilities(model = '') {
    const family = seedreamFamily(model) || 'seedream-4.0';
    if (family === 'seedream-5.5' || family === 'seedream-5.0-pro' || family === 'seedream-5.0-flash') {
        return {
            family,
            ratios: SEEDREAM_RATIOS,
            imageSizes: ['1K', '1.5K', '2K', 'custom'],
            supportedTiers: ['1K', '1.5K', '2K'],
            fallbackTier: family === 'seedream-5.5' ? '2K' : '1K',
            maxReferences: 10,
            supportsOutputFormat: true,
            supportsBackground: true,
            supportsLayerDecomposition: true,
            supportsSequential: false,
            supportsWebSearch: false,
            supportsOptimizePrompt: true,
            customPixels: { minPixels: 921600, maxPixels: 4624220, maxRatio: 16 }
        };
    }
    if (family === 'seedream-5.0') {
        return {
            family,
            ratios: SEEDREAM_RATIOS,
            imageSizes: ['2K', '3K', '4K', 'custom'],
            supportedTiers: ['2K', '3K', '4K'],
            fallbackTier: '2K',
            maxReferences: 14,
            supportsOutputFormat: true,
            supportsBackground: false,
            supportsLayerDecomposition: false,
            supportsSequential: true,
            supportsWebSearch: true,
            supportsOptimizePrompt: true,
            customPixels: { minPixels: 921600, maxPixels: 16777216, maxRatio: 16 }
        };
    }
    if (family === 'seedream-4.5') {
        return {
            family,
            ratios: SEEDREAM_RATIOS,
            imageSizes: ['2K', '4K', 'custom'],
            supportedTiers: ['2K', '4K'],
            fallbackTier: '2K',
            maxReferences: 14,
            supportsOutputFormat: false,
            supportsBackground: false,
            supportsLayerDecomposition: false,
            supportsSequential: true,
            supportsWebSearch: false,
            supportsOptimizePrompt: true,
            customPixels: { minPixels: 921600, maxPixels: 16777216, maxRatio: 16 }
        };
    }
    return {
        family: 'seedream-4.0',
        ratios: SEEDREAM_RATIOS,
        imageSizes: ['1K', '2K', '4K', 'custom'],
        supportedTiers: ['1K', '2K', '4K'],
        fallbackTier: '1K',
        maxReferences: 14,
        supportsOutputFormat: false,
        supportsBackground: false,
        supportsLayerDecomposition: false,
        supportsSequential: true,
        supportsWebSearch: false,
        supportsOptimizePrompt: true,
        customPixels: { minPixels: 921600, maxPixels: 16777216, maxRatio: 16 }
    };
}

function parsePixelSize(value = '') {
    const match = String(value || '').trim().match(/^(\d+)\s*[xX*\u00d7]\s*(\d+)$/);
    if (!match) return null;
    return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}

function validateCustomSize(width, height, model = '') {
    const { family, customPixels } = capabilities(model);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error('Seedream 自定义尺寸需要填写正整数宽高');
    }
    const pixels = width * height;
    if (pixels < customPixels.minPixels || pixels > customPixels.maxPixels) {
        throw new Error(`${family} 自定义尺寸总像素必须在 ${customPixels.minPixels}～${customPixels.maxPixels} 之间，当前 ${width}x${height}（${pixels} 像素）`);
    }
    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    if (longSide / shortSide > customPixels.maxRatio) {
        throw new Error(`${family} 宽高比必须在 1:${customPixels.maxRatio}～${customPixels.maxRatio}:1 之间，当前 ${width}x${height}`);
    }
}

function normalizeTier(value = '', model = '') {
    const tier = String(value || '').trim().toUpperCase();
    const { supportedTiers, fallbackTier } = capabilities(model);
    if (supportedTiers.includes(tier)) return tier;
    if ((tier === '512' || tier === '0.5K') && supportedTiers.includes('1K')) return '1K';
    if ((tier === '512' || tier === '0.5K' || tier === '1K' || tier === '1.5K') && supportedTiers.includes('2K')) {
        return tier === '1.5K' && supportedTiers.includes('1K') ? '1K' : '2K';
    }
    if ((tier === '3K' || tier === '4K') && supportedTiers.includes('2K')) return '2K';
    return fallbackTier;
}

function resolveSize({ ratio = '', imageSize = '1K', model = '', generationConfig = {}, layerDecomposition = false } = {}) {
    if (layerDecomposition) {
        const requestedLayerSize = String(generationConfig.layerSize || '').trim();
        if (requestedLayerSize) {
            const upper = requestedLayerSize.toUpperCase();
            if (requestedLayerSize.toLowerCase() === 'auto') return 'auto';
            if (['1K', '1.5K', '2K'].includes(upper)) return upper;
            throw new Error(`Seedream 图层拆分不支持尺寸参数: ${requestedLayerSize}`);
        }
        return 'auto';
    }

    const explicitRatioSize = parsePixelSize(ratio);
    if (explicitRatioSize) {
        validateCustomSize(explicitRatioSize.width, explicitRatioSize.height, model);
        return `${explicitRatioSize.width}x${explicitRatioSize.height}`;
    }

    const wantsCustom = String(ratio || '').trim().toLowerCase() === 'custom'
        || String(imageSize || '').trim().toLowerCase() === 'custom';
    if (wantsCustom) {
        const width = Number(generationConfig.gptImageWidth);
        const height = Number(generationConfig.gptImageHeight);
        validateCustomSize(width, height, model);
        return `${width}x${height}`;
    }

    const explicitImageSize = parsePixelSize(imageSize);
    if (explicitImageSize) {
        validateCustomSize(explicitImageSize.width, explicitImageSize.height, model);
        return `${explicitImageSize.width}x${explicitImageSize.height}`;
    }

    return normalizeTier(imageSize, model);
}

function withSeedreamAspectRatio(prompt = '', ratio = '', size = '') {
    const ratioText = String(ratio || '').trim();
    if (!ratioText || ratioText.toLowerCase() === 'custom' || ratioText.toLowerCase() === 'auto'
        || parsePixelSize(ratioText) || parsePixelSize(size)) {
        return String(prompt || '');
    }
    if (!/^\d+\s*:\s*\d+$/.test(ratioText)) return String(prompt || '');
    if (String(prompt || '').includes(ratioText)) return String(prompt || '');
    return `${prompt}，宽高比为${ratioText}`;
}

function resolveBackground(model = '', generationConfig = {}, layerDecomposition = false) {
    const raw = String(generationConfig.gptBackground || generationConfig.background || '').trim().toLowerCase();
    if (!raw || raw === 'auto') return '';
    if (layerDecomposition) {
        throw new Error('Seedream 图层拆分模式下不能设置 background 参数');
    }
    const caps = capabilities(model);
    if (!caps.supportsBackground) {
        throw new Error(`当前 Seedream 模型不支持背景参数: ${raw}（仅 Seedream 5.5 与 5.0 Pro 支持）`);
    }
    if (!['opaque', 'transparent'].includes(raw)) {
        throw new Error(`不支持的 Seedream 背景参数: ${raw}`);
    }
    return raw;
}

function resolveOutputFormat(model = '', generationConfig = {}, background = '') {
    const caps = capabilities(model);
    if (!caps.supportsOutputFormat) return '';
    const raw = String(generationConfig.outputMimeType || generationConfig.outputFormat || '').trim().toLowerCase();
    let explicit = '';
    if (raw === 'png' || raw === 'image/png') explicit = 'png';
    else if (raw === 'jpeg' || raw === 'jpg' || raw === 'image/jpeg' || raw === 'image/jpg') explicit = 'jpeg';
    else if (raw) throw new Error(`Seedream 输出格式仅支持 PNG 或 JPEG，当前: ${raw}`);

    if (background === 'transparent' && explicit === 'jpeg') {
        throw new Error('Seedream 透明背景（transparent）要求输出格式为 PNG，不能与 JPEG 同时使用');
    }
    return explicit || 'png';
}

function referenceDataUrl(ref = {}) {
    if (typeof ref === 'string') return ref;
    if (ref.url && /^https?:\/\//i.test(ref.url)) return ref.url;
    const mimeType = String(ref.mimeType || 'image/png').split(';')[0].trim().toLowerCase();
    const base64 = String(ref.base64 || '').replace(/^data:[^,]+,/, '');
    return `data:${mimeType};base64,${base64}`;
}

function buildRequest({
    model,
    prompt = '',
    effectivePrompt = '',
    ratio = '1:1',
    imageSize = '1K',
    referenceImages = [],
    referenceUrls = null,
    generationConfig = {},
    includeStream = true
} = {}) {
    const caps = capabilities(model);
    const images = Array.isArray(referenceUrls)
        ? referenceUrls.filter(Boolean)
        : (Array.isArray(referenceImages) ? referenceImages.filter(ref => ref && (ref.base64 || ref.url)).map(referenceDataUrl) : []);

    if (images.length > caps.maxReferences) {
        throw new Error(`当前 Seedream 模型最多支持 ${caps.maxReferences} 张参考图（当前 ${images.length} 张）`);
    }

    const layerDecomposition = !!generationConfig.layerDecomposition;
    if (layerDecomposition && !caps.supportsLayerDecomposition) {
        throw new Error(`当前 Seedream 模型不支持图层拆分: ${model}`);
    }
    if (layerDecomposition && images.length !== 1) {
        throw new Error(`Seedream 图层拆分需要且仅支持 1 张输入参考图（当前 ${images.length} 张）`);
    }

    const size = resolveSize({ ratio, imageSize, model, generationConfig, layerDecomposition });
    const background = resolveBackground(model, generationConfig, layerDecomposition);
    const outputFormat = resolveOutputFormat(model, generationConfig, background);
    const responseFormat = String(generationConfig.responseFormat || generationConfig.seedreamResponseFormat || 'url').trim();
    if (!['url', 'b64_json'].includes(responseFormat)) {
        throw new Error(`不支持的 Seedream 响应格式: ${responseFormat}`);
    }

    const requestBody = {
        model: String(model || '').trim(),
        size,
        response_format: responseFormat,
        watermark: generationConfig.watermark != null ? !!generationConfig.watermark : false
    };

    if (includeStream) {
        requestBody.stream = false;
    }

    if (layerDecomposition) {
        const rawPrompt = String(prompt || '').trim();
        if (rawPrompt) requestBody.prompt = rawPrompt;
        requestBody.layer_decomposition = true;
        const layerOptions = {};
        if (generationConfig.layerMaxImages != null && generationConfig.layerMaxImages !== '') {
            const maxImages = Number(generationConfig.layerMaxImages);
            if (!Number.isInteger(maxImages) || maxImages < 2 || maxImages > 100) {
                throw new Error('Seedream 图层拆分 max_images 必须是 2 到 100 的整数');
            }
            layerOptions.max_images = maxImages;
        }
        if (generationConfig.layerTextRecognition != null) {
            layerOptions.text_recognition = !!generationConfig.layerTextRecognition;
        }
        if (Object.keys(layerOptions).length > 0) {
            requestBody.layer_decomposition_options = layerOptions;
        }
    } else {
        const basePrompt = effectivePrompt || String(prompt || '');
        requestBody.prompt = withSeedreamAspectRatio(basePrompt, ratio, size);
    }

    if (outputFormat) requestBody.output_format = outputFormat;
    if (background) requestBody.background = background;

    if (images.length === 1) {
        requestBody.image = images[0];
    } else if (images.length > 1) {
        requestBody.image = images;
    }

    if (caps.supportsSequential) {
        if (generationConfig.sequentialImageGeneration) {
            requestBody.sequential_image_generation = generationConfig.sequentialImageGeneration;
        }
        if (generationConfig.maxImages != null || generationConfig.seedreamMaxImages != null) {
            const maxImages = parseInt(generationConfig.maxImages ?? generationConfig.seedreamMaxImages, 10);
            if (Number.isFinite(maxImages) && maxImages > 0) {
                requestBody.sequential_image_generation_options = { max_images: maxImages };
            }
        }
    }

    if (caps.supportsWebSearch && (generationConfig.googleSearch || generationConfig.webSearch)) {
        requestBody.tools = [{ type: 'web_search' }];
    }

    const optimizeMode = String(generationConfig.optimizePromptMode || generationConfig.optimizePromptOptions?.mode || '').trim().toLowerCase();
    if (optimizeMode) {
        if (caps.family === 'seedream-5.5' && optimizeMode !== 'standard') {
            throw new Error(`Seedream 5.5 的 optimize_prompt_options.mode 仅支持 standard，当前: ${optimizeMode}`);
        }
        if (!['standard', 'fast'].includes(optimizeMode)) {
            throw new Error(`不支持的 Seedream 提示词优化模式: ${optimizeMode}`);
        }
        requestBody.optimize_prompt_options = { mode: optimizeMode };
    }

    return { size, body: requestBody };
}

module.exports = {
    PROVIDER_KIND,
    SEEDREAM_RATIOS,
    modelKey,
    isSeedreamModel,
    seedreamFamily,
    isSeedream55Model,
    isSeedream50ProModel,
    isSeedream5Family,
    capabilities,
    parsePixelSize,
    validateCustomSize,
    normalizeTier,
    resolveSize,
    withSeedreamAspectRatio,
    resolveBackground,
    resolveOutputFormat,
    referenceDataUrl,
    buildRequest
};
