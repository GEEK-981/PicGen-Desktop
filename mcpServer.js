const http = require('http');
const crypto = require('crypto');

const PROTOCOL_VERSION = '2025-06-18';

// Sent once at the handshake so an agent knows the fast path without exploring.
const INSTRUCTIONS = [
    'PicGen 是用户本机的 AI 生图应用，生成的图片保存在用户电脑上。',
    '推荐流程：',
    '1. picgen_list_models 查看全部已启用配置组的模型、所属供应商、标价，以及各自支持的画幅、分辨率档位和参考图上限。',
    '2. picgen_generate_batch 一次提交全部请求。每条可单独指定 prompt、model、ratio、imageSize、count、references；不写 model 时沿用用户界面当前序列的模型和设置。参考图按 references 的顺序编号，提示词里称为「参考图1」「参考图2」。',
    '   选供应商：不受界面路由策略（包括「指定配置组」）限制。默认在所有提供该模型的配置组里按标价从低到高选，失败时依次转移；supplier 填供应商名称只用该供应商，groupId 只用那一个配置组，routing 可改成 priority / balanced / speed / order。',
    '3. picgen_wait_tasks 等待结果，返回保存好的文件路径；includeImages=true 可直接看到缩略图。',
    '注意：生图会产生费用。建议每批都带 idempotencyKey：同一批因超时等原因要重发时用同一个 key，PicGen 会返回第一次的结果而不会重复入队。提交结果显示「未确认」时不要重发，先用 picgen_list_tasks 核对。用户可能设置了每日张数上限，picgen_status 可查看今天的剩余额度。picgen_cancel_my_tasks 可撤回你提交的全部任务。'
].join('\n');
const SERVER_NAME = 'picgen';

