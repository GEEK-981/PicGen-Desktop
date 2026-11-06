const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { toolResult, toolError, imageContent } = require('./mcpServer');
const { sniffImageExtension, MIME_BY_EXTENSION } = require('./imageSniff');
const rendererUtils = require('./rendererUtils');
const generationSettings = require('./generationSettings');

// Paths and bytes from an agent are only ever handled as images: anything whose
// header is not an image is refused, so these tools cannot read a key file or
// drop a script. Text an agent reads back (supplier names, prompts, error logs)
// can carry injected instructions, so the limits hold even for a trusted client.
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

function createMcpBridge(deps) {
    return {
        async call(name, args, context = {}) {
            try {
                const payload = await dispatch(name, args || {}, deps, context);
                if (payload && payload._raw) return { content: payload.content };
                return toolResult(payload);
            } catch (error) {
                return toolError(error.message || String(error));
            }
        }
    };
}

async function dispatch(name, args, deps, context = {}) {
    switch (name) {
        case 'picgen_status': return status(deps);
        case 'picgen_generate_batch': return generateBatch(args, deps, context);
        case 'picgen_wait_tasks': return waitTasks(args, deps);
        case 'picgen_cancel_my_tasks': return { cancelled: deps.runtime.taskQueue.cancelBySequence(agentSequence(context).id) };
        case 'picgen_list_suppliers': return listSuppliers(args, deps);
        case 'picgen_list_models': return listModels(deps);
        case 'picgen_test_provider': return testProvider(args, deps);
        case 'picgen_discover_models': return discoverModels(args, deps);
        case 'picgen_provider_health': return deps.runtime.providerManager.getHealthRatings();
        case 'picgen_reset_provider': return resetProvider(args, deps);
        case 'picgen_get_routing': return localJson(deps, 'GET', '/api/providers/failover');
        case 'picgen_set_routing': return setRouting(args, deps);
        case 'picgen_get_proxy': return proxyState(deps);
        case 'picgen_set_proxy': return setProxy(args, deps);
        case 'picgen_test_proxy': return deps.testProxy();
        case 'picgen_get_output_directory': return deps.getOutputDirectory();
        case 'picgen_set_output_directory': return setOutputDirectory(args, deps);
        case 'picgen_open_output_folder': return deps.openOutputFolder();
        case 'picgen_list_sequences': return listSequences(deps);
        case 'picgen_get_sequence': return getSequence(args, deps);
        case 'picgen_create_sequence': return mutateSequence('create', args, deps);
        case 'picgen_update_sequence': return mutateSequence('update', args, deps);
        case 'picgen_delete_sequence': return mutateSequence('delete', args, deps);
        case 'picgen_add_reference': return addReference(args, deps);
        case 'picgen_remove_reference': return mutateSequence('remove-reference', args, deps);
        case 'picgen_generate': return generate(args, deps);
        case 'picgen_list_tasks': return listTasks(args, deps);
        case 'picgen_get_task': return getTask(args, deps);
        case 'picgen_cancel_task': return cancelTask(args, deps);
        case 'picgen_cancel_sequence_tasks': return cancelSequence(args, deps);
        case 'picgen_list_history': return listHistory(args, deps);
        case 'picgen_get_image': return getImage(args, deps);
        case 'picgen_copy_image': return copyImage(args, deps);
        case 'picgen_save_image_as': return saveImageAs(args, deps);
        case 'picgen_trash_images': return trashImages(args, deps);
        case 'picgen_list_recycle_bin': return deps.listRecycleBin();
        case 'picgen_restore_images': return deps.restoreImages(args.paths);
        case 'picgen_purge_images': return purgeImages(args, deps);
        case 'picgen_find_similar': return findSimilar(args, deps);
        case 'picgen_similarity_groups': return deps.similarityGroups();
        case 'picgen_optimize_prompt': return optimizePrompt(args, deps);
        case 'picgen_reverse_prompt': return reversePrompt(args, deps);
        case 'picgen_list_errors': return deps.listErrors(args);
        case 'picgen_clear_errors': return deps.clearErrors();
        default: throw new Error(`未知工具: ${name}`);
    }
}

async function status(deps) {
    const [output, routing, suppliers, tasks, history] = await Promise.all([
        deps.getOutputDirectory(),
        localJson(deps, 'GET', '/api/providers/failover'),
        deps.runtime.unifiedProviderStore.list(),
        Promise.resolve(deps.runtime.taskQueue.listTasks()),
        deps.listHistory()
    ]);
    return {
        name: 'PicGen',
        version: deps.version,
        mcpUrl: deps.mcpUrl,
        outputDirectory: output.effectiveDirectory,
        proxy: await proxyState(deps),
        routing: { strategy: routing.strategy, maxGlobalConcurrent: routing.maxGlobalConcurrent },
        supplierCount: suppliers.length,
        queuedTasks: tasks.filter(task => task.status === 'pending' || task.status === 'running').length,
        historyCount: history.length,
        dailyQuota: await deps.quota.usage(await deps.getDailyLimit())
    };
}

