const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const rendererUtils = require('../rendererUtils');
const { optimizePrompt, reversePrompt, DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT } = require('../apiService');

const ROOT = path.resolve(__dirname, '..');

// 优化器必须知道每张参考图叫什么，否则它只会编出「@第一张参考图文件名」这种占位符。
// 生图路径靠顺序（「参考图N」），优化路径靠名字（「@名称」）—— 两套解析必须并存。
test('mention resolution keeps names for the optimizer and ordinals for generation', () => {
    const references = [
        { name: '大张.jpg', mimeType: 'image/jpeg' },
        { name: '花石道.jpg', mimeType: 'image/jpeg' },
    ];
    const prompt = '@{大张} 放左上，@{花石道} 放右下';

    // 生图：与图片顺序绑定，维持既有契约（test/user-experience.test.js 也依赖它）。
    assert.equal(rendererUtils.resolvePromptMentions(prompt, references), '参考图1 放左上，参考图2 放右下');
    // 优化：保留真实名字，写成编辑器认得的 @{名称} 形式，粘回去就能变回参考图 token。
    assert.equal(rendererUtils.resolvePromptMentionsWithNames(prompt, references), '@{大张} 放左上，@{花石道} 放右下');
});

test('optimizer keeps real reference names instead of inventing placeholders', async t => {
    const captured = [];
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            captured.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '优化后的提示词' } }] }));
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => upstream.close());

    const names = ['大张', '花石道'];
    await optimizePrompt({
        provider: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: 'mock-key',
        model: 'gpt-4o',
        prompt: '@{大张} 放左上，@{花石道} 放右下',
        referenceImages: [{ base64: 'AAAA', mimeType: 'image/png' }, { base64: 'BBBB', mimeType: 'image/png' }],
        referenceImageCount: 2,
        referenceNames: names,
    });

    const content = captured[0].messages[1].content;
    const labels = content.filter(part => part.type === 'text').map(part => part.text);
    const images = content.filter(part => part.type === 'image_url');

    // 每张图前都要有名字标签，模型才能把 @名称 对上具体的图。
    assert.equal(images.length, 2, 'optimizer did not send both reference images');
    assert.ok(labels.some(text => text.includes('大张')), 'reference name 大张 never reached the model');
    assert.ok(labels.some(text => text.includes('花石道')), 'reference name 花石道 never reached the model');
    // 标签必须紧挨着对应的图：不能把两个名字堆在一处、图片另放。
    const order = content.map(part => part.type === 'text' ? `text:${part.text}` : 'image');
    assert.match(order.join(' | '), /大张[\s\S]*image[\s\S]*花石道[\s\S]*image/,
        'reference name labels are not attached to their images');
});

test('the system prompt demands @{name} citations and forbids placeholders', () => {
    // 必须是花括号形式 —— 编辑器只把 @{名称} 解析成参考图 token，裸 @大张 只是普通文字。
    assert.match(DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT, /@\{名称\}/, 'system prompt does not require @{name} citation');
    assert.match(DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT, /第一张参考图文件名/, 'system prompt does not forbid the placeholder wording');
    assert.match(DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT, /【参考图 N：名称】/, 'system prompt does not explain the name label it will receive');
    // 结构化输出要求：六要素按序出现。
    assert.match(DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT, /主体与用途[\s\S]*构图与主体位置[\s\S]*光线与色彩[\s\S]*材质[\s\S]*关键细节[\s\S]*排除项/,
        'system prompt lost its structured-output outline');
});

// 提示词里要的 @{名称} 必须真能被解析回参考图 —— 文案与解析器不能各说各话。
test('the cited @{name} form actually binds back to a reference image', () => {
    const references = [{ name: '大张.jpg', alias: '大张' }, { name: '花石道.jpg', alias: '花石道' }];
    const segments = rendererUtils.promptSegments('@{大张} 放左上，@{花石道} 放右下', references);
    assert.equal(segments.filter(s => s.type === 'reference').length, 2,
        'the @{name} form the system prompt asks for does not resolve to reference images');
    // 裸 @名称 不是合法引用，别让提示词把模型引到这条死路上。
    assert.equal(rendererUtils.promptSegments('@大张 放左上', references).filter(s => s.type === 'reference').length, 0,
        'bare @name unexpectedly resolves; system prompt wording would be misleading');
});

// 反推和优化曾经共用一套「名字含 deepseek 就判死」的猜测。DeepSeek V4.1 能读图了，
// 这类按名字的硬拒必须消失 —— 否则用户选了它，反推直接被本地拦下、根本没发出去。
test('a deepseek-named model is no longer hard-rejected before the request', async t => {
    const captured = [];
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            captured.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '反推结果' } }] }));
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => upstream.close());

    const result = await reversePrompt({
        provider: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: 'mock-key',
        model: 'deepseek-v4-flash',
        referenceImages: [{ base64: 'aGVsbG8=', mimeType: 'image/png' }],
    });

    assert.equal(result.text, '反推结果', 'reverse prompt was blocked locally instead of reaching the model');
    const content = captured[0].messages[1].content;
    assert.ok(Array.isArray(content) && content.some(part => part.type === 'image_url'),
        'reverse prompt did not actually send the image');
});