const TOOLS = [
    { name: 'picgen_status', title: '应用状态', description: '读取 PicGen 当前状态：版本、MCP 地址、保存目录、代理模式、路由策略、供应商数量、队列任务数、历史图片数。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_list_suppliers', title: '列出供应商', description: '列出全部供应商及其配置组（不含 API Key）。role 可按 image / chat 过滤配置组。', inputSchema: { type: 'object', properties: { role: { type: 'string', enum: ['image', 'chat'] } } } },
    { name: 'picgen_list_models', title: '列出模型', description: '列出全部已启用配置组的生图模型（不受界面路由策略限制），含所属供应商、每张标价（price，未标价为 null）、支持的画幅比例、分辨率档位和参考图上限。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_test_provider', title: '测试供应商连接', description: '用已保存的凭据测试一个配置组的连接，不消耗生图额度。groupId 来自 picgen_list_suppliers。', inputSchema: { type: 'object', properties: { groupId: { type: 'string' }, model: { type: 'string', description: '留空则用该配置组的第一个模型' } }, required: ['groupId'] } },
    { name: 'picgen_discover_models', title: '发现模型', description: '向供应商查询它实际提供的模型列表。groupId 来自 picgen_list_suppliers。', inputSchema: { type: 'object', properties: { groupId: { type: 'string' } }, required: ['groupId'] } },
    { name: 'picgen_provider_health', title: '供应商健康', description: '读取各生图配置组的健康状态：可用、降级或故障，以及熔断、冷却和最近错误。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_reset_provider', title: '重置供应商状态', description: '清除熔断和冷却，让供应商重新参与调度。不传 groupId 则重置全部。', inputSchema: { type: 'object', properties: { groupId: { type: 'string' } } } },
    { name: 'picgen_get_routing', title: '读取路由策略', description: '读取当前的请求分配策略、并发上限和故障转移设置。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_set_routing', title: '设置路由策略', description: '修改请求分配策略。strategy 取 order（按顺序）、priority（优先级）、balanced（负载均衡）、fixed（指定配置组，需 selectedProviderId）、price（价格优先）、speed（速度优先）。', inputSchema: { type: 'object', properties: { strategy: { type: 'string', enum: ['order', 'priority', 'balanced', 'fixed', 'price', 'speed'] }, selectedProviderId: { type: 'string' }, enabled: { type: 'boolean', description: '是否启用故障转移' }, maxAttempts: { type: 'integer' }, maxGlobalConcurrent: { type: 'integer' }, failoverThreshold: { type: 'integer' }, cooldownMs: { type: 'integer' } } } },
    { name: 'picgen_get_proxy', title: '读取网络设置', description: '读取当前代理模式：direct（直连）、system（系统代理）或 custom（自定义代理）。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_set_proxy', title: '设置网络代理', description: '切换连接方式。mode=custom 时必须给出 customProxy，例如 http://127.0.0.1:7890。', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['direct', 'system', 'custom'] }, customProxy: { type: 'string' }, bypassList: { type: 'string' } }, required: ['mode'] } },
    { name: 'picgen_test_proxy', title: '测试代理连通性', description: '按当前网络设置测试到上游的连通性。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_get_output_directory', title: '读取保存目录', description: '读取生成图片的默认保存目录，以及它是否为应用默认目录。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_set_output_directory', title: '设置保存目录', description: '把生成图片的默认保存目录改到一个已存在、可写的绝对路径。传空字符串恢复应用默认目录。', inputSchema: { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'] } },
    { name: 'picgen_open_output_folder', title: '打开保存目录', description: '在系统文件管理器中打开当前保存目录。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_list_sequences', title: '列出序列', description: '列出界面上的全部生成序列：提示词、模型、画幅、张数、分辨率和参考图（不含图片内容）。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_get_sequence', title: '读取序列', description: '读取一个序列的完整草稿。sequenceId 留空读取当前序列。', inputSchema: { type: 'object', properties: { sequenceId: { type: 'string' } } } },
    { name: 'picgen_create_sequence', title: '新建序列', description: '新建一个生成序列并立刻显示在界面上。可同时写入提示词、模型、画幅、张数和分辨率。', inputSchema: { type: 'object', properties: { name: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, ratio: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 5 }, imageSize: { type: 'string' }, providerId: { type: 'string' }, makeCurrent: { type: 'boolean' } } } },
    { name: 'picgen_update_sequence', title: '修改序列', description: '修改一个序列的草稿。sequenceId 留空修改当前序列。只传需要改的字段。', inputSchema: { type: 'object', properties: { sequenceId: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, ratio: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 5 }, imageSize: { type: 'string' }, providerId: { type: 'string' }, makeCurrent: { type: 'boolean' } } } },
    { name: 'picgen_delete_sequence', title: '删除序列', description: '删除一个序列。最后一个序列不能删除。', inputSchema: { type: 'object', properties: { sequenceId: { type: 'string' } }, required: ['sequenceId'] } },
    { name: 'picgen_add_reference', title: '添加参考图', description: '给序列添加一张参考图。filePath 指向本地图片，或传 base64 与 mimeType。sequenceId 留空添加到当前序列。', inputSchema: { type: 'object', properties: { sequenceId: { type: 'string' }, filePath: { type: 'string' }, base64: { type: 'string' }, mimeType: { type: 'string' }, name: { type: 'string' }, alias: { type: 'string', description: '提示词里用 @{alias} 引用这张图' } } } },
    { name: 'picgen_remove_reference', title: '移除参考图', description: '从序列移除一张参考图。referenceId 来自 picgen_get_sequence。', inputSchema: { type: 'object', properties: { sequenceId: { type: 'string' }, referenceId: { type: 'string' } }, required: ['referenceId'] } },
    { name: 'picgen_generate_batch', title: '批量生成图片', description: '一次提交多条生图请求，全部立即入队，返回所有任务 ID。每条可单独指定提示词、模型、画幅、档位、张数和参考图；没写的字段用 defaults，再没有就沿用用户界面当前序列。所有条目先整体校验，任何一条不合格就一张都不提交。提交后用 picgen_wait_tasks 等结果。带 idempotencyKey 重发同一批不会重复入队。', inputSchema: { type: 'object', properties: { items: { type: 'array', minItems: 1, items: { type: 'object', properties: { prompt: { type: 'string' }, model: { type: 'string', description: '来自 picgen_list_models；留空沿用界面当前序列' }, groupId: { type: 'string', description: '只用这个配置组（来自 picgen_list_models 的 providerId）；不受界面路由策略限制' }, supplier: { type: 'string', description: '只用这个供应商（名称或 id，见 picgen_list_suppliers）下提供该模型的配置组' }, routing: { type: 'string', enum: ['price', 'priority', 'balanced', 'speed', 'order'], description: '在可选配置组之间怎么挑，默认 price（标价最低优先，失败时按价格依次转移）' }, ratio: { type: 'string', description: '如 16:9，需在该模型支持的画幅内' }, imageSize: { type: 'string', description: '如 1K / 2K / 4K，模型不支持时自动收敛。不写时沿用界面当前序列；没有可沿用的就用应用默认档位（偏高，费用也偏高），在意费用请明确写 1K' }, count: { type: 'integer', minimum: 1, maximum: 100 }, references: { type: 'array', items: { type: 'object', properties: { filePath: { type: 'string', description: '本地图片的绝对路径' }, historyId: { type: 'string', description: '来自 picgen_list_history' }, base64: { type: 'string' } } }, description: '按顺序编号为参考图1、参考图2…' }, advanced: { type: 'object', description: '高级参数，字段同界面高级设置，如 gptQuality、temperature' } }, required: ['prompt'] } }, defaults: { type: 'object', properties: { model: { type: 'string', description: '来自 picgen_list_models；留空沿用界面当前序列' }, groupId: { type: 'string', description: '只用这个配置组（来自 picgen_list_models 的 providerId）；不受界面路由策略限制' }, supplier: { type: 'string', description: '只用这个供应商（名称或 id，见 picgen_list_suppliers）下提供该模型的配置组' }, routing: { type: 'string', enum: ['price', 'priority', 'balanced', 'speed', 'order'], description: '在可选配置组之间怎么挑，默认 price（标价最低优先，失败时按价格依次转移）' }, ratio: { type: 'string', description: '如 16:9，需在该模型支持的画幅内' }, imageSize: { type: 'string', description: '如 1K / 2K / 4K，模型不支持时自动收敛。不写时沿用界面当前序列；没有可沿用的就用应用默认档位（偏高，费用也偏高），在意费用请明确写 1K' }, count: { type: 'integer', minimum: 1, maximum: 100 }, references: { type: 'array', items: { type: 'object', properties: { filePath: { type: 'string', description: '本地图片的绝对路径' }, historyId: { type: 'string', description: '来自 picgen_list_history' }, base64: { type: 'string' } } }, description: '按顺序编号为参考图1、参考图2…' }, advanced: { type: 'object', description: '高级参数，字段同界面高级设置，如 gptQuality、temperature' } } }, idempotencyKey: { type: 'string', description: '同一个 key 24 小时内只提交一次（应用重启后依然有效），重复调用返回第一次的结果；同一个 key 换了请求内容会被拒绝' } }, required: ['items'] } },
    { name: 'picgen_wait_tasks', title: '等待任务完成', description: '等待一组任务全部结束（完成、失败或取消）后一次返回，或到超时返回当前进度。完成的任务带保存好的 filePath；includeImages=true 时附带缩略图。超时未完成的列在 pending 里，可再次调用继续等。', inputSchema: { type: 'object', properties: { taskIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500 }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 600, description: '默认 60' }, includeImages: { type: 'boolean' }, maxEdge: { type: 'integer', description: '缩略图最长边，默认 512' } }, required: ['taskIds'] } },
    { name: 'picgen_cancel_my_tasks', title: '取消我的任务', description: '取消当前客户端（按客户端名称区分，同名的多个窗口算同一个）通过 picgen_generate_batch 提交的、仍在排队或生成中的全部任务。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_generate', title: '按序列生成', description: '按界面上一个序列的草稿提交生成任务（会用到序列里的参考图和 @ 引用），走与界面相同的队列、路由和故障转移。sequenceId 留空使用当前序列。count 覆盖草稿里的张数（1 到 5）。一般批量出图请用 picgen_generate_batch。', inputSchema: { type: 'object', properties: { sequenceId: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 5 }, prompt: { type: 'string', description: '覆盖草稿提示词，只对这一次生效' } } } },
    { name: 'picgen_list_tasks', title: '列出任务', description: '列出队列里的任务。status 取 pending、running、completed、failed、cancelled，多个用逗号分隔。', inputSchema: { type: 'object', properties: { status: { type: 'string' }, sequenceId: { type: 'string' }, limit: { type: 'integer' } } } },
    { name: 'picgen_get_task', title: '读取任务', description: '读取一个任务的状态、进度和结果。完成后 result.filePath 是保存好的图片。', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
    { name: 'picgen_cancel_task', title: '取消任务', description: '取消一个排队中或生成中的任务。正在保存的任务不能取消。', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
    { name: 'picgen_cancel_sequence_tasks', title: '取消序列任务', description: '取消一个序列下全部排队中和生成中的任务。', inputSchema: { type: 'object', properties: { sequenceId: { type: 'string' } }, required: ['sequenceId'] } },
    { name: 'picgen_list_history', title: '列出历史图片', description: '按时间倒序列出已生成的图片。可按模型、关键词过滤，query 同时匹配提示词和文件名。', inputSchema: { type: 'object', properties: { limit: { type: 'integer' }, offset: { type: 'integer' }, model: { type: 'string' }, query: { type: 'string' } } } },
    { name: 'picgen_get_image', title: '读取图片', description: '读取一张图片的像素。historyId 来自 picgen_list_history，或直接给 filePath。返回 PNG/JPEG 等内容，默认最长边 1024。', inputSchema: { type: 'object', properties: { historyId: { type: 'string' }, filePath: { type: 'string' }, maxEdge: { type: 'integer', description: '最长边像素，0 表示原图' } } } },
    { name: 'picgen_copy_image', title: '复制图片', description: '把一张图片复制到系统剪贴板。历史图片会计一次带出次数。', inputSchema: { type: 'object', properties: { historyId: { type: 'string' }, filePath: { type: 'string' } } } },
    { name: 'picgen_save_image_as', title: '另存图片', description: '把一张图片原样复制到指定绝对路径，不弹对话框。扩展名按文件头改写；目标已存在时自动改名为 名字-1，绝不覆盖。返回实际保存的路径。', inputSchema: { type: 'object', properties: { historyId: { type: 'string' }, filePath: { type: 'string' }, destination: { type: 'string' } }, required: ['destination'] } },
    { name: 'picgen_trash_images', title: '移入回收站', description: '把历史图片移入应用内回收站（文件保留，可还原）。historyIds 来自 picgen_list_history。被使用次数保护的图片会被跳过，confirmProtected=true 时一并移入。', inputSchema: { type: 'object', properties: { historyIds: { type: 'array', items: { type: 'string' } }, confirmProtected: { type: 'boolean' } }, required: ['historyIds'] } },
    { name: 'picgen_list_recycle_bin', title: '列出回收站', description: '列出回收站里的图片，最新移入的在前。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_restore_images', title: '还原图片', description: '把回收站里的图片还原回历史。paths 为 picgen_list_recycle_bin 返回的 filePath，留空还原全部。', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } } },
    { name: 'picgen_purge_images', title: '彻底删除图片', description: '从磁盘永久删除回收站里的图片，不可恢复。paths 为 picgen_list_recycle_bin 返回的 filePath；要清空整个回收站必须显式传 all: true。', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' } } } },
    { name: 'picgen_find_similar', title: '查找相似图片', description: '按视觉相似度查找图片。historyId 在历史中查找；filePath 以一张本地图片为查询。match=element 时匹配画面中的局部元素。', inputSchema: { type: 'object', properties: { historyId: { type: 'string' }, filePath: { type: 'string' }, limit: { type: 'integer' }, match: { type: 'string', enum: ['whole', 'element'] } } } },
    { name: 'picgen_similarity_groups', title: '相似分组', description: '读取当前的相似图片分组。', inputSchema: { type: 'object', properties: {} } },
    { name: 'picgen_optimize_prompt', title: '优化提示词', description: '用已配置的对话模型把提示词改写得更适合生图。sequenceId 留空用当前序列的提示词和参考图；prompt 可覆盖。', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, sequenceId: { type: 'string' }, chatProviderId: { type: 'string' }, applyToSequence: { type: 'boolean', description: '为 true 时把结果写回序列' } } } },
    { name: 'picgen_reverse_prompt', title: '反推提示词', description: '用已配置的对话模型从一张图片反推提示词。historyId、filePath 或 base64 三选一。', inputSchema: { type: 'object', properties: { historyId: { type: 'string' }, filePath: { type: 'string' }, base64: { type: 'string' }, mimeType: { type: 'string' }, instruction: { type: 'string' }, chatProviderId: { type: 'string' }, model: { type: 'string' } } } },
    { name: 'picgen_list_errors', title: '列出错误日志', description: '读取最近的错误日志。source 取 generation、prompt、network、storage、system、renderer。', inputSchema: { type: 'object', properties: { source: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } } } },
    { name: 'picgen_clear_errors', title: '清空错误日志', description: '清空全部错误日志。', inputSchema: { type: 'object', properties: {} } }
];

