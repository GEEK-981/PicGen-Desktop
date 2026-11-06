// Uploads dist/site to the landing-page server as a new release and switches the
// `current` symlink to it (atomic: visitors never see a half-uploaded site).
//   npm run build:site && node scripts/deploy-site.js
// Server details live in site/deploy.local.json (git-ignored, never committed):
//   { "host": "root@203.0.113.10", "key": "C:/Users/me/.ssh/server.pem", "root": "/var/www/picgen", "keep": 3 }
// The nginx site points at <root>/current; older releases beyond `keep` are removed.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'dist', 'site');
const CONFIG = path.join(ROOT, 'site', 'deploy.local.json');

function run(command, args, options = {}) {
    return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options });
}

function main() {
    if (!fs.existsSync(CONFIG)) throw new Error(`缺少 ${path.relative(ROOT, CONFIG)}（host / key / root），见脚本开头的说明`);
    const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const { host, key, root = '/var/www/picgen', keep = 3 } = config;
    if (!host || !key) throw new Error('deploy.local.json 需要 host 和 key');
    if (!/^\/[\w./-]+$/.test(root)) throw new Error(`root 路径不安全: ${root}`);
    if (!fs.existsSync(path.join(SITE, 'index.html')) || !fs.existsSync(path.join(SITE, 'version.json'))) {
        throw new Error('dist/site 不完整，先运行 npm run build:site');
    }
    const version = JSON.parse(fs.readFileSync(path.join(SITE, 'version.json'), 'utf8')).version;
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
    const release = `${version}-${stamp}`;
    const ssh = ['-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes'];
    const archive = path.join(os.tmpdir(), `picgen-site-${stamp}.tgz`);

    console.log(`打包 dist/site → ${release}`);
    // Relative archive name: GNU tar reads "C:\..." as a remote host "C".
    run('tar', ['-czf', path.basename(archive), '-C', SITE, '.'], { cwd: os.tmpdir() });
    console.log(`上传到 ${host}`);
    run('scp', [...ssh, archive, `${host}:/tmp/picgen-site-${stamp}.tgz`]);
    fs.rmSync(archive, { force: true });
    const remote = [
        'set -e',
        `dir=${root}/releases/${release}`,
        'mkdir -p "$dir"',
        `tar -xzf /tmp/picgen-site-${stamp}.tgz -C "$dir"`,
        `rm -f /tmp/picgen-site-${stamp}.tgz`,
        `chown -R www-data:www-data ${root}`,
        `ln -sfn "$dir" ${root}/current`,
        // Keep the newest `keep` releases; never the one just linked.
        `ls -1dt ${root}/releases/*/ | tail -n +${Number(keep) + 1} | grep -v "/${release}/" | xargs -r rm -rf`,
        `ls -1 ${root}/releases`
    ].join(' && ');
    console.log(run('ssh', [...ssh, host, remote]));
    console.log(`已切换到 ${release}`);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
