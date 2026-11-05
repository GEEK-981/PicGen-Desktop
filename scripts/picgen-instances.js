// Close running PicGen clients before a portable build (a running portable
// launcher locks its EXE) and start the fresh build afterwards. Windows only.
//
// A client is never killed while it still has queued or running generation
// tasks: those are paid requests whose results would be lost. The build waits
// for them, and gives up (without killing) after `waitForTasksMs`.
const { execFile, spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

function powershell(command) {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
            { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout || '').trim())));
    });
}

function asArray(json) {
    if (!json) return [];
    const value = JSON.parse(json);
    return Array.isArray(value) ? value : [value];
}

async function listPicGenProcesses() {
    const json = await powershell("Get-CimInstance Win32_Process -Filter \"Name like 'PicGen%'\" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress");
    return asArray(json).map(item => ({ pid: item.ProcessId, parentPid: item.ParentProcessId, name: item.Name, path: item.ExecutablePath || '' }));
}

async function listeningPorts(pids) {
    if (!pids.length) return [];
    const json = await powershell(`Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue | Where-Object { @(${pids.join(',')}) -contains $_.OwningProcess } | Select-Object LocalPort | ConvertTo-Json -Compress`);
    return [...new Set(asArray(json).map(item => item.LocalPort))];
}

function getJson(port, route, timeoutMs = 3000) {
    return new Promise(resolve => {
        const request = http.get({ host: '127.0.0.1', port, path: route, timeout: timeoutMs }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                if (response.statusCode !== 200) return resolve(null);
                try { resolve(JSON.parse(body)); } catch { resolve(null); }
            });
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(null));
    });
}

// Counts pending/running tasks across every local PicGen API (the MCP port
// rejects the unauthenticated request and is skipped).
async function activeTaskCount(processes) {
    const ports = await listeningPorts(processes.map(item => item.pid));
    let count = 0;
    for (const port of ports) {
        const tasks = await getJson(port, '/api/tasks?status=pending,running');
        if (Array.isArray(tasks)) count += tasks.length;
        else if (Array.isArray(tasks?.tasks)) count += tasks.tasks.length;
    }
    return count;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function closeRunningPicGen({ waitForTasksMs = 10 * 60 * 1000, log = console.log } = {}) {
    if (process.platform !== 'win32') return [];
    let processes = await listPicGenProcesses();
    if (!processes.length) return [];
    const deadline = Date.now() + waitForTasksMs;
    for (;;) {
        const active = await activeTaskCount(processes);
        if (!active) break;
        if (Date.now() >= deadline) {
            throw new Error(`PicGen 仍有 ${active} 个生成任务未完成，已停止打包（未关闭客户端）。等任务结束后重试。`);
        }
        log(`PicGen 还有 ${active} 个生成任务在进行，等待完成后再关闭…`);
        await sleep(10000);
        processes = await listPicGenProcesses();
        if (!processes.length) return [];
    }
    const pids = new Set(processes.map(item => item.pid));
    // Kill each process tree from its top-most PicGen process (the portable launcher).
    const roots = processes.filter(item => !pids.has(item.parentPid));
    log(`关闭运行中的 PicGen：${roots.map(item => `${item.name} (${item.pid})`).join(', ')}`);
    await powershell(roots.map(item => `taskkill /F /T /PID ${item.pid} 2>$null | Out-Null`).join('; ')).catch(() => {});
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!(await listPicGenProcesses()).length) break;
        await sleep(500);
    }
    return roots;
}

function launchPicGen(executable) {
    if (process.platform !== 'win32') return null;
    const child = spawn(executable, [], { cwd: path.dirname(executable), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return child.pid;
}

module.exports = { listPicGenProcesses, activeTaskCount, closeRunningPicGen, launchPicGen };
