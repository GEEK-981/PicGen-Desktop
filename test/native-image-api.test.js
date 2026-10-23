const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fetch = require('node-fetch');

const profiles = require('../imageApiProfiles');
const { generateImage, _test } = require('../apiService');
const grsaiGptImage = require('../imageAdapters/grsaiGptImage');
const { startServer } = require('../server');

test('routes configured image models by model name', () => {
    assert.equal(profiles.imageApiKind('gpt-image-2'), 'openai');
    assert.equal(profiles.imageApiKind('dall-e-3'), 'openai');
    assert.equal(profiles.imageApiKind('gemini-3.1-flash-image-preview'), 'gemini');
    assert.equal(profiles.imageApiKind('nano-banana-pro'), 'gemini');
    assert.equal(profiles.imageApiKind('grok4.5'), 'xai');
    assert.equal(profiles.imageApiKind('grok-imagine-image-quality'), 'xai');
    assert.equal(profiles.isXAIImagineNativeModel('grok-imagine-image'), true);
    assert.equal(profiles.isXAIImagineNativeModel('xai/grok-imagine-image-2.0'), true);
    assert.equal(profiles.isXAIImagineNativeModel('grok-imagine-image-quality'), false);
});

test('supports GPT Image 2.5 Sunburst and Flare as distinct OpenAI Image families', () => {
    for (const model of ['gpt-image-2.5', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'openai/gpt-image-2.5-flare']) {
        assert.equal(profiles.imageApiKind(model), 'openai', model);
        assert.equal(profiles.isOpenAIImage25Model(model), true, model);
        assert.equal(profiles.isOpenAIImage2Model(model), false, model);
        const profile = profiles.getImageApiProfile(model);
        assert.equal(profile.dimensionLabel, '比例');
        assert.deepEqual(profile.imageSizeOptions.map(option => option.value), ['1K', '2K', '4K', 'custom']);
        assert.deepEqual(profile.qualityOptions.map(option => option.value), ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
        assert.deepEqual(profile.backgroundOptions.map(option => option.value), ['auto', 'opaque', 'transparent']);
        assert.equal(profile.controls.customSize, true);
        assert.equal(profile.maxReferences, 16);
    }
});

test('builds GPT Image 2.5 generation and edit parameters', () => {
    const request = _test.buildOpenAIImageRequest({
        model: 'gpt-image-2.5-sunburst',
        prompt: 'test',
        size: '1536x1024',
        hasReferences: true,
        generationConfig: {
            n: 3,
            gptQuality: 'xhigh',
            gptBackground: 'transparent',
            outputMimeType: 'image/webp',
            imageCompression: 70,
            moderation: 'low'
        }
    });
    assert.equal(request.model, 'gpt-image-2.5-sunburst');
    assert.equal(request.n, 3);
    assert.equal(request.quality, 'xhigh');
    assert.equal(request.background, 'transparent');
    assert.equal(request.output_format, 'webp');
    assert.equal(request.output_compression, 70);
    assert.equal(request.moderation, 'low');
});

test('builds Grsai GPT Image 2.5 request using vendor fields', () => {
    const request = _test.buildGrsaiGptImageRequest({
        provider: 'https://grsaiapi.com',
        model: 'gpt-image-2.5-flare',
        prompt: 'wide scene',
        ratio: '16:9',
        imageSize: '2K',
        referenceImages: [{ base64: 'aGVsbG8=', mimeType: 'image/png' }],
        generationConfig: { gptQuality: 'max', grsaiReplyType: 'async' },
        resolveSize: _test.resolveOpenAIImageSize
    });
    assert.equal(request.url, 'https://grsaiapi.com/v1/api/generate');
    assert.deepEqual(request.body, {
        model: 'gpt-image-2.5-flare',
        prompt: 'wide scene',
        images: ['data:image/png;base64,aGVsbG8='],
        aspectRatio: '2048x1152',
        quality: 'max',
        replyType: 'async'
    });
});

test('sends the Grsai background field only when transparency was requested', () => {
    // Grsai accepts the field only as `transparent`, and only on the VIP / 2.5 Flare /
    // 2.5 Sunburst models. The UI default is `auto`, which Grsai rejects outright, so
    // anything other than `transparent` has to be dropped rather than forwarded.
    for (const model of ['gpt-image-2-vip', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'openai/gpt-image-2.5-sunburst']) {
        const request = _test.buildGrsaiGptImageRequest({
            provider: 'https://grsaiapi.com',
            model,
            prompt: 'cutout',
            ratio: '1:1',
            imageSize: '1K',
            generationConfig: { gptQuality: 'medium', gptBackground: 'transparent' },
            resolveSize: _test.resolveOpenAIImageSize
        });
        assert.equal(request.body.background, 'transparent', model);
    }
    for (const gptBackground of [undefined, '', 'auto', 'opaque']) {
        const request = _test.buildGrsaiGptImageRequest({
            provider: 'https://grsaiapi.com',
            model: 'gpt-image-2.5-flare',
            prompt: 'wide scene',
            ratio: '16:9',
            imageSize: '2K',
            generationConfig: { gptQuality: 'max', gptBackground },
            resolveSize: _test.resolveOpenAIImageSize
        });
        assert.equal('background' in request.body, false, `gptBackground=${gptBackground}`);
    }
});

test('rejects Grsai background values the vendor endpoint cannot accept', () => {
    const build = (model, gptBackground) => _test.buildGrsaiGptImageRequest({
        provider: 'https://grsaiapi.com',
        model,
        prompt: 'cutout',
        ratio: '1:1',
        imageSize: '1K',
        generationConfig: { gptBackground },
        resolveSize: _test.resolveOpenAIImageSize
    });
    // `gpt-image-2` and plain `gpt-image-2.5` are Grsai-served but outside the
    // transparency whitelist — the UI still offers the option, so the adapter guards it.
    assert.equal(grsaiGptImage.supportsTransparentBackground('gpt-image-2'), false);
    assert.equal(grsaiGptImage.supportsTransparentBackground('gpt-image-2.5'), false);
    assert.throws(() => build('gpt-image-2', 'transparent'), /不支持透明背景/);
    assert.throws(() => build('gpt-image-2.5', 'transparent'), /不支持透明背景/);
    assert.throws(() => build('gpt-image-2.5-flare', 'chalkboard'), /背景参数不支持/);
});

test('routes Grsai GPT Image 2.5 through /v1/api/generate', async () => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        requests.push({ url: req.url, body: JSON.parse(await new Promise(resolve => { let s = ''; req.on('data', c => s += c); req.on('end', () => resolve(s)); })) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'fixture', status: 'succeeded', results: [{ url: 'data:image/png;base64,ZmFrZQ==' }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        const result = await generateImage({
            provider: `http://127.0.0.1:${address.port}/grsai`,
            apiKey: 'fixture-key',
            model: 'gpt-image-2.5-sunburst',
            prompt: 'fixture',
            ratio: '16:9',
            imageSize: '1K',
            protocol: 'auto'
        });
        assert.equal(result.base64, 'ZmFrZQ==');
        assert.equal(requests[0].url, '/grsai/v1/api/generate');
        assert.equal(requests[0].body.aspectRatio, '1280x720');
        assert.equal(requests[0].body.replyType, 'json');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('does not mistake gpt-image-mini for a Gemini model', () => {
    // 归一化后是 gptimagemini，尾部含 "gemini" 子串，曾被误判成 Gemini 模型，
    // 导致比例下拉框、1K/2K/4K 和 gemini-native 协议全部用错。
    for (const model of ['gpt-image-mini', 'gptimagemini', 'GPT Image Mini', 'gpt-image-1-mini']) {
        assert.equal(profiles.imageApiKind(model), 'openai', model);
        assert.equal(profiles.isGeminiImageModel(model), false, model);
        assert.equal(profiles.getImageApiProfile(model).dimensionLabel, '尺寸', model);
    }

    assert.equal(profiles.isGeminiImageModel('gemini-3.1-flash-image'), true);
    assert.equal(profiles.isGeminiImageModel('nano-banana-pro'), true);
});

test('does not let the image-2 suffix steal other vendors', () => {
    // 归一化后 gemini-3-flash-image-2 -> gemini3flashimage2 尾部含 "image2"，
    // 曾被 isOpenAIGptImageModel 认成 GPT Image 2。而 protocolRouter 直接调
    // isGeminiImageModel，于是协议按 Gemini 选、请求体按 OpenAI 构造，两边撕裂。
    for (const model of ['gemini-3-flash-image-2', 'gemini-2.5-flash-image-2', 'nano-banana-image-2']) {
        assert.equal(profiles.imageApiKind(model), 'gemini', model);
        assert.equal(profiles.isOpenAIImageModel(model), false, model);
    }

    assert.equal(profiles.imageApiKind('grok-image-2'), 'xai');
    assert.equal(profiles.isOpenAIImageModel('grok-image-2'), false);

    // 未知厂商的裸写法仍应由 image-2 后缀兜底接管。
    for (const model of ['gpt-image-2', 'image-2', 'image2', 'openai/gpt-image-2', 'gpt-image-2-preview']) {
        assert.equal(profiles.imageApiKind(model), 'openai', model);
        assert.equal(profiles.isOpenAIImage2Model(model), true, model);
    }
});

test('strips gateway namespace prefixes before vendor detection', () => {
    // OpenRouter / Azure / Vertex 用 vendor/model 形式。归一化后
    // google/gemini-3-flash-image-2 -> google/gemini3flashimage2 并不以 "gemini"
    // 开头，belongsToOtherVendor 的 startsWith 守卫不触发，于是 image-2 后缀
    // 又把它抢成 OpenAI —— imageApiKind 说 openai，isGeminiImageModel 说 true。
    const namespaced = {
        'google/gemini-3-flash-image-2': 'gemini',
        'openrouter/google/gemini-3-flash-image-2': 'gemini',
        'vertex/gemini-2.5-flash-image-2': 'gemini',
        'models/gemini-2.5-flash-image': 'gemini',
        'xai/grok-image-2': 'xai',
        'providers/xai/grok-image-2': 'xai',
        'azure/gpt-image-2': 'openai',
        'openai/gpt-image-2': 'openai'
    };

    for (const [model, kind] of Object.entries(namespaced)) {
        assert.equal(profiles.imageApiKind(model), kind, model);
        const claims = [
            profiles.isGeminiImageModel(model),
            profiles.isXAIImageModel(model),
            profiles.isOpenAIImageModel(model)
        ].filter(Boolean);
        assert.equal(claims.length, 1, `${model} claimed by ${claims.length} vendors`);
    }

    // 带前缀与裸写法必须归一到同一结果。
    for (const bare of ['gemini-3-flash-image-2', 'grok-image-2', 'gpt-image-2']) {
        assert.equal(profiles.imageApiKind(`openrouter/${bare}`), profiles.imageApiKind(bare), bare);
    }
});

test('vendor detection stays mutually exclusive', () => {
    const models = [
        'gpt-image-2', 'gpt-image-mini', 'dall-e-3', 'image-2',
        'gemini-3.1-flash-image', 'gemini-3-flash-image-2', 'nano-banana-2',
        'grok-2-image', 'grok-image-2'
    ];
    for (const model of models) {
        const matches = [
            profiles.isOpenAIImageModel(model),
            profiles.isGeminiImageModel(model),
            profiles.isXAIImageModel(model)
        ].filter(Boolean);
        assert.equal(matches.length, 1, `${model} 命中了 ${matches.length} 个厂商判定`);
    }
});

test('exposes the documented model-specific dimensions', () => {
    const gemini = profiles.getImageApiProfile('gemini-3.1-flash-image-preview');
    const grok = profiles.getImageApiProfile('grok-imagine-image-quality');
    const image2 = profiles.getImageApiProfile('gpt-image-2');
    const dalle3 = profiles.getImageApiProfile('dall-e-3');

    assert.deepEqual(gemini.dimensionOptions.map(option => option.value), profiles.GEMINI_FULL_RATIOS);
    assert.deepEqual(gemini.imageSizeOptions.map(option => option.value), ['512', '1K', '2K', '4K']);
    assert.deepEqual(grok.dimensionOptions.map(option => option.value), profiles.XAI_RATIOS);
    assert.deepEqual(grok.imageSizeOptions.map(option => option.value), ['1k', '2k']);
    assert.equal(grok.controls.responseFormat, false);
    const grok2 = profiles.getImageApiProfile('grok-imagine-image-2.0');
    assert.equal(grok2.controls.quality, true);
    assert.equal(grok2.controls.responseFormat, true);
    assert.deepEqual(grok2.qualityOptions.map(option => option.value), ['medium', 'low']);
    assert.ok(profiles.XAI_RATIOS.includes('21:9'));
    assert.ok(profiles.XAI_RATIOS.includes('5:2'));
    assert.equal(image2.dimensionLabel, '比例');
    assert.deepEqual(image2.dimensionOptions.map(option => option.value), profiles.OPENAI_IMAGE2_RATIOS);
    assert.deepEqual(image2.countOptions.map(option => option.value), ['1', '2', '3', '4', '5']);
    assert.deepEqual(image2.imageSizeOptions.map(option => option.value), ['1K', '2K', '4K', 'custom']);
    assert.deepEqual(dalle3.dimensionOptions.map(option => option.value), ['1024x1024', '1792x1024', '1024x1792']);
});

test('maps every GPT Image 2 ratio and resolution to a valid API size', () => {
    const expected = {
        '1K': {
            '1:1': '1024x1024',
            '1:2': '768x1536',
            '2:1': '1536x768',
            '2:3': '1024x1536',
            '3:2': '1536x1024',
            '3:4': '960x1280',
            '4:3': '1280x960',
            '4:5': '1024x1280',
            '5:4': '1280x1024',
            '9:16': '720x1280',
            '16:9': '1280x720',
            '21:9': '1344x576'
        },
        '2K': {
            '1:1': '2048x2048',
            '1:2': '1024x2048',
            '2:1': '2048x1024',
            '2:3': '1344x2016',
            '3:2': '2016x1344',
            '3:4': '1536x2048',
            '4:3': '2048x1536',
            '4:5': '1632x2048',
            '5:4': '2048x1632',
            '9:16': '1152x2048',
            '16:9': '2048x1152',
            '21:9': '2048x880'
        },
        '4K': {
            '1:1': '2880x2880',
            '1:2': '1920x3840',
            '2:1': '3840x1920',
            '2:3': '2336x3504',
            '3:2': '3504x2336',
            '3:4': '2480x3312',
            '4:3': '3312x2480',
            '4:5': '2560x3200',
            '5:4': '3200x2560',
            '9:16': '2160x3840',
            '16:9': '3840x2160',
            '21:9': '3840x1648'
        }
    };

    for (const [resolution, ratios] of Object.entries(expected)) {
        for (const [ratio, size] of Object.entries(ratios)) {
            assert.equal(_test.resolveOpenAIImageSize(ratio, 'gpt-image-2', {}, resolution), size);
            const [width, height] = size.split('x').map(Number);
            const pixels = width * height;
            assert.ok(width <= 3840 && height <= 3840, `${resolution} ${ratio}: maximum edge`);
            assert.equal(width % 16, 0, `${resolution} ${ratio}: width multiple`);
            assert.equal(height % 16, 0, `${resolution} ${ratio}: height multiple`);
            assert.ok(pixels >= 655360 && pixels <= 8294400, `${resolution} ${ratio}: pixel count`);
            assert.ok(Math.max(width, height) / Math.min(width, height) <= 3, `${resolution} ${ratio}: aspect limit`);
        }
    }
});

test('maps GPT Image 2.5 ratios and validates custom dimensions', () => {
    assert.equal(_test.resolveOpenAIImageSize('16:9', 'gpt-image-2.5-flare', {}, '4K'), '3840x2160');
    assert.equal(_test.resolveOpenAIImageSize('custom', 'gpt-image-2.5-sunburst', { gptImageWidth: 1600, gptImageHeight: 1200 }, 'custom'), '1600x1200');
    assert.throws(
        () => _test.resolveOpenAIImageSize('custom', 'gpt-image-2.5-sunburst', { gptImageWidth: 1601, gptImageHeight: 1200 }, 'custom'),
        /16 的倍数/
    );
});

test('migrates legacy GPT Image 2 sizes and preserves custom dimensions', () => {
    const legacy = {
        '1024x1024': { ratio: '1:1', resolution: '1K' },
        '1536x1024': { ratio: '3:2', resolution: '1K' },
        '1024x1536': { ratio: '2:3', resolution: '1K' },
        '2048x2048': { ratio: '1:1', resolution: '2K' },
        '2048x1152': { ratio: '16:9', resolution: '2K' },
        '1152x2048': { ratio: '9:16', resolution: '2K' },
        '3840x2160': { ratio: '16:9', resolution: '4K' },
        '2160x3840': { ratio: '9:16', resolution: '4K' }
    };

    for (const [size, selection] of Object.entries(legacy)) {
        assert.deepEqual(profiles.openAIImage2SelectionFromLegacySize(size), selection);
    }
    assert.equal(
        _test.resolveOpenAIImageSize('1:1', 'gpt-image-2', { gptImageWidth: '1600', gptImageHeight: '1200' }, 'custom'),
        '1600x1200'
    );
    assert.throws(
        () => _test.resolveOpenAIImageSize('1:1', 'gpt-image-2', { gptImageWidth: '1601', gptImageHeight: '1200' }, 'custom'),
        /16/
    );
});

test('desktop loads the shared profile registry and exposes native parameter controls', () => {
    const html = require('../scripts/read-ui-source')();
    assert.ok(html.indexOf('imageApiProfiles.js') < html.indexOf('desktop.js'));

    const requiredIds = [
        'openAIModerationSelect',
        'nativeResponseFormatSelect',
        'openAIStyleSelect',
        'inputFidelitySelect',
        'apiUserInput',
        'googleSearchToggle',
        'imageSearchToggle',
        'xaiStoreToggle',
        'xaiFilenameInput',
        'xaiExpiresAfterInput',
        'xaiPublicUrlToggle',
        'maxGlobalConcurrentInput',
        'ratioSelect',
        'newChatProviderBtn',
        'reversePromptNavBtn',
        'reversePromptPage',
        'reversePromptProviderSelect',
        'reversePromptRunBtn'
    ];
    for (const id of requiredIds) assert.match(html, new RegExp(id));
    assert.doesNotMatch(html, /openAIStreamToggle|partialImagesSelect|流式生成|流式预览数/);
    assert.match(html, /id="ratioSelect"[^>]+aria-label="图片比例"/);
    assert.match(fs.readFileSync(require.resolve('../desktop.js'), 'utf8'), /function createRatioVisual\(value\)/);
    assert.match(fs.readFileSync(require.resolve('../desktop.js'), 'utf8'), /chatProviderId: provider\.id/);
});

test('frameless main window stays resizable and settings actions keep a stable height', () => {
    const main = fs.readFileSync(require.resolve('../electron-main.js'), 'utf8');
    const css = fs.readFileSync(require.resolve('../desktop.css'), 'utf8');

    assert.match(main, /frame:\s*false,[\s\S]*transparent:\s*true,[\s\S]*resizable:\s*true/);
    assert.match(main, /thickFrame:\s*true/);
    assert.doesNotMatch(main, /mainWindow\.setResizable\(/);
    assert.match(main, /mainWindow\.setMaximumSize\(workArea\.width, workArea\.height\)/);
    assert.match(css, /\.settings-form\s*\{[\s\S]*?align-content:\s*start/);
    assert.match(css, /\.settings-actions\s*\{[\s\S]*?align-items:\s*center/);
    assert.match(css, /\.settings-actions \.primary-button,[\s\S]*?height:\s*38px;[\s\S]*?max-height:\s*38px/);
});

test('history is a standalone full-page view backed by an untruncated index', () => {
    const html = require('../scripts/read-ui-source')();
    const renderer = fs.readFileSync(require.resolve('../desktop.js'), 'utf8');
    const main = fs.readFileSync(require.resolve('../electron-main.js'), 'utf8');
    const preload = fs.readFileSync(require.resolve('../desktop-preload.js'), 'utf8');

    assert.match(html, /id="historyPage"/);
    assert.match(html, /id="historySearchInput"/);
    assert.match(html, /id="historyDetailDrawer"/);
    assert.match(html, /id="recentSection"/);
    assert.match(html, /最近 10 张/);
    assert.match(renderer, /function showHistoryView\(\)/);
    // The recent strip's count and order are covered by renderer behavior tests.
    assert.match(renderer, /拖到参考图按钮那一行可加为参考图/);
    assert.match(renderer, /window\.picgenDesktop\.startImageDrag\(batch\.length > 1 \? batch\.map\(record => record\.filePath\) : image\.filePath\)/);
    // 参考图重构（2.3.3+）：整列上传区收进提示词左下角堆叠轨；文件拖入提示词分屏
    // （左=加参考图，右=读提示词），上传/粘贴入口在堆叠空位卡的菜单里。
    // 应用内拖历史图走不了 drop 事件（原生拖拽不给拖拽源派发），
    // 松手落点命中由 onImageDragEnded + referenceDropHitFromPoint 完成。
    assert.match(renderer, /function referenceDropHitFromPoint\(point\)/);
    assert.match(renderer, /function addHistoryImageAsReference\(imageOrBatch\)/);
    assert.match(renderer, /function handlePromptDrop\(event\)/);
    assert.match(renderer, /function handleGlobalReferencePaste\(event\)/);
    assert.match(renderer, /function hasDraggedImage\(dataTransfer\)/);
    assert.match(html, /id="referenceStack"/);
    assert.match(html, /id="promptDropOverlay"/);
    assert.match(fs.readFileSync(require.resolve('../workspace.css'), 'utf8'), /history-thumb img[\s\S]*pointer-events: none/);
    assert.match(renderer, /providerName: task\.providerName/);
    assert.match(renderer, /供应商: \$\{image\.providerName/);
    assert.match(main, /providerName: task\.providerName/);
    assert.match(fs.readFileSync(require.resolve('../frontend/PreviewCard.jsx'), 'utf8'), /id=\{id\('Provider'\)\}/);
    // 右键菜单与详情抽屉的「复制提示词」（原「读取提示词」）直接写剪贴板，不再新建序列；
    // createSequenceFromImagePrompt 留给提示词反推页。
    assert.match(html, /复制提示词/);
    assert.doesNotMatch(html, /读取提示词/);
    assert.match(renderer, /function createSequenceFromImagePrompt\(prompt\)/);
    const copyPromptAction = functionBody(renderer, 'copyPromptFromContextImage');
    assert.match(copyPromptAction, /copyText\(/);
    assert.doesNotMatch(copyPromptAction, /createSequenceFromImagePrompt|api\/prompts\/reverse|chatPresetId/);
    assert.match(preload, /listHistoryImages/);
    assert.match(preload, /listRecentImages: \(options\)/);
    assert.match(main, /records\.slice\(0, limit\)/);
    assert.match(main, /desktop:list-history-images/);
    assert.doesNotMatch(main, /RECENT_LIMIT|slice\(0,\s*10\)/);
});

// Local modules reachable from `entry` through require('./…'), plus the scripts they start with
// `new Worker(path.join(__dirname, '…'))` (worker_threads) and everything those require.
function localModuleGraph(entry) {
    const root = path.dirname(require.resolve('../electron-main.js'));
    const seen = new Map();
    const workers = new Set();
    const visit = (file, viaWorker) => {
        const resolved = path.resolve(file);
        if (seen.has(resolved)) {
            if (viaWorker) seen.get(resolved).viaWorker = true;
            return;
        }
        const source = fs.readFileSync(resolved, 'utf8');
        seen.set(resolved, { source, viaWorker });
        for (const match of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
            const target = path.resolve(path.dirname(resolved), match[1]);
            const candidate = fs.existsSync(`${target}.js`) ? `${target}.js` : target;
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) visit(candidate, viaWorker);
        }
        for (const match of source.matchAll(/new Worker\(\s*path\.join\(\s*__dirname,\s*['"]([^'"]+)['"]\s*\)/g)) {
            const target = path.join(path.dirname(resolved), match[1]);
            workers.add(path.relative(root, target));
            visit(target, true);
        }
    };
    visit(entry, false);
    return { modules: seen, workers };
}

test('similarity v3.1 runs in a utility-process service behind logged IPC handlers', () => {
    const mainFile = require.resolve('../electron-main.js');
    const main = fs.readFileSync(mainFile, 'utf8');
    const preload = fs.readFileSync(require.resolve('../desktop-preload.js'), 'utf8');

    for (const method of ['getSimilarityGroups', 'onSimilarityUpdated', 'getSimilarNeighbors', 'setSimilarityOverride',
        'smokeSimilarityStatus', 'smokeEventLoop']) {
        assert.match(preload, new RegExp(`\\b${method}: `), `preload is missing ${method}`);
    }
    assert.match(preload, /getSimilarNeighbors: [^\n]*'desktop:similarity-neighbors'/);
    assert.match(preload, /setSimilarityOverride: [^\n]*'desktop:similarity-override'/);
    assert.match(preload, /smokeSimilarityStatus: [^\n]*'desktop:smoke-similarity-status'/);
    assert.match(preload, /smokeEventLoop: [^\n]*'desktop:smoke-event-loop'/);
    assert.doesNotMatch(preload, /getImageSignatures|desktop:image-signatures/);

    for (const channel of ['similarity-groups', 'similarity-neighbors', 'similarity-override']) {
        assert.match(main, new RegExp(`ipcMain\\.handle\\('desktop:${channel}', loggedIpcHandler\\(`), `${channel} is not a logged handler`);
    }
    assert.doesNotMatch(main, /desktop:image-signatures|getImageSignatures|blockhash|SimilarityIndex|similarityIndex/);
    assert.doesNotMatch(main, /\.update\(records\)|\.update\(hydrated\)/);
    // The whole engine lives in an Electron utility process ("PicGen Similarity").
    assert.match(main, /utilityProcess\.fork\(/);
    assert.match(main, /'similarity-engine-host\.js'/);
    assert.match(main, /serviceName: 'PicGen Similarity'/);
    assert.match(main, /stdio: 'pipe'/);
    assert.match(main, /desktop:similarity-updated/);
    // Record sync is fire-and-forget: every history read/commit hands the records over, never awaited.
    for (const name of ['readHistoryImages', 'commitHistoryImages', 'readRecentImages']) {
        const start = main.indexOf(`async function ${name}(`);
        assert.ok(start >= 0, `${name} is missing`);
        const end = main.slice(start).search(/\r?\n\}\r?\n/);
        assert.ok(end > 0, `${name} has no closing brace`);
        const body = main.slice(start, start + end);
        assert.match(body, /\n\s+syncSimilarityRecords\(/, `${name} does not sync similarity records`);
        assert.doesNotMatch(body, /await\s+\S*(?:syncSimilarityRecords|syncRecords)/, `${name} awaits the similarity sync`);
    }
    // Smoke-only channels exist only behind PICGEN_SMOKE=1.
    const smokeGate = main.indexOf("if (process.env.PICGEN_SMOKE === '1') {");
    assert.ok(smokeGate > 0, 'smoke handlers are not gated on PICGEN_SMOKE');
    const smokeBlock = main.slice(smokeGate, smokeGate + main.slice(smokeGate).search(/\r?\n\}\r?\n/));
    for (const channel of ['desktop:smoke-similarity-status', 'desktop:smoke-event-loop']) {
        assert.ok(smokeBlock.includes(`ipcMain.handle('${channel}'`), `${channel} must be registered inside the smoke gate`);
        assert.equal(main.split(`'${channel}'`).length, 2, `${channel} is registered outside the smoke gate`);
    }
    assert.match(main, /monitorEventLoopDelay\(\{ resolution: 10 \}\)/);
    assert.match(main, /getAppMetrics\(\)/);
    // before-quit gives the service at most 2 s to flush, once.
    const beforeQuitStart = main.indexOf("app.on('before-quit'");
    const beforeQuit = main.slice(beforeQuitStart, beforeQuitStart + main.slice(beforeQuitStart).search(/\r?\n\}\);\r?\n/));
    assert.equal(beforeQuit.split('event.preventDefault()').length, 2, 'before-quit prevents the quit in one place only');
    // The once-flag is read and set before the guard, and preventDefault sits only inside that guard.
    const flagRead = beforeQuit.indexOf('const closingSimilarity = !similarityClosed;');
    const flagSet = beforeQuit.indexOf('similarityClosed = true;');
    const guard = beforeQuit.indexOf('if (similarityService && closingSimilarity) {');
    assert.ok(flagRead > 0 && flagSet > flagRead && guard > flagSet, 'before-quit must set its once-flag before the guard');
    const guarded = beforeQuit.slice(guard, guard + beforeQuit.slice(guard).search(/\r?\n {4}\}/));
    assert.match(guarded, /event\.preventDefault\(\)/, 'preventDefault must sit inside the once-flag guard');
    assert.match(beforeQuit, /Promise\.race\(\[[^\]]*\.close\(\)[^\]]*2000/);
    assert.match(beforeQuit, /app\.quit\(\)/);

    // ORT must never be hosted in worker_threads: terminating a worker during session.run kills
    // the app. Nothing main requires, and no worker script main starts, may load onnxruntime.
    const { modules, workers } = localModuleGraph(mainFile);
    assert.ok([...modules.keys()].some(file => file.endsWith('similarityService.js')), 'main does not use the similarity service');
    assert.ok(workers.has('preview-decoder-worker.js'));
    for (const [file, { source }] of modules) {
        const name = path.basename(file);
        assert.doesNotMatch(source, /require\(\s*['"]onnxruntime-node['"]\s*\)/, `${name} loads onnxruntime in main`);
        assert.doesNotMatch(source, /require\(\s*['"]\.\/(?:similarityEmbedder|similarityEngine|similarity-engine-host)['"]\s*\)/,
            `${name} pulls the similarity engine into main`);
    }
});

// The body of `function name(` / `async function name(` up to its closing brace at column 0.
function functionBody(source, name) {
    const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\(`).exec(source);
    assert.ok(match, `${name} is missing`);
    const end = source.slice(match.index).search(/\r?\n\}\r?\n/);
    assert.ok(end > 0, `${name} has no closing brace`);
    return source.slice(match.index, match.index + end);
}

test('history usage and the in-app recycle bin are wired into main behind logged IPC handlers', () => {
    const main = fs.readFileSync(require.resolve('../electron-main.js'), 'utf8');
    const preload = fs.readFileSync(require.resolve('../desktop-preload.js'), 'utf8');
    const renderer = fs.readFileSync(require.resolve('../desktop.js'), 'utf8');
    const trashModule = fs.readFileSync(require.resolve('../historyTrash.js'), 'utf8');

    const bridge = {
        recordHistoryUsage: /recordHistoryUsage: \(payload\) => ipcRenderer\.invoke\('desktop:record-history-usage', payload\)/,
        onHistoryUsageUpdated: /onHistoryUsageUpdated: [\s\S]{0,200}?'desktop:history-usage-updated'[\s\S]{0,200}?removeListener\('desktop:history-usage-updated'/,
        trashHistoryImages: /trashHistoryImages: \(payload\) => ipcRenderer\.invoke\('desktop:trash-history-images', payload\)/,
        onHistoryTrashProgress: /onHistoryTrashProgress: [\s\S]{0,200}?'desktop:history-trash-progress'[\s\S]{0,200}?removeListener\('desktop:history-trash-progress'/,
        onHistoryChanged: /onHistoryChanged: [\s\S]{0,200}?'desktop:history-changed'[\s\S]{0,200}?removeListener\('desktop:history-changed'/,
        listHistoryBin: /listHistoryBin: \(\) => ipcRenderer\.invoke\('desktop:list-history-bin'\)/,
        restoreHistoryBin: /restoreHistoryBin: \(payload\) => ipcRenderer\.invoke\('desktop:restore-history-bin', payload\)/,
        purgeHistoryBin: /purgeHistoryBin: \(payload\) => ipcRenderer\.invoke\('desktop:purge-history-bin', payload\)/,
        getHistoryBinCount: /getHistoryBinCount: \(\) => ipcRenderer\.invoke\('desktop:get-history-bin-count'\)/,
        onHistoryBinChanged: /onHistoryBinChanged: [\s\S]{0,200}?'desktop:history-bin-changed'[\s\S]{0,200}?removeListener\('desktop:history-bin-changed'/,
        smokeDragOutcome: /smokeDragOutcome: \(payload\) => ipcRenderer\.invoke\('desktop:smoke-drag-outcome', payload\)/,
        smokeHistoryBinSweep: /smokeHistoryBinSweep: \(options\) => ipcRenderer\.invoke\('desktop:smoke-history-bin-sweep', options\)/,
        copyImage: /copyImage: \(payload\) => ipcRenderer\.invoke\('desktop:copy-image', payload\)/,
        smokeClipboardLog: /smokeClipboardLog: \(\) => ipcRenderer\.invoke\('desktop:smoke-clipboard-log'\)/,
        saveImageAs: /saveImageAs: \(payload\) => ipcRenderer\.invoke\('desktop:save-image-as', payload\)/
    };
    for (const [method, pattern] of Object.entries(bridge)) assert.match(preload, pattern, `preload is missing ${method}`);
    assert.doesNotMatch(preload, /open-recycle-bin|smoke-trash-revival/, 'the Windows Recycle Bin bridge is gone');
    // 另存统一走系统「另存为」对话框：选目录的旧通道退役
    assert.doesNotMatch(preload + main, /save-image-to-directory|saveImageToDirectory/);

    for (const channel of ['record-history-usage', 'trash-history-images', 'list-history-bin', 'restore-history-bin', 'purge-history-bin', 'get-history-bin-count',
        'copy-image', 'save-image-as']) {
        assert.match(main, new RegExp(`ipcMain\\.handle\\('desktop:${channel}', loggedIpcHandler\\(`), `${channel} is not a logged handler`);
    }
    assert.match(main, /ipcMain\.handle\('desktop:trash-history-images', loggedIpcHandler\(\{ source: 'storage', title: '移到回收站失败', operation: 'trash-history-images' \}/);
    assert.doesNotMatch(main, /open-recycle-bin|shell\.trashItem|PICGEN_SMOKE_TRASH_DIR/, 'history never uses the Windows Recycle Bin');
    // Smoke-only channels are registered inside the PICGEN_SMOKE gate.
    const gate = main.indexOf("if (process.env.PICGEN_SMOKE === '1') {");
    assert.ok(gate > 0, 'smoke gate is missing');
    const gateBlock = main.slice(gate, gate + main.slice(gate).search(/\r?\n\}\r?\n/));
    for (const channel of ['desktop:smoke-drag-outcome', 'desktop:smoke-history-bin-sweep', 'desktop:smoke-clipboard-log']) {
        assert.ok(gateBlock.includes(`'${channel}'`), `${channel} must be registered behind the smoke gate`);
        assert.equal(main.split(`'${channel}'`).length, 2, `${channel} is registered outside the smoke gate`);
    }
    assert.match(main, /ipcMain\.handle\('desktop:smoke-history-bin-sweep', \(_event, options\) => scheduleHistoryBinSweep\(\{ force: options\?\.force !== false \}\)\)/);

    // Marking never touches a file; the only deletion is purge's fs.unlink, behind an lstat guard.
    assert.doesNotMatch(trashModule, /\.rename\(|\.rm(?:Sync)?\(|\brmdir(?:Sync)?\(|rimraf|trashItem/, 'historyTrash.js moves or removes files outside purge');
    assert.equal(trashModule.match(/\bunlink\(/g).length, 1, 'purge is the only unlink in historyTrash.js');
    const purgeFile = functionBody(trashModule, 'purgeFile');
    assert.ok(purgeFile.indexOf('fs.lstat(') >= 0 && purgeFile.indexOf('fs.lstat(') < purgeFile.indexOf('unlinkFile('), 'purge unlinks only after lstat');
    assert.match(purgeFile, /!stat\.isFile\(\) \|\| !isTrashableImageName\(resolved\)/);
    const unlinkMain = functionBody(main, 'unlinkHistoryFile');
    assert.match(unlinkMain, /process\.env\.PICGEN_SMOKE === '1'/, 'the purge refusal switch is smoke-only');
    assert.match(unlinkMain, /fs\.unlink\(filePath\)/);
    assert.doesNotMatch(renderer, /\bwindow\.confirm\s*\(/);

    // trash(), restore() and purge() queue their own steps on the history queue: calling any of them
    // from inside enqueueHistoryMutation deadlocks every later save (WP4 handoff).
    const trashWiring = functionBody(main, 'getHistoryTrash');
    assert.match(trashWiring, /enqueue: enqueueHistoryMutation/);
    assert.match(trashWiring, /loadIndex: loadHistoryIndex/);
    assert.match(trashWiring, /commit: commitHistoryImages/);
    assert.match(trashWiring, /unlink: unlinkHistoryFile/);
    assert.match(trashWiring, /'desktop:history-bin-changed'/);
    for (const match of main.matchAll(/enqueueHistoryMutation\(/g)) {
        const call = main.slice(match.index, match.index + 1500);
        const callEnd = call.search(/\r?\n\s{0,4}\}\);/);
        assert.doesNotMatch(call.slice(0, callEnd > 0 ? callEnd : call.length), /\.trash\(|\.restore\(|\.purge\(|\.sweep\(|scheduleHistoryBinSweep\(/,
            'bin operations must never run inside enqueueHistoryMutation');
    }
    const sweep = functionBody(main, 'scheduleHistoryBinSweep');
    assert.match(sweep, /HISTORY_BIN_SWEEP_THROTTLE_MS/);
    assert.match(main, /const HISTORY_BIN_SWEEP_THROTTLE_MS = 5000;/);
    assert.match(sweep, /\.list\(\)\.length/);
    assert.match(sweep, /getHistoryTrash\(\)\.sweep\(\)/);
    assert.match(sweep, /\.catch\(/);
    const focus = main.slice(main.indexOf("mainWindow.on('focus'"), main.indexOf("mainWindow.on('focus'") + 400);
    assert.match(focus, /scheduleHistoryBinSweep\(\)/);

    // Load time: binned records leave history before knownPaths, binned paths join knownPaths (so
    // discovery never re-adds them), and the index is marked for rewrite.
    const load = functionBody(main, 'loadHistoryIndex');
    assert.match(load, /Promise\.all\(\[\s*readJsonFile\(store\.recentFile/);
    assert.ok(load.indexOf('reconcileHistoryBin(') > 0 && load.indexOf('reconcileHistoryBin(') < load.indexOf('const knownPaths'),
        'the bin must be applied before knownPaths');
    assert.ok(load.indexOf('binOutcome.binnedPaths') > load.indexOf('const knownPaths') && load.indexOf('binOutcome.binnedPaths') < load.indexOf('discoverHistoryImages('),
        'binned paths must be known before discovery');
    assert.match(load, /discovered\.length > 0 \|\| binChanged/);
    assert.doesNotMatch(load, /\.sweep\(|\.restore\(|\.purge\(|enqueueHistoryMutation/);

    // Usage is projected when records are read and never enters the stored index.
    for (const name of ['readHistoryImages', 'readRecentImages']) assert.match(functionBody(main, name), /\.project\b/);
    assert.doesNotMatch(functionBody(main, 'commitHistoryImages'), /\.project\b/);
    assert.match(main, /const HISTORY_SCHEMA_VERSION = 4;/);

    // Drag-outs are counted after startDrag returns, after the unchanged drag-ended push. The drag-active flag
    // goes up (and any hover preview comes down) before the drag starts, and back down once it has ended.
    assert.match(main, /ipcMain\.on\('desktop:start-image-drag', \(event, payload\) => \{[^\n]*\r?\n(?:\s*\/\/[^\n]*\r?\n)?\s+imageDragActive \+= 1;\r?\n\s+hideImagePreview\(\);\r?\n\s+void startImageDrag\(event\.sender, payload\)\.finally\(\(\) => \{ imageDragActive -= 1; \}\);/);
    const dragBody = functionBody(main, 'startImageDrag');
    // The drag image is composed in the sharp worker with a bounded wait, never decoded on the main thread.
    const iconBody = functionBody(main, 'buildImageDragIcon');
    assert.match(iconBody, /previewDecoder\.dragIcon\(/);
    assert.match(iconBody, /DRAG_ICON_TIMEOUT_MS/);
    assert.doesNotMatch(dragBody + iconBody, /createFromPath\(/);
    // The early return (nothing to drag) ends at once; the real drag-ended push comes after startDrag.
    assert.ok(dragBody.lastIndexOf("'desktop:image-drag-ended'") > dragBody.indexOf('startDrag('), 'drag-ended must follow startDrag');
    assert.ok(dragBody.indexOf('void finishImageDrag(') > dragBody.lastIndexOf("'desktop:image-drag-ended'"), 'finishImageDrag must follow drag-ended');
    const finish = functionBody(main, 'finishImageDrag');
    assert.match(finish, /BrowserWindow\.getAllWindows\(\)/);
    assert.match(finish, /isVisible\(\)/);
    assert.match(finish, /classifyDragEnd\(/);
    assert.match(finish, /findHistoryRecordByPath\(/);
    assert.match(finish, /'drag-out'/);
    // The click-through hover preview is not "inside PicGen": a file released over it went to the app below.
    assert.match(finish, /window !== imagePreviewWindow/);
    assert.match(main, /'desktop:history-usage-updated'/);

    // 复制图片 / 另存为同样记 'drag-out'，只在主进程、成功之后记，计数失败不抛出。
    const external = functionBody(main, 'countExternalUse');
    assert.match(external, /findHistoryRecordByPath\(/);
    assert.match(external, /'drag-out'/);
    assert.match(external, /catch \(error\)[\s\S]*warnHistoryStorageOnce\(/);
    // 解码先走 sharp worker（有限等待），nativeImage 的同步解码只是兜底；空图必须在写剪贴板之前拦下。
    const decode = functionBody(main, 'decodeClipboardImage');
    assert.match(decode, /COPY_IMAGE_TIMEOUT_MS/);
    assert.ok(decode.indexOf('previewDecoder.bitmap(') >= 0 && decode.indexOf('previewDecoder.bitmap(') < decode.indexOf('createFromPath('),
        'the worker decode comes before the main-thread fallback');
    const copy = functionBody(main, 'copyImageToClipboard');
    assert.ok(copy.indexOf('isEmpty()') > 0 && copy.indexOf('isEmpty()') < copy.indexOf('writeClipboard('), 'an empty image never reaches the clipboard');
    assert.ok(copy.indexOf("countExternalUse(filePath, 'copy')") > copy.indexOf('writeClipboard('), 'a copy is counted only after the write');
    assert.match(copy, /resolveReadableImagePath\(/);
    const saveAs = functionBody(main, 'saveImageAs');
    assert.match(saveAs, /resolveReadableImagePath\(/);
    assert.ok(saveAs.indexOf("countExternalUse(source, 'save-as')") > saveAs.indexOf('writeSavedCopy('), 'a save is counted only after the write');
    assert.match(functionBody(main, 'loadCachedImage'), /resolveReadableImagePath\(/);
    // 系统剪贴板只有一个出口，冒烟 dry 模式在这里拦下
    assert.equal(main.match(/clipboard\.write(?:Image|Text)\(/g).length, 2);
    assert.match(functionBody(main, 'writeClipboard'), /process\.env\.PICGEN_SMOKE === '1' && process\.env\.PICGEN_SMOKE_CLIPBOARD === 'dry'/);
    assert.match(main, /ipcMain\.handle\('desktop:copy-text', \(_event, text\) => \{\r?\n\s+writeClipboard\('text'/);
});

test('另存为 lets the user pick the folder and starts from the last picked one, even after a restart', () => {
    const main = fs.readFileSync(require.resolve('../electron-main.js'), 'utf8');
    const save = functionBody(main, 'saveImageAs');
    // The folder comes from the user's own pick in the system Save As dialog.
    assert.ok(save.indexOf('await saveAsStartDirectory()') < save.indexOf('showDockSafeSaveDialog('));
    assert.match(save, /if \(!smokeDir\) rememberSaveAsDirectory\(path\.dirname\(filePath\)\);/);
    const start = functionBody(main, 'saveAsStartDirectory');
    assert.match(start, /outputConfigStore \? \(await outputConfigStore\.get\(\)\)\.saveAsDirectory/);
    assert.match(start, /isDirectory\(\)/);
    // No remembered folder (or it is gone): no fixed fallback folder, so Windows' own last-picked folder wins.
    assert.doesNotMatch(start, /getPath\(/);
    assert.match(save, /defaultPath: directory \? await freeSaveAsPath\(directory, fileName\) : fileName/);
    // A dead network share must not stall every Save As for ~47 s: the folder check is time-boxed.
    assert.match(start, /Promise\.race\(\[/);
    assert.match(start, /SAVE_AS_FOLDER_CHECK_MS/);
    assert.match(functionBody(main, 'rememberSaveAsDirectory'), /outputConfigStore\?\.update\(\{ saveAsDirectory: directory \}\)[\s\S]*?\.catch\(/);
});

test('the hover preview never shows during a native drag or while the real cursor is off the image that asked for it', () => {
    const main = fs.readFileSync(require.resolve('../electron-main.js'), 'utf8');
    const show = functionBody(main, 'showImagePreview');
    const dragBail = show.indexOf('if (imageDragActive > 0) return;');
    assert.ok(dragBail >= 0 && dragBail < show.indexOf('readPreviewImage('), 'a drag in progress refuses the request before any work');
    assert.ok(show.indexOf('imagePreviewAnchor = readPreviewAnchor(payload);') > show.indexOf('++imagePreviewRequestId'), 'each request carries its own anchor');
    const gate = show.indexOf('if (imageDragActive > 0 || !cursorOnImagePreviewAnchor(4))');
    assert.ok(gate > 0 && gate < show.indexOf('showInactive('), 'the anchor check runs right before the window shows');
    assert.match(functionBody(main, 'watchImagePreviewCursor'), /cursorOnImagePreviewAnchor\(24\)/);
    assert.match(functionBody(main, 'hideImagePreview'), /imagePreviewAnchor = null;/);
    const anchor = functionBody(main, 'cursorOnImagePreviewAnchor');
    assert.ok(anchor.indexOf('cursorInsideMainWindow()') < anchor.indexOf('if (!rect) return true;'), 'without an anchor the window check still applies');
    assert.match(anchor, /getContentBounds\(\)/);
    // A window straddling displays with different scale factors falls back to the window check.
    assert.ok(anchor.indexOf('scaleFactor !== windowDisplay.scaleFactor) return true;') < anchor.indexOf('getContentBounds()'));
});

test('opening a history image in the image workspace counts as one reference use', async t => {
    const fixture = createMainHistoryFixture(t, ['w']);
    const [w] = fixture.records;
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: '1' } });
    const used = await main.invoke('desktop:record-history-usage', { filePath: w.filePath, kind: 'reference', source: 'workspace' });
    assert.equal(used.ok, true);
    assert.equal(used.changed, true);
    assert.equal(used.usage.referenceCount, 1);
    assert.equal(used.usage.dragCount, 0);
    assert.equal(main.pushes('desktop:history-usage-updated').length, 1);
});

const HISTORY_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XG62WQAAAABJRU5ErkJggg==', 'base64');

// An isolated profile <base>/PicGenData with one history record per name.
function createMainHistoryFixture(t, names) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-main-history-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const userData = path.join(base, 'PicGenData');
    const images = path.join(userData, 'desktop-cache', 'images');
    fs.mkdirSync(images, { recursive: true });
    const records = names.map((name, index) => {
        const filePath = path.join(images, `${name}.png`);
        fs.writeFileSync(filePath, HISTORY_PIXEL);
        return {
            id: `task_${name}`, filePath, fileName: `${name}.png`, mimeType: 'image/png', prompt: `prompt ${name}`,
            ratio: '1:1', model: 'gpt-image-2', providerName: 'fixture', createdAt: 1000 + index,
            width: 1, height: 1, fileSize: HISTORY_PIXEL.length
        };
    });
    const cache = path.join(userData, 'desktop-cache');
    fs.writeFileSync(path.join(cache, 'recent-images.json'), JSON.stringify({ schemaVersion: 4, images: records }));
    return { base, userData, cache, images, records };
}

// One more history record whose file holds `buffer` (a WebP, a real PNG, …). Call before loading main.
function addFixtureImage(fixture, fileName, buffer, fields = {}) {
    const filePath = path.join(fixture.images, fileName);
    fs.writeFileSync(filePath, buffer);
    const record = {
        id: `task_${path.parse(fileName).name}`, filePath, fileName, mimeType: 'image/png', prompt: '',
        ratio: '1:1', model: 'gpt-image-2', providerName: 'fixture', createdAt: 2000 + fixture.records.length,
        width: 1, height: 1, fileSize: buffer.length, ...fields
    };
    fixture.records.push(record);
    fs.writeFileSync(path.join(fixture.cache, 'recent-images.json'), JSON.stringify({ schemaVersion: 4, images: fixture.records }));
    return record;
}

// Loads a fresh electron-main.js against a stubbed `electron` module: no BrowserWindow is created,
// app.whenReady() never resolves (so no host and no local server) and shell.trashItem throws: history
// must never use the Windows Recycle Bin.
function loadMainWithStubElectron(t, { userData, env = {} }) {
    const Module = require('node:module');
    const control = {
        cursor: { x: 5000, y: 5000 },
        handlers: new Map(),
        listeners: new Map(),
        sent: [],
        appListeners: new Map(),
        quitCalls: 0,
        realTrashCalls: 0,
        // The stubbed system clipboard (never the real one), the bitmaps handed to createFromBitmap
        // and the Save As dialogs shown, whose answer a test sets in saveDialogResult.
        clipboard: [],
        bitmaps: [],
        saveDialogs: [],
        saveDialogResult: { canceled: true }
    };
    const window = {
        isDestroyed: () => false,
        isVisible: () => true,
        getBounds: () => ({ x: 0, y: 0, width: 460, height: 800 }),
        webContents: { send: (channel, payload) => control.sent.push({ channel, payload }) }
    };
    const emptyImage = { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize: () => emptyImage };
    const electron = {
        app: {
            isPackaged: false,
            getPath: () => userData,
            setName() {},
            setAppUserModelId() {},
            requestSingleInstanceLock: () => true,
            isReady: () => false,
            whenReady: () => new Promise(() => {}),
            on: (name, listener) => {
                if (!control.appListeners.has(name)) control.appListeners.set(name, []);
                control.appListeners.get(name).push(listener);
            },
            quit: () => { control.quitCalls += 1; },
            getVersion: () => '0.0.0-test',
            getAppMetrics: () => []
        },
        BrowserWindow: { getAllWindows: () => [window] },
        ipcMain: {
            handle: (channel, handler) => control.handlers.set(channel, handler),
            on: (channel, listener) => control.listeners.set(channel, listener)
        },
        screen: { getCursorScreenPoint: () => ({ ...control.cursor }), getDisplayNearestPoint: () => ({ scaleFactor: 1 }) },
        Tray: class {},
        Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
        nativeImage: {
            createFromPath: () => emptyImage,
            createFromDataURL: () => emptyImage,
            createFromBuffer: () => emptyImage,
            createFromBitmap: (buffer, { width, height }) => {
                control.bitmaps.push({ width, height, bytes: buffer.length, pixel: [...buffer.subarray(0, 8)] });
                return { isEmpty: () => !(width > 0 && height > 0), getSize: () => ({ width, height }) };
            }
        },
        dialog: {
            showSaveDialog: async (_window, options) => {
                control.saveDialogs.push(options);
                return control.saveDialogResult;
            }
        },
        shell: { trashItem: async () => { control.realTrashCalls += 1; throw new Error('the real Recycle Bin must not be used in tests'); } },
        safeStorage: {},
        session: {},
        clipboard: {
            writeImage: image => control.clipboard.push({ kind: 'image', ...image.getSize() }),
            writeText: text => control.clipboard.push({ kind: 'text', text })
        },
        utilityProcess: { fork() { throw new Error('no similarity host in tests'); } },
        powerMonitor: { on() {}, isOnBatteryPower: () => false }
    };
    const previous = {};
    for (const [name, value] of Object.entries(env)) {
        previous[name] = process.env[name];
        if (value == null) delete process.env[name];
        else process.env[name] = value;
    }
    const mainPath = require.resolve('../electron-main.js');
    const originalLoad = Module._load;
    Module._load = function load(request, ...rest) {
        return request === 'electron' ? electron : originalLoad.call(this, request, ...rest);
    };
    delete require.cache[mainPath];
    try {
        require(mainPath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[mainPath];
    }
    t.after(() => {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
    control.dragItems = [];
    control.sender = { startDrag: item => control.dragItems.push(item), isDestroyed: () => false, send: (channel, payload) => control.sent.push({ channel, payload, sender: true }) };
    control.invoke = (channel, payload) => control.handlers.get(channel)({ sender: control.sender }, payload);
    control.emit = (channel, ...args) => control.listeners.get(channel)({ sender: control.sender }, ...args);
    control.emitApp = (name, ...args) => { for (const listener of control.appListeners.get(name) || []) listener(...args); };
    control.pushes = channel => control.sent.filter(entry => entry.channel === channel && !entry.sender);
    return control;
}

async function waitUntil(predicate, label, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`timed out waiting for ${label}`);
}

function readTombstonePaths(fixture) {
    const file = path.join(fixture.cache, 'history-trash.json');
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8')).entries.map(entry => path.basename(entry.path)).sort();
}

test('main counts native drag-outs and in-app reference uses in the usage sidecar', async t => {
    const fixture = createMainHistoryFixture(t, ['a', 'b', 'c']);
    const [a, b, c] = fixture.records;
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: '1' } });

    const used = await main.invoke('desktop:record-history-usage', { filePath: a.filePath, kind: 'reference', source: 'menu' });
    assert.equal(used.ok, true);
    assert.equal(used.changed, true);
    assert.equal(used.usageKey, 'a.png|' + HISTORY_PIXEL.length);
    assert.deepEqual({ dragCount: used.usage.dragCount, referenceCount: used.usage.referenceCount, lastUsedKind: used.usage.lastUsedKind },
        { dragCount: 0, referenceCount: 1, lastUsedKind: 'reference' });
    const again = await main.invoke('desktop:record-history-usage', { filePath: a.filePath.toUpperCase(), kind: 'reference', source: 'drawer' });
    assert.equal(again.ok, true);
    assert.equal(again.coalesced, true, 'the same gesture is not counted twice within 750 ms');
    assert.equal(again.usage.referenceCount, 1);
    assert.deepEqual(await main.invoke('desktop:record-history-usage', { filePath: path.join(fixture.base, 'elsewhere.png'), kind: 'reference', source: 'drop' }),
        { ok: false, reason: 'not-history' });
    for (const payload of [{ filePath: a.filePath, kind: 'drag-out', source: 'drop' }, { filePath: a.filePath, kind: 'reference', source: 'bogus' }, null]) {
        assert.deepEqual(await main.invoke('desktop:record-history-usage', payload), { ok: false, reason: 'bad-kind' });
    }
    const usagePush = main.pushes('desktop:history-usage-updated');
    assert.equal(usagePush.length, 1);
    assert.equal(usagePush[0].payload.usageKey, used.usageKey);
    assert.equal(usagePush[0].payload.filePath, a.filePath);
    assert.equal(usagePush[0].payload.usage.referenceCount, 1);

    // Released inside a visible PicGen window: no drag-out (the renderer counts a band drop itself).
    const inside = await main.invoke('desktop:smoke-drag-outcome', { filePath: b.filePath, point: { x: 10, y: 10 } });
    assert.equal(inside.outcome, 'inside');
    assert.equal(inside.counted, false);
    assert.ok(main.sent.some(entry => entry.sender && entry.channel === 'desktop:image-drag-ended' && entry.payload.x === 10));
    const outside = await main.invoke('desktop:smoke-drag-outcome', { filePath: b.filePath, point: { x: 900, y: 10 } });
    assert.equal(outside.outcome, 'outside');
    assert.equal(outside.counted, true);
    assert.equal(outside.usage.dragCount, 1);
    await assert.rejects(main.invoke('desktop:smoke-drag-outcome', { filePath: b.filePath }), /point/);

    // The real drag handler: startDrag returns at the drop, then drag-ended, then the count.
    main.cursor = { x: -300, y: 40 };
    main.emit('desktop:start-image-drag', c.filePath);
    await waitUntil(() => main.sent.some(entry => entry.sender && entry.channel === 'desktop:image-drag-ended' && entry.payload?.x === -300), 'drag-ended');
    assert.equal(main.dragItems.at(-1).file, path.resolve(c.filePath));
    assert.equal(main.dragItems.at(-1).files, undefined, 'a single file is dragged as one item');
    assert.ok(main.dragItems.at(-1).icon, 'there is always a drag image');
    await waitUntil(() => main.pushes('desktop:history-usage-updated').some(entry => entry.payload.filePath === c.filePath), 'drag-out push');
    const before = main.pushes('desktop:history-usage-updated').length;
    main.emit('desktop:start-image-drag', path.join(fixture.cache, 'references', 'copy.png'));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(main.pushes('desktop:history-usage-updated').length, before, 'a non-history file is never counted');

    const history = await main.invoke('desktop:list-history-images');
    const byName = Object.fromEntries(history.map(record => [record.fileName, record]));
    assert.equal(byName['a.png'].referenceCount, 1);
    assert.equal(byName['a.png'].dragCount, 0);
    assert.equal(byName['b.png'].dragCount, 1);
    assert.equal(byName['c.png'].dragCount, 1);
    assert.equal(byName['c.png'].lastUsedKind, 'drag-out');
    const recent = await main.invoke('desktop:list-recent-images', { limit: 10 });
    assert.equal(recent.find(record => record.fileName === 'b.png').dragCount, 1);

    // Several files: one drag item carrying every existing, unique file (the icon is a counted stack),
    // and each history file dragged out is counted.
    main.emit('desktop:start-image-drag', [a.filePath, c.filePath, a.filePath, path.join(fixture.cache, 'images', 'gone.png')]);
    await waitUntil(() => main.dragItems.at(-1)?.files, 'multi-file drag');
    assert.deepEqual(main.dragItems.at(-1).files, [path.resolve(a.filePath), path.resolve(c.filePath)]);
    assert.equal(main.dragItems.at(-1).file, path.resolve(a.filePath));
    await waitUntil(async () => (await main.invoke('desktop:list-history-images')).find(record => record.fileName === 'a.png').dragCount === 1, 'a counted');
    const dragEnds = main.sent.filter(entry => entry.sender && entry.channel === 'desktop:image-drag-ended').length;
    main.emit('desktop:start-image-drag', [path.join(fixture.cache, 'images', 'gone.png')]);
    await waitUntil(() => main.sent.filter(entry => entry.sender && entry.channel === 'desktop:image-drag-ended').length > dragEnds, 'empty drag ends');
    assert.equal(main.sent.filter(entry => entry.sender && entry.channel === 'desktop:image-drag-ended').at(-1).payload, null, 'nothing to drag: ended at once, no drop point');

    const stored = JSON.parse(fs.readFileSync(path.join(fixture.cache, 'recent-images.json'), 'utf8'));
    assert.equal(stored.schemaVersion, 4);
    assert.ok(stored.images.every(record => !('dragCount' in record) && !('referenceCount' in record)), 'usage never enters the index');
    const sidecar = JSON.parse(fs.readFileSync(path.join(fixture.cache, 'history-usage.json'), 'utf8'));
    assert.deepEqual(Object.keys(sidecar.entries).sort(), ['a.png', 'b.png', 'c.png'].map(name => `${name}|${HISTORY_PIXEL.length}`));
    assert.equal(fs.existsSync(path.join(fixture.cache, 'history-trash.json')), false, 'counting never creates the bin file');
    assert.equal(main.realTrashCalls, 0);
});

test('复制图片 decodes in the sharp worker, never writes an unreadable image and counts a history copy as one drag-out', async t => {
    const sharp = require('sharp');
    const fixture = createMainHistoryFixture(t, ['a']);
    const [a] = fixture.records;
    // 3×1: opaque red, half-transparent green, fully transparent blue.
    const rgba = await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0]), { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
    const alpha = addFixtureImage(fixture, 'alpha.png', rgba, { width: 3, height: 1 });
    const webpBytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ff0000' } }).webp({ lossless: true }).toBuffer();
    const webp = addFixtureImage(fixture, 'photo.webp', webpBytes, { mimeType: 'image/webp', width: 64, height: 48 });
    const reference = path.join(fixture.cache, 'references', 'ref_1.png');
    fs.mkdirSync(path.dirname(reference), { recursive: true });
    fs.copyFileSync(alpha.filePath, reference);
    const broken = path.join(fixture.images, 'broken.png');
    fs.writeFileSync(broken, 'not an image at all');
    const foreign = path.join(fixture.base, 'elsewhere.png');
    fs.copyFileSync(a.filePath, foreign);
    t.mock.method(console, 'warn', () => {});
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: '1', PICGEN_SMOKE_CLIPBOARD: null } });
    // The log exists only in dry mode: a smoke calls it before copying to prove the real clipboard is safe.
    assert.equal(main.handlers.has('desktop:smoke-clipboard-log'), false);
    const usagePushes = () => main.pushes('desktop:history-usage-updated').length;

    const first = await main.invoke('desktop:copy-image', { filePath: alpha.filePath });
    assert.deepEqual({ copied: first.copied, width: first.width, height: first.height, counted: first.counted }, { copied: true, width: 3, height: 1, counted: true });
    assert.deepEqual(main.bitmaps.at(-1), { width: 3, height: 1, bytes: 12, pixel: [0, 0, 255, 255, 0, 128, 0, 128] }, 'premultiplied BGRA');
    assert.deepEqual(main.clipboard, [{ kind: 'image', width: 3, height: 1 }]);
    assert.equal(first.usageKey, `alpha.png|${rgba.length}`);
    assert.deepEqual({ dragCount: first.usage.dragCount, referenceCount: first.usage.referenceCount, lastUsedKind: first.usage.lastUsedKind },
        { dragCount: 1, referenceCount: 0, lastUsedKind: 'drag-out' });
    assert.equal(usagePushes(), 1);
    assert.equal(main.pushes('desktop:history-usage-updated')[0].payload.filePath, alpha.filePath);
    // Copied again within 750 ms: written again, counted once.
    const again = await main.invoke('desktop:copy-image', { filePath: alpha.filePath });
    assert.deepEqual({ copied: again.copied, counted: again.counted, coalesced: again.coalesced, drags: again.usage.dragCount },
        { copied: true, counted: false, coalesced: true, drags: 1 });
    assert.equal(main.clipboard.length, 2);
    assert.equal(usagePushes(), 1);

    // WebP, which nativeImage cannot decode, goes through the worker at its real size.
    const photo = await main.invoke('desktop:copy-image', { filePath: webp.filePath });
    assert.deepEqual([photo.width, photo.height, photo.counted], [64, 48, true]);
    assert.deepEqual(main.bitmaps.at(-1), { width: 64, height: 48, bytes: 64 * 48 * 4, pixel: [0, 0, 255, 255, 0, 0, 255, 255] });
    assert.equal(usagePushes(), 2);

    // A reference-cache file and bare pixels are written but never counted.
    const referenceCopy = await main.invoke('desktop:copy-image', { filePath: reference });
    assert.deepEqual([referenceCopy.copied, referenceCopy.counted, referenceCopy.usage], [true, false, undefined]);
    const pixels = await main.invoke('desktop:copy-image', { base64: rgba.toString('base64'), mimeType: 'image/png' });
    assert.deepEqual([pixels.copied, pixels.width, pixels.height, pixels.counted], [true, 3, 1, false]);
    assert.equal(main.clipboard.length, 5);
    assert.equal(usagePushes(), 2);

    // Undecodable, outside every allowed root, or empty: refused, nothing written, nothing counted.
    await assert.rejects(main.invoke('desktop:copy-image', { filePath: broken }), /无法读取这张图片/);
    await assert.rejects(main.invoke('desktop:copy-image', { filePath: foreign }), /outside PicGen/);
    await assert.rejects(main.invoke('desktop:copy-image', { base64: '' }), /没有可复制的图片/);
    assert.equal(main.clipboard.length, 5);
    assert.equal(usagePushes(), 2);

    // The renderer can never record a copy or a save itself.
    for (const payload of [{ filePath: a.filePath, kind: 'drag-out', source: 'copy' }, { filePath: a.filePath, kind: 'reference', source: 'copy' },
        { filePath: a.filePath, kind: 'drag-out', source: 'save-as' }]) {
        assert.deepEqual(await main.invoke('desktop:record-history-usage', payload), { ok: false, reason: 'bad-kind' });
    }
    const listed = Object.fromEntries((await main.invoke('desktop:list-history-images')).map(record => [record.fileName, record]));
    assert.equal(listed['alpha.png'].dragCount, 1);
    assert.equal(listed['photo.webp'].dragCount, 1);
    assert.equal(listed['a.png'].dragCount, undefined);
});

test('PICGEN_SMOKE_CLIPBOARD=dry keeps smoke runs off the system clipboard and logs what would have been written', async t => {
    const sharp = require('sharp');
    const fixture = createMainHistoryFixture(t, []);
    const image = addFixtureImage(fixture, 'd.png', await sharp({ create: { width: 5, height: 4, channels: 3, background: '#00ff00' } }).png().toBuffer(),
        { width: 5, height: 4, prompt: 'prompt d' });
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: '1', PICGEN_SMOKE_CLIPBOARD: 'dry' } });

    const copied = await main.invoke('desktop:copy-image', { filePath: image.filePath });
    assert.deepEqual([copied.copied, copied.counted], [true, true], 'a dry copy still counts');
    assert.deepEqual(await main.invoke('desktop:copy-text', 'prompt d'), { success: true });
    assert.deepEqual(main.clipboard, [], 'the system clipboard is never touched');
    assert.deepEqual(await main.invoke('desktop:smoke-clipboard-log'), [{ kind: 'image', width: 5, height: 4 }, { kind: 'text', text: 'prompt d' }]);
    for (let index = 0; index < 25; index += 1) await main.invoke('desktop:copy-text', `t${index}`);
    const log = await main.invoke('desktop:smoke-clipboard-log');
    assert.equal(log.length, 20, 'the log keeps the latest 20 writes');
    assert.deepEqual(log.at(-1), { kind: 'text', text: 't24' });
});

test('PICGEN_SMOKE_CLIPBOARD=dry does nothing outside smoke runs', async t => {
    const fixture = createMainHistoryFixture(t, []);
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: null, PICGEN_SMOKE_CLIPBOARD: 'dry' } });
    assert.equal(main.handlers.has('desktop:smoke-clipboard-log'), false);
    await main.invoke('desktop:copy-text', 'x');
    assert.deepEqual(main.clipboard, [{ kind: 'text', text: 'x' }]);
});

test('另存为 copies the original through one Save As dialog, keeps its real extension and counts a history save once', async t => {
    const sharp = require('sharp');
    const fixture = createMainHistoryFixture(t, ['a']);
    const [a] = fixture.records; // no embedded prompt in the file, 'prompt a' in the record
    const webpBytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#3366ff' } }).webp({ lossless: true }).toBuffer();
    const webp = addFixtureImage(fixture, 'photo.webp', webpBytes, { mimeType: 'image/webp', width: 8, height: 6 });
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#808080' } }).jpeg().toBuffer();
    const reference = path.join(fixture.cache, 'references', 'ref_2.png');
    fs.mkdirSync(path.dirname(reference), { recursive: true });
    fs.copyFileSync(a.filePath, reference);
    const saveDir = path.join(fixture.base, 'save-as');
    fs.mkdirSync(saveDir);
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: '1', PICGEN_SMOKE_SAVE_AS_DIR: saveDir } });
    const usagePushes = () => main.pushes('desktop:history-usage-updated').length;

    // Smoke directory, no dialog: a WebP stays a WebP, byte for byte, and counts once.
    const saved = await main.invoke('desktop:save-image-as', { filePath: webp.filePath, fileName: 'photo.webp' });
    assert.deepEqual({ cancelled: saved.cancelled, saved: saved.saved, fileName: saved.fileName, counted: saved.counted, drags: saved.usage.dragCount },
        { cancelled: false, saved: true, fileName: 'photo.webp', counted: true, drags: 1 });
    assert.equal(path.dirname(saved.filePath), saveDir);
    assert.ok(fs.readFileSync(saved.filePath).equals(webpBytes), 'saved as is');
    assert.equal(main.saveDialogs.length, 0);
    assert.equal(usagePushes(), 1);

    // A history file without an embedded prompt gets main's own record prompt, never one from the renderer.
    const embedded = await main.invoke('desktop:save-image-as', { filePath: a.filePath, fileName: 'a.png', prompt: 'from the renderer' });
    assert.equal(embedded.fileName, 'a.png');
    assert.equal((await main.invoke('desktop:get-generated-image-prompt', { filePath: embedded.filePath })).prompt, 'prompt a');
    assert.deepEqual(await main.invoke('desktop:get-generated-image-prompt', { base64: fs.readFileSync(embedded.filePath).toString('base64') }),
        { found: true, prompt: 'prompt a', fileName: '' }, 'embedded metadata is read from bytes');
    assert.ok(fs.readFileSync(a.filePath).equals(HISTORY_PIXEL), 'the original is untouched');
    assert.equal(usagePushes(), 2);

    // A reference card's cache file can be saved too; pixels are saved under their real extension. Neither counts.
    const referenceSave = await main.invoke('desktop:save-image-as', { filePath: reference, fileName: '参考图片.png' });
    assert.deepEqual([referenceSave.fileName, referenceSave.counted], ['参考图片.png', false]);
    const pixels = await main.invoke('desktop:save-image-as', { base64: jpeg.toString('base64'), mimeType: 'image/png', fileName: '工作台-1.png' });
    assert.deepEqual([pixels.fileName, pixels.counted], ['工作台-1.jpg', false]);
    assert.ok(fs.readFileSync(pixels.filePath).equals(jpeg));
    assert.equal(usagePushes(), 2);
    await assert.rejects(main.invoke('desktop:save-image-as', { filePath: path.join(fixture.base, 'elsewhere.png') }), /outside PicGen/);
    await assert.rejects(main.invoke('desktop:save-image-as', { base64: '' }), /没有可保存的图片/);

    // The real dialog. Cancelled: nothing written, nothing counted. Nothing picked yet, so only the file name is given:
    // Windows opens the folder this app last picked in any open/save dialog (a fixed folder would override that).
    delete process.env.PICGEN_SMOKE_SAVE_AS_DIR;
    const filesBefore = fs.readdirSync(saveDir).length;
    main.saveDialogResult = { canceled: true };
    assert.deepEqual(await main.invoke('desktop:save-image-as', { filePath: webp.filePath, fileName: 'photo.webp' }), { cancelled: true });
    assert.deepEqual(main.saveDialogs[0], { title: '另存为', defaultPath: 'photo.webp', filters: [{ name: 'WebP 图片', extensions: ['webp'] }] });
    assert.equal(fs.readdirSync(saveDir).length, filesBefore);
    assert.equal(usagePushes(), 2);
    // The user typed a .jpg name for PNG bytes: the real extension is put back.
    main.saveDialogResult = { canceled: false, filePath: path.join(saveDir, 'renamed.jpg') };
    const renamed = await main.invoke('desktop:save-image-as', { filePath: reference, fileName: 'ref.png' });
    assert.equal(renamed.filePath, path.join(saveDir, 'renamed.jpg.png'));
    assert.ok(fs.readFileSync(renamed.filePath).equals(HISTORY_PIXEL));
    assert.deepEqual(main.saveDialogs[1].filters, [{ name: 'PNG 图片', extensions: ['png'] }]);
    // The next dialog opens where the last save went; a JPEG accepts .jpeg as typed.
    main.saveDialogResult = { canceled: false, filePath: path.join(saveDir, 'typed.JPEG') };
    const typed = await main.invoke('desktop:save-image-as', { base64: jpeg.toString('base64'), mimeType: 'image/jpeg', fileName: 'x' });
    assert.equal(typed.filePath, path.join(saveDir, 'typed.JPEG'));
    assert.deepEqual(main.saveDialogs[2], { title: '另存为', defaultPath: path.join(saveDir, 'x.jpg'), filters: [{ name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }] });
    // Picking the original itself (Windows paths are case-insensitive) saves nothing and counts nothing.
    main.saveDialogResult = { canceled: false, filePath: webp.filePath.toUpperCase() };
    const same = await main.invoke('desktop:save-image-as', { filePath: webp.filePath, fileName: 'photo.webp' });
    assert.deepEqual([same.saved, same.sameFile, same.counted], [false, true, false]);
    assert.ok(fs.readFileSync(webp.filePath).equals(webpBytes), 'the original is untouched');
    assert.equal(usagePushes(), 2);
    main.saveDialogResult = { canceled: true };
    await main.invoke('desktop:save-image-as', { filePath: webp.filePath, fileName: 'photo.webp' });
    // Same folder as the last real save (a same-file pick does not move it). photo.webp is already there from the first
    // save, so the proposed name steps aside instead of making "overwrite" the default action.
    assert.equal(main.saveDialogs.at(-1).defaultPath, path.join(saveDir, 'photo-1.webp'));
    // A header the sniffer doesn't know (a TIFF reference upload) keeps the source's own extension, never .png.
    const tiff = path.join(fixture.cache, 'references', 'ref_3.tiff');
    fs.writeFileSync(tiff, Buffer.from('49492a00080000000000000000000000', 'hex'));
    main.saveDialogResult = { canceled: false, filePath: path.join(saveDir, 'scan') };
    const kept = await main.invoke('desktop:save-image-as', { filePath: tiff, fileName: '扫描.tiff' });
    assert.equal(kept.filePath, path.join(saveDir, 'scan.tiff'));
    assert.deepEqual(main.saveDialogs.at(-1).filters, [{ name: 'TIFF 图片', extensions: ['tiff'] }]);
});

test('the prompt lookup falls back to the whole history index, not just the newest 10', async t => {
    const fixture = createMainHistoryFixture(t, Array.from({ length: 12 }, (_, index) => `r${index}`));
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: {} });
    const oldest = fixture.records[0]; // createdAt ascending: r0 is the 12th newest

    assert.deepEqual(await main.invoke('desktop:get-generated-image-prompt', { filePath: oldest.filePath }),
        { found: true, prompt: 'prompt r0', fileName: 'r0.png' });
    // A copy elsewhere (a reference card's cache, a moved file) is found by its file name.
    assert.deepEqual(await main.invoke('desktop:get-generated-image-prompt', { filePath: path.join(fixture.base, 'moved', 'r0.png'), fileName: 'R0.png' }),
        { found: true, prompt: 'prompt r0', fileName: 'r0.png' });
    assert.deepEqual(await main.invoke('desktop:get-generated-image-prompt', { base64: HISTORY_PIXEL.toString('base64') }),
        { found: false, prompt: '', fileName: '' });
    assert.deepEqual(await main.invoke('desktop:get-generated-image-prompt', { fileName: 'missing.png' }),
        { found: false, prompt: '', fileName: 'missing.png' });
});

test('an image in the in-app bin can be copied and saved from its tile, but it is never counted', async t => {
    const sharp = require('sharp');
    const fixture = createMainHistoryFixture(t, []);
    const image = addFixtureImage(fixture, 'binned.png', await sharp({ create: { width: 6, height: 5, channels: 3, background: '#ff8800' } }).png().toBuffer(),
        { width: 6, height: 5, prompt: 'prompt binned' });
    const saveDir = path.join(fixture.base, 'save-as');
    fs.mkdirSync(saveDir);
    t.mock.method(console, 'warn', () => {});
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: '1', PICGEN_SMOKE_SAVE_AS_DIR: saveDir, PICGEN_SMOKE_CLIPBOARD: null } });
    const marked = await main.invoke('desktop:trash-history-images', { requestId: 'bin-it', items: [{ id: image.id, filePath: image.filePath }], reason: 'selection' });
    assert.equal(marked.trashed.length, 1);

    // The tile hands over the original path (marking never moves a file): readable, but no longer a history record.
    const copied = await main.invoke('desktop:copy-image', { filePath: image.filePath });
    assert.deepEqual([copied.copied, copied.width, copied.height, copied.counted], [true, 6, 5, false]);
    const saved = await main.invoke('desktop:save-image-as', { filePath: image.filePath, fileName: image.fileName });
    assert.deepEqual([saved.saved, saved.fileName, saved.counted], [true, 'binned.png', false]);
    assert.ok(fs.readFileSync(saved.filePath).equals(fs.readFileSync(image.filePath)), 'saved as is');
    assert.deepEqual(main.clipboard, [{ kind: 'image', width: 6, height: 5 }]);
    assert.equal(main.pushes('desktop:history-usage-updated').length, 0);
    const [entry] = (await main.invoke('desktop:list-history-bin')).items;
    assert.ok(entry && !entry.dragCount, 'the bin entry carries no take-out');
});

test('main marks history images into the in-app bin, restores them and purges them for good', async t => {
    const fixture = createMainHistoryFixture(t, ['a', 'b', 'c', 'd', 'e']);
    const [a, b, c, d, e] = fixture.records;
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: '1', PICGEN_SMOKE_PURGE_FAIL: null } });
    const item = record => ({ id: record.id, filePath: record.filePath });
    const names = async () => (await main.invoke('desktop:list-history-images')).map(record => record.fileName).sort();
    const binNames = async () => (await main.invoke('desktop:list-history-bin')).items.map(entry => entry.fileName);

    await main.invoke('desktop:record-history-usage', { filePath: a.filePath, kind: 'reference', source: 'drop' });
    const kept = await main.invoke('desktop:trash-history-images', { requestId: 'keep-a', items: [item(a)], reason: 'selection' });
    assert.deepEqual(kept.skipped, [{ id: a.id, filePath: a.filePath, reason: 'protected' }]);
    await assert.rejects(main.invoke('desktop:trash-history-images', { requestId: 'bad', items: [], reason: 'selection' }), /items/);
    assert.deepEqual(await main.invoke('desktop:get-history-bin-count'), { total: 0 });

    // Marking: the files stay where they are, the records leave history and enter the bin.
    const marked = await main.invoke('desktop:trash-history-images', { requestId: 'b-and-c', items: [item(b), item(c)], reason: 'group-cleanup', groupId: 'sg_1' });
    assert.deepEqual(marked.trashed, [item(b), item(c)]);
    assert.equal(marked.total, 3);
    assert.ok(fs.existsSync(b.filePath) && fs.existsSync(c.filePath), 'marking never moves a file');
    assert.deepEqual(await names(), ['a.png', 'd.png', 'e.png']);
    assert.deepEqual(main.pushes('desktop:history-changed').map(entry => entry.payload), [{ reason: 'trashed', removedIds: [b.id, c.id], addedIds: [] }]);
    assert.deepEqual(main.pushes('desktop:history-bin-changed').map(entry => entry.payload), [{ total: 2 }]);
    assert.deepEqual(await main.invoke('desktop:trash-history-images', { requestId: 'b-and-c', items: [item(b), item(c)], reason: 'group-cleanup' }), marked,
        'a repeated requestId returns the first result');
    assert.deepEqual(await main.invoke('desktop:get-history-bin-count'), { total: 2 });

    const bin = await main.invoke('desktop:list-history-bin');
    assert.equal(bin.total, 2);
    const listedB = bin.items.find(entry => entry.id === b.id);
    assert.equal(listedB.prompt, 'prompt b');
    assert.equal(listedB.filePath, path.resolve(b.filePath));
    assert.ok(listedB.url.startsWith('file:'), 'bin items are hydrated like history records');
    assert.equal(listedB.width, 1);
    assert.equal(listedB.fileSize, HISTORY_PIXEL.length);
    assert.equal(listedB.binReason, 'group-cleanup');
    assert.equal(listedB.binGroupId, 'sg_1');
    assert.equal(typeof listedB.binnedAt, 'number');

    // Drag-to-trash: protected images go straight in when every id is confirmed.
    const dragged = await main.invoke('desktop:trash-history-images', { requestId: 'drag-a', items: [item(a)], includeProtected: true, confirmProtected: [a.id], reason: 'drag' });
    assert.deepEqual(dragged.trashed, [item(a)]);
    const newest = (await main.invoke('desktop:list-history-bin')).items[0];
    assert.equal(newest.id, a.id, 'newest-trashed first');
    assert.equal(newest.referenceCount, 1, 'bin items carry the usage projection');
    assert.equal(newest.binReason, 'drag');

    // Restore c: it comes back with its prompt, hydrated.
    const restored = await main.invoke('desktop:restore-history-bin', { paths: [c.filePath] });
    assert.deepEqual(restored, { restored: [c.id], missing: [], failed: [] });
    const history = await main.invoke('desktop:list-history-images');
    assert.equal(history.find(record => record.id === c.id).prompt, 'prompt c', 'restored with its prompt');
    assert.ok(history.find(record => record.id === c.id).url.startsWith('file:'), 'restored records are hydrated');
    assert.deepEqual(main.pushes('desktop:history-changed').at(-1).payload, { reason: 'restored', removedIds: [], addedIds: [c.id] });
    assert.deepEqual(main.pushes('desktop:history-bin-changed').at(-1).payload, { total: 2 });
    assert.deepEqual(readTombstonePaths(fixture), ['a.png', 'b.png']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.cache, 'history-trash.json'), 'utf8')).version, 2);

    // Relaunch: binned files are still on disk in the images folder, yet discovery never re-adds them;
    // b was deleted outside PicGen meanwhile, so its entry is dropped.
    fs.rmSync(b.filePath);
    const relaunched = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: '1', PICGEN_SMOKE_PURGE_FAIL: null } });
    assert.deepEqual((await relaunched.invoke('desktop:list-history-images')).map(record => record.fileName).sort(), ['c.png', 'd.png', 'e.png']);
    assert.deepEqual(readTombstonePaths(fixture), ['a.png']);
    const persisted = JSON.parse(fs.readFileSync(path.join(fixture.cache, 'recent-images.json'), 'utf8'));
    assert.deepEqual(persisted.images.map(record => record.fileName).sort(), ['c.png', 'd.png', 'e.png']);
    assert.deepEqual(await relaunched.invoke('desktop:get-history-bin-count'), { total: 1 });

    // Purge: a refused unlink keeps the file and the entry; the next one deletes the file for good,
    // with its cached history thumbnail.
    process.env.PICGEN_SMOKE_PURGE_FAIL = 'A.PNG';
    const refused = await relaunched.invoke('desktop:purge-history-bin', { paths: [a.filePath] });
    delete process.env.PICGEN_SMOKE_PURGE_FAIL;
    assert.deepEqual(refused.deleted, []);
    assert.deepEqual(refused.failed.map(entry => path.basename(entry.filePath)), ['a.png']);
    assert.ok(fs.existsSync(a.filePath));
    const thumbnails = path.join(fixture.cache, 'thumbnails');
    fs.mkdirSync(thumbnails, { recursive: true });
    const { historyThumbnailKey } = require('../historyThumbnailKey');
    const thumbnail = path.join(thumbnails, historyThumbnailKey(path.resolve(a.filePath), fs.statSync(a.filePath)));
    fs.writeFileSync(thumbnail, 'thumb');
    const purged = await relaunched.invoke('desktop:purge-history-bin');
    assert.deepEqual(purged, { deleted: [path.resolve(a.filePath)], failed: [] });
    assert.ok(!fs.existsSync(a.filePath), 'purge hard-deletes the file');
    await waitUntil(() => !fs.existsSync(thumbnail), 'the purged thumbnail is removed');
    assert.deepEqual(await binNames(), []);
    assert.deepEqual((await relaunched.invoke('desktop:list-history-bin')), { items: [], total: 0 });
    assert.deepEqual(relaunched.pushes('desktop:history-bin-changed').at(-1).payload, { total: 0 });
    assert.equal(main.realTrashCalls + relaunched.realTrashCalls, 0, 'the Windows Recycle Bin is never used');
});

test('the launch-time pass keeps binned files out of history and drops only provably gone entries', async t => {
    const fixture = createMainHistoryFixture(t, ['a', 'b', 'c']);
    const [a, b, c] = fixture.records;
    // lstat of a path holding a NUL fails with ERR_INVALID_ARG_VALUE, not ENOENT: presence unknown.
    const ghost = { ...a, id: 'task_ghost', filePath: path.join(fixture.images, 'gh\u0000ost.png'), fileName: 'gh\u0000ost.png', createdAt: 900 };
    // An orphan file on disk that is in the bin, and one that is not.
    const binnedOrphan = path.join(fixture.images, 'binned-orphan.png');
    const freshOrphan = path.join(fixture.images, 'fresh-orphan.png');
    fs.writeFileSync(binnedOrphan, HISTORY_PIXEL);
    fs.writeFileSync(freshOrphan, HISTORY_PIXEL);
    // c is both in the index and in the bin (a crash between the bin save and the index commit).
    fs.writeFileSync(path.join(fixture.cache, 'recent-images.json'), JSON.stringify({ schemaVersion: 4, images: [a, c, ghost] }));
    fs.rmSync(b.filePath);
    const entry = (filePath, record) => ({ path: filePath, trashedAt: Date.now(), batchId: 'trash_seed', reason: 'selection', record });
    fs.writeFileSync(path.join(fixture.cache, 'history-trash.json'), JSON.stringify({ version: 1, entries: [
        entry(b.filePath, b), entry(ghost.filePath, ghost), entry(c.filePath, c), entry(binnedOrphan, { id: 'task_orphan', fileName: 'binned-orphan.png' })
    ] }));

    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: {} });
    const history = await main.invoke('desktop:list-history-images');
    assert.deepEqual(history.map(record => record.fileName).sort(), ['a.png', 'fresh-orphan.png'],
        'binned records leave history, a binned orphan is never discovered, a fresh orphan is');
    const stored = JSON.parse(fs.readFileSync(path.join(fixture.cache, 'history-trash.json'), 'utf8'));
    assert.deepEqual(stored.entries.map(saved => path.basename(saved.path)).sort(), ['binned-orphan.png', 'c.png', 'gh\u0000ost.png'],
        'only the provably gone entry is dropped');
    assert.equal(stored.version, 2);
});

test('the focus sweep runs at most once per 5 s unless forced, and drops entries whose file is gone', async t => {
    const fixture = createMainHistoryFixture(t, ['a', 'b']);
    const [a, b] = fixture.records;
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: '1' } });
    let clock = 1_000_000;
    t.mock.method(Date, 'now', () => clock);
    const nothing = { dropped: [], total: 0 };

    assert.deepEqual(await main.invoke('desktop:smoke-history-bin-sweep', { force: false }), nothing, 'the first unforced call runs');
    clock += 4999;
    assert.equal(await main.invoke('desktop:smoke-history-bin-sweep', { force: false }), null, 'a second call within 5 s is throttled');
    clock += 1;
    assert.deepEqual(await main.invoke('desktop:smoke-history-bin-sweep', { force: false }), nothing, 'after 5 s it runs again');
    clock += 1;
    assert.deepEqual(await main.invoke('desktop:smoke-history-bin-sweep'), nothing, 'the smoke trigger forces by default');
    assert.deepEqual(await main.invoke('desktop:smoke-history-bin-sweep', { force: true }), nothing);
    assert.equal(await main.invoke('desktop:smoke-history-bin-sweep', { force: false }), null, 'a forced run restarts the window');

    await main.invoke('desktop:trash-history-images', { requestId: 'ab', items: [a, b].map(record => ({ id: record.id, filePath: record.filePath })), reason: 'selection' });
    fs.rmSync(a.filePath);
    const swept = await main.invoke('desktop:smoke-history-bin-sweep');
    assert.deepEqual(swept, { dropped: [path.resolve(a.filePath)], total: 1 });
    assert.deepEqual(readTombstonePaths(fixture), ['b.png']);
    assert.deepEqual(main.pushes('desktop:history-bin-changed').at(-1).payload, { total: 1 });
    assert.deepEqual(await main.invoke('desktop:list-history-images'), [], 'a sweep never brings anything back into history');
    assert.equal(main.realTrashCalls, 0);
});

test('history lists every record and the bin refuses to work while the sidecars are unreadable', async t => {
    const fixture = createMainHistoryFixture(t, ['a', 'b']);
    const [a, b] = fixture.records;
    // An orphan that may be a binned file: it must not be discovered while the bin cannot be read.
    fs.writeFileSync(path.join(fixture.images, 'maybe-binned.png'), HISTORY_PIXEL);
    // Directories where the sidecar files belong: every read fails with EISDIR.
    fs.mkdirSync(path.join(fixture.cache, 'history-trash.json'));
    fs.mkdirSync(path.join(fixture.cache, 'history-usage.json'));
    t.mock.method(console, 'warn', () => {});
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: {} });

    const history = await main.invoke('desktop:list-history-images');
    assert.deepEqual(history.map(record => record.id).sort(), [a.id, b.id].sort());
    const recent = await main.invoke('desktop:list-recent-images', { limit: 10 });
    assert.deepEqual(recent.map(record => record.id).sort(), [a.id, b.id].sort());

    await assert.rejects(main.invoke('desktop:trash-history-images', { requestId: 'unreadable', items: [{ id: a.id, filePath: a.filePath }], reason: 'selection' }));
    await assert.rejects(main.invoke('desktop:list-history-bin'));
    await assert.rejects(main.invoke('desktop:restore-history-bin'));
    await assert.rejects(main.invoke('desktop:purge-history-bin'));
    assert.ok(fs.existsSync(a.filePath));
    assert.ok(fs.existsSync(b.filePath));
    assert.ok(fs.statSync(path.join(fixture.cache, 'history-trash.json')).isDirectory(), 'the unreadable sidecar is left alone');
    assert.ok(fs.statSync(path.join(fixture.cache, 'history-usage.json')).isDirectory());
    assert.deepEqual((await main.invoke('desktop:list-history-images')).map(record => record.id).sort(), [a.id, b.id].sort(),
        'the refused mark removed nothing from history');
    const stored = JSON.parse(fs.readFileSync(path.join(fixture.cache, 'recent-images.json'), 'utf8'));
    assert.equal(stored.images.length, 2);
    assert.equal(main.realTrashCalls, 0);
});

test('smoke event-loop monitor reports the delay in excess of the timer floor', async t => {
    const fixture = createMainHistoryFixture(t, []);
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: '1' } });
    await assert.rejects(async () => main.invoke('desktop:smoke-event-loop', 'stop'), /not started/);
    assert.deepEqual(await main.invoke('desktop:smoke-event-loop', 'start'), { started: true });
    await new Promise(resolve => setTimeout(resolve, 120));
    const busyUntil = performance.now() + 40;
    while (performance.now() < busyUntil) { /* block the loop once */ }
    await new Promise(resolve => setTimeout(resolve, 60));
    const stats = await main.invoke('desktop:smoke-event-loop', { op: 'stop' });
    assert.ok(stats.samples > 0);
    for (const [excess, raw] of [['excessP99Ms', 'p99'], ['excessMaxMs', 'max'], ['excessMeanMs', 'mean']]) {
        assert.equal(typeof stats[excess], 'number', `${excess} is missing`);
        assert.ok(stats[excess] >= 0, `${excess} is negative`);
        assert.ok(Math.abs(stats[excess] - (stats[raw] - stats.min)) <= 0.02,`${excess} is ${raw} - min`);
    }
    assert.ok(stats.excessMaxMs >= 25, `a 40 ms block shows in excessMaxMs (${stats.excessMaxMs})`);
    assert.ok(stats.excessMaxMs < stats.max, 'the excess fields leave out the timer floor');
});

test('before-quit holds the quit for the similarity flush once', async t => {
    const fixture = createMainHistoryFixture(t, ['a']);
    const main = loadMainWithStubElectron(t, { userData: fixture.userData, env: { PICGEN_SMOKE: '1' } });
    await main.invoke('desktop:smoke-similarity-status'); // creates the service (no host starts in tests)
    const quitEvent = () => ({ prevented: 0, preventDefault() { this.prevented += 1; } });

    const first = quitEvent();
    main.emitApp('before-quit', first);
    assert.equal(first.prevented, 1, 'the first before-quit waits for the similarity flush');
    await waitUntil(() => main.quitCalls === 1, 'the quit resumes after the flush');
    const second = quitEvent();
    main.emitApp('before-quit', second);
    assert.equal(second.prevented, 0, 'the resumed quit is never held again');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(main.quitCalls, 1);
});

test('queue is a standalone right-side view with live task controls', () => {
    const html = require('../scripts/read-ui-source')();
    const renderer = fs.readFileSync(require.resolve('../desktop.js'), 'utf8');
    const styles = fs.readFileSync(require.resolve('../workspace.css'), 'utf8');

    assert.match(html, /id="queuePage"/);
    assert.match(html, /id="queueRunningCount"/);
    assert.match(html, /id="queuePendingCount"/);
    assert.match(html, /data-lucide="refresh-cw"/);
    assert.match(html, /data-lucide="square-x"/);
    assert.doesNotMatch(html, /id="queueOverlay"|id="queueCloseBtn"/);
    assert.match(renderer, /state\.activeView = 'queue'/);
    assert.match(renderer, /function renderQueue\(\)/);
    assert.match(renderer, /state\.activeView === 'queue'/);
    assert.match(styles, /\.queue-page[\s\S]*grid-row:\s*1 \/ -1/);
    assert.match(styles, /\.queue-list-head,[\s\S]*\.queue-item/);
});

test('adds the selected aspect ratio to the upstream prompt', () => {
    const ratioPrompt = _test.withAspectRatioInstruction('产品摄影，画面中已有9:16字样', '9:16');
    assert.equal(
        ratioPrompt,
        '产品摄影，画面中已有9:16字样\n\n构图要求：画面宽高比必须严格为 9:16，不要输出其他比例。'
    );
    assert.equal(
        _test.withAspectRatioInstruction(ratioPrompt, '9:16'),
        ratioPrompt,
        'the standard instruction must be idempotent'
    );
    assert.equal(_test.withAspectRatioInstruction('自由构图', 'auto'), '自由构图');
    assert.equal(
        _test.withAspectRatioInstruction(
            '自定义画布',
            '1:1',
            { gptImageWidth: 1600, gptImageHeight: 1200 },
            'custom'
        ),
        '自定义画布\n\n构图要求：画面宽高比必须严格为 4:3，不要输出其他比例。'
    );
    assert.equal(_test.promptAspectRatio('1152x2048'), '9:16');
});

test('builds Gemini native generateContent body', () => {
    const result = _test.buildGeminiGenerateContentRequest({
        model: 'gemini-3.1-flash-image-preview-2k',
        prompt: 'A red paper sculpture',
        ratio: '1:8',
        imageSize: '1K',
        referenceImages: [{ mimeType: 'image/png', base64: 'aGVsbG8=' }],
        generationConfig: {
            responseModalities: 'IMAGE',
            thinkingLevel: 'high',
            includeThoughts: true,
            temperature: 0.7,
            topP: 0.9,
            topK: 40,
            googleSearch: true,
            imageSearch: true
        }
    });

    assert.equal(result.baseModel, 'gemini-3.1-flash-image-preview');
    assert.deepEqual(result.requestBody.generationConfig.responseModalities, ['IMAGE']);
    assert.deepEqual(result.requestBody.generationConfig.imageConfig, {
        aspectRatio: '1:8',
        imageSize: '2K'
    });
    assert.equal(result.requestBody.generationConfig.responseFormat, undefined);
    assert.deepEqual(result.requestBody.generationConfig.thinkingConfig, {
        includeThoughts: true,
        thinkingLevel: 'High'
    });
    assert.deepEqual(result.requestBody.tools, [{
        google_search: {
            searchTypes: {
                webSearch: {},
                imageSearch: {}
            }
        }
    }]);
    assert.equal(result.requestBody.contents[0].parts[1].inline_data.mime_type, 'image/png');
});

test('uses Gemini preview imageConfig for gemini-3-pro-image-preview', () => {
    const result = _test.buildGeminiGenerateContentRequest({
        model: 'gemini-3-pro-image-preview',
        prompt: 'A wide test scene',
        ratio: '16:9',
        imageSize: '2K',
        generationConfig: { responseModalities: 'TEXT_IMAGE' }
    });

    assert.equal(result.imageConfigField, 'imageConfig');
    assert.deepEqual(result.requestBody.generationConfig.imageConfig, {
        aspectRatio: '16:9',
        imageSize: '2K'
    });
    assert.equal(result.requestBody.generationConfig.responseFormat, undefined);
});

test('selects the last non-thought image from a Gemini native response', async () => {
    const result = await _test.parseJsonResponse({
        candidates: [{
            content: {
                parts: [
                    { thought: true, text: 'Composing the image' },
                    { thought: true, inlineData: { mimeType: 'image/png', data: 'dGhvdWdodA==' } },
                    { inlineData: { mimeType: 'image/png', data: 'Zmlyc3Q=' } },
                    { inlineData: { mimeType: 'image/png', data: 'ZmluYWw=' } }
                ]
            }
        }],
        usageMetadata: { totalTokenCount: 12 }
    }, true);

    assert.equal(result.base64, 'ZmluYWw=');
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.thoughtText, 'Composing the image');
    assert.deepEqual(result.usageMetadata, { totalTokenCount: 12 });
});

test('builds OpenAI Images API parameters for GPT Image and DALL-E', () => {
    const image2 = _test.buildOpenAIImageRequest({
        model: 'gpt-image-2',
        prompt: 'A glass pavilion',
        size: '2048x1152',
        generationConfig: {
            gptQuality: 'high',
            gptBackground: 'opaque',
            outputMimeType: 'image/webp',
            imageCompression: 72,
            moderation: 'low',
            stream: true,
            partialImages: 2,
            user: 'desktop-user'
        }
    });

    assert.deepEqual(image2, {
        model: 'gpt-image-2',
        prompt: 'A glass pavilion',
        size: '2048x1152',
        n: 1,
        quality: 'high',
        background: 'opaque',
        output_format: 'webp',
        output_compression: 72,
        moderation: 'low',
        stream: false,
        user: 'desktop-user'
    });
    assert.equal(image2.partial_images, undefined);

    const dalle3 = _test.buildOpenAIImageRequest({
        model: 'dall-e-3',
        prompt: 'A moonlit harbor',
        size: '1792x1024',
        generationConfig: {
            gptQuality: 'hd',
            responseFormat: 'b64_json',
            style: 'natural'
        }
    });

    assert.equal(dalle3.quality, 'hd');
    assert.equal(dalle3.response_format, 'b64_json');
    assert.equal(dalle3.style, 'natural');
    assert.equal(dalle3.output_format, undefined);
});

test('builds Grok native image generation and edit bodies', () => {
    const generation = _test.buildXAIImageRequest({
        model: 'grok-imagine-image-quality',
        prompt: 'A neon city in rain',
        ratio: '1:1',
        imageSize: '1K'
    });

    assert.equal(generation.endpoint, 'generations');
    assert.deepEqual(generation.requestBody, {
        model: 'grok-imagine-image-quality',
        prompt: 'A neon city in rain',
        n: 1,
        size: '1024x1024'
    });

    const edit = _test.buildXAIImageRequest({
        model: 'grok4.5',
        prompt: 'Combine these subjects',
        ratio: '16:9',
        imageSize: '1k',
        referenceImages: [
            { mimeType: 'image/png', base64: 'YWJj' },
            { mimeType: 'image/jpeg', base64: 'ZGVm' }
        ]
    });

    assert.equal(edit.endpoint, 'edits');
    assert.equal(edit.requestBody.model, 'grok4.5');
    assert.equal(edit.requestBody.size, '1536x864');
    assert.equal(edit.requestBody.image.length, 2);
    assert.equal(edit.requestBody.image[0], 'data:image/png;base64,YWJj');
    assert.equal(edit.requestBody.image[1], 'data:image/jpeg;base64,ZGVm');
});

test('builds the official Grok Imagine request format without changing legacy relay aliases', () => {
    const imagine = _test.buildXAIImageRequest({
        model: 'grok-imagine-image',
        prompt: 'A glass pavilion',
        ratio: '21:9',
        imageSize: '2K',
        generationConfig: { responseFormat: 'b64_json' }
    });
    assert.deepEqual(imagine, {
        endpoint: 'generations',
        requestBody: {
            model: 'grok-imagine-image',
            prompt: 'A glass pavilion',
            n: 1,
            aspect_ratio: '21:9',
            resolution: '2k',
            response_format: 'b64_json'
        }
    });

    const imagine2 = _test.buildXAIImageRequest({
        model: 'xai/grok-imagine-image-2.0',
        prompt: 'A product studio',
        ratio: '5:2',
        imageSize: '1k',
        generationConfig: { n: 3, gptQuality: 'low', nativeResponseFormat: 'url' }
    });
    assert.deepEqual(imagine2.requestBody, {
        model: 'xai/grok-imagine-image-2.0',
        prompt: 'A product studio',
        n: 3,
        aspect_ratio: '5:2',
        resolution: '1k',
        quality: 'low',
        response_format: 'url'
    });

    assert.throws(() => _test.buildXAIImageRequest({
        model: 'grok-imagine-image-2.0',
        prompt: 'test',
        ratio: '1:1',
        imageSize: '1k',
        generationConfig: { gptQuality: 'high' }
    }), /不支持的 Grok 质量/);
    assert.throws(() => _test.buildXAIImageRequest({
        model: 'grok-imagine-image',
        prompt: 'test',
        ratio: '1:1',
        imageSize: '1k',
        generationConfig: { gptQuality: 'low' }
    }), /仅支持 grok-imagine-image-2\.0/);

    const explicitlySelected = _test.buildXAIImageRequest({
        model: 'custom-grok-model',
        prompt: 'Explicit protocol selection',
        ratio: '16:9',
        imageSize: '2k',
        generationConfig: { xaiNative: true, responseFormat: 'url' }
    });
    assert.deepEqual(explicitlySelected.requestBody, {
        model: 'custom-grok-model',
        prompt: 'Explicit protocol selection',
        n: 1,
        aspect_ratio: '16:9',
        resolution: '2k',
        response_format: 'url'
    });
});

test('builds native endpoint URLs without using the relay hostname for protocol selection', () => {
    assert.equal(
        _test.openAIImagesUrl('https://api.example.com', 'generations'),
        'https://api.example.com/v1/images/generations'
    );
    assert.equal(
        _test.geminiGenerateContentUrl('https://api.example.com', 'gemini-3.1-flash-image', 'secret key'),
        'https://api.example.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=secret%20key'
    );
    assert.equal(
        _test.geminiGenerateContentUrl('https://api.example.com', '[zz]gemini-3.1-flash-image-preview', 'secret key'),
        'https://api.example.com/v1beta/models/[zz]gemini-3.1-flash-image-preview:generateContent?key=secret%20key'
    );
});

test('exposes Grok Imagine as an explicit provider protocol', () => {
    const source = fs.readFileSync(require.resolve('../desktop.js'), 'utf8');
    assert.match(source, /\['xai-imagine', 'Grok Imagine'\]/);
    const router = require('../protocolRouter');
    assert.equal(router.normalizeProtocol('xai-imagine'), router.PROTOCOLS.XAI_IMAGINE);
    assert.equal(router.inferProtocol({ baseUrl: 'https://api.example.com', modelRouting: {
        'custom-image': { protocol: 'xai-imagine' }
    } }, 'custom-image'), router.PROTOCOLS.XAI_IMAGINE);
});

test('generateImage sends each configured model through its native protocol', async (t) => {
    const requests = [];
    const server = http.createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            const parsedBody = JSON.parse(body);
            requests.push({
                url: request.url,
                headers: request.headers,
                body: parsedBody
            });
            response.writeHead(200, { 'Content-Type': 'application/json' });
            if (request.url.includes(':generateContent')) {
                response.end(JSON.stringify({
                    candidates: [{
                        content: {
                            parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }]
                        }
                    }]
                }));
            } else {
                const mimeType = parsedBody.model === 'grok-imagine-image-2.0' ? 'image/webp' : 'image/png';
                response.end(JSON.stringify({ data: [{ b64_json: 'YWJj', mime_type: mimeType }] }));
            }
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));

    const address = server.address();
    const provider = `http://127.0.0.1:${address.port}`;
    const common = { provider, apiKey: 'test-key', prompt: 'test prompt', ratio: '1:1', imageSize: '1K' };

    await generateImage({ ...common, model: 'gpt-image-2', generationConfig: { stream: true, partialImages: 3 } });
    await generateImage({ ...common, model: 'gemini-3.1-flash-image-preview' });
    await generateImage({ ...common, model: 'grok-imagine-image-quality' });
    await generateImage({ ...common, model: 'doubao-seedream-5-0-260128', generationConfig: { stream: true } });
    await generateImage({ ...common, model: 'gpt-image-2', ratio: '16:9', imageSize: '4K' });
    await generateImage({ ...common, model: 'gpt-image-2', ratio: '1:1', imageSize: '4K' });
    await generateImage({ ...common, model: 'gpt-image-2', ratio: '2:3', imageSize: '2K' });
    await generateImage({
        ...common,
        model: 'gpt-image-2',
        ratio: '1:1',
        imageSize: 'custom',
        generationConfig: { gptImageWidth: 1600, gptImageHeight: 1200 }
    });
    const grok2Result = await generateImage({
        ...common,
        model: 'grok-imagine-image-2.0',
        ratio: '21:9',
        imageSize: '2K',
        generationConfig: { gptQuality: 'medium', responseFormat: 'b64_json' }
    });

    assert.equal(requests[0].url, '/v1/images/generations');
    assert.equal(requests[0].body.model, 'gpt-image-2');
    assert.equal(requests[0].body.size, '1024x1024');
    assert.equal(
        requests[0].body.prompt,
        'test prompt\n\n构图要求：画面宽高比必须严格为 1:1，不要输出其他比例。'
    );
    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[0].body.partial_images, undefined);
    assert.equal(requests[0].headers.authorization, 'Bearer test-key');
    assert.equal(requests[0].headers.accept, 'application/json');

    assert.equal(
        requests[1].url,
        '/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=test-key'
    );
    assert.equal(requests[1].body.generationConfig.imageConfig.aspectRatio, '1:1');
    assert.equal(
        requests[1].body.contents[0].parts[0].text,
        'test prompt\n\n构图要求：画面宽高比必须严格为 1:1，不要输出其他比例。'
    );
    assert.equal(requests[1].body.stream, undefined);
    assert.equal(requests[1].headers['x-goog-api-key'], 'test-key');

    assert.equal(requests[2].url, '/v1/images/generations');
    assert.deepEqual(requests[2].body, {
        model: 'grok-imagine-image-quality',
        prompt: 'test prompt\n\n构图要求：画面宽高比必须严格为 1:1，不要输出其他比例。',
        n: 1,
        size: '1024x1024'
    });

    assert.equal(requests[3].url, '/v1/images/generations');
    assert.equal(requests[3].body.model, 'doubao-seedream-5-0-260128');
    assert.equal(
        requests[3].body.prompt,
        'test prompt\n\n构图要求：画面宽高比必须严格为 1:1，不要输出其他比例。'
    );
    assert.equal(requests[3].body.stream, false);
    assert.equal(requests[4].body.size, '3840x2160');
    assert.match(requests[4].body.prompt, /宽高比必须严格为 16:9/);
    assert.equal(requests[5].body.size, '2880x2880');
    assert.equal(requests[6].body.size, '1344x2016');
    assert.equal(requests[7].body.size, '1600x1200');
    assert.match(requests[7].body.prompt, /宽高比必须严格为 4:3/);
    assert.equal(requests[8].url, '/v1/images/generations');
    assert.deepEqual(requests[8].body, {
        model: 'grok-imagine-image-2.0',
        prompt: 'test prompt\n\n构图要求：画面宽高比必须严格为 21:9，不要输出其他比例。',
        n: 1,
        aspect_ratio: '21:9',
        resolution: '2k',
        quality: 'medium',
        response_format: 'b64_json'
    });
    assert.equal(grok2Result.mimeType, 'image/webp');
});

test('uses HTTP 202 and a background queue for asynchronous generation', () => {
    const serverSource = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const queueSource = fs.readFileSync(require.resolve('../taskQueue.js'), 'utf8');

    assert.match(serverSource, /res\.status\(202\)\.json\(\{ taskId, status: 'pending' \}\)/);
    assert.match(queueSource, /this\._executeTask\(task\);/);
    assert.doesNotMatch(queueSource, /await\s+this\._executeTask\(task\)/);
    assert.match(queueSource, /stream:\s*false/);
    assert.match(queueSource, /disableStream:\s*true/);
});

test('returns an asynchronous task before the non-streaming upstream request completes', async (t) => {
    let releaseUpstream;
    let upstreamReleased = false;
    const upstreamGate = new Promise(resolve => {
        releaseUpstream = () => {
            if (upstreamReleased) return;
            upstreamReleased = true;
            resolve();
        };
    });

    const upstream = http.createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', async () => {
            const payload = JSON.parse(body);
            assert.equal(payload.stream, false);
            await upstreamGate;
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ data: [{ b64_json: 'YWJj', mime_type: 'image/png' }] }));
        });
    });
    await new Promise((resolve, reject) => {
        upstream.once('error', reject);
        upstream.listen(0, '127.0.0.1', resolve);
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-async-test-'));
    const providerStoreFile = path.join(tempDir, 'providers.json');
    const chatProviderStoreFile = path.join(tempDir, 'chat-providers.json');
    fs.writeFileSync(providerStoreFile, JSON.stringify({ providers: [{ id: 'placeholder', name: 'Placeholder' }] }));
    fs.writeFileSync(chatProviderStoreFile, JSON.stringify({ providers: [{ id: 'placeholder-chat', name: 'Placeholder' }] }));

    const runtime = await startServer({
        port: 0,
        host: '127.0.0.1',
        providerStoreFile,
        chatProviderStoreFile
    });

    t.after(async () => {
        releaseUpstream();
        runtime.close();
        await new Promise(resolve => upstream.close(resolve));
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const upstreamAddress = upstream.address();
    const enqueueResponse = await fetch(`${runtime.url}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sequenceId: 'async-sequence',
            provider: `http://127.0.0.1:${upstreamAddress.port}`,
            apiKey: 'test-key',
            model: 'gpt-image-2',
            prompt: 'async test',
            ratio: '1:1',
            imageSize: '1K',
            generationConfig: { stream: true, partialImages: 3 }
        })
    });

    assert.equal(enqueueResponse.status, 202);
    const accepted = await enqueueResponse.json();
    assert.equal(accepted.status, 'pending');
    assert.match(accepted.taskId, /^task_/);

    const runningResponse = await fetch(`${runtime.url}/api/tasks/${accepted.taskId}`);
    const runningTask = await runningResponse.json();
    assert.ok(['pending', 'running'].includes(runningTask.status));

    releaseUpstream();
    let completedTask = runningTask;
    const deadline = Date.now() + 3000;
    while (completedTask.status !== 'completed' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
        const response = await fetch(`${runtime.url}/api/tasks/${accepted.taskId}`);
        completedTask = await response.json();
    }

    assert.equal(completedTask.status, 'completed');
    assert.equal(completedTask.result.base64, 'YWJj');
});

test('reverse prompt uses the selected prompt optimizer vision provider', async (t) => {
    let upstreamPayload = null;
    const upstream = http.createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            assert.equal(request.url, '/v1/chat/completions');
            assert.equal(request.headers.authorization, 'Bearer vision-key');
            upstreamPayload = JSON.parse(body);
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({
                choices: [{ message: { content: '居中产品摄影，金属材质，柔和棚拍光线' } }]
            }));
        });
    });
    await new Promise((resolve, reject) => {
        upstream.once('error', reject);
        upstream.listen(0, '127.0.0.1', resolve);
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-reverse-prompt-test-'));
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
    const providerStoreFile = path.join(tempDir, 'providers.json');
    const chatProviderStoreFile = path.join(tempDir, 'chat-providers.json');
    fs.writeFileSync(providerStoreFile, JSON.stringify({ providers: [] }));
    fs.writeFileSync(chatProviderStoreFile, JSON.stringify({ providers: [{
        id: 'vision-provider',
        name: 'Vision Provider',
        baseUrl: upstreamUrl,
        apiKey: 'vision-key',
        models: ['vision-model'],
        activeModel: 'vision-model'
    }] }));
    const runtime = await startServer({
        port: 0,
        host: '127.0.0.1',
        providerStoreFile,
        chatProviderStoreFile,
        failoverConfigFile: path.join(tempDir, 'failover.json'),
        proxyConfigFile: path.join(tempDir, 'proxy.json')
    });
    t.after(async () => {
        runtime.close();
        await new Promise(resolve => upstream.close(resolve));
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const response = await fetch(`${runtime.url}/api/prompts/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chatProviderId: 'vision-provider',
            instruction: '重点分析材质和光线',
            image: { base64: 'aGVsbG8=', mimeType: 'image/png' }
        })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        prompt: '居中产品摄影，金属材质，柔和棚拍光线'
    });
    assert.equal(upstreamPayload.model, 'vision-model');
    assert.match(upstreamPayload.messages[0].content, /图像提示词分析师/);
    assert.equal(upstreamPayload.messages[1].content[0].text, '重点分析材质和光线');
    assert.match(upstreamPayload.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('discovers and persists selectable models without a preconfigured model', async (t) => {
    const upstream = http.createServer((request, response) => {
        assert.equal(request.url, '/v1/models');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
            data: [
                { id: 'gpt-image-2', supported_endpoint_types: ['image-generation'] },
                { id: 'custom-provider-image' }
            ]
        }));
    });
    await new Promise((resolve, reject) => {
        upstream.once('error', reject);
        upstream.listen(0, '127.0.0.1', resolve);
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-discovery-test-'));
    const providerStoreFile = path.join(tempDir, 'providers.json');
    const chatProviderStoreFile = path.join(tempDir, 'chat-providers.json');
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
    fs.writeFileSync(providerStoreFile, JSON.stringify({ providers: [{
        id: 'discovery-provider',
        name: 'Discovery Provider',
        baseUrl: upstreamUrl,
        apiKey: 'test-key',
        models: []
    }] }));
    fs.writeFileSync(chatProviderStoreFile, JSON.stringify({ providers: [] }));

    const runtime = await startServer({
        port: 0,
        host: '127.0.0.1',
        providerStoreFile,
        chatProviderStoreFile
    });
    t.after(async () => {
        runtime.close();
        await new Promise(resolve => upstream.close(resolve));
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const discoveryResponse = await fetch(`${runtime.url}/api/providers/discovery-provider/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    assert.equal(discoveryResponse.status, 200);
    const discovery = await discoveryResponse.json();
    assert.deepEqual(discovery.models.map(item => item.id), ['gpt-image-2', 'custom-provider-image']);

    const providers = await fetch(`${runtime.url}/api/providers`).then(response => response.json());
    const provider = providers.find(item => item.id === 'discovery-provider');
    assert.deepEqual(provider.models, []);
    assert.deepEqual(provider.discoveredModels.map(item => item.id), ['gpt-image-2', 'custom-provider-image']);
    assert.ok(provider.modelCapabilities['gpt-image-2'].supported_endpoint_types.includes('image-generation'));
    assert.ok(provider.modelCapabilities['custom-provider-image']);
});
