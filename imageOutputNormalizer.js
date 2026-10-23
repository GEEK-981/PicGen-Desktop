const imageApiProfiles = require('./imageApiProfiles');
const grsaiGptImage = require('./imageAdapters/grsaiGptImage');

function parseSize(value = '') {
    const match = String(value || '').trim().match(/^(\d+)\s*(?:x|\*|\u00d7)\s*(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function requestedImage2OutputSize(task = {}) {
    const isImage2x = imageApiProfiles.isOpenAIImage2Model(task.model)
        || imageApiProfiles.isOpenAIImage25Model(task.model);
    if (!isImage2x) return null;

    const resolution = String(task.imageSize || '').trim();
    if (resolution.toLowerCase() === 'custom') {
        const width = Number(task.generationConfig?.gptImageWidth);
        const height = Number(task.generationConfig?.gptImageHeight);
        return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
            ? { width, height }
            : null;
    }

    const isGrsai = grsaiGptImage.isGrsaiProvider(task.provider);
    if (isGrsai && grsaiGptImage.isModel(task.model)) {
        const mapped = grsaiGptImage.resolvePixelSize(task.ratio, resolution);
        if (mapped) return parseSize(mapped);
    }

    if (imageApiProfiles.OPENAI_IMAGE2_RATIOS.includes(task.ratio)
        && ['1K', '2K', '4K'].includes(resolution.toUpperCase())) {
        return parseSize(imageApiProfiles.resolveOpenAIImage2MappedSize(task.ratio, resolution));
    }

    return parseSize(task.ratio);
}

// Async because a codec may hand the resize off to a worker thread — doing it
// inline costs ~1.23 s of synchronous main-process time on a 3264x2448 frame.
// Synchronous codecs (and the early-exit paths) resolve on the next microtask.
async function normalizeImage2ResultDimensions(task = {}, result = {}, codec) {
    if (result.maskApplied) return result;
    const requested = requestedImage2OutputSize(task);
    if (!requested || !result.base64 || !codec?.getSize) return result;

    try {
        const sourceBuffer = Buffer.from(result.base64, 'base64');
        const source = await codec.getSize(sourceBuffer);
        if (!source?.width || !source?.height) return result;

        const metadata = {
            sourceWidth: source.width,
            sourceHeight: source.height,
            requestedWidth: requested.width,
            requestedHeight: requested.height
        };
        if (source.width === requested.width && source.height === requested.height) {
            return {
                ...result,
                ...metadata,
                width: source.width,
                height: source.height,
                dimensionAdjusted: false
            };
        }

        if (!codec.resize) return { ...result, ...metadata, dimensionAdjusted: false };
        const resized = await codec.resize(sourceBuffer, {
            width: requested.width,
            height: requested.height,
            mimeType: result.mimeType || 'image/png',
            quality: Number(task.generationConfig?.imageCompression) || 95
        });
        if (!resized?.buffer) return { ...result, ...metadata, dimensionAdjusted: false };

        return {
            ...result,
            ...metadata,
            base64: resized.buffer.toString('base64'),
            mimeType: resized.mimeType || result.mimeType || 'image/png',
            width: requested.width,
            height: requested.height,
            dimensionAdjusted: true
        };
    } catch (error) {
        return {
            ...result,
            dimensionAdjusted: false,
            dimensionAdjustmentError: error.message
        };
    }
}

function createElectronImageCodec(nativeImage) {
    return {
        getSize(buffer) {
            const image = nativeImage.createFromBuffer(buffer);
            if (image.isEmpty()) throw new Error('供应商返回的图片无法读取');
            return image.getSize();
        },
        resize(buffer, options) {
            const image = nativeImage.createFromBuffer(buffer);
            if (image.isEmpty()) throw new Error('供应商返回的图片无法缩放');
            const resized = image.resize({
                width: options.width,
                height: options.height,
                quality: 'best'
            });
            const mimeType = String(options.mimeType || 'image/png').toLowerCase();
            if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
                return {
                    buffer: resized.toJPEG(Math.max(0, Math.min(100, Math.round(options.quality || 95)))),
                    mimeType: 'image/jpeg'
                };
            }
            return { buffer: resized.toPNG(), mimeType: 'image/png' };
        }
    };
}

module.exports = {
    parseSize,
    requestedImage2OutputSize,
    normalizeImage2ResultDimensions,
    createElectronImageCodec
};
