const imageApiProfiles = require('./imageApiProfiles');
const grsaiNanoBanana = require('./imageAdapters/grsaiNanoBanana');

const PROTOCOLS = Object.freeze({
    AUTO: 'auto',
    GEMINI_NATIVE: 'gemini-native',
    OPENAI_IMAGES: 'openai-images',
    XAI_IMAGINE: 'xai-imagine',
    OPENAI_CHAT: 'openai-chat',
    GRSAI_NANO_BANANA: grsaiNanoBanana.GRSAI_PROTOCOL
});

const VALID_PROTOCOLS = new Set(Object.values(PROTOCOLS));

function normalizeProtocol(value = '') {
    const protocol = String(value || '').trim().toLowerCase();
    return VALID_PROTOCOLS.has(protocol) ? protocol : PROTOCOLS.AUTO;
}

function canonicalModelName(model = '') {
    return String(model || '').trim().replace(/^\[[^\]]+\]\s*/g, '').toLowerCase();
}

function modelRouteConfig(provider = {}, model = '') {
    const routing = provider.modelRouting && typeof provider.modelRouting === 'object'
        ? provider.modelRouting
        : {};
    return routing[model] || routing[canonicalModelName(model)] || {};
}

function modelCapability(provider = {}, model = '') {
    const capabilities = provider.modelCapabilities && typeof provider.modelCapabilities === 'object'
        ? provider.modelCapabilities
        : {};
    return capabilities[model] || capabilities[canonicalModelName(model)] || {};
}

function routeGroupFor(provider = {}, model = '') {
    return canonicalModelName(model);
}

function advertisedProtocols(provider = {}, model = '') {
    const capability = modelCapability(provider, model);
    const endpointTypes = Array.isArray(capability.supported_endpoint_types)
        ? capability.supported_endpoint_types.map(item => String(item).toLowerCase())
        : [];
    const protocols = [];
    if (endpointTypes.includes('image-generation')) protocols.push(PROTOCOLS.OPENAI_IMAGES);
    if (endpointTypes.includes('gemini')) protocols.push(PROTOCOLS.GEMINI_NATIVE);
    if (endpointTypes.includes('openai') && imageApiProfiles.isGeminiImageModel(model)) {
        protocols.push(PROTOCOLS.OPENAI_IMAGES, PROTOCOLS.OPENAI_CHAT);
    } else if (endpointTypes.includes('openai')) {
        protocols.push(PROTOCOLS.OPENAI_CHAT);
    }
    return [...new Set(protocols)];
}

function inferProtocol(provider = {}, model = '') {
    const lowerModel = String(model || '').toLowerCase();
    const lowerProvider = String(provider.baseUrl || provider.url || '').toLowerCase();
    const configured = normalizeProtocol(modelRouteConfig(provider, model).protocol || provider.protocol);
    // Older PicGen versions saved Grsai's Nano Banana model as Gemini Native.
    // The dedicated async endpoint is the compatible route for this provider;
    // transparently migrate that stale route without touching user settings.
    if (configured === PROTOCOLS.GEMINI_NATIVE
        && grsaiNanoBanana.isGrsaiProvider(lowerProvider)
        && grsaiNanoBanana.isGrsaiNanoBananaModel(model)) {
        return PROTOCOLS.GRSAI_NANO_BANANA;
    }
    if (configured !== PROTOCOLS.AUTO) return configured;
    const advertised = advertisedProtocols(provider, model);
    if (grsaiNanoBanana.shouldUse(lowerProvider, model, configured)) return PROTOCOLS.GRSAI_NANO_BANANA;
    if (lowerModel.includes('(按次)') && advertised.includes(PROTOCOLS.OPENAI_IMAGES)) return PROTOCOLS.OPENAI_IMAGES;
    if (lowerProvider.includes('moyu.info') && imageApiProfiles.isGeminiImageModel(model)) return PROTOCOLS.OPENAI_IMAGES;
    if (imageApiProfiles.isGeminiImageModel(model) && advertised.includes(PROTOCOLS.GEMINI_NATIVE)) {
        return PROTOCOLS.GEMINI_NATIVE;
    }
    if (imageApiProfiles.isOpenAIImageModel(model)
        || imageApiProfiles.isXAIImageModel(model)
        || lowerModel.includes('seedream')) return PROTOCOLS.OPENAI_IMAGES;
    if (lowerProvider.includes('generativelanguage.googleapis.com')) return PROTOCOLS.GEMINI_NATIVE;
    if (advertised.length > 0) return advertised[0];
    if (imageApiProfiles.isGeminiImageModel(model)) return PROTOCOLS.GEMINI_NATIVE;
    return PROTOCOLS.OPENAI_CHAT;
}

function protocolCandidates(provider = {}, model = '') {
    const candidates = [inferProtocol(provider, model), ...advertisedProtocols(provider, model)];
    if (imageApiProfiles.isXAIImageModel(model)) candidates.push(PROTOCOLS.XAI_IMAGINE);
    if (imageApiProfiles.isGeminiImageModel(model)) {
        candidates.push(PROTOCOLS.GEMINI_NATIVE, PROTOCOLS.OPENAI_IMAGES, PROTOCOLS.OPENAI_CHAT);
    }
    return [...new Set(candidates.filter(protocol => protocol !== PROTOCOLS.AUTO))];
}

function supportsOperation(provider = {}, model = '', operation = 'generate') {
    if (operation !== 'edit' && operation !== 'mask-edit') return true;
    const capability = modelCapability(provider, model);
    if (typeof capability.supportsMaskEdit === 'boolean') return capability.supportsMaskEdit;
    // 没有原生蒙版参数的协议由 maskEdit 走"红色涂抹定位图 + 结果贴回原图"兜底，所以都可以做局部编辑
    if (operation === 'mask-edit') return true;
    if (imageApiProfiles.isOpenAIImageModel(model)) return true;
    return protocolCandidates(provider, model).some(protocol => [PROTOCOLS.OPENAI_IMAGES, PROTOCOLS.XAI_IMAGINE].includes(protocol))
        && Number(imageApiProfiles.getImageApiProfile(model).maxReferences || 0) > 0;
}

module.exports = {
    PROTOCOLS,
    normalizeProtocol,
    canonicalModelName,
    modelRouteConfig,
    modelCapability,
    routeGroupFor,
    advertisedProtocols,
    inferProtocol,
    protocolCandidates,
    supportsOperation
};
