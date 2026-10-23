const { generateImage } = require('./apiService');

class TaskQueue {
    constructor(options = {}) {
        this.tasks = new Map();
        this.activeBySequence = new Map();
        this.pendingBySequence = new Map();
        this.sequenceOrder = [];
        this.roundRobinCursor = 0;
        this.activeTasks = new Set();
        // Per-sequence capacity must not silently cap a batch at three. The
        // user-facing global limit (1–64) and provider capacities decide the
        // effective parallelism unless a caller supplies an explicit guard.
        this.maxConcurrent = Math.max(1, Number(options.maxConcurrentPerSequence) || 64);
        this.maxGlobalConcurrent = Math.max(1, Math.min(64, Number(options.maxGlobalConcurrent) || 12));
        this.onTaskEvent = options.onTaskEvent || (() => {});
        this.onError = typeof options.onError === 'function' ? options.onError : (() => {});
        this.providerManager = options.providerManager || null;
        this.resultStore = typeof options.resultStore === 'function' ? options.resultStore : null;
        this.generateImage = options.generateImage || generateImage;
        this.drainScheduled = false;
        this.closed = false;
        this.unsubscribeAvailability = this.providerManager?.onAvailability?.(() => this._scheduleDrain());
    }

    setMaxGlobalConcurrent(value) {
        const next = Number(value);
        if (!Number.isFinite(next)) return this.maxGlobalConcurrent;
        this.maxGlobalConcurrent = Math.max(1, Math.min(64, Math.round(next)));
        this._scheduleDrain();
        return this.maxGlobalConcurrent;
    }

    enqueue(taskData) {
        if (this.closed) throw new Error('Task queue is closed');
        const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const batchTotal = Number(taskData.batchTotal);
        const batchIndex = Number(taskData.batchIndex);
        const task = {
            id: taskId,
            sequenceId: taskData.sequenceId || 'default',
            sequenceName: taskData.sequenceName || taskData.sequenceId || 'default',
            batchId: taskData.batchId || '',
            batchTotal: Number.isFinite(batchTotal) && batchTotal > 0 ? batchTotal : 1,
            batchIndex: Number.isFinite(batchIndex) && batchIndex >= 0 ? batchIndex : 0,
            status: 'pending',
            phase: 'queued',
            operation: taskData.operation || (taskData.maskImage ? 'mask-edit' : 'generate'),
            prompt: String(taskData.prompt || ''),
            ratio: taskData.ratio || '1:1',
            imageSize: taskData.imageSize || '1K',
            provider: taskData.provider,
            apiKey: taskData.apiKey,
            model: taskData.model,
            protocol: taskData.protocol || 'auto',
            routeGroup: taskData.routeGroup || '',
            referenceImages: taskData.referenceImages || [],
            maskImage: taskData.maskImage || null,
            generationConfig: {
                ...(taskData.generationConfig || {}),
                stream: false,
                disableStream: true
            },
            providerName: taskData.providerName || '',
            providerId: taskData.providerId || '',
            providerConfig: taskData.providerConfig || null,
            modelPricing: taskData.modelPricing || 0,
            result: null,
            error: null,
            progress: null,
            attempts: [],
            abortController: null,
            createdAt: Date.now(),
            startedAt: null,
            completedAt: null
        };

        this.tasks.set(taskId, task);
        if (!this.pendingBySequence.has(task.sequenceId)) {
            this.pendingBySequence.set(task.sequenceId, []);
            this.sequenceOrder.push(task.sequenceId);
        }
        this.pendingBySequence.get(task.sequenceId).push(taskId);
        if (!this.activeBySequence.has(task.sequenceId)) this.activeBySequence.set(task.sequenceId, new Set());

        this.onTaskEvent('task:created', this._safeTask(task));
        this._scheduleDrain();
        return taskId;
    }

    cancel(taskId) {
        const task = this.tasks.get(taskId);
        if (!task || !['pending', 'running'].includes(task.status)) return false;
        // The result has already been generated. Finish its atomic persistence and
        // publish completion instead of leaving a saved image marked cancelled.
        if (task.phase === 'saving') return false;
        task.status = 'cancelled';
        task.phase = 'cancelled';
        task.completedAt = Date.now();
        if (task.abortController) task.abortController.abort();
        const pending = this.pendingBySequence.get(task.sequenceId);
        if (pending) {
            const index = pending.indexOf(taskId);
            if (index >= 0) pending.splice(index, 1);
        }
        if (!this.activeTasks.has(task.id)) this._releaseTaskInputs(task);
        this.onTaskEvent('task:cancelled', this._safeTask(task));
        this._scheduleDrain();
        return true;
    }

