'use strict';

// Off-main-thread half of sizeReference: every sharp call for the size-reference
// dialog runs here so dragging the product box never stalls the window.
//
// The product photo is sent once (`prepare`) and cached by key; live previews then
// only carry the spec, not a multi-megabyte image per keystroke.

const { parentPort } = require('node:worker_threads');
const { detectProductRegion, renderSizeReference } = require('./sizeReferenceRender');

const MAX_SOURCES = 3;
const sources = new Map();

function remember(key, buffer) {
    sources.delete(key);
    sources.set(key, buffer);
    while (sources.size > MAX_SOURCES) sources.delete(sources.keys().next().value);
}

async function handle({ op, key, source, spec }) {
    if (op === 'prepare') {
        const buffer = Buffer.from(source);
        const detected = await detectProductRegion(buffer);
        remember(key, buffer);
        return detected;
    }
    if (op === 'render') {
        const buffer = sources.get(key);
        if (!buffer) throw new Error('产品图片已失效，请重新选择图片');
        const result = await renderSizeReference({ ...spec, source: buffer });
        return { ...result, scene: undefined };
    }
    if (op === 'release') {
        sources.delete(key);
        return { released: true };
    }
    throw new Error(`Unknown size-reference op: ${op}`);
}

parentPort.on('message', async message => {
    try {
        parentPort.postMessage({ id: message.id, result: await handle(message) });
    } catch (error) {
        parentPort.postMessage({ id: message.id, error: error.message });
    }
});