async function listSuppliers(args, deps) {
    const suppliers = await deps.runtime.unifiedProviderStore.list();
    return suppliers.map(supplier => ({
        id: supplier.id,
        name: supplier.name,
        website: supplier.website || '',
        baseUrl: supplier.baseUrl || supplier.url || '',
        groups: (supplier.groups || [])
            .filter(group => !args.role || group.role === args.role)
            .map(publicGroup)
    }));
}

function publicGroup(group) {
    return {
        id: group.id,
        name: group.name,
        role: group.role,
        enabled: group.enabled !== false,
        baseUrl: group.baseUrl || group.url || '',
        models: group.models || [],
        modelPricing: group.modelPricing || group.pricing || {},
        hasApiKey: !!group.apiKey
    };
}

// Every enabled group, whatever the UI's routing: agents choose their own route.
async function listModels(deps) {
    const providers = await deps.runtime.providerStore.list();
    const models = [];
    for (const provider of providers) {
        if (provider.enabled === false) continue;
        for (const model of provider.models || []) {
            const profile = deps.imageProfiles.getImageApiProfile(model);
            const price = groupPrice(provider, model);
            models.push({
                model,
                providerId: provider.id,
                providerName: provider.name,
                supplierName: provider.supplierName || '',
                price: Number.isFinite(price) ? price : null,
                ratios: (profile.dimensionOptions || []).map(option => option.value ?? option),
                imageSizes: (profile.imageSizeOptions || []).map(option => option.value ?? option),
                maxReferences: profile.maxReferences
            });
        }
    }
    return models;
}

async function resolveGroup(groupId, deps) {
    const id = String(groupId || '').trim();
    if (!id) throw new Error('需要 groupId');
    const image = await deps.runtime.providerStore.get(id);
    if (image) return { role: 'image', provider: image };
    const chat = await deps.runtime.chatProviderStore.get(id);
    if (chat) return { role: 'chat', provider: chat };
    throw new Error('找不到这个配置组');
}

async function testProvider(args, deps) {
    const { role, provider } = await resolveGroup(args.groupId, deps);
    const model = String(args.model || provider.models?.[0] || provider.model || '');
    const config = { provider: provider.baseUrl || provider.url, apiKey: provider.apiKey, model };
    return role === 'chat' ? deps.testChat(config) : deps.testImage(config);
}

async function discoverModels(args, deps) {
    const { provider } = await resolveGroup(args.groupId, deps);
    return deps.discover({ provider: provider.baseUrl || provider.url, apiKey: provider.apiKey });
}

function resetProvider(args, deps) {
    if (args.groupId) deps.runtime.providerManager.resetProvider(String(args.groupId));
    else deps.runtime.providerManager.resetAll();
    return { reset: true };
}

