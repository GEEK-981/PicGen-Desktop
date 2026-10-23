#!/usr/bin/env node
// stdio ⇄ HTTP bridge for MCP clients that only launch local commands (Claude
// Desktop, Codex). It needs Node 18+ and nothing else. Address and token are
// read from PicGen's mcp.json on every request, so a port fallback, a restart or
// a token reset never requires editing the client's config.
const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');

const NOT_RUNNING = 'PicGen 没有运行，或没有开启 MCP 服务器：打开 PicGen → 设置 → MCP，启用后重试';
const UNCONFIRMED = '结果未确认：连接在 PicGen 回复前断开，这次调用可能已经执行（生图可能已入队并计费）。不要重发；用 picgen_list_tasks 核对';

// How far a request got. Only NOT_SENT may be retried: everything else may have
// reached PicGen, and a tool call there can queue paid image requests.
const NOT_SENT = 'not-sent';
const UNKNOWN = 'unknown';

function portFilePath() {
    const index = process.argv.indexOf('--port-file');
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : path.join(__dirname, 'mcp.json');
}

function readEndpoint() {
    try {
        const parsed = JSON.parse(fs.readFileSync(portFilePath(), 'utf8'));
        return parsed.url && parsed.token ? { url: parsed.url, token: parsed.token } : null;
    } catch {
        return null;
    }
}

function write(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(text) {
    process.stderr.write(`[picgen-mcp] ${text}\n`);
}

let initializeMessage = null;
let sessionId = '';
let initializing = null;

// http.request, not fetch: fetch gives up on a response after 300 s, shorter
// than a picgen_wait_tasks call may legitimately take.
function post(message, { withSession = true } = {}) {
    const endpoint = readEndpoint();
    if (!endpoint) return Promise.resolve({ delivery: NOT_SENT });
    const payload = Buffer.from(JSON.stringify(message));
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${endpoint.token}`, 'Content-Length': payload.length };
    if (withSession && sessionId) headers['Mcp-Session-Id'] = sessionId;
    return new Promise(resolve => {
        const request = http.request(endpoint.url, { method: 'POST', headers }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let body = null;
                try { body = text ? JSON.parse(text) : null; } catch { resolve({ delivery: UNKNOWN }); return; }
                resolve({ status: response.statusCode, session: response.headers['mcp-session-id'], body });
            });
            response.on('error', () => resolve({ delivery: UNKNOWN }));
        });
        request.on('error', error => {
            log(error.message);
            // Refused or unreachable: nothing was sent. Anything later may have run.
            resolve({ delivery: ['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENOTFOUND'].includes(error.code) ? NOT_SENT : UNKNOWN });
        });
        request.end(payload);
    });
}

// Re-run the client's own handshake against the PicGen that is running now.
function reinitialize() {
    if (!initializeMessage) return Promise.resolve(false);
    if (!initializing) {
        initializing = (async () => {
            const reply = await post(initializeMessage, { withSession: false });
            if (reply.status !== 200 || !reply.session) return false;
            sessionId = reply.session;
            await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
            return true;
        })().finally(() => { initializing = null; });
    }
    return initializing;
}

// 401 (token reset) and 404 (PicGen restarted, session gone) are refused before
// anything runs, as is a refused connection; those are safe to send again.
function safeToResend(reply, message) {
    if (reply.delivery === NOT_SENT || reply.status === 401 || reply.status === 404) return true;
    return reply.delivery === UNKNOWN && message.method !== 'tools/call';
}

async function handle(message) {
    if (Array.isArray(message)) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC batches are not supported; send one message per line' } });
        return;
    }
    const isRequest = message && message.id !== undefined && typeof message.method === 'string';
    if (message?.method === 'initialize') {
        initializeMessage = message;
        if (initializing) await initializing;
        const reply = await post(message, { withSession: false });
        if (reply.status === 200 && reply.session) sessionId = reply.session;
        answer(message, reply);
        return;
    }
    if (initializing) await initializing;
    let reply = await post(message);
    if (safeToResend(reply, message) && await reinitialize()) reply = await post(message);
    if (isRequest) answer(message, reply);
}

function answer(message, reply) {
    if (reply.status === 200 && reply.body) { write(reply.body); return; }
    const text = reply.delivery === NOT_SENT ? NOT_RUNNING
        : reply.delivery === UNKNOWN ? (message.method === 'tools/call' ? UNCONFIRMED : 'PicGen 连接中断，请重试')
            : reply.status === 401 ? 'PicGen 拒绝了访问令牌，请在 PicGen 设置 → MCP 中确认已开启'
                : reply.body?.error?.message || reply.body?.error || `PicGen 返回 HTTP ${reply.status}`;
    write({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: String(text) } });
}

readline.createInterface({ input: process.stdin }).on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    handle(message).catch(error => {
        log(error.stack || error.message);
        if (message?.id !== undefined) write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
    });
});
