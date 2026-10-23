'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');

// Persistent client for image-normalize-worker.js, mirroring PreviewDecoder.
//
// A persistent worker (started once, unref'd, id-tagged requests) rather than a
// fresh one per call: normalization is on the save path, and spawning a thread
// per image would trade a 1.23 s freeze for a ~40 ms spawn each time.
class ImageNormalizeWorker {
    constructor(fallback) {
        this.fallback = fallback;
        this.pending = new Map();
        this.nextId = 0;
    }

    start() {
        if (this.worker) return;
        const worker = new Worker(path.join(__dirname, 'image-normalize-worker.js'));
        // The worker must never be a reason for the app to stay alive.
        worker.unref();
        worker.on('message', result => {
            const request = this.pending.get(result.id);
            if (!request) return;
            this.pending.delete(result.id);
            if (result.error) request.reject(new Error(result.error));
            else request.resolve({ buffer: Buffer.from(result.buffer), mimeType: result.mimeType });
        });
        // These listeners belong to THIS worker; `this.worker` is shared state they outlive.
        // A replacement can already own `this.pending` by the time a dying worker reports:
        // `error` clears the client, so the very next resize() spawns a successor, and the
        // dead thread's `exit` arrives after that. Without the identity check the stale
        // report rejects the successor's in-flight requests and orphans a healthy thread.
        const fail = error => {
            if (this.worker !== worker) return;
            this.worker = null;
            // A worker dropped on `error` is usually still running; its MessagePort would
            // keep the thread — and sharp's libvips heap — alive for the app's lifetime.
            // On the `exit` path this is a no-op.
            worker.terminate();
            for (const request of this.pending.values()) request.reject(error);
            this.pending.clear();
        };
        worker.on('error', fail);
        worker.on('exit', code => {
            if (code) fail(new Error(`Image normalizer exited: ${code}`));
        });
        this.worker = worker;
    }

    async resize(source, options) {
        this.start();
        try {
            return await new Promise((resolve, reject) => {
                const id = ++this.nextId;
                this.pending.set(id, { resolve, reject });
                this.worker.postMessage({
                    id,
                    source,
                    width: options.width,
                    height: options.height,
                    mimeType: options.mimeType,
                    quality: options.quality
                });
            });
        } catch (error) {
            // Never lose an image because the worker could not do the work.
            if (this.fallback) return this.fallback(source, options);
            throw error;
        }
    }
}

module.exports = { ImageNormalizeWorker };
