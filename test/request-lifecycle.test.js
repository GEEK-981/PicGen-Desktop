const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { getEventListeners } = require('node:events');
const { generateImage, uploadToImageHost } = require('../apiService');
const { withRequestTimeout, delay } = require('../requestLifecycle');

async function mock(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${server.address().port}`;
}

const config = provider => ({ provider, apiKey: 'fixture', model: 'gpt-image-2', prompt: 'mock', protocol: 'openai-images' });

test('cancellation before submission avoids both generation and reference upload', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(generateImage({ ...config('http://127.0.0.1:1'), signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(uploadToImageHost('YWJj', 'image/png', { signal: controller.signal }), { name: 'AbortError' });
});

test('cancellation interrupts an incomplete result body without another generation', async t => {
    const controller = new AbortController();
    let submissions = 0;
    let downloads = 0;
    let url;
    url = await mock(t, (req, res) => {
        req.resume();
        if (req.method === 'POST') {
            submissions++;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ data: [{ url: `${url}/image` }] }));
        } else {
            downloads++;
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.write('partial');
            setTimeout(() => controller.abort(), 20);
        }
    });
    await assert.rejects(generateImage({ ...config(url), signal: controller.signal }), { name: 'AbortError' });
    assert.equal(submissions, 1);
    assert.equal(downloads, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation interrupts result-download backoff immediately', async t => {
    const controller = new AbortController();
    let submissions = 0;
    let downloads = 0;
    let url;
    url = await mock(t, (req, res) => {
        req.resume();
        if (req.method === 'POST') {
            submissions++;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ data: [{ url: `${url}/image` }] }));
        } else { downloads++; res.writeHead(503); res.end(); }
    });
    const start = Date.now();
    await assert.rejects(generateImage({ ...config(url), signal: controller.signal }, {
        downloadRetryDelayMs: 5000,
        onProgress(progress) {
            if (progress.message?.startsWith('Retrying result download')) setTimeout(() => controller.abort(), 10);
        }
    }), { name: 'AbortError' });
    assert.ok(Date.now() - start < 2000, 'should not wait for the 5 second backoff');
    assert.equal(submissions, 1);
    assert.equal(downloads, 1);
});

test('result-body deadline preserves the no-resubmission outcome', async t => {
    let submissions = 0;
    let url;
    url = await mock(t, (req, res) => {
        req.resume();
        if (req.method === 'POST') {
            submissions++;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ data: [{ url: `${url}/image` }] }));
        } else { res.writeHead(200, { 'Content-Type': 'image/png' }); res.write('partial'); }
    });
    await assert.rejects(generateImage(config(url), { downloadTimeoutMs: 40, downloadRetryAttempts: 1 }),
        error => error.code === 'RESULT_DOWNLOAD_FAILED' && error.ambiguous && !error.retryable);
    assert.equal(submissions, 1);
});

test('a slow result body that keeps making progress is not cut off by the idle deadline', async t => {
    let url;
    url = await mock(t, (req, res) => {
        req.resume();
        if (req.method === 'POST') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ data: [{ url: `${url}/image` }] }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        let sent = 0;
        const timer = setInterval(() => {
            res.write('chunk');
            if (++sent === 8) { clearInterval(timer); res.end(); }
        }, 40);
    });
    // 整个正文约 320ms，远超 100ms 的空闲期限，但每 40ms 都有数据，不该被判超时。
    const result = await generateImage(config(url), { downloadIdleTimeoutMs: 100, downloadRetryAttempts: 1 });
    assert.equal(Buffer.from(result.base64, 'base64').toString(), 'chunk'.repeat(8));
});

function grsaiMock(t, onDownload) {
    const counts = { submissions: 0, downloads: 0 };
    let base;
    return mock(t, (req, res) => {
        req.resume();
        if (req.url.endsWith('/draw/nano-banana')) {
            counts.submissions++;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ code: 0, data: { id: 'grsai-job' } }));
        } else if (req.url.endsWith('/draw/result')) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ code: 0, data: { status: 'succeeded', results: [{ url: `${base}/file.png` }] } }));
        } else {
            counts.downloads++;
            onDownload(res, counts.downloads);
        }
    }).then(url => { base = url; return { url, counts }; });
}

test('a Grsai result link keeps being retried within its validity window instead of failing after 3 tries', async t => {
    const { url, counts } = await grsaiMock(t, (res, n) => {
        if (n < 6) { res.writeHead(503); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end('final-image');
    });
    const result = await generateImage({ ...config(url), model: 'nano-banana-2', protocol: 'grsai-nano-banana' },
        { grsaiPollIntervalMs: 1, downloadRetryDelayMs: 1, downloadRetryWindowMs: 5000 });
    assert.equal(Buffer.from(result.base64, 'base64').toString(), 'final-image');
    assert.equal(counts.submissions, 1);
    assert.equal(counts.downloads, 6);
});

test('a Grsai download that outlasts its retry window keeps the result link and never resubmits', async t => {
    const { url, counts } = await grsaiMock(t, res => { res.writeHead(503); res.end(); });
    await assert.rejects(generateImage({ ...config(url), model: 'nano-banana-2', protocol: 'grsai-nano-banana' },
        { grsaiPollIntervalMs: 1, downloadRetryDelayMs: 5, downloadRetryWindowMs: 120 }),
        error => error.code === 'RESULT_DOWNLOAD_FAILED' && error.ambiguous && !error.retryable
            && error.resultUrl === `${url}/file.png` && /已持续重试/.test(error.message));
    assert.equal(counts.submissions, 1);
    assert.ok(counts.downloads > 3, `expected more than 3 download attempts, got ${counts.downloads}`);
});

test('accepted asynchronous job is not resubmitted when its polling endpoint fails', async t => {
    let submissions = 0;
    let polls = 0;
    const url = await mock(t, (req, res) => {
        req.resume();
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/draw/nano-banana')) {
            submissions++;
            res.end(JSON.stringify({ code: 0, data: { id: 'mock-accepted-job' } }));
        } else { polls++; res.writeHead(503); res.end(JSON.stringify({ error: 'temporary polling error' })); }
    });
    await assert.rejects(generateImage({ ...config(url), model: 'nano-banana-2', protocol: 'grsai-nano-banana' }, { grsaiPollIntervalMs: 1 }),
        error => error.ambiguous && !error.retryable && error.providerTaskId === 'mock-accepted-job');
    assert.equal(submissions, 1);
    assert.equal(polls, 1);
});

test('completed request scopes and sleeps detach cancellation listeners', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 20; i++) {
        assert.equal(await withRequestTimeout(controller.signal, 500, async () => 'done'), 'done');
        await delay(0, controller.signal);
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a poisoned resolver is retried through public DNS without turning certificate checks off', async () => {
    const { downloadAgentFor, publicAddressesFor, fetchDownload } = require('../apiService')._test;
    const agent = downloadAgentFor('https://file2.aitohumanize.com/a.png', '203.0.113.10');
    assert.equal(agent.options.rejectUnauthorized, undefined);
    assert.equal(agent.options.servername, 'file2.aitohumanize.com');
    agent.destroy();

    const response = await fetchDownload('https://file2.aitohumanize.com/', '69.63.206.179');
    assert.equal(response.ok, false);
    assert.equal(response.status, 404);
    response.body?.destroy();

    const answers = await publicAddressesFor('file2.aitohumanize.com');
    assert.deepEqual(answers, ['69.63.206.179']);
});

test('a refused or unreachable result host also falls back to public DNS, but HTTP errors do not', () => {
    const { shouldTryPublicDns } = require('../apiService')._test;
    for (const code of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET']) {
        assert.equal(shouldTryPublicDns({ code }), true, code);
    }
    assert.equal(shouldTryPublicDns({ status: 404 }), false);
    assert.equal(shouldTryPublicDns({ code: 'ENOTFOUND' }), false);
});

test('rejecting a streaming response closes its unread body and socket', async t => {
    let closed;
    const socketClosed = new Promise(resolve => { closed = resolve; });
    const url = await mock(t, (req, res) => {
        req.resume();
        res.on('close', closed);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: waiting\n\n');
    });
    await assert.rejects(generateImage(config(url)));
    await Promise.race([socketClosed, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Unread body socket stayed open')), 1000);
        timer.unref();
    })]);
});
