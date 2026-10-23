const test = require('node:test');
const assert = require('node:assert/strict');

const profiles = require('../imageApiProfiles');
const settings = require('../generationSettings');

test('openai settings use the field names the API layer reads', () => {
    const config = settings.buildGenerationConfig({
        model: 'gpt-image-1',
        advanced: { openAIModeration: 'low', nativeResponseFormat: 'b64_json', apiUser: 'u1', gptQuality: 'high', gptImageWidth: '1024' }
    }, profiles);
    assert.equal(config.moderation, 'low');
    assert.equal(config.responseFormat, 'b64_json');
    assert.equal(config.user, 'u1');
    assert.equal(config.gptQuality, 'high');
    assert.equal(config.gptImageWidth, 1024, 'numbers are parsed, not passed as strings');
    assert.equal('openAIModeration' in config, false);
});

test('gemini settings get their defaults and skip openai-only fields', () => {
    const config = settings.buildGenerationConfig({ model: 'gemini-3-pro-image-preview', advanced: { gptQuality: 'high', temperature: '0.4' } }, profiles);
    assert.equal(config.responseModalities, 'TEXT_IMAGE');
    assert.equal(config.temperature, 0.4);
    assert.equal('gptQuality' in config, false);
});

test('advanced defaults accept the API-style aliases an agent may send', () => {
    const advanced = settings.createDefaultAdvancedSettings({ moderation: 'low', style: 'vivid' });
    assert.equal(advanced.openAIModeration, 'low');
    assert.equal(advanced.openAIStyle, 'vivid');
    assert.equal(advanced.gptQuality, 'auto');
});

test('the size tier is narrowed to what the model offers', () => {
    assert.equal(settings.resolveImageSize('gemini-2.5-flash-image', '4K', profiles), '1K');
    assert.equal(settings.resolveImageSize('gemini-3-pro-image-preview', '', profiles), profiles.resolveImageSizePreference(profiles.DEFAULT_IMAGE_SIZE, profiles.getImageApiProfile('gemini-3-pro-image-preview').imageSizeOptions));
});
