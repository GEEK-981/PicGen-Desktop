const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { appendGlobalPrompt } = require('../rendererUtils');

const ROOT = path.resolve(__dirname, '..');

test('global prompt is appended only when enabled and non-empty', () => {
    assert.equal(appendGlobalPrompt('一只猫', '无水印', true), '一只猫\n\n无水印');
    assert.equal(appendGlobalPrompt('一只猫', '无水印', false), '一只猫');
    assert.equal(appendGlobalPrompt('一只猫', '   ', true), '一只猫');
    assert.equal(appendGlobalPrompt('  一只猫  ', '  无水印 ', true), '一只猫\n\n无水印');
});

test('global prompt never turns an empty prompt into a task or duplicates itself', () => {
    assert.equal(appendGlobalPrompt('', '无水印', true), '');
    assert.equal(appendGlobalPrompt('一只猫\n\n无水印', '无水印', true), '一只猫\n\n无水印');
    assert.equal(appendGlobalPrompt('无水印', '无水印', true), '无水印');
});

test('generation submits the prompt with the global prompt appended', () => {
    const source = fs.readFileSync(path.join(ROOT, 'desktop.js'), 'utf8');
    const body = source.slice(source.indexOf('async function generateImages()'));
    assert.match(body.slice(0, 1500), /const prompt = appendGlobalPrompt\(resolvePromptMentions/);
    assert.match(source, /append\(prompt, state\.globalPromptText, state\.globalPromptEnabled\)/);
    const markup = fs.readFileSync(path.join(ROOT, 'frontend/pages/GenerationWorkspace.jsx'), 'utf8');
    assert.ok(markup.indexOf('globalPromptHost') < markup.indexOf('optimizePromptBtn'), 'switch sits next to 优化');
});
