const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const { McpHttpServer } = require('../mcpServer');

const SCRIPT = path.join(__dirname, '..', 'picgen-mcp-stdio.js');
const fakeApi = { call: async name => ({ content: [{ type: 'text', text: `called ${name}` }] }) };

async function startServer(portFile, token = 'b'.repeat(64), port = 0) {
    const server = new McpHttpServer({ api: fakeApi, port, token });
    await server.start();
    await fs.writeFile(portFile, JSON.stringify({ url: server.url, port: server.port, token }));
    return server;
}

// Drives the stdio bridge the way Claude Desktop or Codex would.
function bridge(portFile) {
    const child = spawn(process.execPath, [SCRIPT, '--port-file', portFile], { stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = new Map();
    const waiters = new Map();
    const lines = [];
    readline.createInterface({ input: child.stdout }).on('line', line => {
        lines.push(line);
        const message = JSON.parse(line);
        if (waiters.has(message.id)) { waiters.get(message.id)(message); waiters.delete(message.id); }
        else replies.set(message.id, message);
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    return {
        lines,
        stderr: () => stderr,
        send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
        request(message) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`no reply to ${message.method}; stderr: ${stderr}`)), 5000);
                waiters.set(message.id, reply => { clearTimeout(timer); resolve(reply); });
                if (replies.has(message.id)) { waiters.get(message.id)(replies.get(message.id)); waiters.delete(message.id); }
                this.send(message);
            });
        },
        close() { child.stdin.end(); child.kill(); }
    };
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Claude Desktop', version: '1' } } };

test('stdio bridge forwards requests with the token read from the port file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-stdio-'));
    const portFile = path.join(dir, 'mcp.json');
    const server = await startServer(portFile);
    const client = bridge(portFile);
    try {
        const init = await client.request(INIT);
        assert.equal(init.result.serverInfo.name, 'picgen');
        client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const listed = await client.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        assert.ok(listed.result.tools.length > 0);
        const [a, b] = await Promise.all([
            client.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'picgen_status', arguments: {} } }),
            client.request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'picgen_list_models', arguments: {} } })
        ]);
        assert.equal(a.result.content[0].text, 'called picgen_status');
        assert.equal(b.result.content[0].text, 'called picgen_list_models');
        assert.ok(client.lines.every(line => JSON.parse(line).jsonrpc === '2.0'), 'stdout carries JSON-RPC only');
    } finally {
        client.close();
        await server.close();
    }
});

test('stdio bridge survives PicGen restarting on a new port with a new token', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-stdio-'));
    const portFile = path.join(dir, 'mcp.json');
    let server = await startServer(portFile, 'c'.repeat(64));
    const client = bridge(portFile);
    try {
        await client.request(INIT);
        await server.close();
        server = await startServer(portFile, 'd'.repeat(64));
        const after = await client.request({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'picgen_status', arguments: {} } });
        assert.equal(after.result.content[0].text, 'called picgen_status', 're-reads the port file and re-initializes on its own');
    } finally {
        client.close();
        await server.close();
    }
});

test('stdio bridge says what to do when PicGen is not running', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-stdio-'));
    const client = bridge(path.join(dir, 'mcp.json'));
    try {
        const reply = await client.request(INIT);
        assert.match(reply.error.message, /PicGen 没有运行|MCP/);
        client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const next = await client.request({ jsonrpc: '2.0', id: 9, method: 'ping' });
        assert.ok(next.error, 'every request gets an answer, none hangs');
    } finally {
        client.close();
    }
});

// A server that reads the request and then drops the connection: the call may
// already have been queued and billed, so the bridge must not send it again.
test('stdio bridge never resends a tool call the server may have run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-stdio-'));
    const portFile = path.join(dir, 'mcp.json');
    let toolCalls = 0;
    const http = require('http');
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const message = JSON.parse(body);
            if (message.method === 'initialize') {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': `s${Date.now()}` });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
                return;
            }
            if (message.method === 'tools/call') { toolCalls += 1; req.socket.destroy(); return; }
            res.writeHead(202); res.end();
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await fs.writeFile(portFile, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp`, token: 't' }));
    const client = bridge(portFile);
    try {
        await client.request(INIT);
        const reply = await client.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'picgen_generate_batch', arguments: {} } });
        assert.equal(toolCalls, 1);
        assert.match(reply.error.message, /未确认/);
        assert.doesNotMatch(reply.error.message, /没有运行/, 'never tell the agent PicGen is down when the call may have run');
    } finally {
        client.close();
        server.close();
    }
});

test('stdio bridge answers a JSON-RPC batch array instead of hanging', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picgen-stdio-'));
    const portFile = path.join(dir, 'mcp.json');
    const server = await startServer(portFile);
    const client = bridge(portFile);
    try {
        await client.request(INIT);
        const lines = client.lines.length;
        client.send([{ jsonrpc: '2.0', id: 7, method: 'ping' }]);
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(client.lines.length, lines + 1);
        assert.equal(JSON.parse(client.lines.at(-1)).error.code, -32600);
    } finally {
        client.close();
        await server.close();
    }
});
