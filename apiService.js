// Server-side image API client with model-driven native protocol routing.
const http = require('http');
const https = require('https');
const net = require('net');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { readPromptStream } = require('./promptStream');
const imageApiProfiles = require('./imageApiProfiles');
const { PROTOCOLS, normalizeProtocol, inferProtocol } = require('./protocolRouter');
const grsaiNanoBanana = require('./imageAdapters/grsaiNanoBanana');
const grsaiGptImage = require('./imageAdapters/grsaiGptImage');
const { throwIfAborted, createLinkedAbortController, delay, withRequestTimeout } = require('./requestLifecycle');

// Relay stations sit behind slow TLS terminators; observed handshakes range from
// 0.6s to 8.4s on the same host. Without connection reuse every request pays it
// again, so keep sockets warm across the whole session.
const KEEP_ALIVE_OPTIONS = {
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 64,
    maxFreeSockets: 16,
    timeout: 300000,
    scheduling: 'lifo'
};
const httpAgent = new http.Agent(KEEP_ALIVE_OPTIONS);
const httpsAgent = new https.Agent(KEEP_ALIVE_OPTIONS);

// Proxy behaviour is decided per request. node-fetch v2 ignores HTTP(S)_PROXY on
// its own, so "direct" simply means handing it a plain keep-alive agent.
let proxyState = { mode: 'direct', customProxy: '' };
const proxyAgentCache = new Map();

function setProxyState(config = {}) {
    const mode = ['direct', 'system', 'custom'].includes(config.mode) ? config.mode : 'direct';
    const customProxy = String(config.customProxy || '');
    if (proxyState.mode === mode && proxyState.customProxy === customProxy) return proxyState;

    for (const agent of proxyAgentCache.values()) {
        if (typeof agent.destroy === 'function') agent.destroy();
    }
    proxyAgentCache.clear();
    proxyState = { mode, customProxy };
    console.log(`[Proxy] 模式=${mode}${mode === 'custom' ? `, 代理=${sanitizeProxyUrl(customProxy)}` : ''}`);
    return proxyState;
}

function getProxyState() {
    return { ...proxyState };
}

function sanitizeProxyUrl(value) {
    try {
        const parsed = new URL(String(value));
        if (parsed.username || parsed.password) {
            parsed.username = '***';
            parsed.password = '';
        }
        return parsed.toString();
    } catch {
        return String(value || '').replace(/\/\/[^@/]+@/, '//***@');
    }
}

function resolveProxyUrl(targetUrl) {
    if (proxyState.mode === 'direct') return '';
    if (proxyState.mode === 'custom') return proxyState.customProxy;
    const { environmentProxyFor } = require('./proxyConfig');
    return environmentProxyFor(targetUrl);
}

function proxyAgentFor(proxyUrl, targetUrl) {
    const isHttpsTarget = !String(targetUrl || '').startsWith('http:');
    const cacheKey = `${isHttpsTarget ? 'https' : 'http'}|${proxyUrl}`;
    const cached = proxyAgentCache.get(cacheKey);
    if (cached) return cached;

    let agent;
    try {
        if (/^socks/i.test(proxyUrl)) {
            throw new Error('socks 代理需要改用代理软件的 HTTP 端口');
        } else if (isHttpsTarget) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            agent = new HttpsProxyAgent(proxyUrl, KEEP_ALIVE_OPTIONS);
        } else {
            const { HttpProxyAgent } = require('http-proxy-agent');
            agent = new HttpProxyAgent(proxyUrl, KEEP_ALIVE_OPTIONS);
        }
    } catch (error) {
        console.warn(`[Proxy] 无法创建代理 agent (${sanitizeProxyUrl(proxyUrl)}), 回退直连: ${error.message}`);
        return isHttpsTarget ? httpsAgent : httpAgent;
    }

    proxyAgentCache.set(cacheKey, agent);
    return agent;
}

function agentFor(url) {
    const proxyUrl = resolveProxyUrl(url);
    if (proxyUrl) return proxyAgentFor(proxyUrl, url);
    return String(url || '').startsWith('http:') ? httpAgent : httpsAgent;
}

// 公共 DNS。本机解析器被污染时（实测 file2.aitohumanize.com 被指到
// 自签 redirect-cnzz 证书的假地址），结果图下载会报 DEPTH_ZERO_SELF_SIGNED_CERT，
// 生成本身已经成功。只在证书校验失败后改走这里，不关闭证书校验。
const PUBLIC_DNS_SERVERS = ['223.5.5.5', '119.29.29.29', '1.1.1.1', '8.8.8.8'];
const CERT_FAILURE_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID'
]);

function dnsQueryA(server, hostname) {
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 65535);
        const labels = String(hostname).split('.');
        const qname = Buffer.concat([
            ...labels.map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
            Buffer.from([0])
        ]);
        const header = Buffer.alloc(12);
        header.writeUInt16BE(id, 0);
        header.writeUInt16BE(0x0100, 2);
        header.writeUInt16BE(1, 4);
        const packet = Buffer.concat([header, qname, Buffer.from([0, 1, 0, 1])]);
        const socket = require('dgram').createSocket('udp4');
        const finish = (error, value) => {
            clearTimeout(timer);
            socket.close();
            if (error) reject(error);
            else resolve(value);
        };
        const timer = setTimeout(() => finish(Object.assign(new Error(`DNS timeout ${server}`), { code: 'ETIMEOUT' })), 2000);
        socket.once('error', error => finish(error));
        socket.once('message', message => {
            if (message.length < 12 || message.readUInt16BE(0) !== id) return;
            const answers = [];
            const readName = offset => {
                while (offset < message.length) {
                    const length = message[offset];
                    if ((length & 0xc0) === 0xc0) return offset + 2;
                    if (length === 0) return offset + 1;
                    offset += 1 + length;
                }
                return offset;
            };
            let offset = readName(12) + 4;
            const count = message.readUInt16BE(6);
            for (let index = 0; index < count && offset + 10 <= message.length; index += 1) {
                offset = readName(offset);
                const type = message.readUInt16BE(offset);
                offset += 8;
                const length = message.readUInt16BE(offset);
                offset += 2;
                if (type === 1 && length === 4) {
                    answers.push(`${message[offset]}.${message[offset + 1]}.${message[offset + 2]}.${message[offset + 3]}`);
                }
                offset += length;
            }
            finish(null, answers);
        });
        socket.send(packet, 53, server);
    });
}

async function publicAddressesFor(hostname) {
    const answers = await Promise.all(PUBLIC_DNS_SERVERS.map(server => dnsQueryA(server, hostname).catch(() => [])));
    const counts = new Map();
    for (const address of answers.flat()) {
        if (net.isIP(address) !== 4) continue;
        counts.set(address, (counts.get(address) || 0) + 1);
    }
    return [...counts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((left, right) => right[1] - left[1])
        .map(([address]) => address);
}

function downloadAgentFor(url, address) {
    if (!address) return agentFor(url);
    const proxyUrl = resolveProxyUrl(url);
    if (proxyUrl) return proxyAgentFor(proxyUrl, url);
    const parsed = new URL(url);
    return new https.Agent({
        ...KEEP_ALIVE_OPTIONS,
        lookup: (_hostname, _options, callback) => callback(null, address, 4),
        servername: parsed.hostname
    });
}

function fetchDownload(url, address, signal) {
    if (!address) return fetch(url, { agent: agentFor(url), signal });
    const parsed = new URL(url);
    const pinned = new URL(url);
    const isIpv6 = net.isIP(address) === 6;
    pinned.hostname = isIpv6 ? `[${address}]` : address;
    return fetch(pinned, {
        agent: downloadAgentFor(url, address),
        signal,
        headers: { Host: parsed.host }
    });
}

function isCertificateError(error) {
    return CERT_FAILURE_CODES.has(error?.code);
}

// 被污染的解析结果不一定是自签证书：实测 file4.aitohumanize.com 在本机/阿里 DNS 上
// 解析到拒绝连接的 103.73.220.77（ECONNREFUSED），其余公共 DNS 给的才是真地址。
const CONNECT_FAILURE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET']);

function shouldTryPublicDns(error) {
    return isCertificateError(error) || CONNECT_FAILURE_CODES.has(error?.code);
}

function defaultProxyProbeTargets() {
    return ['https://svip.xuedingmao.com', new URL(IMAGE_HOST_URL).origin];
}

// 用当前代理模式实测连通性，让"强制直连"开关的效果可以被验证而不是只能猜。
async function testProxyReachability(options = {}) {
    const targets = Array.isArray(options.targets) && options.targets.length > 0
        ? options.targets
        : defaultProxyProbeTargets();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);

    const checks = await Promise.all(targets.map(async (target) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        const proxyUrl = resolveProxyUrl(target);

        try {
            const response = await fetch(target, {
                method: 'HEAD',
                signal: controller.signal,
                agent: agentFor(target)
            });
            return {
                target,
                ok: true,
                status: response.status,
                latencyMs: Date.now() - startedAt,
                viaProxy: !!proxyUrl,
                proxy: sanitizeProxyUrl(proxyUrl)
            };
        } catch (error) {
            return {
                target,
                ok: false,
                status: 0,
                latencyMs: Date.now() - startedAt,
                viaProxy: !!proxyUrl,
                proxy: sanitizeProxyUrl(proxyUrl),
                message: error.name === 'AbortError' ? `超过 ${timeoutMs}ms 未响应` : error.message
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }));

    const reachable = checks.filter(check => check.ok);
    const summary = `${reachable.length}/${checks.length} 个目标可达`;
    // 顶层 latencyMs / message 供 UI 直接展示，避免调用方自行翻找 checks[]。
    const latencyMs = reachable.length > 0
        ? Math.min(...reachable.map(check => check.latencyMs))
        : 0;
    const failureMessage = checks
        .filter(check => !check.ok && check.message)
        .map(check => `${new URL(check.target).host}: ${check.message}`)
        .join('; ');

    return {
        success: reachable.length > 0,
        mode: proxyState.mode,
        checks,
        summary,
        latencyMs,
        message: reachable.length > 0 ? summary : (failureMessage || summary)
    };
}

const API_CONFIG = {
    MAX_RETRIES: 1,
    TIMEOUT: 60000,
    PROMPT_TIMEOUT: 180000, // 提示词优化/反推：慢模型经中转首字就可能等很久，用户可随时手动停止
    IMAGE_EDIT_TIMEOUT: 240000, // 4分钟（考虑编辑操作更复杂）
    OPENAI_IMAGE_TIMEOUT: 240000, // 4分钟（根据供应商反馈3分钟内完成，留1分钟余量）
    GEMINI_IMAGE_TIMEOUT: 240000, // Gemini图片生成超时
    DOWNLOAD_RETRY_BASE_DELAY: 400, // 下载重试基础延迟（ms）
    DOWNLOAD_MAX_RETRIES: 3 // 下载最大重试次数（从4降到3）
};

const IMAGE_HOST_URL = 'https://imageproxy.zhongzhuan.chat/api/upload';
const DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT = [
    '你是专业的 AI 生图提示词优化助手，精通主流图像生成模型的提示词工程。',
    '将用户输入改写为一条更利于图像模型理解的提示词，严格忠于原始意图，不新增与原意冲突的主体、风格或限制。',
    '在与原意相关时按需补充以下要素，不要生硬堆砌：主体与用途（照片／海报／图标／插画等）；构图（取景、主体位置、画幅比例）；光线与色彩（光源方向、氛围、主色调）；材质与媒介（表面质感、绘制或摄影风格，需要真实感时明确"照片级写实"）；关键细节与艺术风格。',
    '用具体可见的描述代替笼统的情绪词；若画面内需出现文字，用引号给出确切文案并说明位置，同时声明不出现多余文字；必要时补充排除项（如无水印、无多余元素）。',
    '用户消息里每张参考图前都有一行【参考图 N：名称】标签，名称就是该图在用户提示词中的引用名。',
    '引用参考图时必须写成 @{名称} 的形式（花括号不可省略，例如 @{大张}、@{花石道}），名称抄标签里的原文，一个字都不要改写、翻译或编造。',
    '严禁输出 @第一张参考图文件名、@第二张参考图文件名 之类的占位说法，也严禁用"参考图1""图一"这种序号指代——它们对不上任何真实图片。',
    '若用户提示词里已经出现 @{名称} 形式的引用，必须原样保留这些引用，并保持它们与各自描述的位置关系。',
    '输出为一条可直接使用的完整提示词，按此结构组织、用分号或换行分隔各要素，不要写标题或编号：',
    '1. 主体与用途；2. 构图与主体位置（涉及多张参考图时，逐张写明哪个 @{名称} 放在哪个位置）；3. 光线与色彩；4. 材质、媒介与风格；5. 关键细节；6. 排除项。',
    '用户消息末尾会给出本次生图的画幅比例参数。这是硬约束：若提示词里出现与之冲突的画幅、比例或朝向描述（例如参数是 1:1 而原文写「画幅 3:4」「竖幅」），必须以该参数为准改写，不要保留互相矛盾的说法。',
    '只返回优化后的提示词正文，语言与用户输入保持一致，不要解释，不要使用 Markdown 标记。'
].join('\n');
const REVERSE_PROMPT_SYSTEM_PROMPT = [
    '你是专业的图像提示词分析师。',
    '根据用户提供的图片，反推出可复现主体、构图、镜头、光线、材质、色彩和风格的中文生图提示词。',
    '不要猜测不可见的品牌、人物身份或拍摄设备。',
    '只返回提示词正文，不要解释，不要使用 Markdown。'
].join('\n');

function convertToStandardRatio(width, height) {
    const ratio = width / height;
    const standardRatios = [
        { name: '1:1', value: 1.0 },
        { name: '4:5', value: 0.8 },
        { name: '5:4', value: 1.25 },
        { name: '2:3', value: 0.667 },
        { name: '3:2', value: 1.5 },
        { name: '3:4', value: 0.75 },
        { name: '4:3', value: 1.333 },
        { name: '9:16', value: 0.5625 },
        { name: '16:9', value: 1.778 },
        { name: '21:9', value: 2.333 },
        { name: '1:4', value: 0.25 },
        { name: '4:1', value: 4.0 },
        { name: '1:8', value: 0.125 },
        { name: '8:1', value: 8.0 }
    ];
    let closest = standardRatios[0];
    let minDiff = Math.abs(ratio - closest.value);
    for (const standard of standardRatios) {
        const diff = Math.abs(ratio - standard.value);
        if (diff < minDiff) { minDiff = diff; closest = standard; }
    }
    return closest.name;
}

function calculateSize(ratio, model) {
    const customMatch = ratio.trim().match(/^(\d+)[xX\*](\d+)$/);
    if (customMatch) return `${customMatch[1]}x${customMatch[2]}`;

    const is4k = model.toLowerCase().includes('4k');
    const is2k = model.toLowerCase().includes('2k');

    const sizeMap = {
        '1:1':  { standard: '1024x1024', '2k': '2048x2048', '4k': '4096x4096' },
        '2:3':  { standard: '832x1248',  '2k': '1696x2528', '4k': '3392x5056' },
        '3:2':  { standard: '1248x832',  '2k': '2528x1696', '4k': '5056x3392' },
        '3:4':  { standard: '864x1184',  '2k': '1792x2400', '4k': '3584x4800' },
        '4:3':  { standard: '1184x864',  '2k': '2400x1792', '4k': '4800x3584' },
        '4:5':  { standard: '896x1152',  '2k': '1856x2304', '4k': '3712x4608' },
        '5:4':  { standard: '1152x896',  '2k': '2304x1856', '4k': '4608x3712' },
        '9:16': { standard: '768x1344',  '2k': '1536x2752', '4k': '3072x5504' },
        '16:9': { standard: '1344x768',  '2k': '2752x1536', '4k': '5504x3072' },
        '21:9': { standard: '1584x672',  '2k': '3168x1344', '4k': '6336x2688' },
        '1:4':  { standard: '512x2048',  '2k': '1024x4096', '4k': '2048x8192' },
        '4:1':  { standard: '2048x512',  '2k': '4096x1024', '4k': '8192x2048' },
        '1:8':  { standard: '384x3072',  '2k': '768x6144',  '4k': '1536x12288' },
        '8:1':  { standard: '3072x384',  '2k': '6144x768',  '4k': '12288x1536' }
    };

    const sizes = sizeMap[ratio];
    if (!sizes) return is4k ? '4096x4096' : is2k ? '2048x2048' : '1024x1024';
    if (is4k) return sizes['4k'];
    if (is2k) return sizes['2k'];
    return sizes.standard;
}

function normalizeModelKeyword(model = '') {
    return imageApiProfiles.normalizeModelKeyword(model);
}

function isOpenAIImageModel(model = '') {
    return imageApiProfiles.isOpenAIImageModel(model);
}

function isOpenAIGptImageModel(model = '') {
    return imageApiProfiles.isOpenAIGptImageModel(model);
}

function isOpenAIDallEModel(model = '') {
    return imageApiProfiles.isOpenAIDallEModel(model);
}

function isOpenAIImage2Model(model = '') {
    return imageApiProfiles.isOpenAIImage2Model(model);
}

function isOpenAIImage25Model(model = '') {
    return imageApiProfiles.isOpenAIImage25Model(model);
}

function isGeminiImageModel(model = '') {
    return imageApiProfiles.isGeminiImageModel(model);
}

function isXAIImageModel(model = '') {
    return imageApiProfiles.isXAIImageModel(model);
}

function isXAIImagineNativeModel(model = '') {
    return imageApiProfiles.isXAIImagineNativeModel(model);
}

function isDoubaoSeedreamModel(model = '') {
    return normalizeModelKeyword(model).includes('seedream');
}

function isDoubaoSeedream5Model(model = '') {
    const normalized = normalizeModelKeyword(model).replace(/\./g, '');
    return normalized.includes('seedream50') || normalized.includes('seedream5');
}

function parseImageSize(value) {
    const match = String(value || '').trim().match(/^(\d+)\s*(?:x|\*|\u00d7)\s*(\d+)$/i);
    if (!match) return null;
    return {
        width: parseInt(match[1], 10),
        height: parseInt(match[2], 10)
    };
}

function normalizeImageSize(value) {
    const parsed = parseImageSize(value);
    return parsed ? `${parsed.width}x${parsed.height}` : String(value || '').trim();
}

function validateOpenAIImage2Size(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
        throw new Error('Image2 自定义尺寸需要填写整数宽高');
    }
    if (width <= 0 || height <= 0 || width > 3840 || height > 3840) {
        throw new Error('Image2 尺寸边长必须大于 0 且不超过 3840');
    }
    if (width % 16 !== 0 || height % 16 !== 0) {
        throw new Error('Image2 自定义尺寸的宽高必须是 16 的倍数');
    }
    const pixels = width * height;
    if (pixels < 655360 || pixels > 8294400) {
        throw new Error('Image2 总像素必须在 655360 到 8294400 之间');
    }
    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    if (longSide / shortSide > 3) {
        throw new Error('Image2 长短边比例不能超过 3:1');
    }
}

