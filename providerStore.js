const fs = require('fs/promises');
const path = require('path');
const os = require('os');

function defaultStoreFile() {
    const home = os.homedir();
    return path.join(home, '.picgen', 'api-providers.json');
}

function defaultChatStoreFile() {
    const home = os.homedir();
    return path.join(home, '.picgen', 'chat-providers.json');
}

function defaultUnifiedStoreFile() {
    const home = os.homedir();
    return path.join(home, '.picgen', 'providers.json');
}

const DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT = [
    '你是专业的 AI 生图提示词优化助手，精通主流图像生成模型的提示词工程。',
    '将用户输入改写为一条更利于图像模型理解的提示词，严格忠于原始意图，不新增与原意冲突的主体、风格或限制。',
    '在与原意相关时按需补充以下要素，不要生硬堆砌：主体与用途（照片／海报／图标／插画等）；构图（取景、主体位置、画幅比例）；光线与色彩（光源方向、氛围、主色调）；材质与媒介（表面质感、绘制或摄影风格，需要真实感时明确"照片级写实"）；关键细节与艺术风格。',
    '用具体可见的描述代替笼统的情绪词；若画面内需出现文字，用引号给出确切文案并说明位置，同时声明不出现多余文字；必要时补充排除项（如无水印、无多余元素）。',
    '只返回优化后的提示词正文，语言与用户输入保持一致，不要解释，不要使用 Markdown 或分点符号。'
].join('\n');

// Provider icons are stored as icon-library names (for example "building-2"
// or "google-gemini"). Keep a stable, harmless fallback for older records
// that predate the icon field and trim excessively long values from imports.
const DEFAULT_PROVIDER_ICON = 'building-2';
function normalizeProviderIcon(value, fallback = DEFAULT_PROVIDER_ICON) {
    const icon = String(value ?? '').trim();
    return (icon || fallback).slice(0, 64);
}
function normalizeProviderIconImage(value, fallback = '') {
    const image = String(value ?? '').trim();
    return (image || fallback).slice(0, 2_000_000);
}

function parseStoreJson(raw) {
    return JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
}

function normalizeModelPricing(input = {}) {
    const pricing = {};
    if (!input || typeof input !== 'object') return pricing;

    for (const [model, value] of Object.entries(input)) {
        const name = String(model || '').trim();
        if (value == null || (typeof value === 'string' && !value.trim())
            || !['number', 'string'].includes(typeof value)) continue;
        const price = Number(value);
        if (name && Number.isFinite(price) && price >= 0) {
            pricing[name] = price;
        }
    }

    return pricing;
}

function normalizeStringList(input = []) {
    return Array.isArray(input)
        ? input.map(item => String(item).trim()).filter(Boolean)
        : [];
}

function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeModelRouting(input = {}, models = []) {
    const source = input && typeof input === 'object' ? input : {};
    return Object.fromEntries(models.map(model => {
        const route = source[model] && typeof source[model] === 'object' ? source[model] : {};
        return [model, {
            protocol: String(route.protocol || 'auto').trim().toLowerCase() || 'auto',
            group: String(route.group || '').trim(),
            enabled: route.enabled !== false
        }];
    }));
}

function normalizeModelCapabilities(input = {}, models = []) {
    const source = input && typeof input === 'object' ? input : {};
    const names = [...new Set([...Object.keys(source), ...models])];
    return Object.fromEntries(names.map(model => {
        const capability = source[model] && typeof source[model] === 'object' ? source[model] : {};
        return [model, {
            ...capability,
            supported_endpoint_types: Array.isArray(capability.supported_endpoint_types)
                ? capability.supported_endpoint_types.map(item => String(item).trim()).filter(Boolean)
                : []
        }];
    }));
}

