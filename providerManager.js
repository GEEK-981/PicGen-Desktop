const Bottleneck = require('bottleneck');
const CircuitBreaker = require('opossum');
const { normalizeStrategy } = require('./failoverConfig');

const {
    canonicalModelName,
    inferProtocol,
    routeGroupFor,
    supportsOperation
} = require('./protocolRouter');

const DEFAULT_COOLDOWN_MS = 30000;
const DEFAULT_EWMA_MS = 60000;

function normalizeProvider(input = {}, index = 0) {
    return {
        ...input,
        id: String(input.id || `provider_${index}`),
        name: String(input.name || `API ${index + 1}`),
        url: String(input.baseUrl || input.url || '').trim(),
        baseUrl: String(input.baseUrl || input.url || '').trim(),
        apiKey: String(input.apiKey || '').trim(),
        apiKeys: Array.isArray(input.apiKeys) && input.apiKeys.length > 0
            ? input.apiKeys.map(String).filter(Boolean)
            : [String(input.apiKey || '').trim()].filter(Boolean),
        models: Array.isArray(input.models) ? input.models.map(String).filter(Boolean) : [],
        pricing: input.modelPricing || input.pricing || {},
        enabled: input.enabled !== false,
        maxConcurrent: Math.max(1, Math.min(8, Math.round(Number(input.maxConcurrent) || 1))),
        priority: Math.max(1, Math.min(100, Math.round(Number(input.priority) || 1))),
        order: index
    };
}