function resolveOpenAIImageSize(sizeOrRatio = '', model = '', generationConfig = {}, imageSize = '') {
    const value = normalizeImageSize(sizeOrRatio);
    const isImage2 = isOpenAIImage2Model(model) || isOpenAIImage25Model(model);
    const family = imageApiProfiles.openAIImageFamily(model);

    // New API-compatible Gemini relays accept aspect ratios in the OpenAI
    // size field. Converting them to GPT's size list loses ratios such as 16:9.
    if (isGeminiImageModel(model)) {
        return resolveGeminiAspectRatio(value, generationConfig);
    }

    const supportedSizes = (isImage2
        ? imageApiProfiles.OPENAI_IMAGE2_SIZES
        : imageApiProfiles.getImageApiProfile(model).dimensionOptions.map(option => option.value))
        .filter(option => option !== 'custom' && (option === 'auto' || /^\d+x\d+$/i.test(option)));

    if (supportedSizes.includes(value)) return value;

    const requestedResolution = String(imageSize || '').trim();
    if (isImage2 && (value === 'custom' || requestedResolution.toLowerCase() === 'custom')) {
        const width = Number(generationConfig.gptImageWidth);
        const height = Number(generationConfig.gptImageHeight);
        validateOpenAIImage2Size(width, height);
        return `${width}x${height}`;
    }

    const parsedSize = parseImageSize(value);
    if (isImage2 && parsedSize) {
        validateOpenAIImage2Size(parsedSize.width, parsedSize.height);
        return `${parsedSize.width}x${parsedSize.height}`;
    }

    const ratioOptions = isOpenAIImage25Model(model)
        ? imageApiProfiles.OPENAI_IMAGE25_RATIOS
        : imageApiProfiles.OPENAI_IMAGE2_RATIOS;
    if (isImage2 && ratioOptions.includes(value)) {
        const mappedSize = imageApiProfiles.resolveOpenAIImage2MappedSize(value, requestedResolution || '1K');
        if (mappedSize === 'auto') return 'auto';
        const parsedMappedSize = parseImageSize(mappedSize);
        validateOpenAIImage2Size(parsedMappedSize?.width, parsedMappedSize?.height);
        return mappedSize;
    }

    const ratioMap = {
        '1:1': '1024x1024',
        '3:2': '1536x1024',
        '2:3': '1024x1536'
    };
    if (family === 'dall-e-3') {
        const ratioParts = value.split(':').map(Number);
        if (ratioParts.length === 2 && ratioParts.every(Number.isFinite)) {
            if (ratioParts[0] > ratioParts[1]) return '1792x1024';
            if (ratioParts[0] < ratioParts[1]) return '1024x1792';
        }
        return '1024x1024';
    }
    if (family === 'dall-e-2') return '1024x1024';

    const mapped = ratioMap[value];
    if (mapped && supportedSizes.includes(mapped)) return mapped;
    return supportedSizes.includes('auto') ? 'auto' : supportedSizes[0] || '1024x1024';
}

function openAIChatCompletionsUrl(provider) {
    const baseUrl = provider.replace(/\/$/, '');
    if (/\/chat\/completions$/i.test(baseUrl)) return baseUrl;
    if (/(?:\/v\d+|\/api\/v\d+)$/i.test(baseUrl)) return `${baseUrl}/chat/completions`;
    return `${baseUrl}/v1/chat/completions`;
}

function openAIImagesUrl(provider, endpoint) {
    const baseUrl = provider.replace(/\/$/, '');
    if (/\/images\/(generations|edits)$/i.test(baseUrl)) return baseUrl;
    if (/(?:\/v\d+|\/api\/v\d+)$/i.test(baseUrl)) return `${baseUrl}/images/${endpoint}`;
    return `${baseUrl}/v1/images/${endpoint}`;
}

function geminiInteractionsUrl(provider) {
    const baseUrl = provider.replace(/\/$/, '');
    if (/\/interactions$/i.test(baseUrl)) return baseUrl;
    if (/\/v1(beta)?$/i.test(baseUrl)) return `${baseUrl}/interactions`;
    return `${baseUrl}/v1beta/interactions`;
}