    cancelBySequence(sequenceId) {
        let count = 0;
        for (const task of this.tasks.values()) {
            if (task.sequenceId === sequenceId && this.cancel(task.id)) count += 1;
        }
        return count;
    }

    getTask(taskId) {
        const task = this.tasks.get(taskId);
        return task ? this._fullTask(task) : null;
    }

    listTasks(filters = {}) {
        const results = [];
        for (const task of this.tasks.values()) {
            if (filters.sequenceId && task.sequenceId !== filters.sequenceId) continue;
            if (filters.status) {
                const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
                if (!statuses.includes(task.status)) continue;
            }
            results.push(this._safeTask(task));
        }
        return results.sort((left, right) => right.createdAt - left.createdAt);
    }

    cleanup(maxAge = 3600000) {
        const now = Date.now();
        for (const [taskId, task] of this.tasks) {
            if (['completed', 'failed', 'cancelled'].includes(task.status)
                && task.completedAt && now - task.completedAt > maxAge) {
                this.tasks.delete(taskId);
            }
        }
    }

    _scheduleDrain() {
        if (this.closed || this.drainScheduled) return;
        this.drainScheduled = true;
        queueMicrotask(() => {
            this.drainScheduled = false;
            if (!this.closed) this._drain();
        });
    }

    _nextDispatchableTask() {
        if (this.sequenceOrder.length === 0) return null;
        for (let offset = 0; offset < this.sequenceOrder.length; offset += 1) {
            const index = (this.roundRobinCursor + offset) % this.sequenceOrder.length;
            const sequenceId = this.sequenceOrder[index];
            const active = this.activeBySequence.get(sequenceId) || new Set();
            const pending = this.pendingBySequence.get(sequenceId) || [];
            if (active.size >= this.maxConcurrent || pending.length === 0) continue;

            while (pending.length > 0) {
                const taskId = pending[0];
                const task = this.tasks.get(taskId);
                if (task?.status === 'pending') {
                    this.roundRobinCursor = (index + 1) % this.sequenceOrder.length;
                    return task;
                }
                pending.shift();
            }
        }
        return null;
    }

    _drain() {
        let examined = 0;
        const maxExamined = [...this.pendingBySequence.values()].reduce((sum, pending) => sum + pending.length, 0);
        while (this.activeTasks.size < this.maxGlobalConcurrent && examined < maxExamined) {
            const task = this._nextDispatchableTask();
            if (!task) break;
            examined += 1;

            const reservation = this.providerManager
                ? this.providerManager.reserve(task, task._excludedProviderIds || [])
                : this._directReservation(task);
            if (!reservation) {
                if (this.providerManager && !this.providerManager.hasCompatibleProvider(task, task._excludedProviderIds || [])) {
                    this.pendingBySequence.get(task.sequenceId)?.shift();
                    task.status = 'failed';
                    task.phase = 'failed';
                    task.completedAt = Date.now();
                    task.error = task._finalError?.message || '当前没有支持此操作的可用供应商路由';
                    this.onTaskEvent('task:failed', this._safeTask(task));
                    this._reportFailure(task, task._finalError || new Error(task.error));
                    this._releaseTaskInputs(task);
                    continue;
                }
                const pending = this.pendingBySequence.get(task.sequenceId);
                if (pending?.[0] === task.id) pending.push(pending.shift());
                continue;
            }

            this.pendingBySequence.get(task.sequenceId)?.shift();
            this.activeTasks.add(task.id);
            this.activeBySequence.get(task.sequenceId).add(task.id);
            task._reservation = reservation;
            this._executeTask(task);
        }
    }

    _directReservation(task) {
        if (!task.provider || !task.apiKey) return null;
        return {
            providerId: task.providerId || '__direct__',
            providerName: task.providerName || 'Direct API',
            provider: task.provider,
            apiKey: task.apiKey,
            model: task.model,
            protocol: task.protocol || 'auto',
            routeGroup: task.routeGroup || ''
        };
    }