// Settings go through the same REST routes as the settings page, so validation
// (a fixed group must be enabled) and side effects (provider manager, Chromium
// proxy) stay in one place.
async function localJson(deps, method, pathname, body) {
    const response = await fetch(`${deps.serverUrl}${pathname}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败');
    return result;
}

async function setRouting(args, deps) {
    const result = await localJson(deps, 'POST', '/api/providers/failover', pick(args, ['strategy', 'selectedProviderId', 'enabled', 'maxAttempts', 'maxGlobalConcurrent', 'failoverThreshold', 'cooldownMs']));
    return result.config;
}

async function proxyState(deps) {
    const config = await deps.runtime.proxyConfigStore.get();
    return { mode: config.mode, customProxy: config.customProxy || '', bypassList: config.bypassList || '' };
}

async function setProxy(args, deps) {
    const { config } = await localJson(deps, 'POST', '/api/providers/proxy', pick(args, ['mode', 'customProxy', 'bypassList']));
    return { mode: config.mode, customProxy: config.customProxy || '' };
}

async function setOutputDirectory(args, deps) {
    const directory = String(args.directory ?? '').trim();
    if (directory) {
        const resolved = path.resolve(directory);
        const stat = await fsp.stat(resolved).catch(() => null);
        if (!stat?.isDirectory()) throw new Error('目录不存在');
        await fsp.access(resolved, fs.constants.W_OK);
    }
    return deps.setOutputDirectory(directory);
}

async function rendererSequences(deps) {
    const sequences = await deps.renderer.listSequences();
    if (!Array.isArray(sequences)) throw new Error('界面没有返回序列');
    return sequences;
}

async function listSequences(deps) {
    const data = await rendererSequences(deps);
    return data.map(sequence => ({ ...publicSequence(sequence), current: sequence.current === true }));
}

async function getSequence(args, deps) {
    const data = await rendererSequences(deps);
    const sequence = pickSequence(data, args.sequenceId);
    return { ...publicSequence(sequence), current: sequence.current === true, advanced: sequence.advanced || {} };
}

function pickSequence(sequences, sequenceId) {
    const id = String(sequenceId || '').trim();
    const sequence = id ? sequences.find(item => item.id === id) : sequences.find(item => item.current) || sequences[0];
    if (!sequence) throw new Error(id ? '找不到这个序列' : '还没有序列');
    return sequence;
}

function publicSequence(sequence) {
    return {
        id: sequence.id,
        name: sequence.name,
        prompt: sequence.prompt || '',
        providerId: sequence.providerId || '',
        model: sequence.model || '',
        ratio: sequence.ratio || '',
        count: sequence.count,
        imageSize: sequence.imageSize || '',
        status: sequence.status || '',
        references: (sequence.references || []).map(reference => ({
            id: reference.id, name: reference.name, alias: reference.alias || '', mimeType: reference.mimeType, filePath: reference.filePath || ''
        }))
    };
}

async function mutateSequence(action, args, deps) {
    const result = await deps.renderer.mutateSequence({ action, ...args });
    if (result?.error) throw new Error(result.error);
    return result;
}

async function addReference(args, deps) {
    let payload = { name: args.name || '', alias: args.alias || '' };
    if (args.filePath) {
        const image = await readImageFile(args.filePath);
        payload = { ...payload, base64: image.buffer.toString('base64'), mimeType: image.mimeType, name: payload.name || path.basename(image.filePath) };
    } else if (args.base64) {
        const image = imageFromBase64(args.base64);
        payload = { ...payload, base64: image.buffer.toString('base64'), mimeType: image.mimeType };
    } else {
        throw new Error('需要 filePath 或 base64');
    }
    const saved = await deps.saveReference(payload);
    return mutateSequence('add-reference', { sequenceId: args.sequenceId, reference: { ...saved, alias: args.alias || '' } }, deps);
}

async function generate(args, deps) {
    const data = await rendererSequences(deps);
    const sequence = pickSequence(data, args.sequenceId);
    // Same checks and @ resolution as the generate button: @{别名} becomes 参考图N,
    // numbered by position, so every reference must be sent and none skipped.
    const rawPrompt = String(args.prompt ?? sequence.prompt ?? '');
    const emptyMentions = rendererUtils.countEmptyReferenceMentions(rawPrompt);
    if (emptyMentions) throw new Error(`提示词里有 ${emptyMentions} 个空 @ 没有指向参考图，删掉或改成 @{别名} 后再生成`);
    const sequenceReferences = sequence.references || [];
    const prompt = rendererUtils.resolvePromptMentions(rawPrompt, sequenceReferences).trim();
    if (!prompt) throw new Error('序列没有提示词');
    const count = clampCount(args.count ?? sequence.count);
    if (!sequence.model) throw new Error('序列没有选择模型');
    const providers = await deps.runtime.providerStore.list();
    const fixedGroupId = await fixedRoutingGroup(deps);
    const { group: provider, model } = pickGroupAndModel({ groupId: sequence.providerId, model: sequence.model }, providers, null, fixedGroupId);
    const references = [];
    for (const reference of sequenceReferences) {
        if (!reference.filePath) throw new Error(`参考图「${reference.alias || reference.name || reference.id}」没有本地文件，移除后重新添加`);
        const image = await readImageFile(reference.filePath);
        references.push({ base64: image.buffer.toString('base64'), mimeType: image.mimeType });
    }
    const profile = deps.imageProfiles.getImageApiProfile(model);
    if (references.length > profile.maxReferences) throw new Error(`当前模型最多支持 ${profile.maxReferences} 张参考图`);
    const limit = await deps.getDailyLimit();
    await deps.quota.reserve(count, limit);
    const submitted = await submitTasks(deps, {
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        count,
        providerId: provider.id,
        providerName: provider.name,
        model,
        operation: 'generate',
        prompt,
        ratio: sequence.ratio || '1:1',
        imageSize: generationSettings.resolveImageSize(model, sequence.imageSize, deps.imageProfiles),
        referenceImages: references,
        generationConfig: generationSettings.buildGenerationConfig({ model, advanced: sequence.advanced }, deps.imageProfiles)
    }, sequence.id);
    if (submitted.submitted === false) { await settle(() => deps.quota.refund(count)); throw new Error(submitted.error); }
    if (submitted.submitted !== true) throw new Error(submitted.error);
    return { taskIds: submitted.taskIds, sequenceId: sequence.id, ...actualRoute(deps, submitted.taskIds, provider.id, model), count };
}

// Never "send it again": the agent cannot know whether the first one was queued.
function unconfirmed(sequenceId, detail = '') {
    return `提交结果未确认：请求可能已经入队并计费。不要重发；用 picgen_list_tasks（sequenceId=${sequenceId}）核对是否已入队${detail ? `（${detail}）` : ''}`;
}

// submitted: true (queued), false (refused, nothing billed) or 'unknown' (the
// request may have reached the queue; never retried automatically).
async function submitTasks(deps, body, sequenceId) {
    let response;
    try {
        response = await fetch(`${deps.serverUrl}/api/tasks/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (error) {
        return { submitted: 'unknown', error: unconfirmed(sequenceId, error.message) };
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return { submitted: false, error: result.error || `入队失败（HTTP ${response.status}）` };
    if (!Array.isArray(result.taskIds) || result.taskIds.length !== body.count) return { submitted: 'unknown', error: unconfirmed(sequenceId), taskIds: result.taskIds || [] };
    return { submitted: true, taskIds: result.taskIds };
}

// Bookkeeping after tasks are queued must never turn a queued batch into an error.
async function settle(task, fallback = undefined) {
    try { return await task(); }
    catch (error) { console.warn('[MCP] bookkeeping after submit failed:', error.message); return fallback; }
}

// Fixed routing makes the server run every UI task on one group. picgen_generate
// runs a UI sequence, so it validates against that group; picgen_generate_batch
// sends its own route instead (pickAgentRoute) and is not bound by it.
async function fixedRoutingGroup(deps) {
    const routing = await localJson(deps, 'GET', '/api/providers/failover');
    return routing?.strategy === 'fixed' ? String(routing.selectedProviderId || '').trim() : '';
}

// What the queue really runs, read back from the task itself.
function actualRoute(deps, taskIds, groupId, model) {
    const task = taskIds?.length ? deps.runtime.taskQueue.getTask(taskIds[0]) : null;
    return { groupId: task?.providerId || groupId, model: task?.model || model };
}

// ---- Agent fast path: stateless batch, wait, cancel -------------------------

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const MAX_BATCH_ITEMS = 500;
const SUBMIT_CONCURRENCY = 4;

// Tasks from one client name share a queue lane: round-robin keeps agents from
// starving the user's own sequences. Two windows of the same client share it.
function agentSequence(context = {}) {
    const name = String(context.client || '').trim().slice(0, 40) || 'agent';
    return { id: `agent:${name}`, name: `Agent · ${name}` };
}

async function generateBatch(args, deps, context) {
    const key = String(args.idempotencyKey || '').trim();
    if (!key) return submitBatch(args, deps, context);
    const lane = agentSequence(context);
    const fingerprint = deps.idempotency.constructor.fingerprint({ items: args.items, defaults: args.defaults || null });
    return deps.idempotency.run(`${lane.id}\n${key}`, fingerprint, () => submitBatch(args, deps, context));
}

// Throws only before anything is queued; after that it always returns a result.
async function submitBatch(args, deps, context) {
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length) throw new Error('items 不能为空');
    if (items.length > MAX_BATCH_ITEMS) throw new Error(`一次最多 ${MAX_BATCH_ITEMS} 条，请分批提交`);
    const defaults = args.defaults && typeof args.defaults === 'object' ? args.defaults : {};
    const providers = await deps.runtime.providerStore.list();
    let active = null;
    try { active = (await rendererSequences(deps)).find(sequence => sequence.current) || null; } catch { /* window closed: no defaults from the UI */ }
    const lane = agentSequence(context);
    const images = new Map();

    // Validate everything before anything is billed: one bad item, nothing sent.
    const bodies = [];
    for (let index = 0; index < items.length; index += 1) {
        const item = { ...defaults, ...items[index] };
        if (defaults.advanced || items[index]?.advanced) item.advanced = { ...defaults.advanced, ...items[index]?.advanced };
        try {
            bodies.push(await batchItemBody(item, { providers, active, lane, deps, images }));
        } catch (error) {
            throw new Error(`第 ${index + 1} 项：${error.message}`);
        }
    }

    const limit = await deps.getDailyLimit();
    const totalImages = bodies.reduce((sum, body) => sum + body.count, 0);
    await deps.quota.reserve(totalImages, limit);

    // A few at a time: each body may carry large reference images.
    const outcomes = new Array(bodies.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(SUBMIT_CONCURRENCY, bodies.length) }, async () => {
        while (next < bodies.length) {
            const index = next++;
            outcomes[index] = await submitTasks(deps, bodies[index], lane.id);
        }
    }));
    const refused = outcomes.reduce((sum, outcome, index) => sum + (outcome.submitted === false ? bodies[index].count : 0), 0);
    if (refused) await settle(() => deps.quota.refund(refused));

    const results = outcomes.map((outcome, index) => ({
        index,
        submitted: outcome.submitted,
        taskIds: outcome.taskIds || [],
        ...actualRoute(deps, outcome.taskIds, bodies[index].providerId, bodies[index].model),
        ...(outcome.error ? { error: outcome.error } : {})
    }));
    return {
        totalImages,
        taskIds: results.flatMap(result => result.taskIds),
        items: results,
        agentSequenceId: lane.id,
        quota: await settle(() => deps.quota.usage(limit), null)
    };
}

