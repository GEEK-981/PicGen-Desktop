const fs = require('fs/promises');
const path = require('path');

function localDay(time) {
    const date = new Date(time);
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Images agents may submit per local day. The check and the count happen in one
// queued step, so parallel calls cannot slip past the limit together.
class McpDailyQuota {
    constructor({ filePath, now = Date.now } = {}) {
        this.filePath = filePath;
        this.now = now;
        this.state = null;
        this.queue = Promise.resolve();
    }

    _serial(task) {
        const run = this.queue.then(task);
        this.queue = run.catch(() => {});
        return run;
    }

    async _load() {
        if (!this.state) {
            try {
                const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
                this.state = { day: String(parsed.day || ''), used: Math.max(0, Number(parsed.used) || 0) };
            } catch {
                this.state = { day: '', used: 0 };
            }
        }
        const today = localDay(this.now());
        if (this.state.day !== today) this.state = { day: today, used: 0 };
        return this.state;
    }

    // Temp file + rename: a crash never leaves half a file that would read as 0 used.
    async _write(state) {
        const temp = `${this.filePath}.${process.pid}.tmp`;
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
        await fs.rename(temp, this.filePath);
    }

    // The new count is adopted only once it is on disk.
    async _commit(used) {
        const next = { day: this.state.day, used };
        await this._write(next);
        this.state = next;
    }

    _describe(limit) {
        const capped = limit > 0;
        return {
            day: this.state.day,
            used: this.state.used,
            limit: capped ? limit : 0,
            remaining: capped ? Math.max(0, limit - this.state.used) : null
        };
    }

    usage(limit = 0) {
        return this._serial(async () => {
            await this._load();
            return this._describe(limit);
        });
    }

    reserve(images, limit = 0) {
        return this._serial(async () => {
            const state = await this._load();
            if (limit > 0 && state.used + images > limit) {
                const left = Math.max(0, limit - state.used);
                const error = new Error(`超过 MCP 每日上限：今天已提交 ${state.used} 张，上限 ${limit} 张，还剩 ${left} 张，这次要 ${images} 张。可在 PicGen 设置 → MCP 里调整上限`);
                error.code = 'MCP_DAILY_LIMIT';
                throw error;
            }
            await this._commit(state.used + images);
            return this._describe(limit);
        });
    }

    refund(images) {
        return this._serial(async () => {
            const state = await this._load();
            await this._commit(Math.max(0, state.used - images));
        });
    }
}

module.exports = { McpDailyQuota, localDay };
