const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createSerialTaskQueue() {
    let tail = Promise.resolve();
    return function enqueue(operation) {
        const run = tail.then(operation, operation);
        tail = run.catch(() => {});
        return run;
    };
}

async function readJsonFile(filePath, fallback) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
        throw error;
    }
}

async function writeJsonAtomic(filePath, value) {
    const directory = path.dirname(filePath);
    const tempPath = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );
    await fs.mkdir(directory, { recursive: true });
    try {
        await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        await fs.rename(tempPath, filePath);
    } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function writeFileExclusive(directory, fileName, buffer) {
    const parsed = path.parse(fileName);
    await fs.mkdir(directory, { recursive: true });

    for (let attempt = 0; attempt < 1000; attempt += 1) {
        const suffix = attempt === 0 ? '' : `-${attempt}`;
        const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
        try {
            await fs.writeFile(candidate, buffer, { flag: 'wx' });
            return candidate;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
    }
    throw new Error(`Unable to allocate a unique file name for ${fileName}`);
}

function buildGeneratedImageFileName({ id, prompt, extension, safeName, now = new Date() }) {
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const taskId = safeName(id || crypto.randomBytes(8).toString('hex'));
    const promptName = safeName(prompt || 'image');
    const ext = String(extension || 'png').replace(/^\.+/, '') || 'png';
    return `${timestamp}_${promptName}_${taskId}.${ext}`;
}

module.exports = {
    createSerialTaskQueue,
    readJsonFile,
    writeJsonAtomic,
    writeFileExclusive,
    buildGeneratedImageFileName
};