async function batchItemBody(item, { providers, active, lane, deps, images }) {
    const prompt = String(item.prompt ?? '').trim();
    if (!prompt) throw new Error('提示词为空');
    const count = Number(item.count ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('张数必须是 1 到 100 的整数');

    const { group, model, routing } = pickAgentRoute(item, providers, active);
    // The active sequence's ratio, size and settings only make sense for its own model.
    const inherit = active && active.model === model ? active : null;
    const profile = deps.imageProfiles.getImageApiProfile(model);
    const ratios = (profile.dimensionOptions || []).map(option => option.value ?? option);
    const ratio = String(item.ratio || inherit?.ratio || ratios[0] || '1:1');
    if (ratios.length && !ratios.includes(ratio)) throw new Error(`画幅 ${ratio} 不受 ${model} 支持，可选：${ratios.join('、')}`);

    const references = Array.isArray(item.references) ? item.references : [];
    if (references.length > profile.maxReferences) throw new Error(`${model} 最多支持 ${profile.maxReferences} 张参考图`);
    const referenceImages = [];
    for (const reference of references) referenceImages.push(await loadReference(reference, deps, images));

    const advanced = item.advanced && typeof item.advanced === 'object' ? item.advanced : inherit?.advanced || {};
    return {
        sequenceId: lane.id,
        sequenceName: lane.name,
        count,
        providerId: group.id,
        providerName: group.name,
        // The agent's own route: the UI's routing (fixed group included) does not apply.
        routing,
        model,
        operation: 'generate',
        prompt,
        ratio,
        imageSize: generationSettings.resolveImageSize(model, item.imageSize || inherit?.imageSize || '', deps.imageProfiles),
        referenceImages,
        generationConfig: generationSettings.buildGenerationConfig({ model, advanced }, deps.imageProfiles)
    };
}

// The same picture used by many items is read and encoded once per call.
function loadReference(reference, deps, images) {
    const key = reference?.base64 ? `b64:${reference.base64}` : reference?.historyId ? `history:${reference.historyId}` : `file:${path.resolve(String(reference?.filePath || ''))}`;
    if (!images.has(key)) {
        images.set(key, (async () => {
            const image = reference?.base64 ? imageFromBase64(reference.base64)
                : reference?.historyId ? await resolveHistory({ historyId: reference.historyId }, deps)
                    : await readImageFile(reference?.filePath);
            return { base64: image.buffer.toString('base64'), mimeType: image.mimeType };
        })());
    }
    return images.get(key);
}

function sameModel(left, right) {
    return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

// Like the generate button: an enabled group with a key and an address.
function usableGroup(group) {
    if (group.enabled === false) throw new Error(`配置组「${group.name}」已停用`);
    if (!group.apiKey || !(group.baseUrl || group.url)) throw new Error(`配置组「${group.name}」没有填写 API Key 或接口地址`);
    return group;
}

function pickGroupAndModel(item, providers, active, fixedGroupId = '') {
    const groupId = String(item.groupId || '').trim();
    const wanted = String(item.model || '').trim();
    if (fixedGroupId) {
        const pinned = providers.find(provider => provider.id === fixedGroupId);
        if (!pinned) throw new Error('路由策略是「指定配置组」，但那个配置组已不存在，请在 PicGen 里重新选择');
        usableGroup(pinned);
        if (groupId && groupId !== pinned.id) throw new Error(`当前路由策略固定使用配置组「${pinned.name}」，不能指定其他配置组`);
        const fallback = (pinned.models || []).find(name => sameModel(name, active?.model)) || pinned.models?.[0];
        const model = (pinned.models || []).find(name => sameModel(name, wanted || fallback));
        if (!model) throw new Error(`当前路由策略固定使用配置组「${pinned.name}」，它没有模型 ${wanted}；可用：${(pinned.models || []).join('、')}`);
        return { group: pinned, model };
    }
    if (groupId) {
        const group = providers.find(provider => provider.id === groupId);
        if (!group) throw new Error(`找不到配置组 ${groupId}，用 picgen_list_models 查看`);
        usableGroup(group);
        const fallback = active?.providerId === group.id ? active.model : group.models?.[0];
        const model = (group.models || []).find(name => sameModel(name, wanted || fallback));
        if (!model) throw new Error(`配置组「${group.name}」没有模型 ${wanted || '（未指定）'}`);
        return { group, model };
    }
    if (wanted) {
        const offering = providers.filter(provider => provider.enabled !== false && (provider.models || []).some(name => sameModel(name, wanted)));
        if (!offering.length) throw new Error(`没有已启用的配置组提供模型 ${wanted}，用 picgen_list_models 查看可用模型`);
        const group = usableGroup(offering.find(provider => provider.id === active?.providerId) || offering.find(provider => provider.apiKey) || offering[0]);
        return { group, model: group.models.find(name => sameModel(name, wanted)) };
    }
    if (!active?.model) throw new Error('没有指定 model，界面上也没有可沿用的当前序列');
    const group = providers.find(provider => provider.id === active.providerId);
    if (!group) throw new Error('界面当前序列的配置组不存在，请指定 model');
    usableGroup(group);
    return { group, model: active.model };
}

const AGENT_STRATEGIES = new Set(['price', 'priority', 'balanced', 'speed', 'order']);

function agentStrategy(value) {
    const strategy = String(value || '').trim().toLowerCase();
    if (!strategy) return 'price';
    if (!AGENT_STRATEGIES.has(strategy)) throw new Error(`routing 只能是 ${[...AGENT_STRATEGIES].join(' / ')}`);
    return strategy;
}

// Per-image price a group lists for a model; unpriced groups sort last.
function groupPrice(group, model) {
    const pricing = group.modelPricing || group.pricing || {};
    const key = Object.keys(pricing).find(name => sameModel(name, model));
    const value = Number(key === undefined ? NaN : pricing[key]);
    return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function matchesSupplier(group, supplier) {
    const wanted = supplier.toLowerCase();
    return [group.supplierId, group.supplierName].some(value => String(value || '').trim().toLowerCase() === wanted);
}

// Agents are not bound to the UI's routing: any enabled group may serve them.
// `groupId` pins one group, `supplier` (name or id) limits them to that
// supplier's groups, and otherwise every group offering the model takes part.
// The candidates go to the scheduler as the task's own route, ordered by
// `routing` (default: cheapest listed price first) with failover among them.
function pickAgentRoute(item, providers, active) {
    const groupId = String(item.groupId || '').trim();
    const supplier = String(item.supplier || '').trim();
    const strategy = agentStrategy(item.routing);
    if (groupId) {
        const group = providers.find(provider => provider.id === groupId);
        if (!group) throw new Error(`找不到配置组 ${groupId}，用 picgen_list_models 查看`);
        if (supplier && !matchesSupplier(group, supplier)) throw new Error(`配置组「${group.name}」不属于供应商「${supplier}」`);
        usableGroup(group);
        const fallback = active?.providerId === group.id ? active.model : group.models?.[0];
        const model = (group.models || []).find(name => sameModel(name, item.model || fallback));
        if (!model) throw new Error(`配置组「${group.name}」没有模型 ${item.model || '（未指定）'}`);
        return { group, model, routing: { strategy, groupIds: [group.id] } };
    }
    const wanted = String(item.model || active?.model || '').trim();
    if (!wanted) throw new Error('没有指定 model，界面上也没有可沿用的当前序列');
    let pool = providers.filter(provider => provider.enabled !== false);
    if (supplier) {
        if (!providers.some(provider => matchesSupplier(provider, supplier))) throw new Error(`找不到供应商「${supplier}」，用 picgen_list_suppliers 查看`);
        pool = pool.filter(provider => matchesSupplier(provider, supplier));
    }
    const offering = pool.filter(provider => (provider.models || []).some(name => sameModel(name, wanted)));
    if (!offering.length) {
        throw new Error(supplier
            ? `供应商「${supplier}」没有已启用的配置组提供模型 ${wanted}`
            : `没有已启用的配置组提供模型 ${wanted}，用 picgen_list_models 查看可用模型`);
    }
    const usable = offering.filter(provider => provider.apiKey && (provider.baseUrl || provider.url));
    if (!usable.length) usableGroup(offering[0]);
    const ranked = strategy === 'price'
        ? [...usable].sort((left, right) => groupPrice(left, wanted) - groupPrice(right, wanted))
        : usable;
    const group = ranked[0];
    return {
        group,
        model: group.models.find(name => sameModel(name, wanted)),
        routing: { strategy, groupIds: ranked.map(provider => provider.id) }
    };
}

async function waitTasks(args, deps) {
    const ids = [...new Set((Array.isArray(args.taskIds) ? args.taskIds : []).map(String))];
    if (!ids.length) throw new Error('需要 taskIds');
    if (ids.length > 500) throw new Error('一次最多等待 500 个任务');
    const timeoutMs = Math.max(1, Math.min(600, Number(args.timeoutSeconds) || 60)) * 1000;
    const deadline = Date.now() + timeoutMs;
    let snapshot;
    while (true) {
        snapshot = ids.map(id => ({ id, task: deps.runtime.taskQueue.getTask(id) }));
        const running = snapshot.some(({ task }) => task && !TERMINAL_STATUSES.has(task.status));
        if (!running || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    const tasks = snapshot.map(({ id, task }) => ({
        taskId: id,
        status: task ? task.status : 'unknown',
        filePath: task?.result?.filePath || '',
        error: task?.error || '',
        prompt: task?.prompt || '',
        progress: task?.progress?.phase || ''
    }));
    const pending = tasks.filter(task => task.status !== 'unknown' && !TERMINAL_STATUSES.has(task.status)).map(task => task.taskId);
    // A typo, or a task cleared an hour after it ended: not "finished", just not known.
    const unknown = tasks.filter(task => task.status === 'unknown').map(task => task.taskId);
    const summary = { done: pending.length === 0, pending, unknown, tasks };
    if (!args.includeImages) return summary;
    const images = [];
    for (const task of tasks) {
        if (task.status !== 'completed' || !task.filePath) continue;
        try {
            const image = await readImageFile(task.filePath);
            const preview = await deps.downscale(image.buffer, Number(args.maxEdge) || 512);
            images.push(imageContent(preview.buffer, preview.mimeType));
        } catch { /* the path in the summary is enough */ }
    }
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...images], _raw: true };
}

function listTasks(args, deps) {
    const filters = {};
    if (args.sequenceId) filters.sequenceId = String(args.sequenceId);
    if (args.status) filters.status = String(args.status).split(',').map(item => item.trim()).filter(Boolean);
    const tasks = deps.runtime.taskQueue.listTasks(filters);
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
    return tasks.slice(0, limit);
}

function getTask(args, deps) {
    const task = deps.runtime.taskQueue.getTask(String(args.taskId || ''));
    if (!task) throw new Error('找不到这个任务');
    return task;
}

function cancelTask(args, deps) {
    const cancelled = deps.runtime.taskQueue.cancel(String(args.taskId || ''));
    if (!cancelled) throw new Error('任务不存在，或已结束、正在保存');
    return { cancelled: true };
}

function cancelSequence(args, deps) {
    return { cancelled: deps.runtime.taskQueue.cancelBySequence(String(args.sequenceId || '')) };
}

async function listHistory(args, deps) {
    const records = await deps.listHistory();
    const query = String(args.query || '').trim().toLowerCase();
    const model = String(args.model || '').trim().toLowerCase();
    const filtered = records.filter(record => {
        if (model && String(record.model || '').toLowerCase() !== model) return false;
        if (!query) return true;
        return [record.prompt, record.fileName].some(value => String(value || '').toLowerCase().includes(query));
    });
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 30));
    return {
        total: filtered.length,
        items: filtered.slice(offset, offset + limit).map(publicHistory)
    };
}

function publicHistory(record) {
    return {
        id: record.id,
        fileName: record.fileName,
        filePath: record.filePath,
        mimeType: record.mimeType,
        prompt: record.prompt || '',
        model: record.model || '',
        providerName: record.providerName || '',
        ratio: record.ratio || '',
        width: record.width || 0,
        height: record.height || 0,
        createdAt: record.createdAt || 0,
        usage: record.usage || null
    };
}

async function readImageFile(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat?.isFile()) throw new Error(`找不到文件: ${resolved}`);
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片超过 64 MB');
    const buffer = await fsp.readFile(resolved);
    const ext = sniffImageExtension(buffer);
    if (!ext) throw new Error(`不是图片（只接受 PNG、JPEG、WebP、GIF、BMP、AVIF）: ${resolved}`);
    return { filePath: resolved, buffer, ext, mimeType: MIME_BY_EXTENSION[ext] };
}

