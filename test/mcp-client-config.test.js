const test = require('node:test');
const assert = require('node:assert/strict');

const { formatMcpClientConfig } = require('../mcpClientConfig');

const settings = { url: 'http://127.0.0.1:47823/mcp', token: 'e'.repeat(64), stdioScript: 'C:\\Users\\me\\AppData\\Roaming\\PicGen\\picgen-mcp-stdio.js' };

test('Claude Code gets a one-line add command with the token header', () => {
    assert.equal(formatMcpClientConfig('claude-code', settings),
        `claude mcp add --transport http picgen http://127.0.0.1:47823/mcp --header "Authorization: Bearer ${'e'.repeat(64)}"`);
});

test('HTTP JSON carries url and header', () => {
    const parsed = JSON.parse(formatMcpClientConfig('http-json', settings));
    assert.deepEqual(parsed.mcpServers.picgen, { type: 'http', url: settings.url, headers: { Authorization: `Bearer ${settings.token}` } });
});

test('stdio configs point node at the bridge and never contain the token', () => {
    const desktop = formatMcpClientConfig('claude-desktop', settings);
    assert.deepEqual(JSON.parse(desktop).mcpServers.picgen, { command: 'node', args: [settings.stdioScript] });
    const codex = formatMcpClientConfig('codex', settings);
    assert.equal(codex, "[mcp_servers.picgen]\ncommand = \"node\"\nargs = ['C:\\Users\\me\\AppData\\Roaming\\PicGen\\picgen-mcp-stdio.js']");
    for (const text of [desktop, codex]) assert.equal(text.includes(settings.token), false);
});

test('a path with a quote still makes valid TOML', () => {
    const codex = formatMcpClientConfig('codex', { ...settings, stdioScript: "D:\\it's\\picgen-mcp-stdio.js" });
    assert.match(codex, /args = \["D:\\\\it's\\\\picgen-mcp-stdio\.js"\]/);
});
