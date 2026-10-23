const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// Only deterministic unit/integration tests. Never auto-discover live-provider scripts.
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test'))
    .filter(name => name.endsWith('.test.js'))
    .sort()
    .map(name => path.join(root, 'test', name));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-tests-'));
const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: sandbox,
    env: {
        ...process.env,
        PICGEN_PROVIDER_STORE: path.join(sandbox, 'api-providers.json'),
        PICGEN_CHAT_PROVIDER_STORE: path.join(sandbox, 'chat-providers.json'),
        PICGEN_FAILOVER_CONFIG: path.join(sandbox, 'failover-config.json'),
        PICGEN_PROXY_CONFIG: path.join(sandbox, 'proxy-config.json')
    },
    stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
