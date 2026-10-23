const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { toolResult, toolError, imageContent } = require('./mcpServer');
const { sniffImageExtension, MIME_BY_EXTENSION } = require('./imageSniff');
const rendererUtils = require('./rendererUtils');

// Paths and bytes from an agent are only ever handled as images: anything whose
// header is not an image is refused, so these tools cannot read a key file or
// drop a script. Text an agent reads back (supplier names, prompts, error logs)
// can carry injected instructions, so the limits hold even for a trusted client.
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

function createMcpBridge(deps) {
    return {
        async call(name, args) {
            try {
                const payload = await dispatch(name, args || {}, deps);
                if (payload && payload._raw) return { content: payload.content };
                return toolResult(payload);
            } catch (error) {
                return toolError(error.message || String(error));
            }
        }
    };
}

async function dispatch(name, args, deps) {
    switch (name) {
        case 'picgen_status': return status(deps);
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
        historyCount: history.length
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

async function listModels(deps) {
    const providers = await deps.runtime.providerStore.list();
    const models = [];
    for (const provider of providers) {
        if (provider.enabled === false) continue;
        for (const model of provider.models || []) {
            const profile = deps.imageProfiles.getImageApiProfile(model);
            models.push({
                model,
                providerId: provider.id,
                providerName: provider.name,
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
    const providers = await deps.runtime.providerStore.list();
    const provider = providers.find(item => item.id === sequence.providerId);
    if (!provider || provider.enabled === false) throw new Error('序列选择的生图配置组不存在或已停用，先用 picgen_update_sequence 换一个配置组');
    const model = sequence.model || '';
    if (!model) throw new Error('序列没有选择模型');
    const references = [];
    for (const reference of sequenceReferences) {
        if (!reference.filePath) throw new Error(`参考图「${reference.alias || reference.name || reference.id}」没有本地文件，移除后重新添加`);
        const image = await readImageFile(reference.filePath);
        references.push({ base64: image.buffer.toString('base64'), mimeType: image.mimeType });
    }
    const profile = deps.imageProfiles.getImageApiProfile(model);
    if (references.length > profile.maxReferences) throw new Error(`当前模型最多支持 ${profile.maxReferences} 张参考图`);
    // Advanced settings and the size tier come from the UI's own builders, so an
    // agent's request carries exactly what the generate button would send.
    const settings = await mutateSequence('generation-settings', { sequenceId: sequence.id }, deps);
    const response = await fetch(`${deps.serverUrl}/api/tasks/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sequenceId: sequence.id,
            sequenceName: sequence.name,
            count,
            providerId: provider.id,
            providerName: provider.name,
            model,
            operation: 'generate',
            prompt,
            ratio: sequence.ratio || '1:1',
            imageSize: settings.imageSize,
            referenceImages: references,
            generationConfig: settings.generationConfig
        })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '入队失败');
    return { taskIds: result.taskIds, sequenceId: sequence.id, model, count };
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
