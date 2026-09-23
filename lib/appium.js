'use strict';

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');

/**
 * Starts, stops and checks the Appium server the platform talks to.
 *
 * The dashboard manages this because the platform's CLI does NOT start Appium itself — it expects
 * one to already be listening and fails immediately if not. That is a reasonable thing for a
 * developer to remember and an unreasonable thing to ask of someone using a dashboard, so the
 * status is shown and a button starts it.
 */
let child = null;

function isRunning(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function start({ port, cwd, onLine }) {
  if (await isRunning(port)) return { started: false, alreadyRunning: true };
  if (child) return { started: false, alreadyRunning: false, note: 'a start is already in progress' };

  // npx resolves the platform's own Appium install, so the dashboard needs no copy of its own.
  // shell:true is required on Windows for npx, which is a .cmd shim rather than an executable.
  const isWindows = os.platform() === 'win32';
  child = spawn('npx', ['--no-install', 'appium', '--port', String(port), '--log-level', 'error'], {
    cwd,
    windowsHide: true,
    shell: isWindows,
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d) => onLine?.(String(d).trimEnd()));
  child.stderr?.on('data', (d) => onLine?.(String(d).trimEnd()));
  child.on('close', () => {
    child = null;
  });

  // Wait for it to answer rather than reporting success the moment the process is spawned.
  for (let waited = 0; waited < 30000; waited += 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isRunning(port)) return { started: true, alreadyRunning: false };
  }
  return { started: false, alreadyRunning: false, note: 'Appium did not answer within 30 seconds' };
}

function stop(port) {
  return new Promise((resolve) => {
    if (os.platform() === 'win32') {
      // Find whatever is listening on the port and kill its tree. The spawned npx shim is not the
      // process that ends up holding the port, so killing our own child handle is not enough.
      const finder = spawn('cmd', ['/c', `netstat -ano | findstr :${port} | findstr LISTENING`], {
        windowsHide: true,
        shell: false,
      });
      let out = '';
      finder.stdout.on('data', (d) => {
        out += d;
      });
      finder.on('close', () => {
        const pids = new Set(
          out
            .split(/\r?\n/)
            .map((l) => l.trim().split(/\s+/).pop())
            .filter((p) => p && /^\d+$/.test(p) && p !== '0'),
        );
        if (!pids.size) {
          resolve({ stopped: false, note: 'nothing was listening on that port' });
          return;
        }
        let remaining = pids.size;
        for (const pid of pids) {
          const kill = spawn('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true, shell: false });
          kill.on('close', () => {
            remaining -= 1;
            if (remaining === 0) resolve({ stopped: true, pids: [...pids] });
          });
        }
      });
      return;
    }
    if (child) {
      child.kill('SIGTERM');
      resolve({ stopped: true });
      return;
    }
    resolve({ stopped: false, note: 'not started by this dashboard' });
  });
}

module.exports = { isRunning, start, stop };
