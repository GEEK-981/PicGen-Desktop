const fs = require('fs/promises');
const path = require('path');
const os = require('os');

function defaultProxyConfigFile() {
    return path.join(os.homedir(), '.picgen', 'proxy-config.json');
}

// direct  = 强制直连，忽略系统代理（默认，中转站本身就在国内可达）
// system  = 跟随系统 / 环境变量代理
// custom  = 使用下面 customProxy 指定的代理
const PROXY_MODES = ['direct', 'system', 'custom'];

const DEFAULT_CONFIG = {
    mode: 'direct',
    customProxy: '',
    bypassList: 'localhost,127.0.0.1,::1'
};

function normalizeMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    return PROXY_MODES.includes(mode) ? mode : DEFAULT_CONFIG.mode;
}

function normalizeCustomProxy(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const withScheme = /^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : `http://${raw}`;
    let parsed;
    try {
        parsed = new URL(withScheme);
    } catch {
        throw new Error(`代理地址格式不正确: ${raw}`);
    }
    if (/^socks/i.test(parsed.protocol)) {
        throw new Error('暂不支持 socks 代理，请填写代理软件的 HTTP 端口（例如 http://127.0.0.1:7890）');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`不支持的代理协议: ${parsed.protocol.replace(':', '')}`);
    }
    if (!parsed.hostname) throw new Error(`代理地址缺少主机名: ${raw}`);
    return parsed.toString().replace(/\/$/, '');
}

function environmentProxyFor(targetUrl = '') {
    const isHttps = !String(targetUrl).startsWith('http:');
    const candidates = isHttps
        ? [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.HTTP_PROXY, process.env.http_proxy]
        : [process.env.HTTP_PROXY, process.env.http_proxy];
    return candidates.find(value => String(value || '').trim()) || '';
}

class ProxyConfigStore {
    constructor(options = {}) {
        this.filePath = options.filePath || process.env.PICGEN_PROXY_CONFIG || defaultProxyConfigFile();
        this.config = { ...DEFAULT_CONFIG };
        this.loaded = false;
    }

    async load() {
        if (this.loaded) return this.config;

        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(String(raw || '').replace(/^﻿/, ''));
            this.config = {
                ...DEFAULT_CONFIG,
                ...parsed,
                mode: normalizeMode(parsed.mode)
            };
        } catch {
            this.config = { ...DEFAULT_CONFIG };
        }

        this.loaded = true;
        return this.config;
    }

    async save() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(this.filePath, JSON.stringify(this.config, null, 2), 'utf8');
    }

    async get() {
        await this.load();
        return { ...this.config };
    }

    async update(updates = {}) {
        await this.load();

        if (updates.mode != null) {
            const mode = String(updates.mode).trim().toLowerCase();
            if (!PROXY_MODES.includes(mode)) {
                throw new Error(`代理模式必须是 ${PROXY_MODES.join(' / ')} 之一`);
            }
            this.config.mode = mode;
        }

        if (updates.customProxy != null) {
            this.config.customProxy = normalizeCustomProxy(updates.customProxy);
        }

        if (updates.bypassList != null) {
            this.config.bypassList = String(updates.bypassList).trim();
        }

        if (this.config.mode === 'custom' && !this.config.customProxy) {
            throw new Error('选择自定义代理时必须填写代理地址');
        }

        await this.save();
        return { ...this.config };
    }
}

module.exports = {
    ProxyConfigStore,
    DEFAULT_CONFIG,
    PROXY_MODES,
    normalizeMode,
    normalizeCustomProxy,
    environmentProxyFor
};
