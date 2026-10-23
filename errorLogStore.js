const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 1600;
const MAX_STACK_LENGTH = 8000;
const MAX_CONTEXT_STRING_LENGTH = 2400;
const ALLOWED_SOURCES = new Set([
    'generation',
    'provider',
    'prompt',
    'network',
    'storage',
    'renderer',
    'system'
]);

const SECRET_KEY_PATTERN = /(api.?key|authorization|token|secret|password|cookie)/i;
const BINARY_KEY_PATTERN = /(base64|mask|reference|binary|buffer|body|image(?:data|bytes|blob)?s?$)/i;
const PROMPT_KEY_PATTERN = /(^|_)(prompt|instruction|systemPrompt)($|_)/i;

function clampText(value, maxLength) {
    const text = String(value ?? '');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function sanitizeString(value, maxLength = MAX_CONTEXT_STRING_LENGTH) {
    const sanitized = String(value ?? '')
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer ***')
        .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, 'sk-***')
        .replace(/([?&](?:key|api_key|token|access_token|authorization)=)[^&#\s]+/gi, '$1***')
        .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[image omitted]')
        .replace(/[a-z0-9+/=]{256,}/gi, '[binary omitted]');
    return clampText(sanitized, maxLength);
}

function sanitizeValue(value, key = '', depth = 0) {
    if (SECRET_KEY_PATTERN.test(key)) return '[redacted]';
    if (BINARY_KEY_PATTERN.test(key) || PROMPT_KEY_PATTERN.test(key)) return '[omitted]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return sanitizeString(value);
    if (depth >= 4) return '[truncated]';
    if (Array.isArray(value)) {
        return value.slice(0, 20).map(item => sanitizeValue(item, '', depth + 1));
    }
    if (typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .slice(0, 60)
            .map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey, depth + 1)]));
    }
    return sanitizeString(value);
}

function normalizedFingerprintText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/task_[a-z0-9_]+/g, 'task_*')
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, 'uuid-*')
        .replace(/\b\d{6,}\b/g, '#');
}

function createFingerprint(entry) {
    const material = [
        entry.source,
        entry.title,
        normalizedFingerprintText(entry.message),
        entry.code,
        entry.httpStatus,
        entry.providerId,
        entry.model,
        entry.operation
    ].join('|');
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 24);
}

function normalizeEntry(input = {}, now = Date.now()) {
    const error = input.error instanceof Error ? input.error : null;
    const source = ALLOWED_SOURCES.has(input.source) ? input.source : 'system';
    const message = sanitizeString(input.message || error?.message || input.error || '未知错误', MAX_MESSAGE_LENGTH);
    const timestamp = Number(input.timestamp) || now;
    const entry = {
        id: `error_${timestamp}_${crypto.randomBytes(4).toString('hex')}`,
        timestamp,
        lastSeenAt: timestamp,
        occurrences: 1,
        source,
        title: sanitizeString(input.title || '运行错误', 120),
        message,
        code: sanitizeString(input.code || error?.code || '', 120),
        httpStatus: Number(input.httpStatus ?? error?.status) || 0,
        providerId: sanitizeString(input.providerId || '', 160),
        providerName: sanitizeString(input.providerName || '', 160),
        model: sanitizeString(input.model || '', 200),
        taskId: sanitizeString(input.taskId || '', 180),
        sequenceId: sanitizeString(input.sequenceId || '', 180),
        requestId: sanitizeString(input.requestId || '', 180),
        operation: sanitizeString(input.operation || '', 100),
        phase: sanitizeString(input.phase || '', 100),
        protocol: sanitizeString(input.protocol || '', 100),
        stack: sanitizeString(input.stack || error?.stack || '', MAX_STACK_LENGTH),
        details: sanitizeValue(input.details || input.context || {}, 'details')
    };
    entry.fingerprint = createFingerprint(entry);
    return entry;
}

function parseStore(raw) {
    const parsed = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
    return Array.isArray(parsed) ? parsed : parsed.entries;
}

class ErrorLogStore {
    constructor(options = {}) {
        if (!options.filePath) throw new Error('Error log file path is required');
        this.filePath = path.resolve(options.filePath);
        this.maxEntries = Math.max(10, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES);
        this.maxAgeMs = Math.max(60000, Number(options.maxAgeMs) || DEFAULT_MAX_AGE_MS);
        this.dedupeWindowMs = Math.max(0, Number.isFinite(Number(options.dedupeWindowMs))
            ? Number(options.dedupeWindowMs)
            : DEFAULT_DEDUPE_WINDOW_MS);
        this.now = typeof options.now === 'function' ? options.now : Date.now;
        this.entries = [];
        this.loaded = false;
        this.loadPromise = null;
        this.mutation = Promise.resolve();
        this.listeners = new Set();
    }

    async load() {
        return this._enqueue(async () => {
            await this._ensureLoaded();
            return this._cloneEntries(this.entries);
        });
    }

