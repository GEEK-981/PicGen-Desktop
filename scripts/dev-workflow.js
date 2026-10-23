const { spawn, exec } = require('child_process');
const path = require('path');

let electronProcess = null;
let isBuilding = false;

// 查找开发版 PicGen 进程（排除稳定版）
async function findDevElectronProcess() {
  return new Promise((resolve) => {
    exec('wmic process where "name=\'electron.exe\'" get processid,commandline /format:list', (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }

      const lines = stdout.split('\n').filter(line => line.trim());
      const processes = [];
      let current = {};

      for (const line of lines) {
        if (line.includes('CommandLine=')) {
          current.cmd = line.split('CommandLine=')[1] || '';
        } else if (line.includes('ProcessId=')) {
          current.pid = line.split('ProcessId=')[1]?.trim();
          if (current.cmd && current.pid) {
            processes.push({ ...current });
          }
          current = {};
        }
      }

      // 查找包含当前工作目录的进程（开发版）
      const devProcess = processes.find(p =>
        p.cmd.includes(__dirname) && !p.cmd.includes('portable')
      );

      resolve(devProcess?.pid || null);
    });
  });
}

// 关闭开发版 Electron
async function closeDevElectron() {
  const pid = await findDevElectronProcess();
  if (pid) {
    console.log(`[DEV] 关闭开发版 Electron (PID: ${pid})`);
    return new Promise((resolve) => {
      exec(`taskkill /PID ${pid} /F`, () => {
        setTimeout(resolve, 1000); // 等待进程完全关闭
      });
    });
  }
}

// 构建 UI
function buildUI() {
  return new Promise((resolve, reject) => {
    if (isBuilding) {
      console.log('[DEV] 构建正在进行中...');
      return resolve();
    }

    isBuilding = true;
    console.log('[DEV] 开始构建前端...');

    const build = spawn('npm', ['run', 'build:ui'], {
      stdio: 'inherit',
      shell: true,
    });

    build.on('close', (code) => {
      isBuilding = false;
      if (code === 0) {
        console.log('[DEV] ✅ 构建完成');
        resolve();
      } else {
        console.error('[DEV] ❌ 构建失败');
        reject(new Error('Build failed'));
      }
    });
  });
}

// 启动 Electron
function startElectron() {
  if (electronProcess) {
    console.log('[DEV] Electron 已经在运行中');
    return;
  }

  console.log('[DEV] 启动 Electron...');
  electronProcess = spawn('npm', ['run', 'desktop'], {
    stdio: 'inherit',
    shell: true,
    detached: false,
  });

  electronProcess.on('close', (code) => {
    console.log(`[DEV] Electron 已退出 (code: ${code})`);
    electronProcess = null;
  });
}

// 主流程
async function devWorkflow() {
  try {
    // 1. 关闭开发版 Electron
    await closeDevElectron();

    // 2. 构建
    await buildUI();

    // 3. 启动
    startElectron();

    console.log('\n[DEV] 🎉 开发版已启动\n');
  } catch (error) {
    console.error('[DEV] 启动失败:', error.message);
    process.exit(1);
  }
}

// 导出函数供外部调用
if (require.main === module) {
  devWorkflow();
} else {
  module.exports = { devWorkflow, closeDevElectron, buildUI, startElectron };
}
