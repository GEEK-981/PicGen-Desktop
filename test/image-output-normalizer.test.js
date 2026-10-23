const test = require('node:test');
const assert = require('node:assert/strict');

const {
    requestedImage2OutputSize,
    normalizeImage2ResultDimensions
} = require('../imageOutputNormalizer');

test('resolves the requested GPT Image 2 output dimensions', () => {
    assert.deepEqual(requestedImage2OutputSize({
        model: 'gpt-image-2',
        ratio: '1:1',
        imageSize: '2K'
    }), { width: 2048, height: 2048 });
    assert.deepEqual(requestedImage2OutputSize({
        model: 'gpt-image-2',
        ratio: '16:9',
        imageSize: '4K'
    }), { width: 3840, height: 2160 });
    assert.equal(requestedImage2OutputSize({
        model: 'gemini-3.1-flash-image',
        ratio: '1:1',
        imageSize: '2K'
    }), null);
});

test('normalizes a provider GPT Image 2 result to the requested pixel dimensions', async () => {
    const resizeCalls = [];
    const result = await normalizeImage2ResultDimensions({
        model: 'gpt-image-2',
        ratio: '1:1',
        imageSize: '2K'
    }, {
        base64: Buffer.from('provider-image').toString('base64'),
        mimeType: 'image/png'
    }, {
        getSize: () => ({ width: 1254, height: 1254 }),
        resize: (_buffer, options) => {
            resizeCalls.push(options);
            return { buffer: Buffer.from('normalized-image'), mimeType: 'image/png' };
        }
    });

    assert.deepEqual(resizeCalls, [{
        width: 2048,
        height: 2048,
        mimeType: 'image/png',
        quality: 95
    }]);
    assert.equal(result.width, 2048);
    assert.equal(result.height, 2048);
    assert.equal(result.sourceWidth, 1254);
    assert.equal(result.sourceHeight, 1254);
    assert.equal(result.dimensionAdjusted, true);
    assert.equal(Buffer.from(result.base64, 'base64').toString(), 'normalized-image');
});

test('does not re-encode an already correct GPT Image 2 result', async () => {
    let resized = false;
    const result = await normalizeImage2ResultDimensions({
        model: 'gpt-image-2',
        ratio: '1:1',
        imageSize: '2K'
    }, {
        base64: Buffer.from('provider-image').toString('base64'),
        mimeType: 'image/png'
    }, {
        getSize: () => ({ width: 2048, height: 2048 }),
        resize: () => { resized = true; }
    });

    assert.equal(resized, false);
    assert.equal(result.dimensionAdjusted, false);
    assert.equal(result.width, 2048);
    assert.equal(result.height, 2048);
});
