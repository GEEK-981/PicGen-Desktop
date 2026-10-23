const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function defaultMcpConfigFile() {
    return path.join(os.homedir(), '.picgen', 'mcp-config.json');
}

// A fixed port keeps the address pasted into an AI client valid across restarts.
const DEFAULT_MCP_PORT = 47823;

function newToken() {
    return crypto.randomBytes(32).toString('hex');
}

function validPort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

function validToken(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

class McpConfigStore {
    constructor(options = {}) {
        this.filePath = options.filePath || process.env.PICGEN_MCP_CONFIG || defaultMcpConfigFile();
        this.config = null;
    }

    async load() {
        if (this.config) return { ...this.config };
        let parsed = {};
        try {
            parsed = JSON.parse(String(await fs.readFile(this.filePath, 'utf8') || '').replace(/^﻿/, '')) || {};
        } catch {
            parsed = {};
        }
        const token = validToken(parsed.token);
        this.config = {
            enabled: parsed.enabled === true,
            port: validPort(parsed.port) || DEFAULT_MCP_PORT,
            token: token || newToken()
        };
        // The token must not change between launches, or every client config breaks.
        if (!token) await this.save();
        return { ...this.config };
    }

    async save() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(this.filePath, JSON.stringify(this.config, null, 2), 'utf8');
    }

    async get() {
        return this.load();
    }

    async update(updates = {}) {
        await this.load();
        if (updates.enabled != null) this.config.enabled = updates.enabled === true;
        if (updates.port != null) this.config.port = validPort(updates.port) || this.config.port;
        if (updates.regenerateToken === true) this.config.token = newToken();
        await this.save();
        return { ...this.config };
    }
}

module.exports = { McpConfigStore, defaultMcpConfigFile, DEFAULT_MCP_PORT };