function appendGeminiApiKey(url, apiKey) {
    return `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
}

function normalizeGeminiImageSize(value = '1K') {
    const normalized = String(value || '1K').trim().toUpperCase();
    if (normalized === '512' || normalized === '0.5K') return '512';
    if (['1K', '2K', '4K'].includes(normalized)) return normalized;
    return '1K';
}

const GEMINI_SUPPORTED_ASPECT_RATIOS = imageApiProfiles.GEMINI_FULL_RATIOS;

function resolveGeminiAspectRatio(ratio = '1:1', generationConfig = {}) {
    let ratioText = String(ratio || '1:1').trim();

    if (ratioText.toLowerCase() === 'custom') {
        const width = Number(generationConfig.gptImageWidth);
        const height = Number(generationConfig.gptImageHeight);
        if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
            ratioText = `${width}x${height}`;
        }
    }

    const customMatch = ratioText.match(/^(\d+)[xX\*](\d+)$/);
    const aspectRatio = customMatch
        ? convertToStandardRatio(parseInt(customMatch[1], 10), parseInt(customMatch[2], 10))
        : ratioText;

    if (!GEMINI_SUPPORTED_ASPECT_RATIOS.includes(aspectRatio)) {
        throw new Error(`不支持的 Gemini 宽高比: ${aspectRatio}`);
    }

    return aspectRatio;
}

function geminiResponseModalities(value = '') {
    return value === 'IMAGE' ? ['IMAGE'] : ['TEXT', 'IMAGE'];
}

function buildGeminiGenerateContentRequest({ model, prompt, ratio, imageSize, referenceImages = [], generationConfig = {} }) {
    const sizeSuffix = String(model || '').match(/-(0\.5k|512|1k|2k|4k)$/i)?.[1] || '';
    const baseModel = String(model || '').replace(/-(0\.5k|512|1k|2k|4k)$/i, '').replace(/^models\//i, '');
    const capabilities = imageApiProfiles.geminiModelCapabilities(baseModel);
    const aspectRatio = resolveGeminiAspectRatio(ratio, generationConfig);
    if (!capabilities.ratios.includes(aspectRatio)) {
        throw new Error(`当前 Gemini 模型不支持宽高比 ${aspectRatio}`);
    }
    const imageConfig = { aspectRatio };
    if (capabilities.sendsImageSize) {
        imageConfig.imageSize = normalizeGeminiImageSize(sizeSuffix || imageSize);
    }

    if (referenceImages.length > capabilities.maxReferences) {
        throw new Error(`当前 Gemini 模型最多支持 ${capabilities.maxReferences} 张参考图`);
    }

    const parts = [
        { text: prompt },
        ...referenceImages.map(ref => ({
            inline_data: {
                mime_type: ref.mimeType || 'image/png',
                data: ref.base64
            }
        }))
    ];

    const nativeGenerationConfig = {
        responseModalities: geminiResponseModalities(generationConfig.responseModalities)
    };
    if (capabilities.imageConfigField === 'imageConfig') {
        nativeGenerationConfig.imageConfig = imageConfig;
    } else {
        nativeGenerationConfig.responseFormat = { image: imageConfig };
    }

    const requestBody = {
        contents: [{ role: 'user', parts }],
        generationConfig: nativeGenerationConfig
    };

    const temperature = Number(generationConfig.temperature);
    const topP = Number(generationConfig.topP);
    const topK = Number(generationConfig.topK);
    if (generationConfig.temperature != null && Number.isFinite(temperature)) {
        requestBody.generationConfig.temperature = temperature;
    }
    if (generationConfig.topP != null && Number.isFinite(topP)) {
        requestBody.generationConfig.topP = topP;
    }
    if (generationConfig.topK != null && Number.isFinite(topK)) {
        requestBody.generationConfig.topK = Math.trunc(topK);
    }

    const includeThoughts = !!generationConfig.includeThoughts;
    const hasThinkingLevel = capabilities.supportsThinkingLevel
        && generationConfig.thinkingLevel
        && generationConfig.thinkingLevel !== 'none'
        && generationConfig.thinkingLevel !== 'default';
    if (hasThinkingLevel || includeThoughts) {
        requestBody.generationConfig.thinkingConfig = { includeThoughts };
        const levelMap = { high: 'High', minimal: 'Minimal' };
        const mappedLevel = levelMap[generationConfig.thinkingLevel];
        if (hasThinkingLevel && mappedLevel) requestBody.generationConfig.thinkingConfig.thinkingLevel = mappedLevel;
    }
    if (generationConfig.safetySettings && Array.isArray(generationConfig.safetySettings) && generationConfig.safetySettings.length > 0) {
        requestBody.safetySettings = generationConfig.safetySettings;
    }

    const useWebSearch = !!generationConfig.googleSearch && capabilities.supportsGoogleSearch;
    const useImageSearch = !!generationConfig.imageSearch && capabilities.supportsImageSearch;
    if (useWebSearch || useImageSearch) {
        const searchTypes = {};
        if (useWebSearch) searchTypes.webSearch = {};
        if (useImageSearch) searchTypes.imageSearch = {};
        requestBody.tools = [{ google_search: { searchTypes } }];
    }

    return { baseModel, requestBody, imageConfig, imageConfigField: capabilities.imageConfigField };
}

function resolveXAIAspectRatio(ratio = 'auto') {
    const value = String(ratio || 'auto').trim();
    if (imageApiProfiles.XAI_RATIOS.includes(value)) return value;

    const custom = parseImageSize(value);
    if (custom) {
        const target = custom.width / custom.height;
        const candidates = imageApiProfiles.XAI_RATIOS.filter(item => item !== 'auto');
        return candidates.reduce((closest, candidate) => {
            const [width, height] = candidate.split(':').map(Number);
            const [closestWidth, closestHeight] = closest.split(':').map(Number);
            return Math.abs(width / height - target) < Math.abs(closestWidth / closestHeight - target)
                ? candidate
                : closest;
        }, '1:1');
    }

    throw new Error(`不支持的 Grok 宽高比: ${value}`);
}

function normalizeXAIResolution(value = '1k') {
    const resolution = String(value || '1k').trim().toLowerCase();
    if (!['1k', '2k'].includes(resolution)) {
        throw new Error(`不支持的 Grok 分辨率: ${value}`);
    }
    return resolution;
}

function resolveXAIImageSize(ratio = '1:1', imageSize = '1k') {
    const normalizedSize = String(imageSize || '1k').trim().toLowerCase();
    const sizeMap = normalizedSize === '2k'
        ? {
            '1:1': '2048x2048',
            '16:9': '2048x1152',
            '9:16': '1152x2048',
            '3:2': '2048x1365',
            '2:3': '1365x2048',
            '4:3': '2048x1536',
            '3:4': '1536x2048'
        }
        : {
            '1:1': '1024x1024',
            '16:9': '1536x864',
            '9:16': '864x1536',
            '3:2': '1536x1024',
            '2:3': '1024x1536',
            '4:3': '1365x1024',
            '3:4': '1024x1365'
        };
    const requestedRatio = resolveXAIAspectRatio(ratio);
    return sizeMap[requestedRatio] || '1024x1024';
}

function buildXAIImageRequest({ model, prompt, ratio, imageSize, referenceImages = [], generationConfig = {} }) {
    if (referenceImages.length > 3) {
        throw new Error('Grok Imagine 最多支持 3 张参考图');
    }

    const n = Number(generationConfig.n ?? 1);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
        throw new Error('Grok 单次生成数量 n 必须在 1 到 10 之间');
    }

    const normalizedModel = String(model || '').trim();
    const isNativeImagine = isXAIImagineNativeModel(normalizedModel) || generationConfig.xaiNative === true;
    const requestBody = {
        model: normalizedModel,
        prompt: String(prompt || '').trim(),
        n
    };

    if (isNativeImagine) {
        requestBody.aspect_ratio = resolveXAIAspectRatio(ratio);
        requestBody.resolution = normalizeXAIResolution(imageSize);

        const quality = String(generationConfig.gptQuality || generationConfig.quality || '').trim().toLowerCase();
        if (quality && quality !== 'auto') {
            if (!imageApiProfiles.isXAIImagineImage2Model(normalizedModel)) {
                throw new Error('Grok quality 参数仅支持 grok-imagine-image-2.0');
            }
            if (!['low', 'medium'].includes(quality)) {
                throw new Error(`不支持的 Grok 质量: ${quality}`);
            }
            requestBody.quality = quality;
        }

        const responseFormat = String(generationConfig.responseFormat || generationConfig.nativeResponseFormat || '').trim();
        if (responseFormat) {
            if (!['url', 'b64_json'].includes(responseFormat)) {
                throw new Error(`不支持的 Grok 响应格式: ${responseFormat}`);
            }
            requestBody.response_format = responseFormat;
        }
    } else {
        // Several existing relays expose Grok aliases with the older OpenAI-style size field.
        requestBody.size = resolveXAIImageSize(ratio, imageSize);
    }

    if (referenceImages.length === 1) {
        requestBody.image = dataUrlFromReference(referenceImages[0]);
    } else if (referenceImages.length > 1) {
        requestBody.image = referenceImages.map(dataUrlFromReference);
    }

    return {
        endpoint: referenceImages.length > 0 ? 'edits' : 'generations',
        requestBody
    };
}

function anthropicMessagesUrl(provider) {
    const baseUrl = provider.replace(/\/$/, '');
    if (/\/messages$/i.test(baseUrl)) return baseUrl;
    if (/\/v1$/i.test(baseUrl)) return `${baseUrl}/messages`;
    return `${baseUrl}/v1/messages`;
}

function geminiGenerateContentUrl(provider, model, apiKey) {
    const baseUrl = provider.replace(/\/$/, '');
    const modelPath = `models/${model}:generateContent`;
    const url = /\/v1(beta)?$/i.test(baseUrl)
        ? `${baseUrl}/${modelPath}`
        : `${baseUrl}/v1beta/${modelPath}`;
    return `${url}?key=${encodeURIComponent(apiKey)}`;
}

function openAIModelsUrl(provider) {
    const baseUrl = provider.replace(/\/$/, '');
    if (/\/models$/i.test(baseUrl)) return baseUrl;
    if (/(?:\/v\d+|\/api\/v\d+)$/i.test(baseUrl)) return `${baseUrl}/models`;
    return `${baseUrl}/v1/models`;
}

function geminiModelsUrl(provider, apiKey) {
    const baseUrl = provider.replace(/\/$/, '');
    const url = /\/v1(beta)?$/i.test(baseUrl)
        ? `${baseUrl}/models`
        : `${baseUrl}/v1beta/models`;
    return `${url}?key=${encodeURIComponent(apiKey)}`;
}

function dataUrlFromReference(ref) {
    return `data:${ref.mimeType || 'image/png'};base64,${ref.base64}`;
}

function sanitizeUrl(url) {
    return String(url || '').replace(/key=[^&]+/g, 'key=***');
}

function summarizeReferences(referenceImages = []) {
    return referenceImages.map((ref, index) => ({
        index,
        mimeType: ref.mimeType || 'image/png',
        approxBytes: ref.base64 ? Math.round((ref.base64.length * 3) / 4) : 0
    }));
}

function chatMode(provider, model) {
    const providerLower = provider.toLowerCase();
    if (providerLower.includes('anthropic') || providerLower.includes('claude')) return 'claude';
    if (providerLower.includes('generativelanguage.googleapis.com')) return 'gemini';
    return 'openai';
}

function normalizeDoubaoSeedreamTier(value, model = '') {
    const tier = String(value || '').trim().toUpperCase();
    const modelLower = String(model || '').toLowerCase();
    const isSeedream5 = isDoubaoSeedream5Model(model);
    const isPro = modelLower.includes('pro');
    let supported;
    let fallback;

    if (isSeedream5 && isPro) {
        supported = ['1K', '2K'];
        fallback = '1K';
    } else if (isSeedream5) {
        supported = ['2K', '3K', '4K'];
        fallback = '2K';
    } else if (modelLower.includes('seedream-4-5')) {
        supported = ['2K', '4K'];
        fallback = '2K';
    } else {
        supported = ['1K', '2K', '4K'];
        fallback = '1K';
    }

    if (supported.includes(tier)) return tier;
    if ((tier === '512' || tier === '0.5K') && supported.includes('1K')) return '1K';
    if (tier === '1K' && supported.includes('2K')) return '2K';
    if ((tier === '3K' || tier === '4K') && supported.includes('2K') && !supported.includes(tier)) return '2K';
    return fallback;
}

function resolveDoubaoSeedreamSize(ratio = '', imageSize = '1K', model = '', generationConfig = {}) {
    const ratioSize = normalizeImageSize(ratio);
    if (parseImageSize(ratioSize)) return ratioSize;

    if (String(ratio || '').trim().toLowerCase() === 'custom') {
        const width = Number(generationConfig.gptImageWidth);
        const height = Number(generationConfig.gptImageHeight);
        if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
            return `${width}x${height}`;
        }
    }

    const explicitImageSize = normalizeImageSize(imageSize);
    if (parseImageSize(explicitImageSize)) return explicitImageSize;

    return normalizeDoubaoSeedreamTier(imageSize, model);
}

function greatestCommonDivisor(left, right) {
    let a = Math.abs(Math.trunc(left));
    let b = Math.abs(Math.trunc(right));
    while (b) {
        [a, b] = [b, a % b];
    }
    return a || 1;
}

function promptAspectRatio(ratio = '', generationConfig = {}, imageSize = '') {
    const ratioText = String(ratio || '').trim();
    if (!ratioText || ratioText.toLowerCase() === 'auto') return '';

    let dimensions = parseImageSize(ratioText);
    if (ratioText.toLowerCase() === 'custom' || String(imageSize || '').trim().toLowerCase() === 'custom') {
        dimensions = {
            width: Number(generationConfig.gptImageWidth),
            height: Number(generationConfig.gptImageHeight)
        };
    }
    if (Number.isInteger(dimensions?.width) && Number.isInteger(dimensions?.height)
        && dimensions.width > 0 && dimensions.height > 0) {
        const divisor = greatestCommonDivisor(dimensions.width, dimensions.height);
        return `${dimensions.width / divisor}:${dimensions.height / divisor}`;
    }

    const explicitRatio = ratioText.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
    return explicitRatio ? `${Number(explicitRatio[1])}:${Number(explicitRatio[2])}` : '';
}

function withAspectRatioInstruction(prompt = '', ratio = '', generationConfig = {}, imageSize = '') {
    const promptText = String(prompt || '').trim();
    const aspectRatio = promptAspectRatio(ratio, generationConfig, imageSize);
    if (!aspectRatio) return promptText;

    const instruction = `构图要求：画面宽高比必须严格为 ${aspectRatio}，不要输出其他比例。`;
    if (promptText.includes(instruction)) return promptText;
    return `${promptText}\n\n${instruction}`;
}

function withDoubaoSeedreamAspectRatio(prompt = '', ratio = '', size = '') {
    const ratioText = String(ratio || '').trim();
    if (!ratioText || ratioText.toLowerCase() === 'custom' || parseImageSize(ratioText) || parseImageSize(size)) {
        return String(prompt || '');
    }
    if (!/^\d+\s*:\s*\d+$/.test(ratioText)) return String(prompt || '');
    if (String(prompt || '').includes(ratioText)) return String(prompt || '');
    return `${prompt}，宽高比为${ratioText}`;
}

function doubaoSeedreamOutputFormat(generationConfig = {}) {
    const mimeType = String(generationConfig.outputMimeType || '').toLowerCase();
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'jpeg';
    return 'png';
}

function doubaoSeedreamReferenceImage(ref = {}) {
    const mimeType = String(ref.mimeType || 'image/png').split(';')[0].toLowerCase();
    return `data:${mimeType};base64,${ref.base64 || ''}`;
}

function openAIOutputFormat(generationConfig = {}) {
    const mimeType = String(generationConfig.outputMimeType || '').toLowerCase();
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'jpeg';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/png') return 'png';
    return '';
}

function buildOpenAIImageRequest({ model, prompt, size, generationConfig = {}, hasReferences = false }) {
    const profile = imageApiProfiles.getImageApiProfile(model);
    const family = profile.family;
    const isGptImage = isOpenAIGptImageModel(model);
    const isDallE = isOpenAIDallEModel(model);
    const requestBody = {
        model,
        prompt,
        size,
        n: 1
    };

    // The Image API supports generating multiple images in one request. Keep
    // the existing default of one image, while allowing callers that opt in to
    // pass an explicit n (the desktop UI still limits a sequence to five).
    if (generationConfig.n != null) {
        const n = Number(generationConfig.n);
        if (!Number.isInteger(n) || n < 1 || n > 10) {
            throw new Error('OpenAI 图片生成数量 n 必须是 1 到 10 的整数');
        }
        requestBody.n = n;
    }

    const quality = String(generationConfig.gptQuality || '').trim();
    const qualityValues = (profile.qualityOptions || []).map(option => option.value);
    if (quality) {
        if (!qualityValues.includes(quality)) throw new Error(`当前 OpenAI 模型不支持质量参数 ${quality}`);
        requestBody.quality = quality;
    }

    if (isGptImage) {
        requestBody.stream = false;
        const background = String(generationConfig.gptBackground || '').trim();
        const backgroundValues = (profile.backgroundOptions || []).map(option => option.value);
        if (background) {
            if (!backgroundValues.includes(background)) throw new Error(`当前 OpenAI 模型不支持背景参数 ${background}`);
            requestBody.background = background;
        }

        const outputFormat = openAIOutputFormat(generationConfig);
        if (outputFormat) requestBody.output_format = outputFormat;
        if (outputFormat === 'jpeg' || outputFormat === 'webp') {
            const compression = Number(generationConfig.imageCompression);
            if (generationConfig.imageCompression != null) {
                if (!Number.isInteger(compression) || compression < 0 || compression > 100) {
                    throw new Error('OpenAI 输出压缩必须是 0 到 100 的整数');
                }
                requestBody.output_compression = compression;
            }
        }

        const moderation = String(generationConfig.moderation || '').trim();
        if (moderation) {
            if (!['auto', 'low'].includes(moderation)) throw new Error(`不支持的 OpenAI 审核参数: ${moderation}`);
            requestBody.moderation = moderation;
        }

        const inputFidelity = String(generationConfig.inputFidelity || '').trim();
        if (hasReferences && inputFidelity && profile.controls.inputFidelity) {
            if (!['low', 'high'].includes(inputFidelity)) throw new Error(`不支持的参考图保真参数: ${inputFidelity}`);
            requestBody.input_fidelity = inputFidelity;
        }
    }

    if (isDallE) {
        const responseFormat = String(generationConfig.responseFormat || '').trim();
        if (responseFormat) {
            if (!['url', 'b64_json'].includes(responseFormat)) throw new Error(`不支持的 OpenAI 响应格式: ${responseFormat}`);
            requestBody.response_format = responseFormat;
        }
    }

    if (family === 'dall-e-3') {
        const style = String(generationConfig.style || '').trim();
        if (style) {
            if (!['vivid', 'natural'].includes(style)) throw new Error(`不支持的 DALL-E 3 风格: ${style}`);
            requestBody.style = style;
        }
    }

    const user = String(generationConfig.user || '').trim();
    if (user) requestBody.user = user;

    return requestBody;
}

function emitProgress(callbacks = {}, event = {}) {
    if (typeof callbacks.onProgress !== 'function') return;
    try {
        callbacks.onProgress({ ...event, updatedAt: Date.now() });
    } catch (error) {
        console.warn('[apiService] progress callback failed:', error.message);
    }
}

function isGeminiNativeProvider(provider = '') {
    const lower = String(provider || '').toLowerCase();
    return lower.includes('generativelanguage.googleapis.com');
}

function tryParseJsonString(value) {
    if (typeof value !== 'string') return { ok: false, value };
    const trimmed = value.trim();
    if (!trimmed || trimmed === '[DONE]') return { ok: false, value: trimmed };
    if (!['{', '[', '"'].includes(trimmed[0])) return { ok: false, value };

    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string' && parsed !== trimmed) {
            const nested = tryParseJsonString(parsed);
            return nested.ok ? nested : { ok: true, value: parsed };
        }
        return { ok: true, value: parsed };
    } catch {
        return { ok: false, value };
    }
}

function providerKindForImage({ isGptImage = false, isImage2 = false, isXAI = false, isDoubaoSeedream = false, isOpenAICompatibleGeminiImage = false, useGeminiNative = false, isGrsaiNanoBanana = false, isGrsaiGptImage = false }) {
    if (isGrsaiNanoBanana) return 'grsai-nano-banana';
    if (isGrsaiGptImage) return 'grsai-gpt-image';
    if (isImage2) return 'openai-image2';
    if (isGptImage) return 'openai-image';
    if (isXAI) return 'xai-grok';
    if (isDoubaoSeedream) return 'doubao-seedream';
    if (isOpenAICompatibleGeminiImage) return 'gemini-openai-compatible';
    if (useGeminiNative) return 'gemini-native';
    return 'openai-compatible';
}

function extractChatText(data, mode) {
    if (mode === 'gemini') {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts
            .map(part => part.text || '')
            .filter(Boolean)
            .join('\n')
            .trim();
        if (text) return text;
    }

    if (mode === 'claude') {
        const text = (data?.content || [])
            .map(item => item.text || '')
            .filter(Boolean)
            .join('\n')
            .trim();
        if (text) return text;
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
        const text = content
            .map(item => item.text || item.content || '')
            .filter(Boolean)
            .join('\n')
            .trim();
        if (text) return text;
    }

    throw new Error('对话模型响应中没有文本');
}

function summarizeErrorBody(text) {
    const body = String(text || '').trim();
    if (!body) return '';

    try {
        const data = JSON.parse(body);
        const message = data?.error?.message || data?.message || data?.error || data?.detail;
        if (message) return String(message).slice(0, 220);
    } catch {
        // Plain text response.
    }

    return body.replace(/\s+/g, ' ').slice(0, 220);
}

async function timedJsonRequest({ url, headers, body, method = 'POST', timeoutMs = 15000 }) {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method,
            headers,
            body: body == null ? undefined : JSON.stringify(body),
            signal: controller.signal,
            agent: agentFor(url)
        });
        const text = await response.text();
        const latencyMs = Date.now() - startedAt;
        const message = response.ok
            ? 'Request succeeded'
            : summarizeErrorBody(text) || response.statusText || 'Request failed';
        return {
            success: response.ok,
            status: response.status,
            statusText: response.statusText,
            latencyMs,
            message,
            url: sanitizeUrl(url)
        };
    } catch (error) {
        const latencyMs = Date.now() - startedAt;
        return {
            success: false,
            status: 0,
            latencyMs,
            message: error.name === 'AbortError' ? 'Request timed out' : error.message,
            url: sanitizeUrl(url)
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function testImageProviderConnection(config) {
    const { provider, apiKey, model = '' } = config;
    if (!provider || !apiKey) {
        return { success: false, status: 0, latencyMs: 0, message: 'Missing Base URL or API Key' };
    }

    const providerLower = provider.toLowerCase();
    const protocol = normalizeProtocol(config.protocol);
    const resolvedProtocol = protocol === PROTOCOLS.AUTO
        ? inferProtocol({ baseUrl: provider }, model)
        : protocol;
    const useGeminiModels = resolvedProtocol === PROTOCOLS.GEMINI_NATIVE
        || (!model && providerLower.includes('generativelanguage.googleapis.com'));
    const url = useGeminiModels ? geminiModelsUrl(provider, apiKey) : openAIModelsUrl(provider);
    const headers = useGeminiModels
        ? { 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

    const result = await timedJsonRequest({ url, headers, method: 'GET' });
    console.log('[ApiTest][image]', {
        success: result.success,
        status: result.status,
        latencyMs: result.latencyMs,
        url: result.url,
        model
    });
    return result;
}

async function testChatProviderConnection(config) {
    const { provider, apiKey, model } = config;
    if (!provider || !apiKey || !model) {
        return { success: false, status: 0, latencyMs: 0, message: 'Missing Base URL, API Key, or model' };
    }

    const mode = chatMode(provider, model);
    const headers = { 'Content-Type': 'application/json' };
    let url;
    let body;

    if (mode === 'gemini') {
        url = geminiGenerateContentUrl(provider, model, apiKey);
        body = {
            contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 1, temperature: 0 }
        };
    } else if (mode === 'claude') {
        url = anthropicMessagesUrl(provider);
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        body = {
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }]
        };
    } else {
        url = openAIChatCompletionsUrl(provider);
        headers.Authorization = `Bearer ${apiKey}`;
        if (provider.includes('openrouter.ai')) {
            headers['HTTP-Referer'] = 'http://localhost';
            headers['X-Title'] = 'PicGen';
        }
        body = {
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            temperature: 0
        };
    }

    const result = await timedJsonRequest({ url, headers, body });
    console.log('[ApiTest][chat]', {
        success: result.success,
        status: result.status,
        latencyMs: result.latencyMs,
        url: result.url,
        mode,
        model
    });
    return result;
}

async function optimizePrompt(config) {
    const {
        requestId = `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        provider,
        apiKey,
        model,
        prompt,
        systemPrompt = DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
        referenceImages = [],
        referenceImageCount,
        referenceNames = [],
        ratio = ''
    } = config;

    if (!provider || !apiKey || !model || !prompt) {
        throw new Error('缺少对话模型配置');
    }

    const mode = chatMode(provider, model);
    const declaredReferenceCount = Number.isFinite(Number(referenceImageCount))
        ? Math.max(0, Math.floor(Number(referenceImageCount)))
        : referenceImages.length;
    // 参考图一律附上。旧实现在这里按名字含 deepseek 就整批丢掉参考图（并在正文里
    // 加一段「接口不支持读图」的免责声明），但 DeepSeek V4.1 已支持读图，且中转站
    // 上的模型名推不出真实能力。真不支持时让上游返回错误，好过我们猜错后静默丢图。
    const sentReferenceImages = referenceImages;
    // 图片 part 本身没有名字，模型看到多张图却不知道哪张叫什么，于是只会编出
    // 「@第一张参考图文件名」这种占位符。有名字时就在每张图前插一行标签，模型才能
    // 把提示词里的 @名称 对上具体的图；没有名字时（反推只有一张无名图）保持原样，
    // 不塞无意义的序号标签。
    const hasNames = Array.isArray(referenceNames) && referenceNames.some(name => String(name || '').trim());
    // 摊平成 [标签?, 图片] 的调用序列：有名字就在图前插一行标签，没有名字就只给图。
    // 三种协议共用这一份序列，保证「名字紧挨着对应的图」在哪儿都成立。
    const referenceSequence = sentReferenceImages.flatMap((ref, index) => (
        hasNames
            ? [`【参考图 ${index + 1}：${String(referenceNames[index] || '').trim() || `参考图${index + 1}`}】`, ref]
            : [ref]
    ));
    // 生成区已设的画幅比例随消息一起给出，并在这里再强一次「冲突以参数为准」——
    // 系统提示词里虽有通用规则，但参数是逐次请求变的，贴着它说明最不容易被忽略。
    const ratioValue = String(ratio || '').trim();
    const textPrompt = ratioValue
        ? `${prompt}\n\n【本次生图的画幅比例参数】${ratioValue}。如果上面的提示词里出现与它冲突的画幅、比例或朝向描述（例如写着「画幅 3:4」「竖幅」而参数不是），一律以本参数为准改写掉，不要保留互相矛盾的说法。`
        : prompt;

    let fetchUrl;
    const headers = { 'Content-Type': 'application/json' };
    let requestBody;

    if (mode === 'gemini') {
        fetchUrl = geminiGenerateContentUrl(provider, model, apiKey);
        requestBody = {
            systemInstruction: {
                parts: [{ text: systemPrompt || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT }]
            },
            contents: [{
                role: 'user',
                parts: [
                    { text: textPrompt },
                    ...referenceSequence.map(item => (typeof item === 'string'
                        ? { text: item }
                        : { inline_data: { mime_type: item.mimeType || 'image/png', data: item.base64 } }))
                ]
            }]
        };
    } else if (mode === 'claude') {
        fetchUrl = anthropicMessagesUrl(provider);
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        requestBody = {
            model,
            max_tokens: 2048,
            system: systemPrompt || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: textPrompt },
                    ...referenceSequence.map(item => (typeof item === 'string'
                        ? { type: 'text', text: item }
                        : { type: 'image', source: { type: 'base64', media_type: item.mimeType || 'image/png', data: item.base64 } }))
                ]
            }]
        };
    } else {
        fetchUrl = openAIChatCompletionsUrl(provider);
        const canSendImages = sentReferenceImages.length > 0;
        requestBody = {
            model,
            messages: [
                { role: 'system', content: systemPrompt || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: canSendImages
                        ? [
                            { type: 'text', text: textPrompt },
                            ...referenceSequence.map(item => (typeof item === 'string'
                                ? { type: 'text', text: item }
                                : { type: 'image_url', image_url: { url: dataUrlFromReference(item) } }))
                        ]
                        : textPrompt
                }
            ],
            temperature: 0.4
        };
    }

    if (mode === 'openai') {
        headers.Authorization = `Bearer ${apiKey}`;
        if (provider.includes('openrouter.ai')) {
            headers['HTTP-Referer'] = 'http://localhost';
            headers['X-Title'] = 'PicGen';
        }
    }

    let contentShape = 'text';
    if (mode === 'gemini') {
        contentShape = sentReferenceImages.length > 0 ? 'gemini-text-inline-images' : 'gemini-text';
    } else if (mode === 'claude') {
        contentShape = sentReferenceImages.length > 0 ? 'claude-text-images' : 'claude-text';
    } else if (Array.isArray(requestBody.messages?.[1]?.content)) {
        contentShape = 'openai-compatible-text-image_url';
    } else {
        contentShape = 'openai-compatible-text';
    }

    console.log('[PromptOptimize][api] request', {
        requestId,
        mode,
        model,
        url: sanitizeUrl(fetchUrl),
        promptLength: prompt.length,
        effectivePromptLength: textPrompt.length,
        systemPromptLength: String(systemPrompt || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT).length,
        referenceCount: declaredReferenceCount,
        sentReferenceCount: sentReferenceImages.length,
        droppedReferenceCount: Math.max(0, declaredReferenceCount - sentReferenceImages.length),
        references: summarizeReferences(sentReferenceImages),
        contentShape
    });

    const streaming = typeof config.onDelta === 'function';
    if (streaming) {
        if (mode === 'gemini') {
            const url = new URL(fetchUrl.replace(':generateContent', ':streamGenerateContent'));
            url.searchParams.set('alt', 'sse');
            fetchUrl = url.href;
        } else requestBody.stream = true;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (config.signal?.aborted) abort();
    config.signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, API_CONFIG.PROMPT_TIMEOUT);

    try {
        const response = await fetch(fetchUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: controller.signal,
            agent: agentFor(fetchUrl)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[PromptOptimize][api] response failed', {
                requestId,
                status: response.status,
                statusText: response.statusText,
                bodyPreview: errorText.substring(0, 500)
            });
            throw new Error(`对话模型请求失败: ${response.status} - ${errorText.substring(0, 200)}`);
        }

        if (streaming && /text\/event-stream/i.test(response.headers.get('content-type') || '')) {
            return await readPromptStream(response.body, mode, config.onDelta);
        }
        const data = await response.json();
        const text = extractChatText(data, mode);
        console.log('[PromptOptimize][api] response parsed', {
            requestId,
            resultLength: text.length,
            responseKeys: Object.keys(data || {})
        });
        if (!text.trim()) throw new Error('对话模型没有返回文本');
        if (streaming) config.onDelta(text);
        return { text };
    } catch (error) {
        if (timedOut && error?.name === 'AbortError') {
            throw Object.assign(new Error(`对话模型 ${API_CONFIG.PROMPT_TIMEOUT / 60000} 分钟内未完成输出，已超时`), { code: 'ETIMEDOUT' });
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
        config.signal?.removeEventListener('abort', abort);
    }
}