    async _executeTask(task) {
        const firstReservation = task._reservation;
        delete task._reservation;
        task.status = 'running';
        task.phase = 'routing';
        task.startedAt ||= Date.now();
        task.abortController = new AbortController();
        this.onTaskEvent('task:started', this._safeTask(task));

        let reservation = firstReservation;
        let result = null;
        let finalError = null;
        const excludedProviderIds = task._excludedProviderIds || [];

        try {
            let attemptIndex = task.attempts.length;
            while (reservation) {
                const attempt = {
                    index: attemptIndex + 1,
                    providerId: reservation.providerId,
                    providerName: reservation.providerName,
                    model: reservation.model,
                    protocol: reservation.protocol,
                    routeGroup: reservation.routeGroup,
                    startedAt: Date.now(),
                    completedAt: null,
                    status: 'running',
                    error: ''
                };
                task.attempts.push(attempt);
                task.providerId = reservation.providerId;
                task.providerName = reservation.providerName;
                task.model = reservation.model;
                task.protocol = reservation.protocol;
                task.routeGroup = reservation.routeGroup;
                task.phase = attemptIndex === 0 ? 'requesting' : 'failover';
                task.progress = null;
                this.onTaskEvent('task:routed', this._safeTask(task));

                try {
                    const run = selected => this.generateImage({
                        provider: selected.provider,
                        apiKey: selected.apiKey,
                        model: selected.model,
                        protocol: selected.protocol,
                        operation: task.operation,
                        prompt: task.prompt,
                        ratio: task.ratio,
                        imageSize: task.imageSize,
                        referenceImages: task.referenceImages,
                        maskImage: task.maskImage,
                        generationConfig: task.generationConfig,
                        signal: task.abortController.signal
                    }, {
                        onProgress: progress => {
                            if (task.status === 'cancelled') return;
                            task.progress = this._safeProgress(progress);
                            task.phase = progress?.phase || task.phase;
                            this.onTaskEvent('task:progress', this._safeTask(task));
                        }
                    });
                    result = this.providerManager
                        ? await this.providerManager.executeReservation(reservation, run, { signal: task.abortController.signal })
                        : await run(reservation);
                    attempt.status = 'completed';
                    attempt.completedAt = Date.now();
                    if (this.providerManager && !this.closed) {
                        this.onTaskEvent('provider:status', this.providerManager.getStatus());
                    }
                    break;
                } catch (error) {
                    attempt.status = task.status === 'cancelled' ? 'cancelled' : 'failed';
                    attempt.completedAt = Date.now();
                    attempt.error = error.message;
                    finalError = error;
                    excludedProviderIds.push(reservation.providerId);
                    if (this.providerManager && !this.closed) {
                        this.onTaskEvent('provider:status', this.providerManager.getStatus());
                    }
                    const canFailover = this.providerManager?.shouldFailover(error)
                        && task.status !== 'cancelled';
                    if (!canFailover) break;
                    reservation = this.providerManager.reserve(task, excludedProviderIds);
                    if (reservation) {
                        this.onTaskEvent('provider:failover', {
                            from: attempt.providerName,
                            to: reservation.providerName,
                            fromId: attempt.providerId,
                            toId: reservation.providerId,
                            taskId: task.id
                        });
                    } else if (this.providerManager.hasCompatibleProvider?.(task, excludedProviderIds)
                        && typeof this.providerManager.onAvailability === 'function') {
                        // A compatible fallback is occupied or cooling down. Keep its wait
                        // in the central queue, without consuming global execution capacity.
                        task._excludedProviderIds = excludedProviderIds;
                        task._finalError = finalError;
                        task.status = 'pending';
                        task.phase = 'queued';
                        this.pendingBySequence.get(task.sequenceId).push(task.id);
                        this.onTaskEvent('task:created', this._safeTask(task));
                        return;
                    }
                    attemptIndex += 1;
                }
            }

            if (task.status === 'cancelled') return;
            if (!result) throw finalError || new Error('没有可用的图片供应商');

            task.phase = 'saving';
            this.onTaskEvent('task:progress', this._safeTask(task));
            task.result = this.resultStore
                ? await this.resultStore(task, result)
                : {
                    base64: result.base64,
                    mimeType: result.mimeType,
                    thoughtText: result.thoughtText || ''
                 };
            if (task.status === 'cancelled') return;
            task.status = 'completed';
            task.phase = 'completed';
            task.completedAt = Date.now();
            this.onTaskEvent('task:completed', this._safeTask(task));
            this.onTaskEvent('cost:update', {
                taskId: task.id,
                model: task.model,
                providerName: task.providerName
            });
        } catch (error) {
            if (task.status !== 'cancelled') {
                task.status = 'failed';
                task.phase = error?.ambiguous ? 'outcome-uncertain' : 'failed';
                task.completedAt = Date.now();
                task.error = error.message;
                this.onTaskEvent('task:failed', this._safeTask(task));
                this._reportFailure(task, error);
                console.error(`[TaskQueue] failed: ${task.id}`, error);
            }
        } finally {
            this.providerManager?.releaseReservation?.(reservation);
            task.abortController = null;
            if (['completed', 'failed', 'cancelled'].includes(task.status)) this._releaseTaskInputs(task);
            this.activeTasks.delete(task.id);
            this.activeBySequence.get(task.sequenceId)?.delete(task.id);
            if (this.providerManager && !this.closed) {
                this.onTaskEvent('provider:status', this.providerManager.getStatus());
            }
            this._scheduleDrain();
        }
    }