function imageFromBase64(value) {
    const buffer = Buffer.from(String(value || ''), 'base64');
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片超过 64 MB');
    const ext = sniffImageExtension(buffer);
    if (!ext) throw new Error('base64 不是图片（只接受 PNG、JPEG、WebP、GIF、BMP、AVIF）');
    return { buffer, ext, mimeType: MIME_BY_EXTENSION[ext] };
}

async function resolveHistory(args, deps) {
    if (args.filePath) return readImageFile(args.filePath);
    const id = String(args.historyId || '').trim();
    if (!id) throw new Error('需要 historyId 或 filePath');
    const records = await deps.listHistory();
    const record = records.find(item => item.id === id);
    if (!record) throw new Error('历史里没有这张图片');
    return readImageFile(record.filePath);
}

async function getImage(args, deps) {
    const image = await resolveHistory(args, deps);
    const maxEdge = Number(args.maxEdge ?? 1024);
    const delivered = maxEdge === 0 ? image : await deps.downscale(image.buffer, maxEdge);
    return {
        content: [imageContent(delivered.buffer, delivered.mimeType), { type: 'text', text: image.filePath }],
        _raw: true
    };
}

async function copyImage(args, deps) {
    const record = await resolveHistory(args, deps);
    return deps.copyImage({ filePath: record.filePath });
}

