const test = require('node:test');
const assert = require('node:assert/strict');

const search = require('../historySearch');

const image = {
    fileName: 'PicGen_20260930_neon.png',
    prompt: '雨夜的霓虹街道，赛博朋克风格，Cinematic lighting',
    model: 'gpt-image-2',
    ratio: '16:9',
    width: 1536,
    height: 864
};
const fieldsOf = record => [record.fileName, record.prompt, record.model, record.ratio, `${record.width}x${record.height}`];
const hit = (query, record = image) => search.matches(fieldsOf(record), search.parseQuery(query));

test('an empty or blank query matches everything and reports itself empty', () => {
    for (const query of ['', '   ', '\t', null, undefined, '-', '""']) {
        const parsed = search.parseQuery(query);
        assert.equal(search.isEmptyQuery(parsed), true, JSON.stringify(query));
        assert.equal(search.matches(fieldsOf(image), parsed), true);
    }
});

test('a single word is a case-insensitive substring of any field', () => {
    assert.equal(hit('霓虹'), true);
    assert.equal(hit('CINEMATIC'), true);
    assert.equal(hit('neon'), true, 'file name');
    assert.equal(hit('GPT-Image'), true, 'model');
    assert.equal(hit('水墨'), false);
});

test('space-separated words must all match, in any order and across fields', () => {
    assert.equal(hit('赛博朋克 雨夜'), true);
    assert.equal(hit('雨夜 gpt-image-2'), true, 'prompt word + model');
    assert.equal(hit('雨夜 水墨'), false);
    assert.equal(hit('  雨夜    霓虹  '), true, 'extra spaces are ignored');
});

test('ratio and dimensions are searchable, full-width input is normalised', () => {
    assert.equal(hit('16:9'), true);
    assert.equal(hit('１６：９'), true, 'full-width digits and colon');
    assert.equal(hit('1536x864'), true);
    assert.equal(hit('1536×864'), true, 'multiplication sign');
    assert.equal(hit('9:16'), false);
    assert.equal(hit('ＮＥＯＮ'), true, 'full-width letters');
});

test('a quoted phrase must appear as written; unquoted words may be apart', () => {
    assert.equal(hit('"cinematic lighting"'), true);
    assert.equal(hit('"lighting cinematic"'), false);
    assert.equal(hit('lighting cinematic'), true);
    assert.equal(hit('“霓虹街道”'), true, 'Chinese curly quotes');
    assert.equal(hit('"雨夜 霓虹"'), false, 'the phrase is not in the text');
    const spaced = { ...image, prompt: 'paper  cranes\non linen' };
    assert.equal(hit('"paper cranes on"', spaced), true, 'runs of spaces and newlines count as one space');
});

test('a leading minus excludes a word or a quoted phrase', () => {
    assert.equal(hit('雨夜 -水墨'), true);
    assert.equal(hit('雨夜 -赛博朋克'), false);
    assert.equal(hit('-"cinematic lighting"'), false);
    assert.equal(hit('-gpt-image-2'), false, 'only the leading minus is an operator');
    assert.equal(hit('gpt-image'), true, 'an inner minus is literal');
    assert.equal(hit('－水墨'), true, 'full-width minus excludes too');
});

test('words never match across the boundary between two fields', () => {
    // "lighting" ends the prompt and "gpt" starts the model: no single field holds "lightinggpt".
    assert.equal(hit('lightinggpt'), false);
    assert.equal(hit('lighting gpt'), true);
});

test('missing fields are tolerated', () => {
    const bare = { fileName: 'x.png' };
    assert.equal(search.matches([bare.fileName, bare.prompt, undefined, null], search.parseQuery('x.png')), true);
    assert.equal(search.matches([undefined, null], search.parseQuery('x')), false);
});

test('parseQuery exposes the parsed words for display', () => {
    assert.deepEqual(search.parseQuery('雨夜 "neon city" -水墨 -"low quality"'), {
        include: ['雨夜', 'neon city'],
        exclude: ['水墨', 'low quality']
    });
});
