'use strict';

const { Worker } = require('node:worker_threads');
const crypto = require('node:crypto');
const path = require('node:path');

// Persistent client for size-reference-worker.js, same lifecycle rules as
// ImageNormalizeWorker: one unref'd thread, id-tagged requests, and a dying
// worker may only fail the requests it owned.
class SizeReferenceWorker {
    constructor() {
        this.pending = new Map();
        this.nextId = 0;
    }

    start() {
        if (this.worker) return;
        const worker = new Worker(path.join(__dirname, 'size-reference-worker.js'));
        worker.unref();
        worker.on('message', message => {
            const request = this.pending.get(message.id);
            if (!request) return;
            this.pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error));
            else request.resolve(message.result);
        });
        const fail = error => {
            if (this.worker !== worker) return;
            this.worker = null;
            worker.terminate();
            for (const request of this.pending.values()) request.reject(error);
            this.pending.clear();
        };
        worker.on('error', fail);
        worker.on('exit', code => {
            if (code) fail(new Error(`Size-reference worker exited: ${code}`));
        });
        this.worker = worker;
    }

    call(message) {
        this.start();
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...message, id });
        });
    }

    // Returns { key, image, region }. The key names the cached photo for render().
    async prepare(sourceBuffer) {
        const key = crypto.createHash('sha1').update(sourceBuffer).digest('hex');
        const detected = await this.call({ op: 'prepare', key, source: sourceBuffer });
        return { key, ...detected };
    }

    async render(key, spec) {
        const result = await this.call({ op: 'render', key, spec });
        return { ...result, buffer: Buffer.from(result.buffer) };
    }

    release(key) {
        if (!this.worker) return Promise.resolve({ released: false });
        return this.call({ op: 'release', key });
    }
}

module.exports = { SizeReferenceWorker };