// The copy always gets the extension of what it really is and never replaces a
// file: run.cmd becomes run.png, an existing keep.png leaves room for keep-1.png.
async function saveImageAs(args, deps) {
    const requested = String(args.destination || '').trim();
    if (!requested) throw new Error('需要 destination');
    if (!path.isAbsolute(requested)) throw new Error('destination 必须是绝对路径');
    const image = await resolveHistory(args, deps);
    const parsed = path.parse(path.resolve(requested));
    await fsp.mkdir(parsed.dir, { recursive: true });
    return deps.saveImageCopy(image.filePath, await freePath(parsed.dir, parsed.name || 'picgen-image', image.ext));
}

async function freePath(directory, name, ext) {
    for (let index = 0; index < 1000; index += 1) {
        const candidate = path.join(directory, `${index ? `${name}-${index}` : name}.${ext}`);
        try { await fsp.access(candidate); } catch { return candidate; }
    }
    throw new Error('目标文件夹里同名文件太多');
}

async function purgeImages(args, deps) {
    if (Array.isArray(args.paths) && args.paths.length) return deps.purgeImages(args.paths.map(String));
    if (args.all === true) return deps.purgeImages(undefined);
    throw new Error('要清空整个回收站请传 all: true；只删部分请传 paths');
}

async function trashImages(args, deps) {
    const ids = Array.isArray(args.historyIds) ? args.historyIds.map(String) : [];
    if (!ids.length) throw new Error('需要 historyIds');
    const records = await deps.listHistory();
    const items = ids.map(id => {
        const record = records.find(item => item.id === id);
        if (!record) throw new Error(`历史里没有 ${id}`);
        return { id: record.id, filePath: record.filePath };
    });
    return deps.trashImages({ items, confirmProtected: args.confirmProtected === true });
}

