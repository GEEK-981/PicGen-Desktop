const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

// Remembers what each idempotency key queued, on disk and for the whole app, so
// a key keeps protecting a batch across a token reset, an MCP restart or an app
// restart: exactly when an agent is most likely to send the same batch again.
class McpIdempotencyStore {
    constructor({ filePath, ttlMs = DAY_MS, now = Date.now } = {}) {
        this.filePath = filePath;
        this.ttlMs = ttlMs;
        this.now = now;
        this.settled = null;
        this.pending = new Map();
    }

    static fingerprint(request) {
        return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
    }

    async _load() {
        if (!this.settled) {
            this.settled = new Map();
            try {
                const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
                for (const [key, entry] of Object.entries(parsed.entries || {})) this.settled.set(key, entry);
            } catch { /* nothing remembered yet */ }
        }
        const cutoff = this.now() - this.ttlMs;
        for (const [key, entry] of this.settled) if (!(entry.at > cutoff)) this.settled.delete(key);
        return this.settled;
    }

    async _save() {
        const temp = `${this.filePath}.${process.pid}.tmp`;
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(temp, JSON.stringify({ entries: Object.fromEntries(this.settled) }), 'utf8');
        await fs.rename(temp, this.filePath);
    }

    // task() must throw only when nothing was queued; whatever it returns is kept.
    async run(key, fingerprint, task) {
        const settled = await this._load();
        const known = settled.get(key) || this.pending.get(key);
        if (known) {
            if (known.fingerprint !== fingerprint) throw new Error('这个 idempotencyKey 已经用于另一批不同的请求；换一个新的 key 再提交');
            const result = known.result || await known.promise;
            return { ...result, replayed: true };
        }
        const promise = task();
        this.pending.set(key, { fingerprint, promise });
        try {
            const result = await promise;
            settled.set(key, { at: this.now(), fingerprint, result });
            await this._save().catch(error => console.warn('[MCP] idempotency save failed:', error.message));
            return result;
        } finally {
            this.pending.delete(key);
        }
    }
}

module.exports = { McpIdempotencyStore };