async function uploadToImageHost(base64Data, mimeType, options = {}) {
    throwIfAborted(options.signal);
    const buffer = Buffer.from(base64Data, 'base64');
    const ext = mimeType.split('/')[1] || 'png';
    const form = new FormData();
    form.append('file', buffer, { filename: `ref_${Date.now()}.${ext}`, contentType: mimeType });

    return withRequestTimeout(options.signal, Math.max(1, Number(options.uploadTimeoutMs) || 60000), async signal => {
        const response = await fetch(IMAGE_HOST_URL, {
            method: 'POST', body: form, headers: form.getHeaders(), agent: agentFor(IMAGE_HOST_URL), signal
        });
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`图床上传失败: ${response.status} - ${errText}`);
        }
        const data = await response.json();
        if (!data.url) throw new Error('图床返回数据异常');
        return { url: data.url };
    });
}

async function downloadImageAsBase64(url, callbacks = {}) {
    const downloadStartTime = Date.now();
    emitProgress(callbacks, {
        phase: 'downloading',
        message: 'Downloading generated image'
    });
    const maxAttempts = Math.max(1, Number(callbacks.downloadRetryAttempts) || API_CONFIG.DOWNLOAD_MAX_RETRIES);
    const configuredDelayMs = Number(callbacks.downloadRetryDelayMs);
    const baseDelayMs = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0 ? configuredDelayMs : API_CONFIG.DOWNLOAD_RETRY_BASE_DELAY;
    const retryableCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT']);
    const host = (() => {
        try { return new URL(url).host; } catch { return 'result host'; }
    })();
    let lastError = null;
    let addressOverride = '';
    let triedPublicDns = false;
    let publicCandidates = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted(callbacks.signal);
        try {
            const { buffer, contentType } = await withRequestTimeout(
                callbacks.signal, Math.max(1, Number(callbacks.downloadTimeoutMs) || 60000), async signal => {
                    const response = await fetchDownload(url, addressOverride, signal);
                    if (!response.ok) {
                        response.body?.destroy();
                        const error = new Error(`下载图片失败: HTTP ${response.status}`);
                        error.status = response.status;
                        throw error;
                    }
                    return { buffer: await response.buffer(), contentType: response.headers.get('content-type') || 'image/png' };
                });
            const downloadTime = Date.now() - downloadStartTime;
            const result = { base64: buffer.toString('base64'), mimeType: contentType };
            console.log(`[Download] 成功: ${host}${addressOverride ? ` via ${addressOverride}` : ''}, 耗时${downloadTime}ms, 大小${(buffer.length / 1024).toFixed(2)}KB, 尝试${attempt}/${maxAttempts}`);
            emitProgress(callbacks, {
                phase: 'downloaded',
                message: 'Generated image downloaded',
                displayProgress: 95
            });
            return result;
        } catch (error) {
            throwIfAborted(callbacks.signal);
            if (error.name === 'AbortError') throw error;
            lastError = error;
            if (shouldTryPublicDns(error) && !resolveProxyUrl(url)) {
                if (!triedPublicDns) {
                    triedPublicDns = true;
                    const hostname = (() => {
                        try { return new URL(url).hostname; } catch { return ''; }
                    })();
                    publicCandidates = hostname ? await publicAddressesFor(hostname).catch(() => []) : [];
                }
                // 逐个试公共 DNS 给出的地址，这几次不占下载重试次数。
                const next = publicCandidates.shift();
                if (next) {
                    console.warn(`[Download] ${host}${addressOverride ? ` via ${addressOverride}` : ''} 失败 (${error.code})，改用公共 DNS ${next} 重试`);
                    addressOverride = next;
                    attempt -= 1;
                    continue;
                }
            }
            const retryable = retryableCodes.has(error.code) || isRetryableStatus(error.status);
            if (!retryable || attempt >= maxAttempts) break;
            emitProgress(callbacks, {
                phase: 'downloading',
                message: `Retrying result download (${attempt + 1}/${maxAttempts})`,
                displayProgress: 90
            });
            await delay(baseDelayMs * (2 ** (attempt - 1)), callbacks.signal);
        }
    }

    throw createApiError(
        `图片已在供应商生成，但从 ${host} 下载失败：${lastError?.code || lastError?.message || '未知错误'}`,
        {
            retryable: false,
            ambiguous: true,
            countsAsFailure: false,
            code: 'RESULT_DOWNLOAD_FAILED'
        }
    );
}