async function findSimilar(args, deps) {
    if (args.filePath) return deps.findSimilarByImage({ filePath: (await readImageFile(args.filePath)).filePath, limit: args.limit, match: args.match });
    const record = await resolveHistory(args, deps);
    return deps.findSimilar({ key: record.id, limit: args.limit });
}

async function optimizePrompt(args, deps) {
    const data = await rendererSequences(deps);
    const sequence = args.sequenceId || args.prompt === undefined ? pickSequence(data, args.sequenceId) : null;
    const prompt = String(args.prompt ?? sequence?.prompt ?? '').trim();
    if (!prompt) throw new Error('没有可优化的提示词');
    const chatProviders = await deps.runtime.chatProviderStore.list();
    const provider = chatProviders.find(item => item.id === args.chatProviderId) || chatProviders.find(item => item.enabled !== false);
    if (!provider) throw new Error('没有可用的对话模型配置组');
    const references = [];
    for (const reference of sequence?.references || []) {
        if (!reference.filePath) continue;
        references.push({ base64: (await fsp.readFile(reference.filePath)).toString('base64'), mimeType: reference.mimeType || 'image/png', name: reference.alias || reference.name || '' });
    }
    const optimized = await deps.optimize({
        chatProviderId: provider.id,
        prompt,
        ratio: sequence?.ratio || '',
        referenceImages: references,
        referenceNames: references.map(reference => reference.name)
    });
    if (args.applyToSequence && sequence) await mutateSequence('update', { sequenceId: sequence.id, prompt: optimized }, deps);
    return { prompt: optimized, appliedTo: args.applyToSequence ? sequence.id : '' };
}

async function reversePrompt(args, deps) {
    let image = null;
    const source = args.base64 ? imageFromBase64(args.base64) : await resolveHistory(args, deps);
    image = { base64: source.buffer.toString('base64'), mimeType: source.mimeType };
    const chatProviders = await deps.runtime.chatProviderStore.list();
    const provider = chatProviders.find(item => item.id === args.chatProviderId) || chatProviders.find(item => item.enabled !== false);
    if (!provider) throw new Error('没有可用的对话模型配置组');
    const prompt = await deps.reverse({ chatProviderId: provider.id, model: args.model || '', instruction: args.instruction || '', image });
    return { prompt };
}

function clampCount(value) {
    const count = Math.floor(Number(value) || 1);
    if (count < 1 || count > 5) throw new Error('张数必须是 1 到 5');
    return count;
}

function pick(source, keys) {
    const result = {};
    for (const key of keys) if (source[key] !== undefined) result[key] = source[key];
    return result;
}

module.exports = { createMcpBridge, dispatch, publicGroup, publicSequence, publicHistory };
