function abortError() {
    return Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError', code: 'ABORT_ERR', retryable: false, countsAsFailure: false
    });
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

function createLinkedAbortController(signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    controller.dispose = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    return controller;
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, ms);
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(abortError());
        };
        signal?.addEventListener('abort', abort, { once: true });
    });
}

// The deadline covers body consumption as well as response headers.
async function withRequestTimeout(signal, timeoutMs, work) {
    throwIfAborted(signal);
    const controller = createLinkedAbortController(signal);
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
    try {
        return await work(controller.signal);
    } catch (error) {
        if (signal?.aborted) throw abortError();
        if (expired) throw Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });
        throw error;
    } finally {
        clearTimeout(timer);
        controller.abort();
        controller.dispose();
    }
}

module.exports = { abortError, throwIfAborted, createLinkedAbortController, delay, withRequestTimeout };
