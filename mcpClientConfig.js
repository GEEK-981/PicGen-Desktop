// What the settings page copies for each kind of MCP client. HTTP clients hold
// the token themselves; stdio clients run picgen-mcp-stdio.js, which reads the
// current address and token from mcp.json, so their config has no secret in it.
(function initMcpClientConfig(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PicGenMcpClientConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMcpClientConfig() {
    function tomlString(value) {
        // A literal string keeps Windows backslashes as they are; it cannot hold a quote.
        return value.includes("'") ? JSON.stringify(value) : `'${value}'`;
    }

    function formatMcpClientConfig(format, { url, token, stdioScript }) {
        const authorization = `Bearer ${token}`;
        if (format === 'claude-code') return `claude mcp add --transport http picgen ${url} --header "Authorization: ${authorization}"`;
        if (format === 'http-json') return JSON.stringify({ mcpServers: { picgen: { type: 'http', url, headers: { Authorization: authorization } } } }, null, 2);
        if (format === 'claude-desktop') return JSON.stringify({ mcpServers: { picgen: { command: 'node', args: [stdioScript] } } }, null, 2);
        if (format === 'codex') return `[mcp_servers.picgen]\ncommand = "node"\nargs = [${tomlString(stdioScript)}]`;
        throw new Error(`unknown client format: ${format}`);
    }

    return { formatMcpClientConfig };
});