async function reversePrompt(config) {
    const references = Array.isArray(config.referenceImages) ? config.referenceImages : [];
    if (references.length === 0) throw new Error('反推提示词需要一张图片');
    // 这里原本对名字/地址含 deepseek 的一律硬拒（和优化路径同一套猜测）。DeepSeek V4.1
    // 已支持读图，中转站上的模型名更推不出真实能力，改由上游判定：真不支持时它会报错。
    return optimizePrompt({
        ...config,
        prompt: String(config.prompt || '请分析这张图片并反推出可复现它的生图提示词。'),
        systemPrompt: config.systemPrompt || REVERSE_PROMPT_SYSTEM_PROMPT,
        referenceImages: references,
        referenceImageCount: references.length
    });
}

async function discoverImageProviderCapabilities(config) {
    const { provider, apiKey, model = '' } = config;
    if (!provider || !apiKey) throw new Error('Missing Base URL or API Key');
    const providerLower = provider.toLowerCase();
    const protocol = normalizeProtocol(config.protocol);
    const resolvedProtocol = protocol === PROTOCOLS.AUTO
        ? inferProtocol({ baseUrl: provider }, model)
        : protocol;
    const useGeminiModels = resolvedProtocol === PROTOCOLS.GEMINI_NATIVE
        || (!model && providerLower.includes('generativelanguage.googleapis.com'));
    const url = useGeminiModels ? geminiModelsUrl(provider, apiKey) : openAIModelsUrl(provider);
    const headers = useGeminiModels
        ? { Accept: 'application/json', 'x-goog-api-key': apiKey }
        : { Accept: 'application/json', Authorization: `Bearer ${apiKey}` };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const startedAt = Date.now();

    try {
        const response = await fetch(url, { method: 'GET', headers, signal: controller.signal, agent: agentFor(url) });
        const text = await response.text();
        if (!response.ok) {
            throw createApiError(`模型能力发现失败: ${response.status} - ${summarizeErrorBody(text)}`, {
                status: response.status,
                retryable: isRetryableStatus(response.status)
            });
        }
        const data = JSON.parse(text || '{}');
        const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
        const models = rows.map(item => {
            const id = String(item.id || item.name || '').replace(/^models\//, '');
            const advertised = Array.isArray(item.supported_endpoint_types)
                ? item.supported_endpoint_types.map(String)
                : [];
            const methods = Array.isArray(item.supportedGenerationMethods)
                ? item.supportedGenerationMethods.map(String)
                : [];
            const supportedEndpointTypes = [...new Set([
                ...advertised,
                ...(useGeminiModels || methods.includes('generateContent') ? ['gemini'] : ['openai']),
                ...(isOpenAIImageModel(id) || isGeminiImageModel(id) || isXAIImageModel(id)
                    || /image|seedream|flux/i.test(id) ? ['image-generation'] : [])
            ])];
            return { id, supported_endpoint_types: supportedEndpointTypes };
        }).filter(item => item.id);
        return {
            success: true,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            protocol: useGeminiModels ? PROTOCOLS.GEMINI_NATIVE : PROTOCOLS.OPENAI_IMAGES,
            models
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

function createApiError(message, metadata = {}) {
    const error = new Error(message);
    error.status = Number(metadata.status) || 0;
    error.retryAfter = metadata.retryAfter || '';
    error.retryable = !!metadata.retryable;
    error.ambiguous = !!metadata.ambiguous;
    error.countsAsFailure = metadata.countsAsFailure !== false;
    error.code = metadata.code || '';
    return error;
}

function isRetryableStatus(status) {
    return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

/**
 * 服务端生成图片 — 支持全部 Gemini API 参数
 * @param {Object} config
 * @returns {Promise<{base64: string, mimeType: string, usageMetadata?: object, thoughtText?: string}>}
 */
async function generateImage(config, callbacks = {}) {
    if (config.maskImage || config.operation === 'mask-edit') {
        return require('./maskEdit').generateMaskedImage(config, callbacks, generateImageRequest);
    }
    return generateImageRequest(config, callbacks);
}

async function generateImageRequest(config, callbacks = {}) {
    throwIfAborted(config.signal);
    const apiCallStartTime = Date.now();
    const {
        provider, apiKey, model, prompt,
        ratio = '1:1', imageSize = '1K',
        referenceImages = [],
        maskImage = null,
        operation = maskImage ? 'edit' : 'generate',
        generationConfig = {}
    } = config;

    console.log(`[apiService] 开始生成: model=${model}, ratio=${ratio}, imageSize=${imageSize}, refs=${referenceImages.length}, 时间=${new Date().toISOString()}`);
    const performanceLog = {
        startTime: apiCallStartTime,
        phases: {}
    };

    if (!provider || !apiKey || !model || !prompt) {
        throw new Error('缺少必要的配置参数');
    }

    const providerLower = provider.toLowerCase();
    const isOpenRouter = providerLower.includes('openrouter.ai');
    const hasRefs = referenceImages.length > 0;
    const modelLower = model.toLowerCase();
    const isGeminiModel = isGeminiImageModel(model);
    const isOpenAIImage = isOpenAIImageModel(model);
    const isGptImage = isOpenAIGptImageModel(model);
    const isDoubaoSeedream = isDoubaoSeedreamModel(model);
    const requestedProtocol = normalizeProtocol(config.protocol);
    const resolvedProtocol = requestedProtocol === PROTOCOLS.AUTO
        ? inferProtocol({ baseUrl: provider }, model)
        : requestedProtocol;
    const useGrsaiNanoBanana = resolvedProtocol === PROTOCOLS.GRSAI_NANO_BANANA
        || grsaiNanoBanana.shouldUse(provider, model, resolvedProtocol);
    const useGrsaiGptImage = grsaiGptImage.shouldUse(provider, model, resolvedProtocol);
    const useXAIImagineProtocol = resolvedProtocol === PROTOCOLS.XAI_IMAGINE;
    const isXAI = isXAIImageModel(model) || useXAIImagineProtocol;
    const isEditOperation = operation === 'edit' || operation === 'mask-edit';

    const useGeminiInteractions = false;
    const useGeminiNative = resolvedProtocol === PROTOCOLS.GEMINI_NATIVE
        || (!useGrsaiNanoBanana && requestedProtocol === PROTOCOLS.AUTO && isGeminiModel && !isOpenAIImage && !isXAI && !isDoubaoSeedream);
    const useOpenAIImages = resolvedProtocol === PROTOCOLS.OPENAI_IMAGES
        || useXAIImagineProtocol
        || (!useGrsaiNanoBanana && requestedProtocol === PROTOCOLS.AUTO && (isOpenAIImage || isXAI || isDoubaoSeedream));
    const isOpenAICompatibleGeminiImage = isGeminiModel && useOpenAIImages && !useGeminiNative;
    const isImage2 = isOpenAIImage2Model(model) || isOpenAIImage25Model(model);
    const effectivePrompt = withAspectRatioInstruction(prompt, ratio, generationConfig, imageSize);
    const providerKind = providerKindForImage({
        isGptImage,
        isImage2,
        isXAI,
        isDoubaoSeedream,
        isOpenAICompatibleGeminiImage,
        useGeminiNative,
        isGrsaiNanoBanana: useGrsaiNanoBanana,
        isGrsaiGptImage: useGrsaiGptImage
    });
    let requestBody;

    if (useGrsaiGptImage) {
        const grsaiRequest = grsaiGptImage.buildGenerateRequest({
            provider,
            model,
            prompt: effectivePrompt,
            ratio,
            imageSize,
            referenceImages,
            generationConfig,
            resolveSize: resolveOpenAIImageSize
        });
        requestBody = grsaiRequest.body;
        config._grsaiGptImageUrl = grsaiRequest.url;
        config._grsaiGptImageReplyType = grsaiRequest.replyType;
    } else if (useGrsaiNanoBanana) {
        const grsaiRequest = grsaiNanoBanana.buildDrawRequest({
            provider,
            model,
            prompt: effectivePrompt,
            ratio,
            imageSize,
            referenceImages
        });
        requestBody = grsaiRequest.body;
        config._grsaiDrawUrl = grsaiRequest.url;
    } else if (useGeminiInteractions) {
        const baseModel = model.replace(/-(0\.5k|2k|4k)$/i, '');
        const customMatch = ratio.trim().match(/^(\d+)[xX\*](\d+)$/);
        let actualRatio = ratio;
        if (customMatch) {
            actualRatio = convertToStandardRatio(parseInt(customMatch[1]), parseInt(customMatch[2]));
        }
        const supportedRatios = ['1:1','1:4','1:8','2:3','3:2','3:4','4:1','4:3','4:5','5:4','8:1','9:16','16:9','21:9'];
        if (!supportedRatios.includes(actualRatio)) {
            throw new Error(`不支持的宽高比: ${actualRatio}`);
        }

        const imageFormat = {
            type: 'image',
            aspect_ratio: actualRatio,
            image_size: normalizeGeminiImageSize(imageSize)
        };
        if (generationConfig.outputMimeType) {
            imageFormat.mime_type = generationConfig.outputMimeType;
        }

        requestBody = {
            model: baseModel,
            input: hasRefs
                ? [
                    { type: 'text', text: effectivePrompt },
                    ...referenceImages.map(ref => ({
                        type: 'image',
                        data: ref.base64,
                        mime_type: ref.mimeType || 'image/png'
                    }))
                ]
                : effectivePrompt,
            response_format: generationConfig.responseModalities === 'IMAGE'
                ? imageFormat
                : [{ type: 'text' }, imageFormat]
        };

        if (generationConfig.temperature != null || generationConfig.topP != null || generationConfig.topK != null || (generationConfig.thinkingLevel && generationConfig.thinkingLevel !== 'none' && generationConfig.thinkingLevel !== 'default')) {
            requestBody.generation_config = {};
            if (generationConfig.temperature != null) requestBody.generation_config.temperature = parseFloat(generationConfig.temperature);
            if (generationConfig.topP != null) requestBody.generation_config.top_p = parseFloat(generationConfig.topP);
            if (generationConfig.topK != null) requestBody.generation_config.top_k = parseInt(generationConfig.topK);
            if (generationConfig.thinkingLevel && generationConfig.thinkingLevel !== 'none' && generationConfig.thinkingLevel !== 'default') {
                requestBody.generation_config.thinking_level = generationConfig.thinkingLevel;
            }
        }

        const tools = [];
        if (generationConfig.googleSearch) {
            tools.push({ type: 'google_search' });
        }
        if (generationConfig.imageSearch) {
            tools.push({ type: 'google_search', search_types: ['image_search'] });
        }
        if (tools.length > 0) {
            requestBody.tools = tools;
        }

        config._baseModel = baseModel;
    } else if (useGeminiNative) {
        const geminiRequest = buildGeminiGenerateContentRequest({
            model,
            prompt: effectivePrompt,
            ratio,
            imageSize,
            referenceImages,
            generationConfig: {
                ...generationConfig,
                xaiNative: useXAIImagineProtocol
            }
        });
        requestBody = geminiRequest.requestBody;
        config._baseModel = geminiRequest.baseModel;
        config._geminiImageConfig = geminiRequest.imageConfig;
    } else if (isXAI && useOpenAIImages) {
        const xaiRequest = buildXAIImageRequest({
            model,
            prompt: effectivePrompt,
            ratio,
            imageSize,
            referenceImages,
            generationConfig
        });
        requestBody = xaiRequest.requestBody;
        config._xaiEndpoint = xaiRequest.endpoint;
    } else if (isDoubaoSeedream && useOpenAIImages) {
        const seedreamSize = resolveDoubaoSeedreamSize(ratio, imageSize, model, generationConfig);
        const seedreamPrompt = withDoubaoSeedreamAspectRatio(effectivePrompt, ratio, seedreamSize);
        requestBody = {
            model,
            prompt: seedreamPrompt,
            size: seedreamSize,
            response_format: generationConfig.responseFormat || generationConfig.seedreamResponseFormat || 'url',
            stream: false,
            watermark: generationConfig.watermark != null ? !!generationConfig.watermark : false
        };

        if (isDoubaoSeedream5Model(model)) {
            requestBody.output_format = doubaoSeedreamOutputFormat(generationConfig);
        }

        if (hasRefs) {
            const images = referenceImages.map(doubaoSeedreamReferenceImage);
            requestBody.image = images.length === 1 ? images[0] : images;
        }

        if (generationConfig.sequentialImageGeneration) {
            requestBody.sequential_image_generation = generationConfig.sequentialImageGeneration;
        }
        if (generationConfig.maxImages != null || generationConfig.seedreamMaxImages != null) {
            const maxImages = parseInt(generationConfig.maxImages ?? generationConfig.seedreamMaxImages, 10);
            if (Number.isFinite(maxImages) && maxImages > 0) {
                requestBody.sequential_image_generation_options = { max_images: maxImages };
            }
        }
        if (generationConfig.googleSearch || generationConfig.webSearch) {
            requestBody.tools = [{ type: 'web_search' }];
        }

        config._doubaoSeedreamSize = seedreamSize;
    } else {
        // ── GPT / OpenAI 风格格式 ──
        const isGeminiImageProxy = modelLower.includes('gemini') && modelLower.includes('image');
        const needsImageConfig = isGeminiImageProxy || isGptImage;

        if (useOpenAIImages) {
            const gptSize = resolveOpenAIImageSize(ratio, model, generationConfig, imageSize);
            config._openAIImageSize = gptSize;
            const profile = imageApiProfiles.getImageApiProfile(model);
            if (referenceImages.length > profile.maxReferences) {
                throw new Error(`当前 OpenAI 模型最多支持 ${profile.maxReferences} 张参考图`);
            }
            const openAIRequest = buildOpenAIImageRequest({
                model,
                prompt: effectivePrompt,
                size: gptSize,
                generationConfig,
                hasReferences: hasRefs
            });

            if (hasRefs || isEditOperation) {
                if (!hasRefs) throw new Error('图片编辑至少需要一张源图');
                const form = new FormData();
                for (const [key, value] of Object.entries(openAIRequest)) {
                    form.append(key, String(value));
                }
                referenceImages.forEach((ref, i) => {
                    const buf = Buffer.from(ref.base64, 'base64');
                    const ext = (ref.mimeType || 'image/png').split('/')[1] || 'png';
                    form.append('image', buf, { filename: `ref_${i}.${ext}`, contentType: ref.mimeType });
                });
                if (maskImage?.base64) {
                    const maskMimeType = maskImage.mimeType || 'image/png';
                    form.append('mask', Buffer.from(maskImage.base64, 'base64'), {
                        filename: 'mask.png',
                        contentType: maskMimeType
                    });
                }
                config._gptImageForm = form;
                requestBody = null;
            } else {
                requestBody = openAIRequest;
            }
        } else {
            requestBody = {
                model,
                messages: [{ role: 'user', content: effectivePrompt }]
            };

            if (needsImageConfig) {
                const imageOnlyModels = ['flux', 'sourceful', 'seedream'];
                const isImageOnlyModel = isOpenAICompatibleGeminiImage || imageOnlyModels.some(m => modelLower.includes(m));
                requestBody.modalities = isImageOnlyModel ? ['image'] : ['image', 'text'];

                const customMatch = ratio.trim().match(/^(\d+)[xX\*](\d+)$/);
                if (customMatch) {
                    requestBody.image_config = {
                        width: parseInt(customMatch[1], 10),
                        height: parseInt(customMatch[2], 10)
                    };
                } else {
                    requestBody.image_config = { aspect_ratio: ratio, image_size: imageSize };
                }
            }

            requestBody.stream = false;

            if (hasRefs) {
                console.log(`[apiService] 上传 ${referenceImages.length} 张参考图到图床`);
                const hostedImages = [];
                for (const ref of referenceImages) {
                    const hosted = await uploadToImageHost(ref.base64, ref.mimeType, { ...callbacks, signal: config.signal });
                    hostedImages.push(hosted);
                }
                requestBody.messages[0].content = [
                    { type: 'text', text: effectivePrompt },
                    ...hostedImages.map(({ url }) => ({ type: 'image_url', image_url: { url } }))
                ];
            }
        }
    }

    // 确定请求 URL
    const baseUrl = provider.replace(/\/$/, '');
    let fetchUrl;
    if (useGrsaiGptImage) {
        fetchUrl = config._grsaiGptImageUrl;
    } else if (useGrsaiNanoBanana) {
        fetchUrl = config._grsaiDrawUrl;
    } else if (useGeminiInteractions) {
        fetchUrl = appendGeminiApiKey(geminiInteractionsUrl(baseUrl), apiKey);
    } else if (useGeminiNative) {
        const baseModel = config._baseModel || model;
        fetchUrl = geminiGenerateContentUrl(baseUrl, baseModel, apiKey);
    } else if (isXAI && useOpenAIImages) {
        fetchUrl = openAIImagesUrl(baseUrl, config._xaiEndpoint || (hasRefs || isEditOperation ? 'edits' : 'generations'));
    } else if (isDoubaoSeedream && useOpenAIImages) {
        fetchUrl = openAIImagesUrl(baseUrl, 'generations');
    } else if (useOpenAIImages) {
        fetchUrl = openAIImagesUrl(baseUrl, hasRefs || isEditOperation ? 'edits' : 'generations');
    } else {
        fetchUrl = openAIChatCompletionsUrl(baseUrl);
    }

    // A generation POST is submitted once. Safe cross-provider failover is owned by TaskQueue.
    let lastError = null;
    for (let attempt = 1; attempt <= API_CONFIG.MAX_RETRIES; attempt++) {
        let currentTimeoutMs = API_CONFIG.TIMEOUT;
        let timeoutId = null;
        let didTimeout = false;
        let controller = null;
        let acceptedProviderTaskId = '';
        try {
            console.log(`[apiService] 尝试 ${attempt}/${API_CONFIG.MAX_RETRIES}: ${fetchUrl.replace(/key=[^&]+/, 'key=***')}`);
            const bodyKeys = requestBody ? Object.keys(requestBody).join(',') : 'multipart/form-data';
            const requestMode = useGrsaiGptImage
                ? 'grsai-gpt-image'
                : useGrsaiNanoBanana
                ? 'grsai-nano-banana'
                : useGeminiInteractions
                ? 'gemini-interactions'
                : useGeminiNative
                    ? 'gemini-native'
                        : isXAI
                            ? 'xai-images'
                        : isDoubaoSeedream
                            ? 'doubao-seedream-images'
                            : useOpenAIImages
                                ? 'openai-images'
                                : 'openai-compatible';
            console.log(`[apiService] mode=${requestMode}, requestBody keys: ${bodyKeys}`);
            if (useGeminiInteractions && requestBody && requestBody.response_format) {
                console.log(`[apiService] response_format: ${JSON.stringify(requestBody.response_format)}`);
            }
            if (useGeminiNative && requestBody && requestBody.generationConfig) {
                console.log(`[apiService] generationConfig: ${JSON.stringify(requestBody.generationConfig)}`);
            }

            // Image2 / GPT Image can take several minutes, especially at 2K/4K sizes.
            const hasThinking = useGeminiNative && generationConfig.thinkingLevel && generationConfig.thinkingLevel !== 'none' && generationConfig.thinkingLevel !== 'default';
            if (useGrsaiGptImage || useGrsaiNanoBanana || useOpenAIImages || isXAI) {
                currentTimeoutMs = API_CONFIG.OPENAI_IMAGE_TIMEOUT;
            } else if (isDoubaoSeedream) {
                currentTimeoutMs = API_CONFIG.OPENAI_IMAGE_TIMEOUT;
            } else if (useGeminiNative && isGeminiModel) {
                currentTimeoutMs = API_CONFIG.GEMINI_IMAGE_TIMEOUT;
            } else if (isOpenAICompatibleGeminiImage) {
                currentTimeoutMs = API_CONFIG.OPENAI_IMAGE_TIMEOUT;
            } else if (hasRefs) {
                currentTimeoutMs = API_CONFIG.IMAGE_EDIT_TIMEOUT;
            } else if (hasThinking) {
                currentTimeoutMs = 180000; // Gemini 思考模式 3 分钟
            } else {
                currentTimeoutMs = API_CONFIG.TIMEOUT;
            }

            performanceLog.phases.requestPrepare = Date.now() - apiCallStartTime;
            console.log('[apiService] request options:', {
                model,
                isOpenAIImage,
                isGptImage,
                isXAI,
                imageSize: config._openAIImageSize || config._doubaoSeedreamSize || config._geminiImageConfig?.imageSize || imageSize,
                aspectRatio: config._geminiImageConfig?.aspectRatio || ratio,
                ratio,
                hasRefs,
                useGeminiInteractions,
                isDoubaoSeedream,
                providerKind,
                stream: false,
                timeoutMs: currentTimeoutMs,
                prepareTime: `${performanceLog.phases.requestPrepare}ms`
            });
            emitProgress(callbacks, {
                phase: 'requesting',
                providerKind,
                stream: false,
                displayProgress: 5,
                message: 'Submitting image request'
            });
            controller = createLinkedAbortController(config.signal);
            const requestCallbacks = { ...callbacks, signal: controller.signal };
            timeoutId = setTimeout(() => {
                didTimeout = true;
                controller.abort();
            }, currentTimeoutMs);

            const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
            if (useGeminiNative) {
                headers['x-goog-api-key'] = apiKey;
                if (!isGeminiNativeProvider(provider)) {
                    headers['Authorization'] = `Bearer ${apiKey}`;
                }
            } else {
                headers['Authorization'] = `Bearer ${apiKey}`;
                if (isOpenRouter) {
                    headers['HTTP-Referer'] = 'http://localhost:3000';
                    headers['X-Title'] = 'NanoBanana2';
                }
            }

            let fetchBody;
            if (config._gptImageForm) {
                fetchBody = config._gptImageForm;
                delete headers['Content-Type'];
                Object.assign(headers, config._gptImageForm.getHeaders());
            } else {
                fetchBody = JSON.stringify(requestBody);
            }

            const response = await fetch(fetchUrl, {
                method: 'POST', headers,
                body: fetchBody,
                signal: controller.signal,
                agent: agentFor(fetchUrl)
            });

            performanceLog.phases.apiResponse = Date.now() - apiCallStartTime;
            console.log(`[apiService] 收到响应: status=${response.status}, 耗时${performanceLog.phases.apiResponse}ms`);

            if (!response.ok) {
                const errorText = await response.text();
                const isHtml = errorText.trimStart().startsWith('<');
                const summary = isHtml
                    ? `${response.status} ${response.statusText || 'HTTP Error'}`
                    : `${response.status} - ${errorText.substring(0, 200)}`;
                throw createApiError(`API 请求失败: ${summary}`, {
                    status: response.status,
                    retryAfter: response.headers.get('retry-after') || '',
                    retryable: isRetryableStatus(response.status),
                    ambiguous: false,
                    countsAsFailure: response.status !== 400 && response.status !== 401 && response.status !== 403
                });
            }

            const contentType = response.headers.get('content-type') || '';
            if (contentType.toLowerCase().includes('text/event-stream')) {
                const error = new Error('API 返回了流式响应，但 PicGen 已强制使用非流式异步任务模式');
                error.noRetry = true;
                error.retryable = false;
                error.ambiguous = false;
                throw error;
            }
            emitProgress(callbacks, {
                phase: 'response_received',
                providerKind,
                stream: false,
                displayProgress: 80,
                message: 'Image response received'
            });

            if (contentType.includes('application/json')) {
                const responseText = await response.text();
                performanceLog.phases.bodyReceived = Date.now() - apiCallStartTime;
                const data = JSON.parse(responseText);
                performanceLog.phases.jsonParse = Date.now() - apiCallStartTime;
                console.log('[apiService] JSON response timing', {
                    receiveBodyMs: performanceLog.phases.bodyReceived - performanceLog.phases.apiResponse,
                    parseJsonMs: performanceLog.phases.jsonParse - performanceLog.phases.bodyReceived
                });
                if (useGrsaiGptImage) {
                    const directUrl = grsaiGptImage.extractResultUrl(data);
                    if (directUrl) {
                        const downloaded = directUrl.startsWith('data:image/')
                            ? parseDataUrl(directUrl, null)
                            : await downloadImageAsBase64(directUrl, requestCallbacks);
                        clearTimeout(timeoutId);
                        return downloaded;
                    }
                    const taskId = grsaiGptImage.extractId(data);
                    if (!taskId) throw new Error(`Grsai GPT Image 响应缺少任务 ID 或图片 URL: ${JSON.stringify(data).slice(0, 240)}`);
                    const pollIntervalMs = Math.max(200, Number(callbacks.grsaiPollIntervalMs ?? generationConfig.grsaiPollIntervalMs) || 1200);
                    const pollDeadline = Date.now() + Math.max(1000, currentTimeoutMs - 1000);
                    while (Date.now() < pollDeadline) {
                        await delay(pollIntervalMs, controller.signal);
                        const pollResponse = await fetch(grsaiGptImage.resultUrl(provider, taskId), {
                            method: 'GET',
                            headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
                            signal: controller.signal,
                            agent: agentFor(fetchUrl)
                        });
                        const pollText = await pollResponse.text();
                        let pollData;
                        try { pollData = JSON.parse(pollText || '{}'); } catch { pollData = {}; }
                        if (!pollResponse.ok) throw createApiError(`Grsai GPT Image 结果查询失败: ${pollResponse.status} - ${pollText.slice(0, 200)}`, { status: pollResponse.status, retryable: isRetryableStatus(pollResponse.status) });
                        const resultUrl = grsaiGptImage.extractResultUrl(pollData);
                        emitProgress(callbacks, { phase: 'polling', providerKind, displayProgress: resultUrl ? 90 : 60, message: resultUrl ? 'Grsai image ready' : 'Waiting for Grsai image' });
                        if (resultUrl) {
                            const downloaded = resultUrl.startsWith('data:image/') ? parseDataUrl(resultUrl, null) : await downloadImageAsBase64(resultUrl, requestCallbacks);
                            clearTimeout(timeoutId);
                            return downloaded;
                        }
                        if (grsaiGptImage.isFailed(grsaiGptImage.state(pollData))) throw new Error(`Grsai GPT Image 任务失败: ${JSON.stringify(pollData).slice(0, 240)}`);
                        if (grsaiGptImage.isDone(grsaiGptImage.state(pollData))) throw new Error(`Grsai GPT Image 已完成但没有图片 URL: ${JSON.stringify(pollData).slice(0, 240)}`);
                    }
                    throw createApiError(`Grsai GPT Image 任务轮询超时（taskId=${taskId}）`, { retryable: false, ambiguous: true, code: 'OUTCOME_UNCERTAIN' });
                }
                if (useGrsaiNanoBanana) {
                    if (!grsaiNanoBanana.isSuccess(data)) {
                        throw new Error(`Grsai 提交任务失败: ${data.msg || data.message || data.error || JSON.stringify(data).slice(0, 240)}`);
                    }
                    const taskId = grsaiNanoBanana.extractTaskId(data);
                    if (!taskId) throw new Error(`Grsai 提交响应缺少任务 ID: ${JSON.stringify(data).slice(0, 240)}`);
                    acceptedProviderTaskId = taskId;
                    const pollIntervalMs = Math.max(1, Number(callbacks.grsaiPollIntervalMs ?? generationConfig.grsaiPollIntervalMs) || 1200);
                    const pollDeadline = Date.now() + Math.max(1000, currentTimeoutMs - 1000);
                    let latest = data;
                    while (Date.now() < pollDeadline) {
                        await delay(pollIntervalMs, controller.signal);
                        const pollRequest = grsaiNanoBanana.buildResultRequest(provider, taskId);
                        const pollResponse = await fetch(pollRequest.url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
                            body: JSON.stringify(pollRequest.body),
                            signal: controller.signal,
                            agent: agentFor(pollRequest.url)
                        });
                        const pollText = await pollResponse.text();
                        let pollData;
                        try { pollData = JSON.parse(pollText || '{}'); } catch { pollData = {}; }
                        latest = pollData;
                        if (!pollResponse.ok) {
                            throw createApiError(`Grsai 结果查询失败: ${pollResponse.status} - ${pollText.substring(0, 200)}`, {
                                status: pollResponse.status,
                                retryable: isRetryableStatus(pollResponse.status),
                                countsAsFailure: pollResponse.status !== 400 && pollResponse.status !== 401 && pollResponse.status !== 403
                            });
                        }
                        if (!grsaiNanoBanana.isSuccess(pollData)) {
                            throw new Error(`Grsai 结果查询失败: ${pollData.msg || pollData.message || pollData.error || JSON.stringify(pollData).slice(0, 240)}`);
                        }
                        const state = grsaiNanoBanana.resultState(pollData);
                        const resultUrl = grsaiNanoBanana.extractResultUrl(pollData);
                        emitProgress(callbacks, { phase: 'polling', providerKind, displayProgress: resultUrl ? 90 : 60, message: resultUrl ? 'Grsai image ready' : 'Waiting for Grsai image' });
                        if (resultUrl || grsaiNanoBanana.isCompletedState(state)) {
                            if (!resultUrl) throw new Error(`Grsai 任务已完成但没有图片 URL: ${JSON.stringify(pollData).slice(0, 240)}`);
                            const downloaded = resultUrl.startsWith('data:image/')
                                ? parseDataUrl(resultUrl, null)
                                : await downloadImageAsBase64(resultUrl, requestCallbacks);
                            performanceLog.phases.complete = Date.now() - apiCallStartTime;
                            clearTimeout(timeoutId);
                            return downloaded;
                        }
                        if (grsaiNanoBanana.isFailedState(state)) {
                            throw new Error(`Grsai 图片任务失败: ${pollData.msg || pollData.message || state}`);
                        }
                    }
                    throw createApiError(`Grsai 图片任务轮询超时（taskId=${taskId}）`, { retryable: false, ambiguous: true, code: 'OUTCOME_UNCERTAIN' });
                }
                const result = await parseJsonResponse(data, useGeminiNative, requestCallbacks);
                performanceLog.phases.complete = Date.now() - apiCallStartTime;
                console.log('[apiService] 解析成功:', {
                    hasBase64: !!result.base64,
                    base64Length: result.base64?.length || 0,
                    mimeType: result.mimeType,
                    totalTime: `${performanceLog.phases.complete}ms`
                });
                clearTimeout(timeoutId);
                return result;
            } else if (contentType && contentType.includes('image/')) {
                const buffer = await response.buffer();
                performanceLog.phases.complete = Date.now() - apiCallStartTime;
                console.log('[apiService] 收到图片响应:', contentType, `总耗时${performanceLog.phases.complete}ms`);
                clearTimeout(timeoutId);
                return { base64: buffer.toString('base64'), mimeType: contentType.split(';')[0] };
            } else {
                throw new Error('不支持的响应格式');
            }

        } catch (error) {
            if (timeoutId) clearTimeout(timeoutId);
            const isAbortError = error.name === 'AbortError' || /aborted|abort/i.test(error.message || '');
            let normalizedError = error;
            if (isAbortError && didTimeout) {
                normalizedError = createApiError(
                    `本地等待超时：${Math.round(currentTimeoutMs / 1000)} 秒内没有收到图片生成响应；结果状态未知，PicGen 不会自动重复提交`,
                    { retryable: false, ambiguous: true, countsAsFailure: true, code: 'OUTCOME_UNCERTAIN' }
                );
            } else if (isAbortError) {
                normalizedError.name = 'AbortError';
                normalizedError.retryable = false;
                normalizedError.ambiguous = false;
                normalizedError.countsAsFailure = false;
            } else if (normalizedError.retryable == null) {
                const safeNetworkFailure = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error.code);
                normalizedError.retryable = safeNetworkFailure;
                normalizedError.ambiguous = !safeNetworkFailure && !!error.code;
                normalizedError.countsAsFailure = true;
            }
            // A poll failure after an accepted asynchronous job must not create another paid job.
            if (acceptedProviderTaskId && !isAbortError) {
                normalizedError.retryable = false;
                normalizedError.ambiguous = true;
                normalizedError.providerTaskId = acceptedProviderTaskId;
            }
            lastError = normalizedError;
            console.error(`[apiService] 尝试 ${attempt} 失败: ${normalizedError.message}`, {
                originalMessage: error.message,
                name: error.name,
                isNativeImageApi: useOpenAIImages || isXAI || useGeminiNative,
                timeoutMs: currentTimeoutMs
            });
            break;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
            // Rejected streaming/unknown response bodies must not keep a socket alive.
            controller?.abort();
            controller?.dispose();
        }
    }

    throw lastError || new Error('API 调用失败');
}

/**
 * 解析 JSON 响应，提取图片数据
 */
async function parseGeminiNativeResponse(data, usageMetadata, callbacks = {}) {
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const finalImages = [];
    const thoughtImages = [];
    const finalImageUrls = [];
    const thoughtLines = [];
    const responseText = [];
    let hasGeminiContent = false;

    for (const candidate of candidates) {
        const parts = candidate?.content?.parts;
        if (!Array.isArray(parts)) continue;
        hasGeminiContent = true;

        for (const part of parts) {
            const isThought = part?.thought === true;
            if (isThought && typeof part.text === 'string') {
                thoughtLines.push(part.text);
            }

            const imgData = part?.inline_data || part?.inlineData;
            const mimeType = imgData?.mime_type || imgData?.mimeType;
            if (typeof imgData?.data === 'string' && typeof mimeType === 'string' && mimeType.startsWith('image/')) {
                (isThought ? thoughtImages : finalImages).push({ base64: imgData.data, mimeType });
                continue;
            }

            if (!isThought && typeof part?.text === 'string') {
                const markdownMatches = [...part.text.matchAll(/!\[.*?\]\((https?:\/\/[^)]+)\)/g)];
                for (const match of markdownMatches) finalImageUrls.push(match[1]);
                if (markdownMatches.length === 0) responseText.push(part.text);
            }
        }
    }

    const thoughtText = thoughtLines.join('\n').trim() || undefined;
    const selectedImage = finalImages[finalImages.length - 1];
    if (selectedImage) return { ...selectedImage, usageMetadata, thoughtText };

    const selectedUrl = finalImageUrls[finalImageUrls.length - 1];
    if (selectedUrl) {
        const downloaded = await downloadImageAsBase64(selectedUrl, callbacks);
        return { ...downloaded, usageMetadata, thoughtText };
    }

    // Some Gemini relays mark every rendered image as a thought; the final one is the usable output.
    const thoughtFallback = thoughtImages[thoughtImages.length - 1];
    if (thoughtFallback) return { ...thoughtFallback, usageMetadata, thoughtText };

    if (!hasGeminiContent) return null;
    const refusalText = responseText.join(' ').trim();
    if (refusalText) throw new Error(`模型拒绝生成图片: ${refusalText.substring(0, 200)}`);
    throw new Error('Gemini API 响应中未找到图片数据');
}

async function parseJsonResponse(data, isGeminiNative, callbacks = {}) {
    console.log('[parseJsonResponse] 开始解析，isGeminiNative:', isGeminiNative);
    console.log('[parseJsonResponse] 响应数据结构:', {
        hasCandidates: !!data.candidates,
        hasChoices: !!data.choices,
        keys: Object.keys(data)
    });

    const usageMetadata = data.usageMetadata || data.usage || data.metadata?.usage || null;
    if (isGeminiNative || Array.isArray(data.candidates)) {
        const geminiImage = await parseGeminiNativeResponse(data, usageMetadata, callbacks);
        if (geminiImage) return geminiImage;
    }

    const directImage = await extractImageFromJson(data, usageMetadata, '', callbacks);
    if (directImage) return directImage;

    // Chat completions 格式（OpenAI 兼容 / GPT-Image-2-All）
    if (data.choices && data.choices[0]) {
        const message = data.choices[0].message;
        const content = message.content;

        // GPT-Image-2-All: 检查 message.images 数组
        if (message.images && message.images.length > 0) {
            const img = message.images[0];
            if (typeof img === 'string') return parseDataUrl(img, usageMetadata);
            if (img.image_url && img.image_url.url) {
                const url = img.image_url.url;
                if (url.startsWith('data:')) return parseDataUrl(url, usageMetadata);
                const downloaded = await downloadImageAsBase64(url, callbacks);
                return { ...downloaded, usageMetadata };
            }
            if (img.url) {
                const downloaded = await downloadImageAsBase64(img.url, callbacks);
                return { ...downloaded, usageMetadata };
            }
            // GPT-Image-2-All: 直接包含 b64_json 字段
            if (img.b64_json) {
                return { base64: img.b64_json, mimeType: 'image/png', usageMetadata };
            }
        }

        // GPT-Image-2-All: 检查 message.content 是否为数组（多模态响应）
        if (Array.isArray(content)) {
            for (const item of content) {
                if (item.type === 'image_url' && item.image_url && item.image_url.url) {
                    const url = item.image_url.url;
                    if (url.startsWith('data:')) return parseDataUrl(url, usageMetadata);
                    const downloaded = await downloadImageAsBase64(url, callbacks);
                    return { ...downloaded, usageMetadata };
                }
                // GPT-Image-2-All: 支持 type: 'image' 格式
                if (item.type === 'image' && item.image_url && item.image_url.url) {
                    const url = item.image_url.url;
                    if (url.startsWith('data:')) return parseDataUrl(url, usageMetadata);
                    const downloaded = await downloadImageAsBase64(url, callbacks);
                    return { ...downloaded, usageMetadata };
                }
                // 直接包含 b64_json
                if (item.type === 'image' && item.b64_json) {
                    return { base64: item.b64_json, mimeType: 'image/png', usageMetadata };
                }
            }
        }

        if (typeof content === 'string') {
            if (content.includes('data:image/') && content.includes(';base64,')) {
                const dataUrlStart = content.indexOf('data:image/');
                let dataUrlEnd = content.indexOf(')', dataUrlStart);
                if (dataUrlEnd === -1) dataUrlEnd = content.length;
                return parseDataUrl(content.substring(dataUrlStart, dataUrlEnd), usageMetadata);
            }
            const markdownMatch = content.match(/!\[.*?\]\((https?:\/\/[^\)]+)\)/);
            if (markdownMatch && markdownMatch[1]) {
                const downloaded = await downloadImageAsBase64(markdownMatch[1], callbacks);
                return { ...downloaded, usageMetadata };
            }
            if (content.trim().startsWith('http')) {
                const downloaded = await downloadImageAsBase64(content.trim(), callbacks);
                return { ...downloaded, usageMetadata };
            }
            if (content.length > 100 && !content.includes('http')) {
                return { base64: content.replace(/[^A-Za-z0-9+/=]/g, ''), mimeType: 'image/png', usageMetadata };
            }
        }
    }

    // DALL-E 格式
    if (data.data && data.data[0]) {
        if (data.data[0].url) {
            const downloaded = await downloadImageAsBase64(data.data[0].url, callbacks);
            return { ...downloaded, usageMetadata };
        }
        if (data.data[0].b64_json) {
            return {
                base64: data.data[0].b64_json,
                mimeType: data.data[0].mime_type || data.data[0].mimeType || 'image/png',
                usageMetadata
            };
        }
    }
    if (data.image_url) {
        const downloaded = await downloadImageAsBase64(data.image_url, callbacks);
        return { ...downloaded, usageMetadata };
    }
    if (data.image_data) {
        return parseDataUrl(data.image_data, usageMetadata);
    }

    throw new Error('API 响应格式错误: 缺少图片数据');
}

async function extractImageFromJson(value, usageMetadata, parentKey = '', callbacks = {}) {
    if (!value) return null;

    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return null;

        const parsed = tryParseJsonString(text);
        if (parsed.ok && parsed.value !== text) {
            const result = await extractImageFromJson(parsed.value, usageMetadata, parentKey, callbacks);
            if (result) return result;
        }

        if (text.startsWith('data:image/') && text.includes(';base64,')) {
            return parseDataUrl(text, usageMetadata);
        }

        const embeddedDataUrl = text.match(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/i);
        if (embeddedDataUrl) {
            return parseDataUrl(embeddedDataUrl[0], usageMetadata);
        }

        const markdownMatch = text.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
        if (markdownMatch && markdownMatch[1]) {
            const downloaded = await downloadImageAsBase64(markdownMatch[1], callbacks);
            return { ...downloaded, usageMetadata };
        }

        const imageLikeKey = /image|url|content|output|result|response/i.test(parentKey);
        if ((parentKey === 'url' || parentKey === 'image_url' || imageLikeKey) && /^https?:\/\//i.test(text)) {
            const downloaded = await downloadImageAsBase64(text, callbacks);
            return { ...downloaded, usageMetadata };
        }

        const base64LikeKey = /image|inline|b64|base64|bytes|data/i.test(parentKey);
        if (base64LikeKey && text.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
            return { base64: text.replace(/[^A-Za-z0-9+/=]/g, ''), mimeType: 'image/png', usageMetadata };
        }

        return null;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const result = await extractImageFromJson(item, usageMetadata, parentKey, callbacks);
            if (result) return result;
        }
        return null;
    }

    if (typeof value !== 'object') return null;

    const mimeType = value.mime_type || value.mimeType || value.media_type || value.mediaType;
    const hasImageMime = typeof mimeType === 'string' && mimeType.startsWith('image/');
    const typeValue = value.type || value.kind || '';
    const likelyImageKey = /image|inline|b64/i.test(parentKey) || (typeof typeValue === 'string' && /image/i.test(typeValue));

    if (value.inline_data || value.inlineData || value.output_image || value.outputImage) {
        const nested = value.inline_data || value.inlineData || value.output_image || value.outputImage;
        const result = await extractImageFromJson(nested, usageMetadata, parentKey || 'image', callbacks);
        if (result) return result;
    }

    if (value.image_url) {
        const result = await extractImageFromJson(value.image_url, usageMetadata, 'image_url', callbacks);
        if (result) return result;
    }

    const base64Value = value.b64_json || value.base64 || value.data || value.image_bytes || value.imageBytes;
    if (typeof base64Value === 'string' && (hasImageMime || likelyImageKey || value.b64_json || value.base64)) {
        if (base64Value.startsWith('data:image/')) return parseDataUrl(base64Value, usageMetadata);
        return { base64: base64Value.replace(/[^A-Za-z0-9+/=]/g, ''), mimeType: mimeType || 'image/png', usageMetadata };
    }

    const imageResultUrl = typeof value.url === 'string'
        && (/^(?:data|output|result|response|image|images)$/i.test(parentKey)
            || Object.prototype.hasOwnProperty.call(value, 'size'));
    if (typeof value.url === 'string' && (hasImageMime || likelyImageKey || imageResultUrl || value.url.startsWith('data:image/'))) {
        if (value.url.startsWith('data:image/')) return parseDataUrl(value.url, usageMetadata);
        const downloaded = await downloadImageAsBase64(value.url, callbacks);
        return { ...downloaded, usageMetadata };
    }

    const priorityKeys = [
        'output_image',
        'outputImage',
        'image',
        'images',
        'image_url',
        'choices',
        'message',
        'delta',
        'parts',
        'part',
        'candidates',
        'candidate',
        'steps',
        'content',
        'output',
        'result',
        'response',
        'data'
    ];
    for (const key of priorityKeys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            const result = await extractImageFromJson(value[key], usageMetadata, key, callbacks);
            if (result) return result;
        }
    }

    return null;
}

