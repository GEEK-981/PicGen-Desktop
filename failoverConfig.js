const fs = require('fs/promises');
const path = require('path');
const os = require('os');

function defaultFailoverConfigFile() {
    const home = os.homedir();
    return path.join(home, '.picgen', 'failover-config.json');
}

const STRATEGIES = Object.freeze(['order', 'priority', 'balanced', 'fixed', 'price', 'speed']);

function normalizeStrategy(value) {
    const strategy = String(value || '').trim().toLowerCase();
    return STRATEGIES.includes(strategy) ? strategy : 'order';
}

const DEFAULT_CONFIG = {
    enabled: true,
    maxAttempts: 3,
    maxGlobalConcurrent: 12,
    respectPriority: true,
    failoverThreshold: 3,
    cooldownMs: 30000,
    strategy: 'order',
    selectedProviderId: ''
};

class FailoverConfigStore {
    constructor(options = {}) {
        this.filePath = options.filePath || process.env.PICGEN_FAILOVER_CONFIG || defaultFailoverConfigFile();
        this.legacyFilePath = options.legacyFilePath || '';
        this.config = { ...DEFAULT_CONFIG };
        this.loaded = false;
    }

    async load() {
        if (this.loaded) return this.config;

        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(String(raw || '').replace(/^﻿/, ''));
            this.config = { ...DEFAULT_CONFIG, ...parsed };
        } catch {
            try {
                if (!this.legacyFilePath || path.resolve(this.legacyFilePath) === path.resolve(this.filePath)) {
                    throw new Error('No separate legacy config');
                }
                const raw = await fs.readFile(this.legacyFilePath, 'utf8');
                const parsed = JSON.parse(String(raw || '').replace(/^﻿/, ''));
                this.config = { ...DEFAULT_CONFIG, ...parsed };
                await this.save();
            } catch {
                this.config = { ...DEFAULT_CONFIG };
            }
        }

        this.config.strategy = normalizeStrategy(this.config.strategy);
        this.loaded = true;
        return this.config;
    }

    async save() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const payload = JSON.stringify(this.config, null, 2);
        await fs.writeFile(this.filePath, payload, 'utf8');
    }

    async get() {
        await this.load();
        return { ...this.config };
    }

    async update(updates = {}) {
        await this.load();

        if (updates.enabled != null) {
            this.config.enabled = !!updates.enabled;
        }

        if (updates.maxAttempts != null) {
            this.config.maxAttempts = Math.max(1, Math.min(10, Number(updates.maxAttempts)));
        }

        if (updates.maxGlobalConcurrent != null) {
            const value = Number(updates.maxGlobalConcurrent);
            if (Number.isFinite(value)) {
                this.config.maxGlobalConcurrent = Math.max(1, Math.min(64, Math.round(value)));
            }
        }

        if (updates.respectPriority != null) {
            this.config.respectPriority = !!updates.respectPriority;
        }

        if (updates.failoverThreshold != null) {
            this.config.failoverThreshold = Math.max(1, Number(updates.failoverThreshold));
        }

        if (updates.cooldownMs != null) {
            this.config.cooldownMs = Math.max(1000, Number(updates.cooldownMs));
        }

        if (updates.strategy != null) {
            this.config.strategy = normalizeStrategy(updates.strategy);
        }

        if (updates.selectedProviderId != null) {
            this.config.selectedProviderId = String(updates.selectedProviderId).trim();
        }

        await this.save();
        return { ...this.config };
    }
}

module.exports = {
    STRATEGIES,
    normalizeStrategy,
    FailoverConfigStore,
    DEFAULT_CONFIG,
    defaultFailoverConfigFile
};
