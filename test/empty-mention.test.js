const test = require('node:test');
const assert = require('node:assert/strict');
const rendererUtils = require('../rendererUtils');

const references = [
    { id: 'a', name: '大张.jpg' },
    { id: 'b', name: '花石道.jpg' },
];

// 删图后提示词里的 @ 不消失，留一个「空 @」占位，等用户点它重新挑一张。
test('removing a reference turns its mentions into empty mentions', () => {
    const prompt = '@{大张} 放左上，@{花石道} 放右下，再看 @{大张}';
    const next = rendererUtils.promptWithReferenceRemoved(prompt, references, 'a');
    assert.equal(next, '@{} 放左上，@{花石道} 放右下，再看 @{}');
    assert.equal(rendererUtils.countEmptyReferenceMentions(next), 2);
});

test('empty mentions parse as their own segment and survive a round trip', () => {
    const segments = rendererUtils.promptSegments('看 @{} 和 @{花石道}', references);
    assert.deepEqual(segments.map(segment => segment.type), ['text', 'empty-reference', 'text', 'reference']);
    const empty = segments[1];
    assert.equal(empty.mention, rendererUtils.EMPTY_REFERENCE_MENTION);
    // 只拼 text 的旧序列化路径（别名重算、重排）也必须原样保留空 @。
    assert.equal(segments.map(segment => segment.type === 'reference' ? segment.mention : segment.text).join(''), '看 @{} 和 @{花石道}');
});

test('empty mentions never reach the model as literal braces', () => {
    const prompt = '@{} 放左上，@{花石道} 放右下';
    assert.equal(rendererUtils.resolvePromptMentions(prompt, references), ' 放左上，参考图2 放右下');
    assert.equal(rendererUtils.resolvePromptMentionsWithNames(prompt, references), ' 放左上，@{花石道} 放右下');
});

test('unknown names stay plain text and are not counted as empty mentions', () => {
    const prompt = '@{不存在的图} 和 @{ }';
    assert.equal(rendererUtils.countEmptyReferenceMentions(prompt), 1);
    assert.equal(rendererUtils.promptSegments(prompt, references)[0].type, 'text');
});