function retryAfterMs(error) {
    const headerValue = error?.retryAfter || error?.headers?.['retry-after'];
    if (headerValue == null || headerValue === '') return 0;
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(String(headerValue));
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

class ProviderManager {
    constructor(options = {}) {
        this.providers = [];
        this.runtime = new Map();
        this.managedProviderIds = new Set();
        this.availabilityListeners = new Set();
        this.cooldownTimer = null;
        this.closed = false;
        this.failoverThreshold = Math.max(1, Number(options.failoverThreshold) || 3);
        this.cooldownMs = Math.max(1000, Number(options.cooldownMs) || DEFAULT_COOLDOWN_MS);
        this.ewmaSeedMs = Math.max(1000, Number(options.ewmaSeedMs) || DEFAULT_EWMA_MS);
        this.enableFailover = options.enableFailover !== false; // 默认启用failover
        this.failoverOptions = {
            maxAttempts: Math.max(1, Number(options.maxFailoverAttempts) || 3), // 最多尝试3个供应商
            // Legacy flag retained for config compatibility; strategy controls priority use.
            respectPriority: options.respectPriority !== false,
            strategy: normalizeStrategy(options.strategy),
            selectedProviderId: String(options.selectedProviderId || ''),
            ...options.failoverOptions
        };
        this.failoverOptions.strategy = normalizeStrategy(this.failoverOptions.strategy);
    }

    syncProviders(presets = []) {
        const next = presets.map(normalizeProvider);
        const nextIds = new Set(next.map(provider => provider.id));
        for (const id of nextIds) this.managedProviderIds.add(id);

        for (const [id, state] of this.runtime) {
            if (nextIds.has(id)) continue;
            // In-flight direct tasks can overlap an asynchronous store refresh.
            // Keep their runtime alive; it is no longer selectable once removed from this.providers.
            state.retired = true;
        }

        this.providers = next;
        for (const provider of next) this._ensureRuntime(provider);
        this._notifyAvailability();

        // 数组顺序用于顺序策略，以及其他策略相同评分时的选择。
        const orderInfo = next
            .filter(p => p.enabled)
            .sort((a, b) => a.order - b.order)
            .map(p => p.name)
            .join(' > ');
        console.log(`[ProviderManager] 供应商顺序: ${orderInfo || '无可用供应商'}`);
        console.log(`[ProviderManager] Failover ${this.enableFailover ? '已启用' : '已禁用'}, 最大尝试次数: ${this.failoverOptions.maxAttempts}`);

        return this.getStatus();
    }

    _ensureRuntime(provider) {
        let state = this.runtime.get(provider.id);
        if (!state) {
            const limiter = new Bottleneck({ maxConcurrent: provider.maxConcurrent });
            const breaker = new CircuitBreaker(
                async ({ selectedProvider, work }) => work(selectedProvider),
                {
                    timeout: 0,
                    resetTimeout: this.cooldownMs,
                    errorThresholdPercentage: 50,
                    volumeThreshold: this.failoverThreshold,
                    errorFilter: error => error?.countsAsFailure === false || error?.name === 'AbortError'
                }
            );
            state = {
                limiter,
                breaker,
                active: 0,
                reserved: 0,
                consecutiveFailures: 0,
                successes: 0,
                failures: 0,
                ewmaLatencyMs: this.ewmaSeedMs,
                latencySamples: 0,
                cooldownUntil: 0,
                keyIndex: 0,
                lastError: '',
                lastUsedAt: 0
            };
            breaker.on('open', () => {
                state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + this.cooldownMs);
                this._scheduleCooldownWake();
            });
            breaker.on('halfOpen', () => {
                // A Retry-After deadline can outlast the breaker's reset timeout.
                this._notifyAvailability();
            });
            breaker.on('close', () => {
                state.cooldownUntil = 0;
                state.consecutiveFailures = 0;
                this._notifyAvailability();
            });
            breaker.on('error', () => {});
            this.runtime.set(provider.id, state);
        } else {
            if (state.maxConcurrent !== provider.maxConcurrent) {
                state.limiter.updateSettings({ maxConcurrent: provider.maxConcurrent });
            }
        }
        state.maxConcurrent = provider.maxConcurrent;
        state.retired = false;
        return state;
    }

    onAvailability(listener) {
        this.availabilityListeners.add(listener);
        return () => this.availabilityListeners.delete(listener);
    }

    _notifyAvailability() {
        if (this.closed) return;
        this._scheduleCooldownWake();
        for (const listener of this.availabilityListeners) listener();
    }

    _scheduleCooldownWake() {
        clearTimeout(this.cooldownTimer);
        this.cooldownTimer = null;
        if (this.closed) return;
        const now = Date.now();
        const deadlines = this.providers.filter(provider => provider.enabled)
            .map(provider => this.runtime.get(provider.id)?.cooldownUntil || 0)
            .filter(deadline => deadline > now);
        if (!deadlines.length) return;
        this.cooldownTimer = setTimeout(() => this._notifyAvailability(),
            Math.min(2147483647, Math.max(1, Math.min(...deadlines) - now)));
        this.cooldownTimer.unref?.();
    }

    _canUseDirectTask(task, excluded) {
        const id = task.providerId || '__direct__';
        return !!task.provider && !!task.apiKey && !excluded.has(id)
            && !this.managedProviderIds.has(id) && !task.providerConfig;
    }

    _matchingModel(provider, requestedModel) {
        return provider.models.find(model => canonicalModelName(model) === canonicalModelName(requestedModel)) || '';
    }

    candidatesFor(task = {}, excludedIds = []) {
        const excluded = new Set(excludedIds);
        const fixedMode = this.failoverOptions.strategy === 'fixed';
        const fixedProviderId = fixedMode ? String(this.failoverOptions.selectedProviderId || '') : '';
        const now = Date.now();
        const candidates = this.providers.flatMap(provider => {
            if (fixedMode && provider.id !== fixedProviderId) return [];
            if (!provider.enabled || !provider.url || !provider.apiKey || excluded.has(provider.id)) return [];
            const model = this._matchingModel(provider, task.model);
            if (!model || !supportsOperation(provider, model, task.operation || 'generate')) return [];
            const state = this._ensureRuntime(provider);
            const bypassBreaker = fixedMode && provider.id === fixedProviderId;
            if (!bypassBreaker && state.breaker.opened && !state.breaker.halfOpen) return [];
            if (!bypassBreaker && state.cooldownUntil > now) return [];
            return [{ provider, state, model, protocol: inferProtocol(provider, model), bypassBreaker }];
        });

        if (candidates.length > 0) return candidates;
        if (fixedMode && String(task.providerId || '') !== fixedProviderId) return [];
        if (!this._canUseDirectTask(task, excluded)) return [];

        const direct = normalizeProvider({
            id: task.providerId || '__direct__',
            name: task.providerName || 'Direct API',
            baseUrl: task.provider,
            apiKey: task.apiKey,
            models: [task.model],
            modelRouting: task.modelRouting || {},
            modelCapabilities: task.modelCapabilities || {},
            maxConcurrent: task.maxConcurrent || 1,
            priority: task.priority || 1,
            order: this.providers.length
        });
        const existing = this.providers.find(item => item.id === direct.id);
        if (!existing) this.providers.push(direct);
        const selected = existing || direct;
        if (!selected.enabled || !selected.url || !selected.apiKey) return [];
        if (!supportsOperation(selected, task.model, task.operation || 'generate')) return [];
        const state = this._ensureRuntime(selected);
        const bypassBreaker = fixedMode && selected.id === fixedProviderId;
        if (!bypassBreaker && (state.breaker.opened || state.cooldownUntil > now)) return [];
        return [{
            provider: selected,
            state,
            model: task.model,
            protocol: inferProtocol(selected, task.model),
            bypassBreaker
        }];
    }

    hasCompatibleProvider(task = {}, excludedIds = []) {
        const excluded = new Set(excludedIds);
        if (excluded.size >= this.failoverOptions.maxAttempts) return false;
        const fixedMode = this.failoverOptions.strategy === 'fixed';
        const fixedProviderId = fixedMode ? String(this.failoverOptions.selectedProviderId || '') : '';
        const managed = this.providers.some(provider => {
            if (fixedMode && provider.id !== fixedProviderId) return false;
            if (excluded.has(provider.id)) return false;
            if (!provider.enabled || !provider.url || !provider.apiKey) return false;
            const model = this._matchingModel(provider, task.model);
            return !!model && supportsOperation(provider, model, task.operation || 'generate');
        });
        if (managed) return true;
        if (fixedMode && String(task.providerId || '') !== fixedProviderId) return false;
        if (!this._canUseDirectTask(task, excluded)) return false;
        const existing = this.providers.find(provider => provider.id === (task.providerId || '__direct__'));
        if (existing && (!existing.enabled || !this._matchingModel(existing, task.model))) return false;
        const direct = normalizeProvider({
            id: task.providerId || '__direct__',
            baseUrl: task.provider,
            apiKey: task.apiKey,
            models: [task.model],
            modelRouting: task.modelRouting || {},
            modelCapabilities: task.modelCapabilities || {}
        });
        return supportsOperation(direct, task.model, task.operation || 'generate');
    }

    _hasFreeSlot(entry) {
        const limit = entry.state.breaker.halfOpen && !entry.bypassBreaker
            ? 1 : entry.provider.maxConcurrent;
        return (entry.state.active + entry.state.reserved) < limit;
    }

    _priceOf(entry) {
        const pricing = entry.provider.pricing || {};
        const raw = pricing[entry.model] ?? pricing[canonicalModelName(entry.model)];
        const price = typeof raw === 'object' && raw ? (raw.perImage ?? raw.price ?? raw.output) : raw;
        if (price == null || (typeof price === 'string' && !price.trim())
            || !['number', 'string'].includes(typeof price)) return Number.POSITIVE_INFINITY;
        const value = Number(price);
        // 没标价的排最后，否则"免费"的空配置会永远抢在真便宜的前面。
        return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
    }

    // Compare only eligible groups with free capacity; use configured order for ties.
    _compareByStrategy(left, right) {
        const strategy = this.failoverOptions.strategy;
        if (strategy === 'price') {
            const leftPrice = this._priceOf(left);
            const rightPrice = this._priceOf(right);
            if (leftPrice !== rightPrice) return leftPrice < rightPrice ? -1 : 1;
        }
        if (strategy === 'speed') {
            const a = left.state.latencySamples ? left.state.ewmaLatencyMs : Infinity;
            const b = right.state.latencySamples ? right.state.ewmaLatencyMs : Infinity;
            if (a !== b) return a < b ? -1 : 1;
        }
        if (strategy === 'balanced') {
            const leftLoad = (left.state.active + left.state.reserved) / left.provider.maxConcurrent;
            const rightLoad = (right.state.active + right.state.reserved) / right.provider.maxConcurrent;
            if (leftLoad !== rightLoad) return leftLoad - rightLoad;
        }
        if (['priority', 'balanced'].includes(strategy) && left.provider.priority !== right.provider.priority) {
            return left.provider.priority - right.provider.priority;
        }
        return left.provider.order - right.provider.order;
    }

    reserve(task = {}, excludedIds = []) {
        if (this.closed) return null;
        const candidates = this.candidatesFor(task, excludedIds).filter(entry => this._hasFreeSlot(entry));
        this._scheduleCooldownWake();
        if (candidates.length === 0) return null;
        const isFailover = excludedIds.length > 0;

        // 检查是否超过最大failover尝试次数
        if (isFailover && excludedIds.length >= this.failoverOptions.maxAttempts) {
            console.log(`[ProviderManager] 已达到最大failover尝试次数(${this.failoverOptions.maxAttempts})，停止尝试`);
            return null;
        }

        candidates.sort((left, right) => this._compareByStrategy(left, right));

        const selected = candidates[0];
        selected.state.reserved += 1;
        selected.state.lastUsedAt = Date.now();

        if (isFailover) {
            console.log(`[ProviderManager] Failover选择供应商: ${selected.provider.name} (顺序${selected.provider.order + 1}, 尝试${excludedIds.length + 1}/${this.failoverOptions.maxAttempts})`);
        } else {
            console.log(`[ProviderManager] 选择供应商: ${selected.provider.name} (顺序${selected.provider.order + 1})`);
        }

        return {
            providerId: selected.provider.id,
            providerName: selected.provider.name,
            provider: selected.provider.url,
            apiKey: this.getNextApiKey(selected.provider.id) || selected.provider.apiKey,
            model: selected.model,
            protocol: selected.protocol,
            routeGroup: routeGroupFor(selected.provider, selected.model),
            bypassBreaker: selected.bypassBreaker === true,
            _managed: this.managedProviderIds.has(selected.provider.id),
            _state: selected.state,
            _phase: 'reserved',
            _released: false
        };
    }

    async executeReservation(reservation, work, options = {}) {
        if (!reservation || typeof work !== 'function') throw new Error('Invalid provider reservation');
        if (reservation._released || reservation._scheduled) throw new Error('Provider reservation was already consumed');
        reservation._scheduled = true;
        const state = reservation._state;
        return state.limiter.schedule(async () => {
            if (options.signal?.aborted) {
                const error = new Error('Task cancelled before request submission');
                error.name = 'AbortError';
                error.countsAsFailure = false;
                throw error;
            }
            const current = this.getProvider(reservation.providerId);
            // Startup store hydration may retire a legacy/direct runtime while its
            // already accepted request is being dispatched. Managed IDs still obey
            // the current store and cannot be revived from their task snapshot.
            const managed = reservation._managed || this.managedProviderIds.has(reservation.providerId);
            if ((managed ? !current?.enabled || state.retired : current?.enabled === false)
                || (!reservation.bypassBreaker && (state.cooldownUntil > Date.now()
                    || (state.breaker.opened && !state.breaker.halfOpen)))) {
                const error = new Error('Provider became unavailable before request submission');
                error.code = 'PROVIDER_UNAVAILABLE';
                error.retryable = true;
                error.countsAsFailure = false;
                throw error;
            }
            state.reserved = Math.max(0, state.reserved - 1);
            state.active += 1;
            reservation._phase = 'active';
            const startedAt = Date.now();
            try {
                if (reservation.bypassBreaker) {
                    state.breaker.close();
                    state.cooldownUntil = 0;
                }
                const result = reservation.bypassBreaker
                    ? await work(reservation)
                    : await state.breaker.fire({ selectedProvider: reservation, work });
                this.recordSuccess(reservation.providerId, Date.now() - startedAt);
                return result;
            } catch (error) {
                if (reservation.bypassBreaker) {
                    this.recordBypassedFailure(reservation.providerId, error);
                } else {
                    this.recordFailure(reservation.providerId, error);
                }
                throw error;
            }
        }).finally(() => this.releaseReservation(reservation));
    }

    releaseReservation(reservation) {
        if (!reservation || reservation._released) return;
        const counter = reservation._phase === 'active' ? 'active' : 'reserved';
        reservation._state[counter] = Math.max(0, reservation._state[counter] - 1);
        reservation._phase = 'released';
        reservation._released = true;
        reservation.apiKey = '';
        this._notifyAvailability();
    }

    recordSuccess(providerId, latencyMs = 0) {
        const state = this.runtime.get(providerId);
        if (!state) return;
        state.successes += 1;
        state.consecutiveFailures = 0;
        state.lastError = '';
        if (Number.isFinite(latencyMs) && latencyMs > 0) {
            state.ewmaLatencyMs = state.latencySamples ? Math.round((state.ewmaLatencyMs * 0.75) + (latencyMs * 0.25)) : Math.round(latencyMs);
            state.latencySamples += 1;
        }
    }

    recordFailure(providerId, error = null) {
        if (error?.name === 'AbortError' || error?.countsAsFailure === false) {
            return { failover: false, nextProvider: null };
        }
        const state = this.runtime.get(providerId);
        if (!state) return { failover: false, nextProvider: null };
        state.failures += 1;
        state.lastError = String(error?.message || error || '').slice(0, 240);
        if (error?.countsAsFailure !== false) state.consecutiveFailures += 1;
        const cooldown = Math.max(retryAfterMs(error), this.cooldownMs);
        if (error?.status === 429 || state.consecutiveFailures >= this.failoverThreshold) {
            state.cooldownUntil = Date.now() + cooldown;
            this._scheduleCooldownWake();
        }
        const nextProvider = this.getNextActiveProvider(providerId);
        return { failover: !!nextProvider, nextProvider };
    }

    recordBypassedFailure(providerId, error = null) {
        if (error?.name === 'AbortError' || error?.countsAsFailure === false) return;
        const state = this.runtime.get(providerId);
        if (!state) return;
        state.failures += 1;
        state.lastError = String(error?.message || error || '').slice(0, 240);
        state.consecutiveFailures = 0;
        state.cooldownUntil = 0;
        state.breaker.close();
        this._notifyAvailability();
    }

    shouldFailover(error) {
        if (!this.enableFailover) {
            console.log('[ProviderManager] Failover已禁用，不会切换供应商');
            return false;
        }
        if (!error || error.ambiguous || error.name === 'AbortError') return false;
        const shouldFailover = Number(error.status) > 0 || !!error.retryable;
        if (shouldFailover) {
            console.log(`[ProviderManager] 错误可failover: status=${error.status}, retryable=${error.retryable}`);
        }
        return shouldFailover;
    }

    getNextActiveProvider(currentId) {
        const now = Date.now();
        const currentIndex = this.providers.findIndex(provider => provider.id === currentId);
        const ordered = currentIndex >= 0
            ? [...this.providers.slice(currentIndex + 1), ...this.providers.slice(0, currentIndex)]
            : this.providers;
        return ordered.find(provider => {
            if (provider.id === currentId || !provider.enabled) return false;
            const state = this.runtime.get(provider.id);
            return state && !state.breaker.opened && state.cooldownUntil <= now;
        }) || null;
    }

    getProvider(providerId) {
        return this.providers.find(provider => provider.id === providerId) || null;
    }

    resetProvider(providerId) {
        const state = this.runtime.get(providerId);
        if (!state) return;
        state.consecutiveFailures = 0;
        state.cooldownUntil = 0;
        state.lastError = '';
        state.breaker.close();
        this._notifyAvailability();
    }

    resetAll() {
        for (const provider of this.providers) this.resetProvider(provider.id);
    }

    setFailoverEnabled(enabled) {
        this.enableFailover = !!enabled;
        console.log(`[ProviderManager] Failover已${this.enableFailover ? '启用' : '禁用'}`);
        return this.getFailoverConfig();
    }

    setFailoverOptions(options = {}) {
        if (options.maxAttempts != null) {
            this.failoverOptions.maxAttempts = Math.max(1, Math.min(10, Number(options.maxAttempts)));
        }
        if (options.respectPriority != null) {
            this.failoverOptions.respectPriority = !!options.respectPriority;
        }
        if (options.strategy != null) {
            this.failoverOptions.strategy = normalizeStrategy(options.strategy);
        }
        if (options.selectedProviderId != null) {
            this.failoverOptions.selectedProviderId = String(options.selectedProviderId);
        }
        console.log(`[ProviderManager] Failover配置已更新:`, this.failoverOptions);
        this._notifyAvailability();
        return this.getFailoverConfig();
    }

    getFailoverConfig() {
        return {
            enabled: this.enableFailover,
            maxAttempts: this.failoverOptions.maxAttempts,
            respectPriority: this.failoverOptions.respectPriority,
            strategy: this.failoverOptions.strategy,
            selectedProviderId: this.failoverOptions.selectedProviderId,
            failoverThreshold: this.failoverThreshold,
            cooldownMs: this.cooldownMs
        };
    }

    getNextApiKey(providerId) {
        const provider = this.getProvider(providerId);
        const state = this.runtime.get(providerId);
        if (!provider || !state || provider.apiKeys.length === 0) return null;
        const key = provider.apiKeys[state.keyIndex % provider.apiKeys.length];
        state.keyIndex += 1;
        return key;
    }

    _selectableRouteProviders(sourceProvider, model, now = Date.now()) {
        return this.providers.filter(provider => {
            if (!provider.enabled || !provider.url || !provider.apiKey) return false;
            const matchingModel = this._matchingModel(provider, model);
            if (!matchingModel || !supportsOperation(provider, matchingModel, 'generate')) return false;
            const state = this._ensureRuntime(provider);
            if (state.breaker.opened && !state.breaker.halfOpen) return false;
            return state.cooldownUntil <= now;
        });
    }

    _healthRating(provider, now = Date.now()) {
        const state = this._ensureRuntime(provider);
        const models = provider.models || [];
        const routeAvailability = models.map(model => {
            const candidates = this._selectableRouteProviders(provider, model, now);
            return {
                model,
                available: candidates.length > 0,
                direct: candidates.some(candidate => candidate.id === provider.id),
                fallback: candidates.some(candidate => candidate.id !== provider.id)
            };
        });
        const routeCount = routeAvailability.length;
        const availableRouteCount = routeAvailability.filter(route => route.available).length;
        const directRouteCount = routeAvailability.filter(route => route.direct).length;
        const fallbackRouteCount = routeAvailability.filter(route => route.fallback).length;
        const unavailableRouteCount = routeCount - availableRouteCount;
        const coolingDown = state.cooldownUntil > now;
        const circuit = state.breaker.opened ? 'open' : state.breaker.halfOpen ? 'half-open' : 'closed';

        let rating = 'available';
        let ratingLabel = '可用';
        let ratingReason = `全部 ${routeCount} 个模型可用`;

        if (!provider.enabled) {
            rating = 'failed';
            ratingLabel = '故障';
            ratingReason = '提供商已停用';
        } else if (!provider.url || !provider.apiKey || routeCount === 0) {
            rating = 'failed';
            ratingLabel = '故障';
            ratingReason = '配置不完整，需要 Base URL、API Key 和至少一个模型';
        } else if (availableRouteCount === 0) {
            rating = 'failed';
            ratingLabel = '故障';
            ratingReason = `0/${routeCount} 个模型可用`;
        } else if (circuit !== 'closed' || coolingDown || state.consecutiveFailures > 0
            || directRouteCount < routeCount || unavailableRouteCount > 0) {
            rating = 'degraded';
            ratingLabel = '降级';
            const routeSummary = `${availableRouteCount}/${routeCount} 个模型可用`;
            if (coolingDown) {
                ratingReason = `本提供商冷却中，${routeSummary}`;
            } else if (circuit === 'half-open') {
                ratingReason = `本提供商正在探测恢复，${routeSummary}`;
            } else if (state.consecutiveFailures > 0) {
                ratingReason = `最近连续失败 ${state.consecutiveFailures} 次，${routeSummary}`;
            } else {
                ratingReason = `本提供商的部分模型需要切换供应商，${routeSummary}`;
            }
        }

        return {
            id: provider.id,
            name: provider.name,
            rating,
            ratingLabel,
            ratingReason,
            routeCount,
            availableRouteCount,
            directRouteCount,
            fallbackRouteCount,
            unavailableRouteCount,
            circuit,
            cooldownUntil: state.cooldownUntil,
            consecutiveFailures: state.consecutiveFailures,
            lastError: state.lastError
        };
    }

    getHealthRatings() {
        const now = Date.now();
        return this.providers.map(provider => this._healthRating(provider, now));
    }

    getRanking(model, strategy) {
        const entries = this.providers.filter(provider => provider.enabled && provider.url && provider.apiKey)
            .map(provider => ({ provider, state: this._ensureRuntime(provider), model: this._matchingModel(provider, model) }))
            .filter(entry => entry.model && supportsOperation(entry.provider, entry.model, 'generate'));
        entries.sort((a, b) => {
            const left = strategy === 'price' ? this._priceOf(a) : (a.state.latencySamples ? a.state.ewmaLatencyMs : Infinity);
            const right = strategy === 'price' ? this._priceOf(b) : (b.state.latencySamples ? b.state.ewmaLatencyMs : Infinity);
            return left === right ? a.provider.order - b.provider.order : left < right ? -1 : 1;
        });
        return entries.slice(0, 5).map(({ provider, state, model: matched }) => ({
            id: provider.id, name: provider.name, model: matched,
            price: Number.isFinite(this._priceOf({ provider, model: matched })) ? this._priceOf({ provider, model: matched }) : null,
            latencyMs: state.latencySamples ? state.ewmaLatencyMs : null,
            samples: state.latencySamples,
            available: !state.breaker.opened && state.cooldownUntil <= Date.now(),
            busy: state.active + state.reserved >= provider.maxConcurrent
        }));
    }

    getStatus() {
        const now = Date.now();
        const healthById = new Map(this.providers.map(provider => {
            const health = this._healthRating(provider, now);
            return [provider.id, health];
        }));
        return this.providers.map(provider => {
            const state = this._ensureRuntime(provider);
            const coolingDown = state.cooldownUntil > now;
            const health = healthById.get(provider.id);
            return {
                id: provider.id,
                name: provider.name,
                enabled: provider.enabled,
                isActive: provider.enabled && !state.breaker.opened && !coolingDown,
                circuit: state.breaker.opened ? 'open' : state.breaker.halfOpen ? 'half-open' : 'closed',
                consecutiveFailures: state.consecutiveFailures,
                active: state.active,
                reserved: state.reserved,
                maxConcurrent: provider.maxConcurrent,
                ewmaLatencyMs: state.ewmaLatencyMs,
                cooldownUntil: state.cooldownUntil,
                lastError: state.lastError,
                rating: health.rating,
                ratingLabel: health.ratingLabel,
                ratingReason: health.ratingReason,
                routeCount: health.routeCount,
                availableRouteCount: health.availableRouteCount,
                directRouteCount: health.directRouteCount,
                fallbackRouteCount: health.fallbackRouteCount,
                unavailableRouteCount: health.unavailableRouteCount
            };
        });
    }

    close() {
        this.closed = true;
        clearTimeout(this.cooldownTimer);
        this.availabilityListeners.clear();
        for (const state of this.runtime.values()) {
            state.breaker.shutdown();
            state.limiter.stop({ dropWaitingJobs: true }).catch(() => {});
        }
        this.runtime.clear();
    }
}

module.exports = ProviderManager;
