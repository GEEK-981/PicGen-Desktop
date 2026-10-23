// Locates the x64 Microsoft Visual C++ runtime DLLs that onnxruntime.dll / onnxruntime_binding.node
// import (MSVCP140, MSVCP140_1, VCRUNTIME140, VCRUNTIME140_1). They are copied app-local next to
// onnxruntime_binding.node, which is searched before System32 (LoadLibraryEx + altered search path),
// so a clean PC without the VC++ Redistributable, or one with an old System32 copy, still works.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VC_RUNTIME_DLLS = Object.freeze(['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']);
// ORT 1.24.3 is linked with MSVC 14.44; runtimes older than 14.40 crash in std::mutex.
const MIN_VERSION = Object.freeze([14, 40]);

function versionTuple(text) {
    return String(text).split('.').map(part => Number(part) || 0);
}

function atLeast(version, min) {
    for (let i = 0; i < min.length; i++) {
        if ((version[i] || 0) !== min[i]) return (version[i] || 0) > min[i];
    }
    return true;
}

function hasAll(dir) {
    return !!dir && VC_RUNTIME_DLLS.every(name => fs.existsSync(path.join(dir, name)));
}

function fromVisualStudio() {
    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (!fs.existsSync(vswhere)) return null;
    let installs = [];
    try {
        installs = execFileSync(vswhere, ['-all', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' })
            .split(/\r?\n/).filter(Boolean);
    } catch {
        return null;
    }
    const candidates = [];
    for (const install of installs) {
        const redist = path.join(install, 'VC', 'Redist', 'MSVC');
        if (!fs.existsSync(redist)) continue;
        for (const version of fs.readdirSync(redist)) {
            const x64 = path.join(redist, version, 'x64');
            if (!fs.existsSync(x64)) continue;
            for (const crt of fs.readdirSync(x64).filter(name => /^Microsoft\.VC\d+\.CRT$/i.test(name))) {
                const dir = path.join(x64, crt);
                if (hasAll(dir)) candidates.push({ dir, version: versionTuple(version) });
            }
        }
    }
    candidates.sort((a, b) => {
        for (let i = 0; i < 3; i++) {
            if (a.version[i] !== b.version[i]) return (b.version[i] || 0) - (a.version[i] || 0);
        }
        return 0;
    });
    return candidates[0] || null;
}

function findVcRuntime() {
    const override = process.env.PICGEN_VCRUNTIME_DIR;
    if (override) {
        if (!hasAll(override)) throw new Error(`PICGEN_VCRUNTIME_DIR is missing one of ${VC_RUNTIME_DLLS.join(', ')}`);
        return { dir: override, version: null, source: 'env' };
    }
    const found = fromVisualStudio();
    if (!found) throw new Error('x64 VC++ runtime DLLs not found. Install "MSVC v14x build tools" (Visual Studio Build Tools) or set PICGEN_VCRUNTIME_DIR to a Microsoft.VC14x.CRT folder.');
    if (!atLeast(found.version, MIN_VERSION)) throw new Error(`VC++ redist ${found.version.join('.')} is older than ${MIN_VERSION.join('.')}`);
    return { ...found, source: 'vswhere' };
}

module.exports = { VC_RUNTIME_DLLS, MIN_VERSION, findVcRuntime };

if (require.main === module) console.log(findVcRuntime());
