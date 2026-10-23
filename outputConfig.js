const fs = require('fs/promises');
const path = require('path');

const DEFAULT_CONFIG = Object.freeze({
    directory: '',
    // 「另存为」上次选的文件夹：下次打开对话框从这里开始（重启后也记得）
    saveAsDirectory: ''
});

function normalizeDirectory(value) {
    const directory = String(value || '').trim();
    if (!directory) return '';
    if (!path.isAbsolute(directory)) throw new Error('保存目录必须是绝对路径');
    return path.normalize(directory);
}

// 只是个"从哪儿开始"的提示：坏值当没有，不能连累保存目录一起被重置
function normalizeHintDirectory(value) {
    try { return normalizeDirectory(value); } catch { return ''; }
}

class OutputConfigStore {
    constructor(options = {}) {
        if (!options.filePath) throw new Error('Output config file path is required');
        this.filePath = path.resolve(options.filePath);
        this.config = { ...DEFAULT_CONFIG };
        this.loaded = false;
    }

    async load() {
        if (this.loaded) return this.config;
        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
            this.config = {
                ...DEFAULT_CONFIG,
                directory: normalizeDirectory(parsed?.directory),
                saveAsDirectory: normalizeHintDirectory(parsed?.saveAsDirectory)
            };
        } catch {
            this.config = { ...DEFAULT_CONFIG };
        }
        this.loaded = true;
        return this.config;
    }

    // 串行写：后发起的保存一定写入最新配置。先写临时文件再改名：写到一半被杀/断电也不会留下坏文件
    // （坏文件会让 load() 把整份配置连同保存目录一起重置）。改名失败（被杀毒软件占用等）再直接写。
    async save() {
        const write = async () => {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            const text = `${JSON.stringify(this.config, null, 2)}\n`;
            const temp = `${this.filePath}.${process.pid}.tmp`;
            await fs.writeFile(temp, text, 'utf8');
            try {
                await fs.rename(temp, this.filePath);
            } catch {
                await fs.writeFile(this.filePath, text, 'utf8');
                await fs.unlink(temp).catch(() => {});
            }
        };
        this.saving = (this.saving || Promise.resolve()).catch(() => {}).then(write);
        return this.saving;
    }

    async get() {
        await this.load();
        return { ...this.config };
    }

    async update(updates = {}) {
        await this.load();
        if (updates.directory != null) {
            this.config.directory = normalizeDirectory(updates.directory);
        }
        if (updates.saveAsDirectory != null) {
            this.config.saveAsDirectory = normalizeHintDirectory(updates.saveAsDirectory);
        }
        await this.save();
        return { ...this.config };
    }
}

module.exports = {
    DEFAULT_CONFIG,
    OutputConfigStore,
    normalizeDirectory
};