function parseDataUrl(dataUrl, usageMetadata) {
    let base64, mimeType = 'image/png';
    if (dataUrl.startsWith('data:')) {
        const commaIndex = dataUrl.indexOf(',');
        const header = dataUrl.substring(0, commaIndex);
        const mimeMatch = header.match(/data:([^;]+)/);
        if (mimeMatch) mimeType = mimeMatch[1];
        base64 = dataUrl.substring(commaIndex + 1);
    } else {
        base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    }
    base64 = base64.replace(/[^A-Za-z0-9+/=]/g, '');
    return { base64, mimeType, usageMetadata };
}

module.exports = {
    generateImage,
    optimizePrompt,
    reversePrompt,
    discoverImageProviderCapabilities,
    testImageProviderConnection,
    testChatProviderConnection,
    uploadToImageHost,
    setProxyState,
    getProxyState,
    testProxyReachability,
    convertToStandardRatio,
    calculateSize,
    DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
    REVERSE_PROMPT_SYSTEM_PROMPT,
    _test: {
        buildGeminiGenerateContentRequest,
        buildOpenAIImageRequest,
        buildXAIImageRequest,
        buildGrsaiGptImageRequest: grsaiGptImage.buildGenerateRequest,
        promptAspectRatio,
        withAspectRatioInstruction,
        createApiError,
        parseJsonResponse,
        geminiGenerateContentUrl,
        openAIImagesUrl,
        resolveOpenAIImageSize,
        publicAddressesFor,
        shouldTryPublicDns,
        downloadAgentFor,
        fetchDownload
    }
};
