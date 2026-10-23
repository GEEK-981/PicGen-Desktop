const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// One asynchronous decoder at a time; obsolete queued hovers never decode.
class PreviewCache {
    constructor({ directory, createThumbnail, encode = image => image.toPNG(), limit = 64, size = 1000 }) {
        Object.assign(this, { directory, createThumbnail, encode, limit, size });
        this.cache = new Map();
        this.jobs = new Map();
        this.tail = Promise.resolve();
    }

    async get(source, isCurrent = () => true, natural = {}) {
        const stat = await fs.stat(source);
        if (!isCurrent()) return null;
        const key = crypto.createHash('sha256').update(`hover-v1:${source}:${stat.size}:${stat.mtimeMs}`).digest('hex');
        if (this.cache.has(key)) {
            const cached = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, cached);
            return cached;
        }
        if (!this.jobs.has(key)) {
            const job = this.tail.then(async () => {
                if (!isCurrent()) return null;
                const destination = path.join(this.directory, `${key}-hover.png`);
                try { await fs.access(destination); } catch {
                    if (!isCurrent()) return null;
                    // Electron uses the Windows thumbnail API off the JS thread.
                    const width = natural.width > 0 && natural.height > natural.width
                        ? Math.max(1, Math.round(this.size * natural.width / natural.height)) : this.size;
                    const image = await this.createThumbnail(source, { width, height: this.size });
                    if (image.isEmpty()) throw new Error('图片预览无法解码');
                    const dimensions = image.getSize();
                    const scale = Math.min(1, this.size / Math.max(dimensions.width, dimensions.height));
                    const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(dimensions.width * scale)),
                        height: Math.max(1, Math.round(dimensions.height * scale)), quality: 'good' }) : image;
                    await fs.mkdir(this.directory, { recursive: true });
                    await fs.writeFile(destination, await this.encode(resized));
                }
                this.cache.set(key, destination);
                while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
                return destination;
            }).finally(() => this.jobs.delete(key));
            this.jobs.set(key, job);
            this.tail = job.catch(() => {});
        }
        const result = await this.jobs.get(key);
        // A newer hover of the same image can join a canceled queued request.
        if (!result && isCurrent()) return this.get(source, isCurrent, natural);
        return isCurrent() ? result : null;
    }
}

module.exports = { PreviewCache };