// 用户在设置里点过保存后，那段文本就进了 localStorage 并长期盖住新的默认值 ——
// 于是「升级了默认提示词」对这些人完全不起作用。存的是旧默认时必须当没存过。
test('a saved copy of an older default prompt is migrated, a custom one is kept', () => {
    const source = fs.readFileSync(path.join(ROOT, 'desktop.js'), 'utf8');
    const grab = marker => {
        const start = source.indexOf(marker);
        assert.ok(start >= 0, `desktop.js no longer defines ${marker}`);
        return start;
    };
    const listStart = grab('const LEGACY_PROMPT_OPTIMIZER_SYSTEM_PROMPTS = [');
    const listEnd = source.indexOf('].map(text => text.trim());', listStart);
    const listLiteral = source.slice(
        listStart + 'const LEGACY_PROMPT_OPTIMIZER_SYSTEM_PROMPTS = '.length,
        listEnd + 1
    );
    const legacy = eval(listLiteral).map(text => text.trim());
    assert.ok(legacy.length > 0, 'legacy prompt list is empty; old saved defaults would never migrate');

    // 迁移判定本身：把 desktop.js 里的纯函数抽出来跑，不依赖 DOM/localStorage。
    const fnStart = grab('function isLegacyPromptOptimizerSystemPrompt(text)');
    const fnEnd = source.indexOf('\n}', fnStart) + 2;
    const isLegacy = new Function(
        `const LEGACY_PROMPT_OPTIMIZER_SYSTEM_PROMPTS = ${JSON.stringify(legacy)};`
        + source.slice(fnStart, fnEnd)
        + '; return isLegacyPromptOptimizerSystemPrompt;'
    )();

    assert.equal(isLegacy(legacy[0]), true, 'the previously shipped default is not recognised as stock');
    assert.equal(isLegacy(`  ${legacy[0]}  `), true, 'surrounding whitespace should not defeat the match');
    assert.equal(isLegacy('我自己写的优化规则：先把主体写清楚。'), false, 'a custom prompt would be wiped by the migration');
    assert.equal(isLegacy(''), false, 'empty input should fall through to the built-in default');
    // 当前默认值若同时被列成「旧默认」，用户一保存就会被重置 —— 这不是我们想要的语义。
    assert.equal(isLegacy(DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT), false,
        'the current default is listed as legacy; saving it would silently reset');
});

test('the optimizer receives the configured aspect ratio and is told it wins conflicts', async t => {
    const captured = [];
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            captured.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '优化后的提示词' } }] }));
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => upstream.close());
    const base = {
        provider: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: 'mock-key', model: 'gpt-4o',
        prompt: '一张海报，画幅 3:4',
    };

    await optimizePrompt({ ...base, ratio: '1:1（方形比例）' });
    const withRatio = captured[0].messages[1].content;
    const text = Array.isArray(withRatio) ? withRatio.find(p => p.type === 'text').text : withRatio;
    assert.ok(text.includes('1:1（方形比例）'), 'the configured ratio never reached the optimizer');
    assert.ok(text.includes('冲突'), 'the optimizer was not told how to resolve a conflicting ratio');
    // 系统提示词里也要有这条硬约束，不能只在某一次请求的正文里出现。
    assert.match(DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT, /画幅比例参数/,
        'system prompt does not mention the aspect-ratio parameter');
    assert.match(DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT, /必须以该参数为准/,
        'system prompt does not make the parameter authoritative over conflicting wording');

    captured.length = 0;
    await optimizePrompt(base);
    const bare = captured[0].messages[1].content;
    const bareText = Array.isArray(bare) ? bare.find(p => p.type === 'text').text : bare;
    assert.equal(bareText, '一张海报，画幅 3:4',
        'an empty ratio should not append a spurious parameter note');
});

// 比例说明要和界面上显示的一致（方形／横向／竖向），否则模型按错误朝向改写。
test('ratio values are described with the same orientation wording the UI uses', () => {
    const source = fs.readFileSync(path.join(ROOT, 'desktop.js'), 'utf8');
    const extract = name => {
        const start = source.indexOf(`function ${name}`);
        assert.ok(start >= 0, `desktop.js no longer defines ${name}`);
        return source.slice(start, source.indexOf('\n}', start) + 2);
    };
    const describe = new Function(
        `${extract('getRatioVisualMetrics')}\n${extract('getRatioOrientationDescription')}\n${extract('describeSequenceRatio')}`
        + '; return describeSequenceRatio;'
    )();
    assert.equal(describe('1:1'), '1:1（方形比例）');
    assert.equal(describe('3:4'), '3:4（竖向比例）');
    assert.equal(describe('16:9'), '16:9（横向比例）');
    assert.match(describe('reference'), /贴合参考图比例/);
    assert.equal(describe(''), '', 'no ratio configured should stay silent');
});

// desktop.js 与 apiService.js 各存了一份同样的默认提示词（前者灌进设置里的文本框、
// 后者是服务端兜底）。两份分叉过就会「界面上看到的」和「实际生效的」不是一回事。
test('both copies of the default system prompt stay identical', () => {
    const grab = file => {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const start = source.indexOf('const DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT = [');
        assert.ok(start >= 0, `${file} no longer defines DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT`);
        return source.slice(start, source.indexOf('].join', start));
    };
    assert.equal(grab('desktop.js'), grab('apiService.js'),
        'desktop.js and apiService.js default optimizer prompts have drifted apart');
});
