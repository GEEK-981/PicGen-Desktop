const test = require('node:test');
const assert = require('node:assert/strict');

const profiles = require('../imageApiProfiles');

const valuesOf = profile => profile.imageSizeOptions.map(option => option.value);

test('新建序列的默认分辨率档位是 4K', () => {
    assert.equal(profiles.DEFAULT_IMAGE_SIZE, '4K');
});

test('首选档位被模型支持时原样使用', () => {
    const openai = profiles.getImageApiProfile('gpt-image-2.5-flare');
    assert.deepEqual(valuesOf(openai), ['1K', '2K', '4K', 'custom']);
    assert.equal(profiles.resolveImageSizePreference(profiles.DEFAULT_IMAGE_SIZE, openai.imageSizeOptions), '4K');
});

test('模型没有 4K 档时回落到它支持的最高档', () => {
    // Gemini 2.5 Flash Image 只有 1K。
    const flash25 = profiles.getImageApiProfile('gemini-2.5-flash-image');
    assert.deepEqual(valuesOf(flash25), ['1K']);
    assert.equal(profiles.resolveImageSizePreference('4K', flash25.imageSizeOptions), '1K');

    // Gemini 3.1 Flash Image 多一档 512，但 4K 依然选得出来。
    const flash31 = profiles.getImageApiProfile('gemini-3.1-flash-image-preview');
    assert.deepEqual(valuesOf(flash31), ['512', '1K', '2K', '4K']);
    assert.equal(profiles.resolveImageSizePreference('4K', flash31.imageSizeOptions), '4K');

    // grok-imagine 的档位是小写的 1k/2k，回落要保留它原本的写法。
    const xai = profiles.getImageApiProfile('grok-imagine-image-quality');
    assert.deepEqual(valuesOf(xai), ['1k', '2k']);
    assert.equal(profiles.resolveImageSizePreference('4K', xai.imageSizeOptions), '2k');
});

test('解析结果永远落在该模型的选项列表里', () => {
    // 提交时 imageSize 是原样发给上游的，解析出一个不存在的档位就是一次注定失败的请求。
    for (const model of [
        'gpt-image-2.5-flare',
        'gemini-2.5-flash-image',
        'gemini-3.1-flash-image-preview',
        'grok-imagine-image-quality',
        'grok4.5'
    ]) {
        const options = profiles.getImageApiProfile(model).imageSizeOptions;
        const resolved = profiles.resolveImageSizePreference(profiles.DEFAULT_IMAGE_SIZE, options);
        assert.ok(options.some(option => option.value === resolved), `${model} → ${resolved}`);
    }
});

test('选项为空时不返回任何档位', () => {
    assert.equal(profiles.resolveImageSizePreference('4K', []), '');
    assert.equal(profiles.resolveImageSizePreference('4K', undefined), '');
});

test('回落不会猜 custom，也不会猜具体尺寸', () => {
    const openai = profiles.getImageApiProfile('gpt-image-2.5-flare').imageSizeOptions;

    // 首选比所有真实档位都低：没有更低的档可退，退到首项，而不是 custom。
    assert.equal(profiles.resolveImageSizePreference('512', openai), '1K');
    // 但用户自己选的 custom 是精确命中，要原样保留。
    assert.equal(profiles.resolveImageSizePreference('custom', openai), 'custom');
});

test('排序不了的首选按默认档解析，而不是掉到最小档', () => {
    // 在 gpt-image 上选「自定义尺寸」、不动分辨率直接切到 gemini：序列里留着的还是
    // 'custom'，而 gemini 没有这一档。旧实现落到 values[0]，而 gemini-3.1 的 values[0]
    // 是 512，于是同一个操作把 1024² 的请求变成 512²。
    const flash31 = profiles.getImageApiProfile('gemini-3.1-flash-image-preview');
    assert.deepEqual(valuesOf(flash31), ['512', '1K', '2K', '4K']);
    assert.equal(profiles.resolveImageSizePreference('custom', flash31.imageSizeOptions), '4K');

    // 没有 custom 这一档的模型同理：按默认档，而不是掉到它唯一那项之外的东西。
    const flash25 = profiles.getImageApiProfile('gemini-2.5-flash-image');
    assert.deepEqual(valuesOf(flash25), ['1K']);
    assert.equal(profiles.resolveImageSizePreference('custom', flash25.imageSizeOptions), '1K');

    // 具体像素尺寸（rank 也是 -1）一律按默认档，而不是首项。
    const openai = profiles.getImageApiProfile('gpt-image-2.5-flare').imageSizeOptions;
    assert.equal(profiles.resolveImageSizePreference('2048x2048', openai), '4K');
    assert.equal(profiles.resolveImageSizePreference('', openai), '4K');

    // 能被排序的首选仍然走"不高于它"的老规则，不受影响。
    assert.equal(profiles.resolveImageSizePreference('2K', openai), '2K');
    assert.equal(profiles.resolveImageSizePreference('1K', openai), '1K');
});
