// What a generate request carries besides the prompt: the advanced settings and
// the size tier. Shared by the renderer (generate button) and the main process
// (MCP), so an agent's request is built exactly like a click.
(function initGenerationSettings(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PicGenGenerationSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createGenerationSettings() {
    function createDefaultAdvancedSettings(input = {}) {
        return {
            outputMimeType: input.outputMimeType || '',
            imageCompression: String(input.imageCompression ?? '80'),
            gptQuality: input.gptQuality || 'auto',
            gptBackground: input.gptBackground || 'auto',
            gptImageWidth: input.gptImageWidth ?? '',
            gptImageHeight: input.gptImageHeight ?? '',
            openAIModeration: input.openAIModeration || input.moderation || 'auto',
            nativeResponseFormat: input.nativeResponseFormat || input.responseFormat || '',
            openAIStyle: input.openAIStyle || input.style || '',
            inputFidelity: input.inputFidelity || '',
            apiUser: input.apiUser || input.user || '',
            responseModalities: input.responseModalities || 'TEXT_IMAGE',
            thinkingLevel: input.thinkingLevel && input.thinkingLevel !== 'none' ? input.thinkingLevel : 'default',
            includeThoughts: !!input.includeThoughts,
            temperature: input.temperature ?? '',
            topP: input.topP ?? '',
            topK: input.topK ?? '',
            googleSearch: !!input.googleSearch,
            imageSearch: !!input.imageSearch,
            xaiStore: !!input.xaiStore,
            xaiFilename: input.xaiFilename || '',
            xaiExpiresAfter: input.xaiExpiresAfter ?? '',
            xaiPublicUrl: !!input.xaiPublicUrl
        };
    }

    function buildGenerationConfig(sequence, imageApiProfiles) {
        const advanced = createDefaultAdvancedSettings(sequence.advanced);
        const profile = imageApiProfiles.getImageApiProfile(sequence.model);
        const kind = profile.apiKind;
        const config = {};

        if (profile.controls.outputFormat && advanced.outputMimeType) config.outputMimeType = advanced.outputMimeType;
        if (profile.controls.compression && advanced.imageCompression !== '' && advanced.outputMimeType) {
            config.imageCompression = parseInt(advanced.imageCompression, 10);
        }

        if (kind === 'openai') {
            if (advanced.gptQuality) config.gptQuality = advanced.gptQuality;
            if (advanced.gptBackground) config.gptBackground = advanced.gptBackground;
            if (advanced.gptImageWidth !== '') config.gptImageWidth = parseInt(advanced.gptImageWidth, 10);
            if (advanced.gptImageHeight !== '') config.gptImageHeight = parseInt(advanced.gptImageHeight, 10);
            if (advanced.openAIModeration) config.moderation = advanced.openAIModeration;
            if (advanced.nativeResponseFormat) config.responseFormat = advanced.nativeResponseFormat;
            if (advanced.openAIStyle) config.style = advanced.openAIStyle;
            if (advanced.inputFidelity) config.inputFidelity = advanced.inputFidelity;
            if (advanced.apiUser) config.user = advanced.apiUser;
        }

        if (kind === 'gemini') {
            config.responseModalities = advanced.responseModalities || 'TEXT_IMAGE';
            config.thinkingLevel = advanced.thinkingLevel || 'default';
            config.includeThoughts = !!advanced.includeThoughts;
            if (advanced.temperature !== '') config.temperature = parseFloat(advanced.temperature);
            if (advanced.topP !== '') config.topP = parseFloat(advanced.topP);
            if (advanced.topK !== '') config.topK = parseInt(advanced.topK, 10);
            config.googleSearch = !!advanced.googleSearch;
            config.imageSearch = !!advanced.imageSearch;
        }

        if (kind === 'xai') {
            if (profile.controls.quality && advanced.gptQuality) config.gptQuality = advanced.gptQuality;
            if (profile.controls.responseFormat && advanced.nativeResponseFormat) {
                config.responseFormat = advanced.nativeResponseFormat;
            }
        }

        return config;
    }

    // imageSize goes upstream as is, so a tier the model lacks is a request that
    // is bound to fail. Narrow it at submit time; an empty preference means the
    // app default. Models without size options keep what was asked.
    function resolveImageSize(model, imageSize, imageApiProfiles) {
        const options = imageApiProfiles.getImageApiProfile(model).imageSizeOptions;
        return imageApiProfiles.resolveImageSizePreference(imageSize || imageApiProfiles.DEFAULT_IMAGE_SIZE, options) || imageSize || '';
    }

    return { createDefaultAdvancedSettings, buildGenerationConfig, resolveImageSize };
});