function normalizeDiscoveredModels(input = []) {
    const discovered = [];
    const seen = new Set();
    for (const item of Array.isArray(input) ? input : []) {
        const source = item && typeof item === 'object' ? item : { id: item };
        const id = String(source.id || source.name || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        discovered.push({
            id,
            supported_endpoint_types: Array.isArray(source.supported_endpoint_types)
                ? source.supported_endpoint_types.map(value => String(value).trim()).filter(Boolean)
                : [],
            discoveredAt: Number(source.discoveredAt) || Date.now()
        });
    }
    return discovered;
}

function createEmptyProvider() {
    const now = Date.now();
    return {
        id: `api_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: '当前 API',
        icon: DEFAULT_PROVIDER_ICON,
        baseUrl: '',
        apiKey: '',
        models: [],
        modelPricing: {},
        modelRouting: {},
        modelCapabilities: {},
        discoveredModels: [],
        enabled: true,
        maxConcurrent: 1,
        priority: 1,
        chatModels: [],
        activeChatModel: '',
        chatModel: '',
        promptOptimizerSystemPrompt: DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
        createdAt: now,
        updatedAt: now
    };
}

function createEmptyChatProvider() {
    const now = Date.now();
    return {
        id: `chat_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: '对话 API',
        icon: DEFAULT_PROVIDER_ICON,
        baseUrl: '',
        apiKey: '',
        models: [],
        activeModel: '',
        model: '',
        promptOptimizerSystemPrompt: DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
        createdAt: now,
        updatedAt: now
    };
}

function normalizeProvider(input = {}, existing = null) {
    const now = Date.now();
    const id = existing?.id || input.id || `api_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const chatModels = normalizeStringList(
        input.chatModels
            ?? existing?.chatModels
            ?? [input.chatModel ?? existing?.chatModel].filter(Boolean)
    );
    const requestedChatModel = String(
        input.activeChatModel
            ?? input.chatModel
            ?? existing?.activeChatModel
            ?? existing?.chatModel
            ?? ''
    ).trim();
    const activeChatModel = chatModels.includes(requestedChatModel)
        ? requestedChatModel
        : (chatModels[0] || '');

    const models = Array.isArray(input.models)
        ? input.models.map(item => String(item).trim()).filter(Boolean)
        : (existing?.models || []);

    return {
        id,
        name: String(input.name || existing?.name || '未命名 API').trim() || '未命名 API',
        icon: normalizeProviderIcon(input.icon ?? existing?.icon),
        iconImage: normalizeProviderIconImage(input.iconImage ?? existing?.iconImage),
        baseUrl: String(input.baseUrl ?? input.url ?? existing?.baseUrl ?? '').trim(),
        apiKey: String(input.apiKey ?? existing?.apiKey ?? '').trim(),
        models,
        modelPricing: normalizeModelPricing(input.modelPricing ?? input.pricing ?? existing?.modelPricing ?? existing?.pricing),
        modelRouting: normalizeModelRouting(input.modelRouting ?? existing?.modelRouting, models),
        modelCapabilities: normalizeModelCapabilities(input.modelCapabilities ?? existing?.modelCapabilities, models),
        discoveredModels: normalizeDiscoveredModels(input.discoveredModels ?? existing?.discoveredModels),
        enabled: input.enabled ?? existing?.enabled ?? true,
        maxConcurrent: Math.round(clampNumber(input.maxConcurrent ?? existing?.maxConcurrent, 1, 1, 8)),
        priority: Math.round(clampNumber(input.priority ?? existing?.priority, 1, 1, 100)),
        chatModels,
        activeChatModel,
        chatModel: activeChatModel,
        promptOptimizerSystemPrompt: String(
            input.promptOptimizerSystemPrompt
                ?? existing?.promptOptimizerSystemPrompt
                ?? DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT
        ).trim() || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
        createdAt: existing?.createdAt || input.createdAt || now,
        updatedAt: now
    };
}

function publicProvider(provider) {
    return {
        ...provider,
        pricing: provider.modelPricing || {},
        url: provider.baseUrl
    };
}

function normalizeChatProvider(input = {}, existing = null) {
    const now = Date.now();
    const id = existing?.id || input.id || `chat_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const models = normalizeStringList(input.models ?? existing?.models ?? [input.model ?? existing?.model].filter(Boolean));
    const requestedModel = String(input.activeModel ?? input.model ?? existing?.activeModel ?? existing?.model ?? '').trim();
    const activeModel = models.includes(requestedModel) ? requestedModel : (models[0] || '');

    return {
        id,
        name: String(input.name || existing?.name || '对话 API').trim() || '对话 API',
        icon: normalizeProviderIcon(input.icon ?? existing?.icon),
        iconImage: normalizeProviderIconImage(input.iconImage ?? existing?.iconImage),
        baseUrl: String(input.baseUrl ?? input.url ?? existing?.baseUrl ?? '').trim(),
        apiKey: String(input.apiKey ?? existing?.apiKey ?? '').trim(),
        models,
        activeModel,
        model: activeModel,
        promptOptimizerSystemPrompt: String(
            input.promptOptimizerSystemPrompt
                ?? existing?.promptOptimizerSystemPrompt
                ?? DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT
        ).trim() || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
        createdAt: existing?.createdAt || input.createdAt || now,
        updatedAt: now
    };
}

function publicChatProvider(provider) {
    return {
        ...provider,
        url: provider.baseUrl
    };
}

// Unified provider identity model. A provider owns one or more role-specific
// credential groups (image/chat). Legacy api-providers.json and
// chat-providers.json records are migrated into this shape on first load.
function normalizeUnifiedGroup(input = {}, existing = null, roleHint = 'image') {
    const now = Date.now();
    const role = (input.role ?? existing?.role ?? roleHint) === 'chat' ? 'chat' : 'image';
    const models = normalizeStringList(input.models ?? existing?.models ?? []);
    const activeModel = String(input.activeModel ?? input.model ?? existing?.activeModel ?? existing?.model ?? models[0] ?? '').trim();
    return {
        id: String(existing?.id || input.id || `${role}_${now}_${Math.random().toString(36).slice(2, 8)}`),
        name: String(input.name || existing?.name || (role === 'chat' ? '对话配置组' : '生图配置组')).trim(),
        role,
        apiKey: String(input.apiKey ?? existing?.apiKey ?? '').trim(),
        models,
        activeModel: models.includes(activeModel) ? activeModel : (models[0] || ''),
        model: models.includes(activeModel) ? activeModel : (models[0] || ''),
        maxConcurrent: Math.round(clampNumber(input.maxConcurrent ?? existing?.maxConcurrent, 1, 1, 64)),
        priority: Math.round(clampNumber(input.priority ?? existing?.priority, 1, 1, 100)),
        enabled: (input.enabled ?? existing?.enabled) !== false,
        modelPricing: normalizeModelPricing(input.modelPricing ?? input.pricing ?? existing?.modelPricing),
        modelRouting: normalizeModelRouting(input.modelRouting ?? existing?.modelRouting, models),
        modelCapabilities: normalizeModelCapabilities(input.modelCapabilities ?? existing?.modelCapabilities, models),
        discoveredModels: normalizeDiscoveredModels(input.discoveredModels ?? existing?.discoveredModels),
        chatModels: normalizeStringList(input.chatModels ?? existing?.chatModels),
        activeChatModel: String(input.activeChatModel ?? existing?.activeChatModel ?? '').trim(),
        promptOptimizerSystemPrompt: String(input.promptOptimizerSystemPrompt ?? existing?.promptOptimizerSystemPrompt ?? DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT).trim() || DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
        createdAt: existing?.createdAt || input.createdAt || now,
        updatedAt: now
    };
}

function normalizeUnifiedProvider(input = {}, existing = null) {
    const now = Date.now();
    const groups = Array.isArray(input.groups)
        ? input.groups.map(group => normalizeUnifiedGroup(group, null, group.role))
        : (existing?.groups || []);
    return {
        id: String(existing?.id || input.id || `provider_${now}_${Math.random().toString(36).slice(2, 8)}`),
        name: String(input.name || existing?.name || '未命名供应商').trim() || '未命名供应商',
        icon: normalizeProviderIcon(input.icon ?? existing?.icon),
        iconImage: normalizeProviderIconImage(input.iconImage ?? existing?.iconImage),
        baseUrl: String(input.baseUrl ?? input.url ?? existing?.baseUrl ?? '').trim(),
        website: String(input.website ?? existing?.website ?? '').trim().slice(0, 2048),
        enabled: (input.enabled ?? existing?.enabled) !== false,
        groups,
        createdAt: existing?.createdAt || input.createdAt || now,
        updatedAt: now
    };
}

function publicUnifiedProvider(provider) {
    return { ...provider, url: provider.baseUrl, groups: provider.groups.map(group => ({ ...group, pricing: group.modelPricing || {} })) };
}

class UnifiedProviderStore {
    constructor(options = {}) {
        this.filePath = options.filePath || process.env.PICGEN_UNIFIED_PROVIDER_STORE || defaultUnifiedStoreFile();
        this.legacyProviderStoreFile = options.legacyProviderStoreFile || options.providerStoreFile || defaultStoreFile();
        this.legacyChatStoreFile = options.legacyChatStoreFile || options.chatProviderStoreFile || defaultChatStoreFile();
        this.secretCodec = options.secretCodec || null;
        this.providers = [];
        this.groupOrder = {};
        this.legacyMigrated = false;
        this.loaded = false;
        this.loadingPromise = null;
        this.mutationPromise = Promise.resolve();
    }

    async load() {
        if (this.loaded) return this.providers;
        if (this.loadingPromise) return this.loadingPromise;
        this.loadingPromise = (async () => {
        let migrated = false;
        const legacyMigratedBefore = this.legacyMigrated;
        let unifiedExists = true;
        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const parsed = parseStoreJson(raw);
            const list = Array.isArray(parsed) ? parsed : parsed.providers;
            if (!Array.isArray(list)) throw new Error('统一供应商配置格式错误');
            this.providers = list.map(item => normalizeUnifiedProvider({ ...item, groups: (item.groups || []).map(group => ({ ...group, apiKey: this._decodeSecret(group.apiKey) })) }));
            this.groupOrder = parsed.groupOrder || {};
            this.legacyMigrated = parsed.legacyMigrated === true;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            unifiedExists = false;
            this.providers = [];
        }
        // Legacy stores can coexist with an empty canonical placeholder (for
        // example a portable profile created by an earlier build). Always
        // inspect them and merge only missing provider identities/groups. This
        // makes migration idempotent while preserving canonical credentials.
        const legacyImages = await this._readLegacy(this.legacyProviderStoreFile, 'image');
        const legacyChats = await this._readLegacy(this.legacyChatStoreFile, 'chat');
        const legacyConfigured = [...legacyImages, ...legacyChats].some(item => (
            String(item.baseUrl || item.url || '').trim() || String(item.apiKey || '').trim() ||
            (Array.isArray(item.models) && item.models.length) || (Array.isArray(item.chatModels) && item.chatModels.length)
        ));
        if (legacyConfigured && !this.legacyMigrated) {
            const byIdentity = new Map();
            const identity = item => `${String(item.name || '').trim().replace(/\s+/g, ' ').toLowerCase()}|${(() => { try { const u = new URL(String(item.baseUrl || item.url || '').trim()); return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${u.port ? ':' + u.port : ''}${u.pathname}${u.search}`; } catch { return String(item.baseUrl || item.url || '').trim().replace(/\/$/, ''); } })()}`;
            const canonical = this.providers.filter(provider => String(provider.baseUrl || '').trim() || provider.groups.some(group => group.apiKey || group.models.length));
            const beforeGroupCount = canonical.reduce((total, provider) => total + provider.groups.length, 0);
            for (const provider of canonical) byIdentity.set(identity(provider), provider);
            const addGroup = (provider, item, role, derived = null) => {
                const group = normalizeUnifiedGroup(derived || item, null, role);
                const duplicate = provider.groups.some(existing => String(existing.id) === String(group.id) && existing.role === group.role);
                if (!duplicate) provider.groups.push(group);
            };
            for (const item of legacyImages) {
                const key = identity(item);
                let provider = byIdentity.get(key);
                if (!provider) {
                    provider = normalizeUnifiedProvider({ name: item.name, icon: item.icon, baseUrl: item.baseUrl || item.url, groups: [] });
                    byIdentity.set(key, provider);
                }
                addGroup(provider, item, 'image');
                if (Array.isArray(item.chatModels) && item.chatModels.length) addGroup(provider, item, 'chat', { ...item, role: 'chat', id: `${item.id || 'legacy'}_chat`, models: item.chatModels, activeModel: item.activeChatModel || item.chatModel, name: `${item.name || '对话'} · 对话` });
            }
            for (const item of legacyChats) {
                const key = identity(item);
                let provider = byIdentity.get(key);
                if (!provider) { provider = normalizeUnifiedProvider({ name: item.name, icon: item.icon, baseUrl: item.baseUrl || item.url, groups: [] }); byIdentity.set(key, provider); }
                addGroup(provider, item, 'chat');
            }
            this.providers = [...byIdentity.values()];
            const afterGroupCount = this.providers.reduce((total, provider) => total + provider.groups.length, 0);
            if (this.providers.length !== canonical.length || afterGroupCount !== beforeGroupCount) migrated = true;
            // Even when all identities were already present, mark the legacy
            // import complete so a later delete is not resurrected from the
            // compatibility files.
            this.legacyMigrated = true;
        }
        if (this.providers.length === 0 && !unifiedExists) {
            this.providers = [normalizeUnifiedProvider({ name: '当前 API', groups: [normalizeUnifiedGroup({}, null, 'image')] })];
        }
        this.loaded = true;
        if (migrated) await this._backupLegacyFiles();
        if (migrated || this.secretCodec || this.legacyMigrated !== legacyMigratedBefore) await this.save();
        return this.providers;
        })().catch(error => { this.loadingPromise = null; throw error; });
        return this.loadingPromise;
    }

    async _backupLegacyFiles() {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        for (const filePath of [this.legacyProviderStoreFile, this.legacyChatStoreFile]) {
            try {
                await fs.copyFile(filePath, `${filePath}.bak-${stamp}`);
            } catch { /* legacy file may not exist */ }
        }
    }

    async _readLegacy(filePath, role) {
        try {
            const raw = await fs.readFile(filePath, 'utf8');
            const parsed = parseStoreJson(raw);
            const list = Array.isArray(parsed) ? parsed : parsed.providers;
            return Array.isArray(list) ? list.map(item => ({ ...item, apiKey: this._decodeSecret(item.apiKey), role })) : [];
        } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    }

    async save() {
        const write = async () => {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            const payload = JSON.stringify({ schemaVersion: 1, legacyMigrated: this.legacyMigrated === true, groupOrder: this.groupOrder || {}, providers: this.providers.map(provider => ({ ...provider, groups: provider.groups.map(group => ({ ...group, apiKey: this._encodeSecret(group.apiKey) })) })) }, null, 2);
            const temp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
            await fs.writeFile(temp, payload, 'utf8');
            await fs.rename(temp, this.filePath);
        };
        this.mutationPromise = this.mutationPromise.then(write, write);
        return this.mutationPromise;
    }
    async list() { await this.load(); return this.providers.map(publicUnifiedProvider); }
    async get(id) { await this.load(); const p = this.providers.find(item => item.id === id); return p ? publicUnifiedProvider(p) : null; }
    async create(input) { await this.load(); const p = normalizeUnifiedProvider(input); this.providers.push(p); await this.save(); return publicUnifiedProvider(p); }
    async update(id, input) { await this.load(); const i = this.providers.findIndex(item => item.id === id); if (i < 0) return null; this.providers[i] = normalizeUnifiedProvider({ ...input, id }, this.providers[i]); await this.save(); return publicUnifiedProvider(this.providers[i]); }
    async addGroup(id, input) {
        await this.load();
        const provider = this.providers.find(item => item.id === id);
        if (!provider) return null;
        provider.groups.push(normalizeUnifiedGroup(input, null, input?.role));
        provider.updatedAt = Date.now();
        await this.save();
        return publicUnifiedProvider(provider);
    }
    async updateGroup(id, groupId, input) {
        await this.load();
        const provider = this.providers.find(item => item.id === id);
        if (!provider) return null;
        const index = provider.groups.findIndex(group => String(group.id) === String(groupId));
        if (index < 0) return null;
        provider.groups[index] = normalizeUnifiedGroup({ ...input, id: groupId }, provider.groups[index], input?.role || provider.groups[index].role);
        provider.updatedAt = Date.now();
        await this.save();
        return publicUnifiedProvider(provider);
    }
    async deleteGroup(id, groupId) {
        await this.load();
        const provider = this.providers.find(item => item.id === id);
        if (!provider) return null;
        const before = provider.groups.length;
        provider.groups = provider.groups.filter(group => String(group.id) !== String(groupId));
        if (provider.groups.length === before) return null;
        provider.updatedAt = Date.now();
        await this.save();
        return publicUnifiedProvider(provider);
    }
    async delete(id) { await this.load(); const before = this.providers.length; this.providers = this.providers.filter(item => item.id !== id); if (this.providers.length === before) return false; await this.save(); return true; }
    async reorder(ids = []) { await this.load(); const order = new Map((Array.isArray(ids) ? ids : []).map((id, index) => [String(id), index])); this.providers.sort((a, b) => (order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER) - (order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER)); await this.save(); return this.list(); }
    // Compatibility facade exposing the historical ProviderStore API for one role.
    // All mutations are persisted to this unified store; legacy files are read only
    // during migration and never consulted afterwards.
    createRoleStore(role = 'image') {
        const unified = this;
        const roleName = role === 'chat' ? 'chat' : 'image';
        const listRole = async () => {
            await unified.load();
            const groups = unified.providers.flatMap(provider => provider.groups
                .filter(group => group.role === roleName)
                .map(group => ({ provider, group })));
            const order = Array.isArray(unified.groupOrder?.[roleName])
                ? unified.groupOrder[roleName].map(String)
                : [];
            const rank = new Map(order.map((id, index) => [id, index]));
            groups.sort((left, right) => {
                const leftRank = rank.has(String(left.group.id)) ? rank.get(String(left.group.id)) : order.length;
                const rightRank = rank.has(String(right.group.id)) ? rank.get(String(right.group.id)) : order.length;
                return leftRank - rightRank;
            });
            return groups.map(({ provider, group }) => flatten(provider, group));
        };
        const flatten = (provider, group) => publicProvider({
            ...group,
            id: group.id,
            name: group.name || provider.name,
            // 生成区那颗按钮写的是「供应商」，但这里每一条其实是一个配置组。把供应商名一并
            // 交出去，显示端才能拼出「供应商 · 组名」——只给组名的话，供应商改名后按钮上
            // 看不到任何变化（迁移期的组名正是供应商名的副本）。仅供显示，不参与回写。
            supplierName: String(provider.name || '').trim(),
            baseUrl: provider.baseUrl,
            icon: provider.icon,
            apiKey: group.apiKey,
            enabled: provider.enabled !== false && group.enabled !== false
        });
        const find = async id => {
            await unified.load();
            for (const provider of unified.providers) {
                const group = provider.groups.find(g => String(g.id) === String(id) && g.role === roleName);
                if (group) return { provider, group };
            }
            return null;
        };
        return {
            load: () => unified.load(),
            list: listRole,
            get: async id => { const found = await find(id); return found ? flatten(found.provider, found.group) : null; },
            create: async input => { await unified.load(); const provider = normalizeUnifiedProvider({ name: input.name, icon: input.icon, baseUrl: input.baseUrl || input.url, groups: [] }); provider.groups.push(normalizeUnifiedGroup(input, null, roleName)); unified.providers.push(provider); await unified.save(); return flatten(provider, provider.groups[0]); },
            update: async (id, input) => { const found = await find(id); if (!found) return null; found.provider.name = String(input.providerName || input.supplierName || found.provider.name || input.name || '').trim() || found.provider.name; if (input.icon !== undefined) found.provider.icon = normalizeProviderIcon(input.icon, found.provider.icon); if (input.baseUrl || input.url) found.provider.baseUrl = String(input.baseUrl || input.url).trim(); found.group = normalizeUnifiedGroup({ ...input, id: found.group.id }, found.group, roleName); const index = found.provider.groups.findIndex(g => String(g.id) === String(id)); found.provider.groups[index] = found.group; found.provider.updatedAt = Date.now(); await unified.save(); return flatten(found.provider, found.group); },
            delete: async id => { const found = await find(id); if (!found) return false; found.provider.groups = found.provider.groups.filter(g => String(g.id) !== String(id)); if (!found.provider.groups.length) unified.providers = unified.providers.filter(p => p !== found.provider); await unified.save(); return true; },
            reorder: async ids => {
                await unified.load();
                const wanted = Array.isArray(ids) ? ids.map(String) : [];
                const groups = unified.providers.flatMap(provider => provider.groups.filter(group => group.role === roleName));
                const byId = new Map(groups.map(group => [String(group.id), group]));
                const orderedIds = [];
                const seen = new Set();
                for (const id of wanted) {
                    if (byId.has(id) && !seen.has(id)) {
                        orderedIds.push(id);
                        seen.add(id);
                    }
                }
                for (const group of groups) {
                    const id = String(group.id);
                    if (!seen.has(id)) orderedIds.push(id);
                }
                unified.groupOrder = { ...(unified.groupOrder || {}), [roleName]: orderedIds };
                await unified.save();
                return listRole();
            },
            replace: async list => {
                await unified.load();
                const retained = unified.providers.map(p => ({ ...p, groups: p.groups.filter(g => g.role !== roleName) })).filter(p => p.groups.length);
                const byIdentity = new Map(retained.map(p => [`${p.name.toLowerCase()}|${p.baseUrl}`, p]));
                for (const item of (Array.isArray(list) ? list : [])) {
                    const name = String(item.name || '未命名供应商').trim();
                    const baseUrl = String(item.baseUrl || item.url || '').trim();
                    const key = `${name.toLowerCase()}|${baseUrl}`;
                    let p = byIdentity.get(key);
                    if (!p) { p = normalizeUnifiedProvider({ name, icon: item.icon, baseUrl, groups: [] }); retained.push(p); byIdentity.set(key, p); }
                    p.groups.push(normalizeUnifiedGroup(item, null, roleName));
                }
                unified.providers = retained.length ? retained : [normalizeUnifiedProvider({ name: '当前 API', groups: [normalizeUnifiedGroup({}, null, roleName)] })];
                await unified.save();
                return listRole();
            },
            updateCapabilities: async (id, capabilities, discoveredModels) => { const found = await find(id); if (!found) return null; found.group.modelCapabilities = normalizeModelCapabilities(capabilities, found.group.models); if (Array.isArray(discoveredModels)) found.group.discoveredModels = normalizeDiscoveredModels(discoveredModels); await unified.save(); return flatten(found.provider, found.group); }
        };
    }
    _encodeSecret(value) { if (!this.secretCodec || !value || String(value).startsWith('enc:v1:')) return value || ''; return this.secretCodec.encrypt(String(value)); }
    _decodeSecret(value) {
        if (!this.secretCodec || !String(value || '').startsWith('enc:v1:')) return value || '';
        try {
            return this.secretCodec.decrypt(String(value));
        } catch {
            // Keep the ciphertext when it cannot be decrypted (for example
            // after moving a portable profile to another Windows account).
            // Returning an empty string here used to make the next automatic
            // save irreversibly erase the user's credential.
            return String(value);
        }
    }
}

class ProviderStore {
    constructor(options = {}) {
        this.filePath = options.filePath || process.env.PICGEN_PROVIDER_STORE || defaultStoreFile();
        this.secretCodec = options.secretCodec || null;
        this.providers = [];
        this.loaded = false;
    }

    async load() {
        if (this.loaded) return this.providers;

        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const parsed = parseStoreJson(raw);
            const list = Array.isArray(parsed) ? parsed : parsed.providers;
            this.providers = Array.isArray(list)
                ? list.map(item => normalizeProvider({ ...item, apiKey: this._decodeSecret(item.apiKey) }))
                : [];
        } catch {
            this.providers = [];
        }

        if (this.providers.length === 0) {
            this.providers = [createEmptyProvider()];
            await this.save();
        }

        this.loaded = true;
        if (this.secretCodec) await this.save();
        return this.providers;
    }

    async save() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const payload = JSON.stringify({
            schemaVersion: 2,
            providers: this.providers.map(provider => ({ ...provider, apiKey: this._encodeSecret(provider.apiKey) }))
        }, null, 2);
        await fs.writeFile(this.filePath, payload, 'utf8');
    }

    async list() {
        await this.load();
        return this.providers.map(publicProvider);
    }

    async get(id) {
        await this.load();
        const provider = this.providers.find(item => item.id === id);
        return provider ? publicProvider(provider) : null;
    }

    async create(input) {
        await this.load();
        const provider = normalizeProvider(input);
        this.providers.push(provider);
        await this.save();
        return publicProvider(provider);
    }

    async update(id, input) {
        await this.load();
        const index = this.providers.findIndex(item => item.id === id);
        if (index === -1) return null;

        this.providers[index] = normalizeProvider({ ...input, id }, this.providers[index]);
        await this.save();
        return publicProvider(this.providers[index]);
    }

    // 按 ids 给出的顺序重排。数组顺序是唯一选路顺序；priority 仅保留旧配置兼容。
    // 直接改内部记录，不走 publicProvider 往返，免得 pricing/url 这类派生字段被当成输入。
    async reorder(ids) {
        await this.load();
        const wanted = Array.isArray(ids) ? ids.map(String) : [];
        const byId = new Map(this.providers.map(item => [String(item.id), item]));

        const ordered = [];
        const seen = new Set();
        for (const id of wanted) {
            const provider = byId.get(id);
            if (!provider || seen.has(id)) continue;
            ordered.push(provider);
            seen.add(id);
        }
        // ids 里没提到的（比如刚新建还没刷新到前端的）保持原相对顺序接在后面，不能丢。
        for (const provider of this.providers) {
            if (!seen.has(String(provider.id))) ordered.push(provider);
        }

        this.providers = ordered.map(provider => ({
            ...provider,
            updatedAt: Date.now()
        }));

        await this.save();
        return this.list();
    }

    async replace(list) {
        await this.load();
        this.providers = Array.isArray(list)
            ? list.map(item => normalizeProvider(item))
            : [];
        if (this.providers.length === 0) this.providers = [createEmptyProvider()];
        await this.save();
        return this.list();
    }

    async delete(id) {
        await this.load();
        const before = this.providers.length;
        this.providers = this.providers.filter(item => item.id !== id);
        if (this.providers.length === before) return false;
        if (this.providers.length === 0) this.providers = [createEmptyProvider()];
        await this.save();
        return true;
    }

    async updateCapabilities(id, capabilities = {}, discoveredModels = null) {
        await this.load();
        const provider = this.providers.find(item => item.id === id);
        if (!provider) return null;
        provider.modelCapabilities = normalizeModelCapabilities(capabilities, provider.models);
        if (Array.isArray(discoveredModels)) {
            provider.discoveredModels = normalizeDiscoveredModels(discoveredModels);
        }
        provider.updatedAt = Date.now();
        await this.save();
        return publicProvider(provider);
    }

    _encodeSecret(value) {
        if (!this.secretCodec || !value || String(value).startsWith('enc:v1:')) return value || '';
        return this.secretCodec.encrypt(String(value));
    }

    _decodeSecret(value) {
        if (!this.secretCodec || !String(value || '').startsWith('enc:v1:')) return value || '';
        try { return this.secretCodec.decrypt(String(value)); } catch { return String(value); }
    }
}

class ChatProviderStore {
    constructor(options = {}) {
        this.filePath = options.filePath || process.env.PICGEN_CHAT_PROVIDER_STORE || defaultChatStoreFile();
        this.secretCodec = options.secretCodec || null;
        this.providers = [];
        this.loaded = false;
    }

    async load() {
        if (this.loaded) return this.providers;

        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const parsed = parseStoreJson(raw);
            const list = Array.isArray(parsed) ? parsed : parsed.providers;
            this.providers = Array.isArray(list)
                ? list.map(item => normalizeChatProvider({ ...item, apiKey: this._decodeSecret(item.apiKey) }))
                : [];
        } catch {
            this.providers = [];
        }

        if (this.providers.length === 0) {
            this.providers = [createEmptyChatProvider()];
            await this.save();
        }

        this.loaded = true;
        if (this.secretCodec) await this.save();
        return this.providers;
    }

    async save() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const payload = JSON.stringify({
            schemaVersion: 2,
            providers: this.providers.map(provider => ({ ...provider, apiKey: this._encodeSecret(provider.apiKey) }))
        }, null, 2);
        await fs.writeFile(this.filePath, payload, 'utf8');
    }

    async list() {
        await this.load();
        return this.providers.map(publicChatProvider);
    }

    async get(id) {
        await this.load();
        const provider = this.providers.find(item => item.id === id);
        return provider ? publicChatProvider(provider) : null;
    }

    async create(input) {
        await this.load();
        const provider = normalizeChatProvider(input);
        this.providers.push(provider);
        await this.save();
        return publicChatProvider(provider);
    }

    async update(id, input) {
        await this.load();
        const index = this.providers.findIndex(item => item.id === id);
        if (index === -1) return null;

        this.providers[index] = normalizeChatProvider({ ...input, id }, this.providers[index]);
        await this.save();
        return publicChatProvider(this.providers[index]);
    }

    async delete(id) {
        await this.load();
        const before = this.providers.length;
        this.providers = this.providers.filter(item => item.id !== id);
        if (this.providers.length === before) return false;
        if (this.providers.length === 0) this.providers = [createEmptyChatProvider()];
        await this.save();
        return true;
    }

    _encodeSecret(value) {
        if (!this.secretCodec || !value || String(value).startsWith('enc:v1:')) return value || '';
        return this.secretCodec.encrypt(String(value));
    }

    _decodeSecret(value) {
        if (!this.secretCodec || !String(value || '').startsWith('enc:v1:')) return value || '';
        try { return this.secretCodec.decrypt(String(value)); } catch { return String(value); }
    }
}

module.exports = {
    UnifiedProviderStore,
    ProviderStore,
    ChatProviderStore,
    DEFAULT_PROMPT_OPTIMIZER_SYSTEM_PROMPT
};
