(function initImageApiProfiles(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PicGenImageApiProfiles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createImageApiProfiles() {
    'use strict';

    const GEMINI_FULL_RATIOS = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'];
    const GEMINI_STANDARD_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
    const XAI_RATIOS = ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '9:19.5', '19.5:9', '9:20', '20:9', '1:2', '2:1', '21:9', '5:2'];
    const LEGACY_RATIOS = GEMINI_FULL_RATIOS;
    const COUNT_OPTIONS = Array.from({ length: 5 }, (_, index) => String(index + 1));
    const OPENAI_IMAGE2_RATIOS = [
        'auto', '1:1', '1:2', '2:1', '2:3', '3:2', '3:4',
        '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'
    ];
    const OPENAI_IMAGE25_RATIOS = [...OPENAI_IMAGE2_RATIOS, '9:21', '1:3', '3:1'];
    const OPENAI_IMAGE2_RESOLUTIONS = ['1K', '2K', '4K', 'custom'];

    // GPT Image 2.5 (Sunburst / Flare) uses the same Image API size envelope
    // as GPT Image 2, while adding xhigh and max quality tiers.
    const OPENAI_IMAGE25_RESOLUTIONS = OPENAI_IMAGE2_RESOLUTIONS;

    // 新建序列（以及全新安装）默认使用的分辨率档位。用户仍可在画面设置里改。
    const DEFAULT_IMAGE_SIZE = '4K';

    // 档位高低表，用于把首选档位回落到模型真正支持的档。'custom' 与具体的
    // "2048x2048" 这类不参与排序（rank 为 -1），因此永远不会被自动选中。
    const IMAGE_SIZE_TIERS = {
        '512': 512,
        '0.5K': 512,
        '1K': 1024,
        '2K': 2048,
        '3K': 3072,
        '4K': 4096
    };

    const OPENAI_GPT_IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'];
    const OPENAI_IMAGE2_SIZES = [
        ...OPENAI_GPT_IMAGE_SIZES,
        '2048x2048',
        '2048x1152',
        '1152x2048',
        '3840x2160',
        '2160x3840',
        'custom'
    ];
    const OPENAI_IMAGE2_SIZE_MAP = {
        '1K': {
            '1:1': '1024x1024',
            '1:2': '768x1536',
            '2:1': '1536x768',
            '2:3': '1024x1536',
            '3:2': '1536x1024',
            '3:4': '960x1280',
            '4:3': '1280x960',
            '4:5': '1024x1280',
            '5:4': '1280x1024',
            '9:16': '720x1280',
            '16:9': '1280x720',
            '21:9': '1344x576'
            , '9:21': '576x1344', '1:3': '512x1536', '3:1': '1536x512'
        },
        '2K': {
            '1:1': '2048x2048',
            '1:2': '1024x2048',
            '2:1': '2048x1024',
            '2:3': '1344x2016',
            '3:2': '2016x1344',
            '3:4': '1536x2048',
            '4:3': '2048x1536',
            '4:5': '1632x2048',
            '5:4': '2048x1632',
            '9:16': '1152x2048',
            '16:9': '2048x1152',
            '21:9': '2048x880'
            , '9:21': '880x2048', '1:3': '1280x3840', '3:1': '3840x1280'
        },
        '4K': {
            '1:1': '2880x2880',
            '1:2': '1920x3840',
            '2:1': '3840x1920',
            '2:3': '2336x3504',
            '3:2': '3504x2336',
            '3:4': '2480x3312',
            '4:3': '3312x2480',
            '4:5': '2560x3200',
            '5:4': '3200x2560',
            '9:16': '2160x3840',
            '16:9': '3840x2160',
            '21:9': '3840x1648'
            , '9:21': '1648x3840', '1:3': '1280x3840', '3:1': '3840x1280'
        }
    };
    const OPENAI_IMAGE2_LEGACY_SELECTIONS = {
        auto: { ratio: '1:1', resolution: '1K' },
        '1024x1024': { ratio: '1:1', resolution: '1K' },
        '1536x1024': { ratio: '3:2', resolution: '1K' },
        '1024x1536': { ratio: '2:3', resolution: '1K' },
        '2048x2048': { ratio: '1:1', resolution: '2K' },
        '2048x1152': { ratio: '16:9', resolution: '2K' },
        '1152x2048': { ratio: '9:16', resolution: '2K' },
        '3840x2160': { ratio: '16:9', resolution: '4K' },
        '2160x3840': { ratio: '9:16', resolution: '4K' },
        custom: { ratio: '1:1', resolution: 'custom' }
    };
    const OPENAI_DALLE3_SIZES = ['1024x1024', '1792x1024', '1024x1792'];
    const OPENAI_DALLE2_SIZES = ['256x256', '512x512', '1024x1024'];

    // 聚合网关（OpenRouter / Azure / Vertex）用 vendor/model 形式，
    // 例如 google/gemini-3-flash-image-2。前缀会让下面的厂商判定失效，
    // 所以归一化时一并剥掉，使带前缀与裸写法收敛到同一个键。
    function normalizeModelKeyword(model = '') {
        return String(model || '')
            .toLowerCase()
            .replace(/[\s_-]+/g, '')
            .replace(/^.*\//, '');
    }

    // 归一化会去掉分隔符，模型名之间容易出现意外的子串重叠：
    // gpt-image-mini -> gptimagemini 尾部含 "gemini"，
    // gemini-3-flash-image-2 -> gemini3flashimage2 尾部含 "image2"。
    // 判定某一厂商前，先确认模型名不属于其他厂商。
    const VENDOR_PREFIXES = {
        openai: ['gptimage', 'dalle'],
        gemini: ['gemini', 'nanobanana'],
        xai: ['grok']
    };

    function belongsToOtherVendor(normalized, vendor) {
        return Object.entries(VENDOR_PREFIXES)
            .filter(([name]) => name !== vendor)
            .some(([, prefixes]) => prefixes.some(prefix => normalized.startsWith(prefix)));
    }

    function isGeminiImageModel(model = '') {
        const normalized = normalizeModelKeyword(model);
        if (belongsToOtherVendor(normalized, 'gemini')) return false;
        return normalized.includes('gemini') || normalized.includes('nanobanana');
    }

    function isXAIImageModel(model = '') {
        const normalized = normalizeModelKeyword(model);
        if (belongsToOtherVendor(normalized, 'xai')) return false;
        return normalized.includes('grok');
    }

    function isXAIImagineNativeModel(model = '') {
        const normalized = normalizeModelKeyword(model);
        return normalized === 'grokimagineimage' || normalized === 'grokimagineimage2.0';
    }

    function isXAIImagineImage2Model(model = '') {
        return normalizeModelKeyword(model) === 'grokimagineimage2.0';
    }

    function isOpenAIGptImageModel(model = '') {
        const normalized = normalizeModelKeyword(model);
        if (normalized.startsWith('gptimage')) return true;
        if (belongsToOtherVendor(normalized, 'openai')) return false;
        return normalized === 'image2' || normalized.endsWith('image2');
    }

    function isOpenAIDallEModel(model = '') {
        return normalizeModelKeyword(model).startsWith('dalle');
    }

    function isOpenAIImageModel(model = '') {
        return isOpenAIGptImageModel(model) || isOpenAIDallEModel(model);
    }

    function isOpenAIImage2Model(model = '') {
        const normalized = normalizeModelKeyword(model);
        if (normalized.includes('gptimage25') || normalized.includes('gptimage2.5')) return false;
        if (normalized.includes('gptimage2')) return true;
        if (belongsToOtherVendor(normalized, 'openai')) return false;
        return normalized === 'image2' || normalized.endsWith('image2');
    }

    function isOpenAIImage25Model(model = '') {
        const normalized = normalizeModelKeyword(model);
        if (belongsToOtherVendor(normalized, 'openai')) return false;
        return normalized.includes('gptimage25')
            || normalized.includes('gptimage2vip')
            || normalized === 'image25'
            || normalized.includes('gptimage2.5');
    }

    function openAIImageFamily(model = '') {
        const normalized = normalizeModelKeyword(model);
        if (isOpenAIImage25Model(model)) {
            if (normalized.includes('flare')) return 'gpt-image-2.5-flare';
            if (normalized.includes('sunburst')) return 'gpt-image-2.5-sunburst';
            return 'gpt-image-2.5';
        }
        if (isOpenAIImage2Model(model)) return 'gpt-image-2';
        if (normalized.includes('gptimage') && normalized.includes('mini')) return 'gpt-image-mini';
        if (normalized.startsWith('gptimage')) return 'gpt-image';
        if (normalized.startsWith('dalle3')) return 'dall-e-3';
        if (normalized.startsWith('dalle2')) return 'dall-e-2';
        return isOpenAIImageModel(model) ? 'openai-image' : '';
    }

    function imageApiKind(model = '') {
        // OpenAI 判断必须在 Gemini 之前：gpt-image-mini 归一化成 gptimagemini，
        // 尾部恰好包含 "gemini" 子串，会被 isGeminiImageModel 误判。
        if (isOpenAIImageModel(model)) return 'openai';
        if (isGeminiImageModel(model)) return 'gemini';
        if (isXAIImageModel(model)) return 'xai';
        return 'legacy';
    }

    function labelOptions(values) {
        return values.map(value => ({
            value,
            label: value === 'custom' ? '自定义' : value.replace('x', ' x ')
        }));
    }

    // \u628a"\u60f3\u7528\u7684\u6863\u4f4d"\u89e3\u6790\u6210\u8be5\u6a21\u578b\u9009\u9879\u5217\u8868\u91cc\u771f\u5b9e\u5b58\u5728\u7684\u4e00\u4e2a\u503c\u3002
    //
    // \u9ed8\u8ba4\u6863\u4f4d\u662f 4K\uff0c\u4f46\u6709\u4e9b\u6a21\u578b\u6ca1\u6709\u8fd9\u4e00\u6863\uff08Gemini 2.5 Flash Image \u53ea\u6709 1K\u3001
    // grok-imagine \u53ea\u6709 1k/2k\uff09\u3002\u8fd9\u65f6\u9000\u5230\u4e0d\u9ad8\u4e8e\u9996\u9009\u7684\u6700\u9ad8\u6863\uff1b\u8fde\u66f4\u4f4e\u7684\u90fd\u6ca1\u6709\u624d
    // \u7528\u9996\u9879\u3002\u7edd\u4e0d\u8fd4\u56de\u5217\u8868\u4ee5\u5916\u7684\u503c\u2014\u2014\u63d0\u4ea4\u65f6 imageSize \u662f\u539f\u6837\u53d1\u7ed9\u4e0a\u6e38\u7684\uff0c\u8fd4\u56de
    // \u4e00\u4e2a\u6a21\u578b\u4e0d\u652f\u6301\u7684\u6863\u4f4d\u5c31\u662f\u4e00\u6b21\u6ce8\u5b9a\u5931\u8d25\u7684\u8bf7\u6c42\u3002
    function resolveImageSizePreference(preferred = DEFAULT_IMAGE_SIZE, options = []) {
        const values = (Array.isArray(options) ? options : [])
            .map(option => (option && typeof option === 'object' ? option.value : option))
            .filter(value => value !== undefined && value !== null && value !== '');
        if (values.length === 0) return '';

        const wanted = String(preferred || '').trim().toUpperCase();
        // \u5927\u5c0f\u5199\u4e0d\u654f\u611f\u5339\u914d\uff0c\u8fd9\u6837 xai \u7684\u5c0f\u5199 '1k'/'2k' \u80fd\u539f\u6837\u4fdd\u7559\u3002
        const exact = values.find(value => String(value).toUpperCase() === wanted);
        if (exact !== undefined) return exact;

        const rank = value => IMAGE_SIZE_TIERS[String(value).toUpperCase()] ?? -1;
        // 'custom' 和旧的 '2048x2048' 这类不参与排序（rank 为 -1）。它们不等于"比所有档位都低"：
        // 那样会落到下面的 values[0]，而 values[0] 是最小档——gemini-3.1 的列表以 512 打头，
        // 于是"在 gpt-image 上选了自定义尺寸、不动分辨率直接切到 gemini"会把 1024² 的请求变成 512²。
        // 这类首选等同于没有偏好，按默认档位解析（与新建序列同一条规则）。
        const wantedRank = rank(wanted);
        const targetRank = wantedRank > 0 ? wantedRank : rank(String(DEFAULT_IMAGE_SIZE).toUpperCase());
        if (targetRank > 0) {
            const notHigher = values.filter(value => rank(value) > 0 && rank(value) <= targetRank);
            if (notHigher.length > 0) {
                return notHigher.reduce((best, value) => (rank(value) > rank(best) ? value : best));
            }
        }
        return values[0];
    }

    function normalizeImageSize(value = '') {
        const match = String(value || '').trim().match(/^(\d+)\s*(?:x|\*|\u00d7)\s*(\d+)$/i);
        return match ? `${Number(match[1])}x${Number(match[2])}` : String(value || '').trim();
    }

    function openAIImage2SelectionFromLegacySize(value = '') {
        const normalized = normalizeImageSize(value).toLowerCase();
        return OPENAI_IMAGE2_LEGACY_SELECTIONS[normalized]
            ? { ...OPENAI_IMAGE2_LEGACY_SELECTIONS[normalized] }
            : null;
    }

    function resolveOpenAIImage2MappedSize(ratio = '1:1', resolution = '1K') {
        // 智能比例：交由服务端自动决定尺寸。
        if (ratio === 'auto') return 'auto';
        const normalizedRatio = (OPENAI_IMAGE2_RATIOS.includes(ratio) || OPENAI_IMAGE25_RATIOS.includes(ratio)) ? ratio : '1:1';
        const normalizedResolution = String(resolution || '1K').toUpperCase();
        const tier = OPENAI_IMAGE2_SIZE_MAP[normalizedResolution] || OPENAI_IMAGE2_SIZE_MAP['1K'];
        return tier[normalizedRatio];
    }

    function geminiModelCapabilities(model = '') {
        const normalized = normalizeModelKeyword(model);
        const isFlash31 = normalized.includes('gemini3.1flashimage');
        const isFlashLite31 = normalized.includes('gemini3.1flashliteimage');
        const isProImage = normalized.includes('proimage');
        const isFlash25 = normalized.includes('gemini2.5flashimage');
        const fullRatios = isFlash31 || isFlashLite31 || (!isProImage && !isFlash25);

        let imageSizes = ['1K', '2K', '4K'];
        if (isFlash31) imageSizes = ['512', '1K', '2K', '4K'];
        if (isFlashLite31 || isFlash25) imageSizes = ['1K'];

        return {
            ratios: fullRatios ? GEMINI_FULL_RATIOS : GEMINI_STANDARD_RATIOS,
            imageSizes,
            sendsImageSize: !isFlashLite31 && !isFlash25,
            imageConfigField: 'imageConfig',
            supportsThinkingLevel: isFlash31 || isFlashLite31,
            supportsGoogleSearch: isFlash31 || isProImage,
            supportsImageSearch: isFlash31 && !isFlashLite31,
            maxReferences: isFlash25 ? 3 : 14
        };
    }

    function getImageApiProfile(model = '') {
        const apiKind = imageApiKind(model);
        const family = openAIImageFamily(model);
        const isGptImage = family.startsWith('gpt-image') || family === 'openai-image';
        const isGptImage25 = family.startsWith('gpt-image-2.5') || family === 'gpt-image-2-vip';
        const isDallE = family.startsWith('dall-e');

        if (apiKind === 'gemini') {
            const capabilities = geminiModelCapabilities(model);
            return {
                apiKind,
                family: 'gemini-image',
                dimensionLabel: '比例',
                dimensionOptions: labelOptions(capabilities.ratios),
                imageSizeOptions: labelOptions(capabilities.imageSizes),
                countOptions: labelOptions(COUNT_OPTIONS),
                maxReferences: capabilities.maxReferences,
                sendsImageSize: capabilities.sendsImageSize,
                controls: {
                    responseModalities: true,
                    thinkingLevel: capabilities.supportsThinkingLevel,
                    includeThoughts: true,
                    temperature: true,
                    topP: true,
                    topK: true,
                    googleSearch: capabilities.supportsGoogleSearch,
                    imageSearch: capabilities.supportsImageSearch
                }
            };
        }

        if (apiKind === 'xai') {
            const isNativeImagine = isXAIImagineNativeModel(model);
            const isImagine2 = isXAIImagineImage2Model(model);
            return {
                apiKind,
                family: isImagine2 ? 'grok-imagine-image-2.0' : isNativeImagine ? 'grok-imagine-image' : 'grok-image',
                dimensionLabel: '比例',
                dimensionOptions: labelOptions(XAI_RATIOS),
                imageSizeOptions: labelOptions(['1k', '2k']),
                countOptions: labelOptions(COUNT_OPTIONS),
                maxReferences: 3,
                controls: {
                    quality: isImagine2,
                    responseFormat: isNativeImagine
                },
                qualityOptions: isImagine2 ? labelOptions(['medium', 'low']) : undefined
            };
        }

        if (apiKind === 'openai') {
            let sizes = OPENAI_GPT_IMAGE_SIZES;
            if (family === 'gpt-image-2' || isGptImage25) sizes = OPENAI_IMAGE2_SIZES;
            if (family === 'dall-e-3') sizes = OPENAI_DALLE3_SIZES;
            if (family === 'dall-e-2') sizes = OPENAI_DALLE2_SIZES;

            const isImage2 = family === 'gpt-image-2' || isGptImage25;
            return {
                apiKind,
                family,
                dimensionLabel: isImage2 ? '比例' : '尺寸',
                dimensionOptions: labelOptions(isGptImage25 ? OPENAI_IMAGE25_RATIOS : isImage2 ? OPENAI_IMAGE2_RATIOS : sizes),
                imageSizeOptions: isImage2 ? labelOptions(OPENAI_IMAGE2_RESOLUTIONS) : [],
                countOptions: labelOptions(COUNT_OPTIONS),
                maxReferences: family === 'dall-e-3' ? 0 : family === 'dall-e-2' ? 1 : 16,
                controls: {
                    outputFormat: isGptImage,
                    compression: isGptImage,
                    quality: true,
                    background: isGptImage,
                    customSize: isImage2,
                    moderation: isGptImage,
                    responseFormat: isDallE,
                    style: family === 'dall-e-3',
                    inputFidelity: isGptImage && !isImage2 && family !== 'gpt-image-mini',
                    apiUser: true
                },
                qualityOptions: family === 'dall-e-3'
                    ? labelOptions(['standard', 'hd'])
                    : family === 'dall-e-2'
                        ? labelOptions(['standard'])
                        : isGptImage25
                            ? labelOptions(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
                            : labelOptions(['auto', 'low', 'medium', 'high']),
                backgroundOptions: isGptImage25
                    ? labelOptions(['auto', 'opaque', 'transparent'])
                    : family === 'gpt-image-2'
                        ? labelOptions(['auto', 'opaque'])
                    : labelOptions(['auto', 'opaque', 'transparent'])
            };
        }

        return {
            apiKind,
            family: 'legacy',
            dimensionLabel: '比例',
            dimensionOptions: labelOptions(LEGACY_RATIOS),
            imageSizeOptions: labelOptions(['1K', '2K', '4K']),
            countOptions: labelOptions(['1', '2', '4']),
            maxReferences: 8,
            controls: {}
        };
    }

    return {
        GEMINI_FULL_RATIOS,
        GEMINI_STANDARD_RATIOS,
        XAI_RATIOS,
        OPENAI_GPT_IMAGE_SIZES,
        OPENAI_IMAGE2_RATIOS,
        OPENAI_IMAGE25_RATIOS,
        OPENAI_IMAGE2_RESOLUTIONS,
        OPENAI_IMAGE25_RESOLUTIONS,
        DEFAULT_IMAGE_SIZE,
        IMAGE_SIZE_TIERS,
        resolveImageSizePreference,
        OPENAI_IMAGE2_SIZE_MAP,
        OPENAI_IMAGE2_SIZES,
        OPENAI_DALLE3_SIZES,
        OPENAI_DALLE2_SIZES,
        normalizeModelKeyword,
        isGeminiImageModel,
        isXAIImageModel,
        isXAIImagineNativeModel,
        isXAIImagineImage2Model,
        isOpenAIGptImageModel,
        isOpenAIDallEModel,
        isOpenAIImageModel,
        isOpenAIImage2Model,
        isOpenAIImage25Model,
        openAIImageFamily,
        imageApiKind,
        geminiModelCapabilities,
        openAIImage2SelectionFromLegacySize,
        resolveOpenAIImage2MappedSize,
        getImageApiProfile
    };
});