    async list(options = {}) {
        return this._enqueue(async () => {
            await this._ensureLoaded();
            const changed = this._prune(this.now());
            if (changed) await this._save();

            const source = ALLOWED_SOURCES.has(options.source) ? options.source : '';
            const since = Math.max(0, Number(options.since) || 0);
            const query = String(options.query || '').trim().toLowerCase();
            const limit = Math.max(1, Math.min(this.maxEntries, Number(options.limit) || this.maxEntries));
            const filtered = this.entries.filter(entry => {
                if (source && entry.source !== source) return false;
                if (since && entry.lastSeenAt < since) return false;
                if (!query) return true;
                return [entry.title, entry.message, entry.providerName, entry.model, entry.taskId, entry.code]
                    .some(value => String(value || '').toLowerCase().includes(query));
            });
            return this._cloneEntries(filtered.slice(0, limit));
        });
    }

    async count() {
        return this._enqueue(async () => {
            await this._ensureLoaded();
            const changed = this._prune(this.now());
            if (changed) await this._save();
            return this.entries.length;
        });
    }

    async record(input = {}) {
        return this._enqueue(async () => {
            await this._ensureLoaded();
            const now = this.now();
            const incoming = normalizeEntry(input, now);
            const duplicateIndex = this.dedupeWindowMs > 0
                ? this.entries.findIndex(entry => entry.fingerprint === incoming.fingerprint
                    && now - Number(entry.lastSeenAt || entry.timestamp || 0) <= this.dedupeWindowMs)
                : -1;

            let stored = incoming;
            if (duplicateIndex >= 0) {
                const duplicate = this.entries.splice(duplicateIndex, 1)[0];
                stored = {
                    ...duplicate,
                    ...incoming,
                    id: duplicate.id,
                    timestamp: duplicate.timestamp,
                    lastSeenAt: now,
                    occurrences: Math.max(1, Number(duplicate.occurrences) || 1) + 1
                };
            }
            this.entries.unshift(stored);
            this._prune(now);
            await this._save();

            const publicEntry = this._cloneEntry(stored);
            for (const listener of this.listeners) {
                try { listener(publicEntry); } catch { /* Listener failures must not block logging. */ }
            }
            return publicEntry;
        });
    }

    async clear() {
        return this._enqueue(async () => {
            await this._ensureLoaded();
            const removed = this.entries.length;
            this.entries = [];
            await this._save();
            return { success: true, removed };
        });
    }

    onEntry(listener) {
        if (typeof listener !== 'function') return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    _enqueue(action) {
        const run = this.mutation.then(action, action);
        this.mutation = run.catch(() => {});
        return run;
    }

    async _ensureLoaded() {
        if (this.loaded) return;
        if (!this.loadPromise) this.loadPromise = this._loadFromDisk();
        await this.loadPromise;
    }

    async _loadFromDisk() {
        try {
            const entries = parseStore(await fs.readFile(this.filePath, 'utf8'));
            this.entries = Array.isArray(entries)
                ? entries.filter(entry => entry && entry.id && entry.message)
                    .sort((left, right) => Number(right.lastSeenAt || right.timestamp) - Number(left.lastSeenAt || left.timestamp))
                : [];
        } catch (error) {
            if (error.code !== 'ENOENT') await this._backupCorruptFile();
            this.entries = [];
        }
        this.loaded = true;
        const changed = this._prune(this.now());
        if (changed) await this._save();
    }

    _prune(now) {
        const cutoff = now - this.maxAgeMs;
        const next = this.entries
            .filter(entry => Number(entry.lastSeenAt || entry.timestamp || 0) >= cutoff)
            .slice(0, this.maxEntries);
        const changed = next.length !== this.entries.length;
        this.entries = next;
        return changed;
    }

    async _save() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
        const payload = JSON.stringify({ schemaVersion: 1, entries: this.entries }, null, 2);
        await fs.writeFile(temporary, payload, 'utf8');
        try {
            await fs.rename(temporary, this.filePath);
        } catch (error) {
            if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
            await fs.rm(this.filePath, { force: true });
            await fs.rename(temporary, this.filePath);
        } finally {
            await fs.rm(temporary, { force: true }).catch(() => {});
        }
    }

    async _backupCorruptFile() {
        const suffix = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
        const backup = `${this.filePath}.corrupt-${suffix}.json`;
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.rename(this.filePath, backup).catch(() => {});
    }

    _cloneEntry(entry) {
        return JSON.parse(JSON.stringify(entry));
    }

    _cloneEntries(entries) {
        return entries.map(entry => this._cloneEntry(entry));
    }
}

module.exports = {
    ErrorLogStore,
    normalizeEntry,
    sanitizeString,
    sanitizeValue,
    DEFAULT_MAX_ENTRIES,
    DEFAULT_MAX_AGE_MS,
    DEFAULT_DEDUPE_WINDOW_MS
};