    _releaseTaskInputs(task) {
        task.referenceImages = [];
        task.maskImage = null;
        task.providerConfig = null;
        task.apiKey = '';
        task.provider = '';
        task.generationConfig = {};
        delete task._excludedProviderIds;
        delete task._finalError;
        delete task._reservation;
    }

    close() {
        this.closed = true;
        this.unsubscribeAvailability?.();
        for (const task of this.tasks.values()) this.cancel(task.id);
    }

    _safeTask(task) {
        return {
            id: task.id,
            sequenceId: task.sequenceId,
            sequenceName: task.sequenceName,
            batchId: task.batchId,
            batchTotal: task.batchTotal,
            batchIndex: task.batchIndex,
            status: task.status,
            phase: task.phase,
            operation: task.operation,
            prompt: task.prompt,
            ratio: task.ratio,
            imageSize: task.imageSize,
            model: task.model,
            protocol: task.protocol,
            routeGroup: task.routeGroup,
            providerName: task.providerName,
            providerId: task.providerId,
            modelPricing: task.modelPricing,
            error: task.error,
            progress: task.progress,
            attempts: task.attempts.map(attempt => ({ ...attempt })),
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            result: task.result ? {
                id: task.result.id || task.id,
                url: task.result.url || '',
                filePath: task.result.filePath || '',
                fileName: task.result.fileName || '',
                mimeType: task.result.mimeType || 'image/png',
                createdAt: Number(task.result.createdAt || task.completedAt || 0),
                width: Number(task.result.width || 0),
                height: Number(task.result.height || 0),
                fileSize: Number(task.result.fileSize || 0),
                sourceWidth: Number(task.result.sourceWidth || 0),
                sourceHeight: Number(task.result.sourceHeight || 0),
                requestedWidth: Number(task.result.requestedWidth || 0),
                requestedHeight: Number(task.result.requestedHeight || 0),
                dimensionAdjusted: !!task.result.dimensionAdjusted,
                thoughtText: task.result.thoughtText || ''
            } : null
        };
    }

    _reportFailure(task, error) {
        const report = {
            source: 'generation',
            title: task.operation === 'mask-edit' ? '局部编辑失败' : '图片生成失败',
            message: error?.message || task.error || '未知错误',
            error,
            code: error?.code || '',
            httpStatus: Number(error?.status) || 0,
            providerId: task.providerId || '',
            providerName: task.providerName || '',
            model: task.model || '',
            taskId: task.id,
            sequenceId: task.sequenceId,
            operation: task.operation,
            phase: task.phase,
            protocol: task.protocol,
            details: {
                ratio: task.ratio,
                imageSize: task.imageSize,
                attempts: task.attempts.map(attempt => ({
                    index: attempt.index,
                    providerId: attempt.providerId,
                    providerName: attempt.providerName,
                    model: attempt.model,
                    protocol: attempt.protocol,
                    status: attempt.status,
                    error: attempt.error,
                    startedAt: attempt.startedAt,
                    completedAt: attempt.completedAt
                }))
            }
        };
        try {
            Promise.resolve(this.onError(report)).catch(() => {});
        } catch {
            // Logging must never change task completion behavior.
        }
    }

    _fullTask(task) {
        const safe = this._safeTask(task);
        if (task.result?.base64) safe.result.base64 = task.result.base64;
        return safe;
    }

    _safeProgress(progress) {
        if (!progress || typeof progress !== 'object') return null;
        const safe = { ...progress };
        if (safe.preview) {
            safe.preview = {
                mimeType: safe.preview.mimeType || 'image/png',
                hasBase64: !!safe.preview.base64
            };
        }
        return safe;
    }
}

module.exports = TaskQueue;
