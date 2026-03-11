import { spawn, spawnSync } from 'child_process';

const entry = 'dist/index.js';

function wireChild(child) {
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    console.error(error);
    process.exit(1);
  });
}

if (process.platform === 'win32') {
  spawnSync(process.env.comspec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'chcp 65001>nul'], {
    stdio: 'ignore',
    env: process.env,
    cwd: process.cwd(),
  });
}

const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd(),
});

wireChild(child);