function toolResult(payload, extra = {}) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...extra };
}

function toolError(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function imageContent(buffer, mimeType) {
    return { type: 'image', data: buffer.toString('base64'), mimeType };
}

class McpHttpServer {
    constructor(options = {}) {
        this.api = options.api;
        this.host = options.host || '127.0.0.1';
        this.port = Number.isInteger(options.port) ? options.port : 0;
        this.token = typeof options.token === 'string' ? options.token : '';
        if (!this.token) throw new Error('MCP 服务器需要访问令牌');
        this.portFallback = false;
        this.serverName = options.serverName || SERVER_NAME;
        this.version = options.version || '0.0.0';
        this.tools = options.tools || TOOLS;
        this.sessions = new Map();
        this.server = http.createServer((req, res) => this._handle(req, res));
    }

    async start() {
        const preferred = this.port;
        try {
            await this._listen(preferred);
        } catch (error) {
            // Another program holds the usual port, or Windows reserved it (Hyper-V / WSL
            // exclusion ranges answer EACCES): still start, and say so in the settings page.
            if (!['EADDRINUSE', 'EACCES'].includes(error.code) || preferred === 0) throw error;
            await this._listen(0);
            this.portFallback = true;
        }
        const address = this.server.address();
        this.port = typeof address === 'object' ? address.port : this.port;
        this.url = `http://${this.host}:${this.port}/mcp`;
        return this;
    }

    _listen(port) {
        return new Promise((resolve, reject) => {
            const onError = error => { this.server.removeListener('listening', onListening); reject(error); };
            const onListening = () => { this.server.removeListener('error', onError); resolve(); };
            this.server.once('error', onError);
            this.server.once('listening', onListening);
            this.server.listen(port, this.host);
        });
    }

    close() {
        for (const session of this.sessions.values()) {
            try { session.res?.end(); } catch { /* already gone */ }
        }
        this.sessions.clear();
        if (!this.server.listening) return Promise.resolve();
        return new Promise(resolve => {
            this.server.close(() => resolve());
            this.server.closeAllConnections?.();
        });
    }

    // Refuses everything a web page could send. A browser always adds Origin to a
    // cross-site request and cannot set Authorization without a CORS grant, which
    // this server never gives; the Host check stops DNS rebinding.
    _reject(req) {
        if (req.headers.origin) return [403, 'browser requests are not allowed'];
        const host = String(req.headers.host || '').toLowerCase();
        if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return [403, 'host not allowed'];
        const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
        const given = Buffer.from(match ? match[1] : '');
        const expected = Buffer.from(this.token);
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return [401, 'missing or wrong token'];
        return null;
    }

    async _handle(req, res) {
        const refused = this._reject(req);
        if (refused) { this._send(res, refused[0], { error: refused[1] }); return; }
        try {
            let pathname = '';
            try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; }
            catch { this._send(res, 400, { error: 'bad request path' }); return; }
            if (pathname !== '/mcp') { this._send(res, 404, { error: 'not found' }); return; }
            if (req.method === 'GET') return this._openStream(req, res);
            if (req.method === 'DELETE') return this._endSession(req, res);
            if (req.method === 'POST') return await this._post(req, res);
            this._send(res, 405, { error: 'method not allowed' });
        } catch (error) {
            if (!res.headersSent) this._send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: error.message }, id: null });
        }
    }

    _openStream(req, res) {
        const id = req.headers['mcp-session-id'];
        const session = id && this.sessions.get(id);
        if (!session) { this._send(res, 400, { error: 'unknown or missing session' }); return; }
        if (session.res) { try { session.res.end(); } catch { /* replaced */ } }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Mcp-Session-Id': id });
        session.res = res;
        for (const event of session.pending) this._writeEvent(res, event);
        session.pending = [];
        req.on('close', () => { if (session.res === res) session.res = null; });
    }

    _endSession(req, res) {
        const id = req.headers['mcp-session-id'];
        const session = id && this.sessions.get(id);
        if (session?.res) { try { session.res.end(); } catch { /* already gone */ } }
        if (id) this.sessions.delete(id);
        res.writeHead(204);
        res.end();
    }

    async _post(req, res) {
        const body = await readBody(req);
        let message;
        try { message = JSON.parse(body || '{}'); }
        catch { this._send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }); return; }
        const messages = Array.isArray(message) ? message : [message];
        const replies = [];
        let sessionId = req.headers['mcp-session-id'] || '';
        // A session this server never issued (or forgot on restart): the spec answers 404 so the client re-initializes.
        if (sessionId && !this.sessions.has(sessionId) && !messages.some(item => item?.method === 'initialize')) {
            this._send(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'session not found' }, id: null });
            return;
        }
        // A tool call carries the client's identity (its queue lane, its idempotency
        // keys), which comes from the handshake: no session, no tool call.
        if (!sessionId && messages.some(item => item?.method === 'tools/call')) {
            this._send(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: 'initialize first: tools/call needs the Mcp-Session-Id from the handshake' }, id: null });
            return;
        }
        for (const item of messages) {
            if (!item || item.jsonrpc !== '2.0' || typeof item.method !== 'string') {
                replies.push({ jsonrpc: '2.0', error: { code: -32600, message: 'invalid request' }, id: item?.id ?? null });
                continue;
            }
            if (item.id === undefined) { this._notify(item); continue; }
            const outcome = await this._dispatch(item, sessionId);
            if (outcome.sessionId) sessionId = outcome.sessionId;
            replies.push(outcome.reply);
        }
        if (!replies.length) { res.writeHead(202); res.end(); return; }
        const payload = Array.isArray(message) ? replies : replies[0];
        const headers = { 'Content-Type': 'application/json' };
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        res.writeHead(200, headers);
        res.end(JSON.stringify(payload));
    }

    _notify(message) {
        if (message.method === 'notifications/initialized') return;
    }

    async _dispatch(message, sessionId) {
        const reply = result => ({ reply: { jsonrpc: '2.0', id: message.id, ...result }, sessionId });
        try {
            if (message.method === 'initialize') {
                const id = crypto.randomBytes(16).toString('hex');
                this._forgetOldestSessions();
                const client = String(message.params?.clientInfo?.name || '').trim();
                this.sessions.set(id, { pending: [], res: null, client });
                return {
                    reply: {
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: PROTOCOL_VERSION,
                            capabilities: { tools: { listChanged: false } },
                            serverInfo: { name: this.serverName, version: this.version },
                            instructions: INSTRUCTIONS
                        }
                    },
                    sessionId: id
                };
            }
            if (message.method === 'ping') return reply({ result: {} });
            if (message.method === 'tools/list') return reply({ result: { tools: this.tools } });
            if (message.method === 'tools/call') {
                const name = message.params?.name;
                const args = message.params?.arguments || {};
                const tool = this.tools.find(item => item.name === name);
                if (!tool) return reply({ error: { code: -32602, message: `unknown tool: ${name}` } });
                const result = await this.api.call(name, args, { client: this.sessions.get(sessionId)?.client || '' });
                return reply({ result });
            }
            return reply({ error: { code: -32601, message: `method not found: ${message.method}` } });
        } catch (error) {
            return reply({ error: { code: -32603, message: error.message } });
        }
    }

    // Clients that never send DELETE would otherwise grow the map without end.
    _forgetOldestSessions(limit = 64) {
        for (const [id, session] of this.sessions) {
            if (this.sessions.size < limit) return;
            if (session.res) continue;
            this.sessions.delete(id);
        }
    }

    _writeEvent(res, event) {
        res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }

    _send(res, status, payload) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    }
}

function readBody(req, limit = 64 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) { reject(new Error('request too large')); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

module.exports = { McpHttpServer, TOOLS, toolResult, toolError, imageContent, PROTOCOL_VERSION, INSTRUCTIONS };
