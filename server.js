const { createPromptResponse } = require('./promptStream');
require('dotenv').config({ quiet: true });

const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const TaskQueue = require('./taskQueue');
const ProviderManager = require('./providerManager');
const { UnifiedProviderStore } = require('./providerStore');
const { FailoverConfigStore, normalizeStrategy } = require('./failoverConfig');
const { ProxyConfigStore, environmentProxyFor } = require('./proxyConfig');
const {
    optimizePrompt,
    reversePrompt,
    discoverImageProviderCapabilities,
    testImageProviderConnection,
    testChatProviderConnection,
    setProxyState,
    getProxyState,
    testProxyReachability
} = require('./apiService');

function createServerApp(options = {}) {
    const app = express();
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });
    const errorLogStore = options.errorLogStore || null;

    function recordError(entry) {
        if (!errorLogStore?.record) return Promise.resolve(null);
        return Promise.resolve(errorLogStore.record(entry)).catch(error => {
            console.error('[ErrorLog] write failed:', error.message);
            return null;
        });
    }

    const failoverConfigStore = new FailoverConfigStore({
        filePath: options.failoverConfigFile,
        legacyFilePath: options.legacyFailoverConfigFile
    });
    const proxyConfigStore = new ProxyConfigStore({
        filePath: options.proxyConfigFile
    });
    const providerManager = new ProviderManager();
    const unifiedProviderStore = new UnifiedProviderStore({
        filePath: options.unifiedProviderStoreFile || process.env.PICGEN_UNIFIED_PROVIDER_STORE || path.join(path.dirname(options.providerStoreFile || process.env.PICGEN_PROVIDER_STORE || path.join(os.homedir(), '.picgen', 'api-providers.json')), 'unified-suppliers.json'),
        providerStoreFile: options.providerStoreFile || process.env.PICGEN_PROVIDER_STORE,
        chatProviderStoreFile: options.chatProviderStoreFile || process.env.PICGEN_CHAT_PROVIDER_STORE,
        secretCodec: options.secretCodec
    });
    const providerStore = unifiedProviderStore.createRoleStore('image');
    const chatProviderStore = unifiedProviderStore.createRoleStore('chat');
    const wsClients = new Set();
    const taskQueue = new TaskQueue({
        // The global setting is the user-facing concurrency limit. Keep the
        // per-sequence guard at the supported global ceiling so a hidden
        // default does not cap batches at three tasks.
        maxConcurrentPerSequence: options.maxConcurrentPerSequence || 64,
        maxGlobalConcurrent: options.maxGlobalConcurrent || 12,
        providerManager,
        resultStore: options.resultStore,
        onTaskEvent: (type, data) => broadcast(type, data),
        onError: entry => recordError(entry)
    });

    const cleanupTimer = setInterval(() => taskQueue.cleanup(), 3600000);

    wss.on('connection', (ws) => {
        wsClients.add(ws);
        console.log(`[WS] client connected. total=${wsClients.size}`);

        ws.on('close', () => {
            wsClients.delete(ws);
            console.log(`[WS] client disconnected. total=${wsClients.size}`);
        });

        ws.on('error', (err) => console.error('[WS] error:', err.message));
    });

    function broadcast(type, data) {
        const message = JSON.stringify({ type, data });

        for (const ws of wsClients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        }
    }

    function formatProviderHost(url) {
        try {
            return new URL(url).host;
        } catch {
            return String(url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        }
    }

    async function getImageProvider(id) {
        return providerStore.get(id);
    }

    async function getChatProvider(id) {
        return chatProviderStore.get(id);
    }

    async function syncProviderManager() {
        const providers = await providerStore.list();
        let failoverConfig = await failoverConfigStore.get();
        const knownProviderIds = new Set(providers.map(provider => String(provider.id)));
        if (failoverConfig.selectedProviderId
            && !knownProviderIds.has(String(failoverConfig.selectedProviderId))) {
            failoverConfig = await failoverConfigStore.update({ selectedProviderId: '' });
        }

        // 应用failover配置到ProviderManager
        providerManager.enableFailover = failoverConfig.enabled;
        providerManager.failoverOptions.maxAttempts = failoverConfig.maxAttempts;
        providerManager.failoverOptions.respectPriority = failoverConfig.respectPriority;
        providerManager.failoverOptions.strategy = failoverConfig.strategy;
        providerManager.failoverOptions.selectedProviderId = failoverConfig.selectedProviderId || '';
        providerManager.failoverThreshold = failoverConfig.failoverThreshold;
        providerManager.cooldownMs = failoverConfig.cooldownMs;
        taskQueue.setMaxGlobalConcurrent(failoverConfig.maxGlobalConcurrent);

        providerManager.syncProviders(providers);
        const status = providerManager.getStatus();
        broadcast('provider:status', status);
        broadcast('provider:failover-config', failoverConfig);
        return status;
    }

    async function resolveTaskProvider(taskData) {
        const payload = { ...taskData };
        const failoverConfig = await failoverConfigStore.get();
        const fixedProviderId = failoverConfig.strategy === 'fixed'
            ? String(failoverConfig.selectedProviderId || '').trim()
            : '';
        const requestedProviderId = fixedProviderId || String(payload.providerId || '').trim();
        if (!requestedProviderId) return payload;

        const provider = await getImageProvider(requestedProviderId);
        if (!provider) throw new Error('API provider not found');

        // Fixed routing is a server-side policy. Resolve the task against the
        // selected provider before it enters the queue, even when the renderer
        // still has the previous provider/model selected. This keeps queued
        // tasks consistent with the policy and avoids requiring a second save
        // of the provider form to refresh runtime state.
        const requestedModel = String(payload.model || '').trim();
        const providerModels = Array.isArray(provider.models) ? provider.models : [];
        const exactModel = providerModels.find(model => model === requestedModel);
        const compatibleModel = exactModel || providerModels.find(model =>
            String(model).toLowerCase() === requestedModel.toLowerCase()
        );
        const model = fixedProviderId
            ? compatibleModel || providerModels[0] || requestedModel
            : requestedModel || providerModels[0] || '';

        payload.providerId = provider.id;
        payload.provider = provider.baseUrl || provider.url;
        payload.apiKey = provider.apiKey;
        payload.providerName = provider.name;
        payload.model = model;
        payload.modelPricing = Number(provider.modelPricing?.[model] ?? provider.pricing?.[model] ?? 0) || 0;
        payload.providerConfig = provider;
        payload.modelRouting = provider.modelRouting || {};
        payload.modelCapabilities = provider.modelCapabilities || {};
        return payload;
    }

    async function syncProxyConfig() {
        const config = await proxyConfigStore.get();
        setProxyState(config);
        if (typeof options.onProxyConfig === 'function') {
            try {
                await options.onProxyConfig(config);
            } catch (error) {
                console.error('[Proxy] 应用到 Electron 失败:', error.message);
                await recordError({
                    source: 'network',
                    title: '应用代理设置失败',
                    message: error.message,
                    error,
                    details: { mode: config.mode }
                });
            }
        }
        broadcast('provider:proxy-config', config);
        return config;
    }

    proxyConfigStore.get()
        .then(() => syncProxyConfig())
        .catch(error => {
            console.error('[ProxyConfigStore] load failed:', error.message);
            recordError({ source: 'network', title: '读取网络设置失败', message: error.message, error });
        });
    const providerReady = providerStore.load()
        .then(() => syncProviderManager())
        .catch(error => {
            console.error('[ProviderStore] load failed:', error.message);
            recordError({ source: 'storage', title: '读取 API 提供商失败', message: error.message, error });
        });
    chatProviderStore.load()
        .catch(error => {
            console.error('[ChatProviderStore] load failed:', error.message);
            recordError({ source: 'storage', title: '读取提示词优化配置失败', message: error.message, error });
        });
    unifiedProviderStore.load()
        .catch(error => {
            console.error('[UnifiedProviderStore] load failed:', error.message);
            recordError({ source: 'storage', title: '读取统一供应商失败', message: error.message, error });
        });

    app.use(cors());
    app.use(express.json({ limit: '100mb' }));
    // Do not let a late startup snapshot overwrite a setting already saved
    // by the first renderer request.
    app.use(async (_req, _res, next) => { await providerReady; next(); });

    // 代理路由必须注册在 /api/providers/:id 之前，否则 :id 会把 "proxy" 当成供应商 ID。
    app.get('/api/providers/proxy', async (_req, res) => {
        try {
            const config = await proxyConfigStore.get();
            res.json({
                ...config,
                active: getProxyState(),
                effectiveProxy: effectiveProxyFor(config)
            });
        } catch (error) {
            await recordError({ source: 'network', title: '读取代理设置失败', message: error.message, error });
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/providers/proxy/test', async (_req, res) => {
        try {
            const config = await proxyConfigStore.get();
            const result = await testProxyReachability();
            res.json({
                ...result,
                mode: config.mode,
                effectiveProxy: effectiveProxyFor(config)
            });
        } catch (error) {
            await recordError({ source: 'network', title: '代理连接测试失败', message: error.message, error });
            res.status(400).json({ error: error.message });
        }
    });

    app.post('/api/providers/proxy', async (req, res) => {
        try {
            const { mode, customProxy, bypassList } = req.body;
            const config = await proxyConfigStore.update({ mode, customProxy, bypassList });
            await syncProxyConfig();
            res.json({ success: true, config, active: getProxyState() });
        } catch (error) {
            await recordError({
                source: 'network',
                title: '保存代理设置失败',
                message: error.message,
                error,
                details: { mode: req.body?.mode || '' }
            });
            res.status(400).json({ error: error.message });
        }
    });

    // One batch carries one reference-image payload. Tasks retain the shared immutable
    // array until completion rather than parsing/retaining N copies of Base64.
    app.post('/api/tasks/batch', async (req, res) => {
        try {
            const count = Number(req.body?.count);
            if (!Number.isInteger(count) || count < 1 || count > 100) {
                return res.status(400).json({ error: '批次数量必须是 1 到 100 的整数' });
            }
            const payload = await resolveTaskProvider({ ...req.body });
            if (!String(payload.prompt || '').trim() || !String(payload.model || '').trim()) {
                return res.status(400).json({ error: '缺少提示词或模型' });
            }
            if (!Array.isArray(payload.referenceImages || [])) {
                return res.status(400).json({ error: '参考图格式无效' });
            }
            const startIndex = Math.max(0, Math.floor(Number(payload.batchIndex) || 0));
            const taskIds = Array.from({ length: count }, (_, index) => taskQueue.enqueue({
                ...payload,
                batchIndex: startIndex + index,
                batchTotal: Math.max(startIndex + count, Math.floor(Number(payload.batchTotal) || count))
            }));
            res.status(202).json({ taskIds, status: 'pending' });
        } catch (error) {
            await recordError({ source: 'generation', title: '批量入队失败', message: error.message, error });
            res.status(400).json({ error: error.message });
        }
    });

    app.post('/api/tasks', async (req, res) => {
        try {
            const taskId = taskQueue.enqueue(await resolveTaskProvider(req.body));
            res.status(202).json({ taskId, status: 'pending' });
        } catch (error) {
            console.error('[Server] enqueue failed:', error);
            await recordError({
                source: 'generation',
                title: '生成任务入队失败',
                message: error.message,
                error,
                providerId: req.body?.providerId || '',
                model: req.body?.model || '',
                sequenceId: req.body?.sequenceId || '',
                operation: req.body?.operation || 'generate'
            });
            res.status(400).json({ error: error.message });
        }
    });

    app.get('/api/providers', async (_req, res) => {
        try {
            res.json(await providerStore.list());
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 必须注册在 /api/providers/:id 之前，否则 "reorder" 会被当成供应商 ID。
    app.post('/api/providers/reorder', async (req, res) => {
        try {
            const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
            if (!ids || !ids.length) {
                res.status(400).json({ error: 'ids 必须是非空数组' });
                return;
            }

            // 保存拖拽后的数组顺序；ProviderManager 会按该顺序依次尝试线路。
            // List order breaks ties; per-group priority is saved independently.
            const providers = await providerStore.reorder(ids);
            await syncProviderManager();
            res.json({ success: true, providers });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    app.post('/api/providers', async (req, res) => {
        try {
            const provider = await providerStore.create(req.body);
            await syncProviderManager();
            res.status(201).json(provider);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    app.put('/api/providers/:id', async (req, res) => {
        try {
            const provider = await providerStore.update(req.params.id, req.body);
            if (!provider) return res.status(404).json({ error: 'API provider not found' });
            await syncProviderManager();
            res.json(provider);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    app.delete('/api/providers/:id', async (req, res) => {
        try {
            const deleted = await providerStore.delete(req.params.id);
            if (!deleted) return res.status(404).json({ error: 'API provider not found' });
            const status = await syncProviderManager();
            res.json({ success: true, status, providers: await providerStore.list() });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    app.post('/api/providers/:id/test', async (req, res) => {
        let provider = null;
        try {
            provider = await getImageProvider(req.params.id);
            if (!provider) return res.status(404).json({ error: 'API provider not found' });
            const model = provider.models?.[0] || provider.model || '';
            const result = await testImageProviderConnection({
                provider: provider.baseUrl || provider.url,
                apiKey: provider.apiKey,
                model,
                protocol: provider.modelRouting?.[model]?.protocol || 'auto'
            });
            if (result.success) {
                providerManager.resetProvider(provider.id);
                providerManager.recordSuccess(provider.id, result.latencyMs);
            } else {
                const testError = new Error(result.message || 'API test failed');
                testError.status = Number(result.status) || 0;
                providerManager.recordFailure(provider.id, testError);
                await recordError({
                    source: 'provider',
                    title: 'API 连接测试失败',
                    message: testError.message,
                    error: testError,
                    providerId: provider.id,
                    providerName: provider.name,
                    model,
                    protocol: provider.modelRouting?.[model]?.protocol || 'auto'
                });
            }
            const status = providerManager.getStatus();
            broadcast('provider:status', status);
            res.json({
                ...result,
                health: providerManager.getHealthRatings().find(item => item.id === provider.id) || null
            });
        } catch (error) {
            providerManager.recordFailure(req.params.id, error);
            broadcast('provider:status', providerManager.getStatus());
            await recordError({
                source: 'provider',
                title: 'API 连接测试失败',
                message: error.message,
                error,
                providerId: req.params.id,
                providerName: provider?.name || '',
                model: provider?.models?.[0] || ''
            });
            res.status(400).json({ error: error.message });
        }
    });

    app.post('/api/providers/:id/discover', async (req, res) => {
        let provider = null;
        try {
            provider = await getImageProvider(req.params.id);
            if (!provider) return res.status(404).json({ error: 'API provider not found' });
            const selectedModel = req.body?.model || provider.models?.[0] || '';
            const result = await discoverImageProviderCapabilities({
                provider: provider.baseUrl || provider.url,
                apiKey: provider.apiKey,
                model: selectedModel,
                protocol: provider.modelRouting?.[selectedModel]?.protocol || 'auto'
            });
            const byModel = Object.fromEntries(result.models.map(item => [item.id, {
                supported_endpoint_types: item.supported_endpoint_types,
                discoveredAt: Date.now()
            }]));
            const existing = provider.modelCapabilities || {};
            await providerStore.updateCapabilities(provider.id, { ...existing, ...byModel }, result.models);
            await syncProviderManager();
            res.json(result);
        } catch (error) {
            await recordError({
                source: 'provider',
                title: '发现模型失败',
                message: error.message,
                error,
                providerId: req.params.id,
                providerName: provider?.name || '',
                model: req.body?.model || provider?.models?.[0] || ''
            });
            res.status(Number(error.status) || 400).json({ error: error.message });
        }
    });

    app.get('/api/chat-providers', async (_req, res) => {
        try {
            res.json(await chatProviderStore.list());
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/chat-providers', async (req, res) => {
        try {
            const provider = await chatProviderStore.create(req.body);
            res.status(201).json(provider);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    app.put('/api/chat-providers/:id', async (req, res) => {
        try {
            const provider = await chatProviderStore.update(req.params.id, req.body);
            if (!provider) return res.status(404).json({ error: 'Chat provider not found' });
            res.json(provider);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    app.delete('/api/chat-providers/:id', async (req, res) => {
        try {
            const deleted = await chatProviderStore.delete(req.params.id);
            if (!deleted) return res.status(404).json({ error: 'Chat provider not found' });
            res.json({ success: true, providers: await chatProviderStore.list() });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    app.post('/api/chat-providers/:id/test', async (req, res) => {
        let provider = null;
        try {
            provider = await chatProviderStore.get(req.params.id);
            if (!provider) return res.status(404).json({ error: 'Chat provider not found' });
            const result = await testChatProviderConnection({
                provider: provider.baseUrl || provider.url,
                apiKey: provider.apiKey,
                model: provider.model || provider.activeModel
            });
            res.json(result);
        } catch (error) {
            await recordError({
                source: 'prompt',
                title: '提示词优化 API 测试失败',
                message: error.message,
                error,
                providerId: req.params.id,
                providerName: provider?.name || '',
                model: provider?.model || provider?.activeModel || ''
            });
            res.status(400).json({ error: error.message });
        }
    });

    // Unified supplier identity API. A supplier contains role-specific groups
    // (image/chat), each with its own key and model list. Legacy endpoints
    // remain available for backwards compatibility.
    app.get('/api/unified-providers', async (_req, res) => {
        try { res.json(await unifiedProviderStore.list()); }
        catch (error) { res.status(500).json({ error: error.message }); }
    });
    // Friendly supplier aliases used by the modern settings workspace.
    app.get('/api/suppliers', async (_req, res) => {
        try { res.json(await unifiedProviderStore.list()); }
        catch (error) { res.status(500).json({ error: error.message }); }
    });
    app.post('/api/suppliers', async (req, res) => {
        try { const provider = await unifiedProviderStore.create(req.body); await syncProviderManager(); res.status(201).json(provider); }
        catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.put('/api/suppliers/:id', async (req, res) => {
        try {
            const provider = await unifiedProviderStore.update(req.params.id, req.body);
            if (!provider) return res.status(404).json({ error: 'Supplier not found' });
            await syncProviderManager();
            res.json(provider);
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.delete('/api/suppliers/:id', async (req, res) => {
        try {
            const deleted = await unifiedProviderStore.delete(req.params.id);
            if (!deleted) return res.status(404).json({ error: 'Supplier not found' });
            await syncProviderManager();
            res.json({ success: true, suppliers: await unifiedProviderStore.list() });
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.post('/api/suppliers/:id/groups', async (req, res) => {
        try {
            const provider = await unifiedProviderStore.addGroup(req.params.id, req.body);
            if (!provider) return res.status(404).json({ error: 'Supplier not found' });
            await syncProviderManager();
            res.status(201).json(provider);
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.put('/api/suppliers/:id/groups/:groupId', async (req, res) => {
        try {
            const provider = await unifiedProviderStore.updateGroup(req.params.id, req.params.groupId, req.body);
            if (!provider) return res.status(404).json({ error: 'Supplier or group not found' });
            await syncProviderManager();
            res.json(provider);
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.delete('/api/suppliers/:id/groups/:groupId', async (req, res) => {
        try {
            const provider = await unifiedProviderStore.deleteGroup(req.params.id, req.params.groupId);
            if (!provider) return res.status(404).json({ error: 'Supplier or group not found' });
            await syncProviderManager();
            res.json(provider);
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.post('/api/suppliers/reorder', async (req, res) => {
        try { const suppliers = await unifiedProviderStore.reorder(req.body?.ids || []); await syncProviderManager(); res.json(suppliers); }
        catch (error) { res.status(400).json({ error: error.message }); }
    });
    // Draft connectivity checks: operate on the submitted credentials instead of
    // a persisted group, so the settings panel can test/discover before saving.
    app.post('/api/suppliers/test-draft', async (req, res) => {
        try {
            const { baseUrl, apiKey = '', model = '', protocol = 'auto', role = 'image' } = req.body || {};
            if (!baseUrl) return res.status(400).json({ error: 'baseUrl is required' });
            const result = role === 'chat' && model
                ? await testChatProviderConnection({ provider: baseUrl, apiKey, model })
                : await testImageProviderConnection({ provider: baseUrl, apiKey, model, protocol });
            res.json(result);
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.post('/api/suppliers/discover-draft', async (req, res) => {
        try {
            const { baseUrl, apiKey = '', model = '', protocol = 'auto' } = req.body || {};
            if (!baseUrl) return res.status(400).json({ error: 'baseUrl is required' });
            const result = await discoverImageProviderCapabilities({ provider: baseUrl, apiKey, model, protocol });
            res.json(result);
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.post('/api/suppliers/:id/groups/:groupId/test', async (req, res) => {
        try {
            const provider = await unifiedProviderStore.get(req.params.id);
            const group = provider?.groups?.find(item => String(item.id) === String(req.params.groupId));
            if (!provider || !group) return res.status(404).json({ error: 'Supplier or group not found' });
            const model = group.models?.[0] || group.model || '';
            const result = await testImageProviderConnection({
                provider: provider.baseUrl || provider.url,
                apiKey: group.apiKey,
                model,
                protocol: group.modelRouting?.[model]?.protocol || 'auto'
            });
            res.json(result);
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.post('/api/suppliers/:id/groups/:groupId/discover', async (req, res) => {
        try {
            const provider = await unifiedProviderStore.get(req.params.id);
            const group = provider?.groups?.find(item => String(item.id) === String(req.params.groupId));
            if (!provider || !group) return res.status(404).json({ error: 'Supplier or group not found' });
            const selectedModel = req.body?.model || group.models?.[0] || '';
            const result = await discoverImageProviderCapabilities({
                provider: provider.baseUrl || provider.url,
                apiKey: group.apiKey,
                model: selectedModel,
                protocol: group.modelRouting?.[selectedModel]?.protocol || 'auto'
            });
            const discoveredModels = (Array.isArray(result.models) ? result.models : []).map(item => ({ id: item.id, supported_endpoint_types: item.supported_endpoint_types, discoveredAt: Date.now() }));
            const merged = [...(group.discoveredModels || []), ...discoveredModels].reduce((all, item) => all.some(existing => existing.id === item.id) ? all : [...all, item], []);
            const updated = await unifiedProviderStore.updateGroup(provider.id, group.id, { ...group, discoveredModels: merged });
            res.json({ ...result, provider: updated });
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.post('/api/unified-providers', async (req, res) => {
        try { const provider = await unifiedProviderStore.create(req.body); await syncProviderManager(); res.status(201).json(provider); }
        catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.put('/api/unified-providers/:id', async (req, res) => {
        try {
            const provider = await unifiedProviderStore.update(req.params.id, req.body);
            if (!provider) return res.status(404).json({ error: 'Unified provider not found' });
            await syncProviderManager();
            res.json(provider);
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.delete('/api/unified-providers/:id', async (req, res) => {
        try {
            const deleted = await unifiedProviderStore.delete(req.params.id);
            if (!deleted) return res.status(404).json({ error: 'Unified provider not found' });
            await syncProviderManager();
            res.json({ success: true, providers: await unifiedProviderStore.list() });
        } catch (error) { res.status(400).json({ error: error.message }); }
    });

    app.post('/api/prompts/optimize', async (req, res) => {
        const requestId = req.body.requestId || `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let selectedProvider = null;
        const output = createPromptResponse(req, res);
        try {
            const prompt = String(req.body.prompt || '').trim();
            const chatProviderId = req.body.chatProviderId;
            const providerId = req.body.providerId;
            const referenceImages = Array.isArray(req.body.referenceImages) ? req.body.referenceImages : [];
            const declaredReferenceCount = Number.isFinite(Number(req.body.referenceImageCount))
                ? Math.max(0, Math.floor(Number(req.body.referenceImageCount)))
                : referenceImages.length;
            const referenceMimeTypes = Array.isArray(req.body.referenceMimeTypes)
                ? req.body.referenceMimeTypes.map(type => String(type || 'image/png'))
                : referenceImages.map(ref => ref.mimeType || 'image/png');
            const referenceNames = Array.isArray(req.body.referenceNames)
                ? req.body.referenceNames.map(name => String(name || ''))
                : [];
            const ratio = String(req.body.ratio || '');
            console.log('[PromptOptimize][server] received', {
                requestId,
                chatProviderId: chatProviderId || '',
                legacyProviderId: providerId || '',
                promptLength: prompt.length,
                referenceCount: declaredReferenceCount,
                receivedReferenceCount: referenceImages.length,
                referenceMimeTypes,
                referenceNames,
                ratio
            });

            if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

            const provider = chatProviderId
                ? await getChatProvider(chatProviderId)
                : (providerId ? await getChatProvider(providerId) || await getChatProvider(`${providerId}_chat`) : null);
            selectedProvider = provider;
            if (!provider) return res.status(404).json({ error: 'Chat provider not found' });

            const model = provider.model || provider.chatModel;
            if (!provider.baseUrl || !provider.apiKey || !model) {
                return res.status(400).json({ error: '请先在 API 设置中填写对话大模型' });
            }

            console.log('[PromptOptimize][server] provider', {
                requestId,
                providerName: provider.name || '',
                providerHost: formatProviderHost(provider.baseUrl || provider.url),
                model,
                systemPromptLength: String(req.body.systemPrompt || provider.promptOptimizerSystemPrompt || '').length
            });

            const result = await optimizePrompt({
                signal: output.signal, onDelta: output.onDelta,
                requestId,
                provider: provider.baseUrl || provider.url,
                apiKey: provider.apiKey,
                model,
                prompt,
                systemPrompt: req.body.systemPrompt || provider.promptOptimizerSystemPrompt,
                referenceImageCount: declaredReferenceCount,
                referenceNames,
                ratio,
                referenceImages
            });

            console.log('[PromptOptimize][server] success', {
                requestId,
                resultLength: result.text.length
            });
            output.done(result.text);
        } catch (error) {
            if (output.signal.aborted) return;
            console.error('[PromptOptimize][server] failed', {
                requestId,
                message: error.message,
                stack: error.stack
            });
            await recordError({
                source: 'prompt',
                title: '提示词优化失败',
                message: error.message,
                error,
                requestId,
                providerId: selectedProvider?.id || req.body?.chatProviderId || req.body?.providerId || '',
                providerName: selectedProvider?.name || '',
                model: selectedProvider?.model || selectedProvider?.chatModel || '',
                operation: 'optimize-prompt'
            });
            output.error(error);
        } finally { output.dispose(); }
    });

    app.post('/api/prompts/reverse', async (req, res) => {
        const requestId = req.body.requestId || `reverse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let selectedProvider = null;
        const output = createPromptResponse(req, res);
        try {
            const image = req.body.image;
            if (!image?.base64) return res.status(400).json({ error: 'Missing image' });
            const provider = req.body.chatProviderId
                ? await getChatProvider(req.body.chatProviderId)
                : (req.body.providerId ? await getChatProvider(req.body.providerId) || await getChatProvider(`${req.body.providerId}_chat`) : null);
            selectedProvider = provider;
            if (!provider) return res.status(404).json({ error: 'Chat provider not found' });
            const requestedModel = String(req.body.model || '').trim();
            const availableModels = Array.isArray(provider.models) ? provider.models.map(String) : [];
            if (requestedModel && !availableModels.includes(requestedModel)) {
                return res.status(400).json({ error: '所选反推模型不属于当前供应商' });
            }
            const model = requestedModel || provider.model || provider.activeModel || provider.chatModel;
            if (!model) return res.status(400).json({ error: '请先在统一 API 提供商设置中选择反推模型' });
            const result = await reversePrompt({
                signal: output.signal, onDelta: output.onDelta,
                requestId,
                provider: provider.baseUrl || provider.url,
                apiKey: provider.apiKey,
                model,
                prompt: req.body.instruction,
                systemPrompt: req.body.systemPrompt,
                referenceImages: [{ base64: image.base64, mimeType: image.mimeType || 'image/png' }]
            });
            output.done(result.text);
        } catch (error) {
            if (output.signal.aborted) return;
            console.error('[ReversePrompt] failed:', error.message);
            await recordError({
                source: 'prompt',
                title: '提示词反推失败',
                message: error.message,
                error,
                requestId,
                providerId: selectedProvider?.id || req.body?.chatProviderId || req.body?.providerId || '',
                providerName: selectedProvider?.name || '',
                model: selectedProvider?.model || selectedProvider?.chatModel || '',
                operation: 'reverse-prompt'
            });
            output.error(error);
        } finally { output.dispose(); }
    });

    app.get('/api/tasks', (req, res) => {
        const filters = {};
        if (req.query.sequenceId) filters.sequenceId = req.query.sequenceId;
        if (req.query.status) {
            filters.status = req.query.status.split(',').map(s => s.trim());
        }

        res.json(taskQueue.listTasks(filters));
    });

    app.get('/api/tasks/:id', (req, res) => {
        const task = taskQueue.getTask(req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        res.json(task);
    });

    app.delete('/api/tasks/:id', (req, res) => {
        const ok = taskQueue.cancel(req.params.id);
        res.json({ success: ok });
    });

    app.delete('/api/tasks', (req, res) => {
        const sequenceId = req.query.sequenceId;
        if (!sequenceId) return res.status(400).json({ error: 'Missing sequenceId' });

        const count = taskQueue.cancelBySequence(sequenceId);
        res.json({ cancelled: count });
    });

    app.get('/api/providers/health', async (_req, res) => {
        try {
            res.json(providerManager.getHealthRatings());
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/providers/status', (req, res) => {
        res.json(providerManager.getStatus());
    });

    app.get('/api/providers/ranking', (req, res) => {
        res.json(providerManager.getRanking(String(req.query.model || ''), req.query.strategy === 'price' ? 'price' : 'speed'));
    });

    app.post('/api/providers/reset', (req, res) => {
        const { providerId } = req.body;
        if (providerId) {
            providerManager.resetProvider(providerId);
        } else {
            providerManager.resetAll();
        }

        const status = providerManager.getStatus();
        broadcast('provider:status', status);
        res.json({ success: true, status });
    });

    app.get('/api/providers/failover', async (req, res) => {
        try {
            const config = await failoverConfigStore.get();
            res.json(config);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/providers/failover', async (req, res) => {
        try {
            const {
                enabled,
                maxAttempts,
                maxGlobalConcurrent,
                respectPriority,
                failoverThreshold,
                cooldownMs,
                strategy,
                selectedProviderId
            } = req.body;

            const current = await failoverConfigStore.get();
            if (normalizeStrategy(strategy ?? current.strategy) === 'fixed') {
                const selected = await providerStore.get(String(selectedProviderId ?? current.selectedProviderId));
                if (!selected || selected.enabled === false) {
                    return res.status(400).json({ error: '请选择一个已启用的生图配置组' });
                }
            }

            const config = await failoverConfigStore.update({
                enabled,
                maxAttempts,
                maxGlobalConcurrent,
                respectPriority,
                failoverThreshold,
                cooldownMs,
                strategy,
                selectedProviderId
            });

            // 立即应用新配置
            await syncProviderManager();

            res.json({ success: true, config });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    function effectiveProxyFor(config) {
        if (config.mode === 'direct') return '';
        if (config.mode === 'custom') return config.customProxy || '';
        return environmentProxyFor('https://example.com') || '';
    }

    function close() {
        clearInterval(cleanupTimer);
        taskQueue.close();
        providerManager.close();
        for (const ws of wsClients) ws.close();
        wss.close();
        server.close();
    }

    return {
        app,
        server,
        wss,
        taskQueue,
        providerManager,
        providerStore,
        chatProviderStore,
        unifiedProviderStore,
        proxyConfigStore,
        errorLogStore,
        close
    };
}

function startServer(options = {}) {
    const runtime = createServerApp(options);
    const port = options.port !== undefined ? options.port : (process.env.PORT || 3000);
    const host = options.host || '127.0.0.1';

    return new Promise((resolve, reject) => {
        runtime.server.once('error', reject);
        runtime.server.listen(port, host, () => {
            const address = runtime.server.address();
            const actualPort = typeof address === 'object' ? address.port : port;
            const urlHost = host || 'localhost';
            const url = `http://${urlHost}:${actualPort}`;
            console.log(`PicGen server running at ${url}`);
            resolve({ ...runtime, port: actualPort, host: urlHost, url });
        });
    });
}

if (require.main === module) {
    startServer({
        port: process.env.PORT || 3000,
        host: process.env.HOST || '127.0.0.1'
    }).catch((error) => {
        console.error('[Server] failed to start:', error);
        process.exit(1);
    });
}

module.exports = {
    createServerApp,
    startServer
};
