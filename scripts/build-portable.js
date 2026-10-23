// Build away from live portable profiles. Only the finished executable is
// promoted into dist/release; builder cleanup never sees that directory.
const fs = require('node:fs');
const path = require('node:path');
const { ensureModels } = require('./fetch-models');

function promoteArtifact(source, destination, rename = fs.renameSync) {
    const pending = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`);
    fs.copyFileSync(source, pending, fs.constants.COPYFILE_EXCL);
    try {
        rename(pending, destination);
        return destination;
    } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        // A running Windows portable launcher locks its EXE. Publish alongside
        // it so the user can exit and switch versions when ready.
        const alternate = destination.replace(/\.exe$/i, `-updated-${Date.now()}.exe`);
        fs.renameSync(pending, alternate);
        return alternate;
    }
}

async function buildPortable({ root = path.resolve(__dirname, '..'), unpacked = false, build } = {}) {
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    // Real builds only (tests inject `build`): the model ships as an extraResource, so make sure
    // it exists and matches its sha256 pin before electron-builder starts (downloads on a cold cache).
    if (!build) await ensureModels({ root });
    const staging = fs.mkdtempSync(path.join(dist, '.portable-build-'));
    const options = {
        projectDir: root,
        config: { directories: { output: staging }, electronDist: path.join(root, 'node_modules', 'electron', 'dist') },
        publish: 'never'
    };
    if (!build) {
        const builder = require('electron-builder');
        options.targets = builder.Platform.WINDOWS.createTarget(unpacked ? ['dir'] : ['portable'], builder.Arch.x64);
        build = builder.build;
    }
    await build(options);
    if (unpacked) return [path.join(staging, 'win-unpacked')];

    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const name = `${pkg.build.productName}-${pkg.version}-x64.exe`;
    if (path.basename(name) !== name) throw new Error('Invalid portable artifact name');
    const source = path.join(staging, name);
    if (!fs.statSync(source).isFile()) throw new Error('Portable artifact missing');
    const output = path.join(dist, 'release');
    fs.mkdirSync(output, { recursive: true });
    const destination = path.join(output, name);
    return [promoteArtifact(source, destination)];
}

if (require.main === module) {
    buildPortable({ unpacked: process.argv.includes('--dir') }).then(paths => {
        for (const artifact of paths) console.log(`Built: ${artifact}`);
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { buildPortable, promoteArtifact };
