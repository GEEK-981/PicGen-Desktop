const { Worker } = require('node:worker_threads');
const path = require('node:path');
class PreviewDecoder {
    constructor(fallback) { this.fallback = fallback; this.pending = new Map(); this.nextId = 0; }
    start() {
        if (this.worker) return;
        this.worker = new Worker(path.join(__dirname, 'preview-decoder-worker.js'));
        this.worker.on('message', result => {
            const request = this.pending.get(result.id); if (!request) return;
            this.pending.delete(result.id);
            if (result.error) request.reject(new Error(result.error));
            else if (request.format === 'jpeg') request.resolve(Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength));
            else if (request.format === 'drag-icon' || request.format === 'bitmap') request.resolve({ buffer: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength), width: result.width, height: result.height });
            else request.resolve({ isEmpty: () => false, getSize: () => ({ width: result.width, height: result.height }),
                toPNG: () => Buffer.from(result.data) });
        });
        const fail = error => { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); this.worker = null; };
        this.worker.on('error', fail);
        this.worker.on('exit', code => { if (code) fail(new Error(`Preview decoder exited: ${code}`)); });
        // After the listeners: a 'message' listener re-refs the port, so an earlier unref() is lost.
        this.worker.unref();
    }
    request(source, size, format, extra) {
        return new Promise((resolve, reject) => {
            const id = ++this.nextId; this.pending.set(id, { resolve, reject, format }); this.worker.postMessage({ id, source, size, format, ...extra });
        });
    }
    async decode(source, size) {
        this.start();
        try { return await this.request(source, size); }
        catch (error) { if (this.fallback) return this.fallback(source, size); throw error; }
    }
    // A bounded JPEG (EXIF-rotated, never enlarged, flattened on white). Rejects instead of using the
    // PNG fallback, so the caller can pick its own.
    async thumbnailJpeg(source, max) {
        this.start();
        return this.request(source, { width: max, height: max }, 'jpeg');
    }
    // Native drag image (see dragIcon.js) → {buffer: PNG, width, height}. No fallback: the caller has one.
    dragIcon(options) {
        this.start();
        return this.request(null, null, 'drag-icon', { dragIcon: options });
    }
    // Full clipboard bitmap (path or encoded bytes) → {buffer: premultiplied BGRA, width, height}.
    // No fallback: the caller has one.
    bitmap(source) {
        this.start();
        return this.request(source, null, 'bitmap');
    }
}
module.exports = { PreviewDecoder };
