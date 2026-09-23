'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Read-only view of the automation platform's directory.
 *
 * Everything here inspects the platform; nothing writes to it. The platform's own CLI is the only
 * thing that ever changes its contents, which is what keeps the dashboard from being able to
 * corrupt a working checkout. Suites and reports are read straight off disk rather than by parsing
 * CLI output, because the files carry titles, step counts and timestamps that the CLI's text
 * summary does not.
 */

const APPS_SUBPATH = path.join('artifacts', 'apps');
/** Module folder names the platform stores suites under, in the order worth showing them. */
const KNOWN_MODULES = ['manual', 'login', 'sign-up', 'hamburger-menu'];

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function platformPaths(automationDir) {
  return {
    root: automationDir,
    cli: path.join(automationDir, 'dist', 'main.js'),
    appsDir: path.join(automationDir, APPS_SUBPATH),
    parallelRunner: path.join(automationDir, 'tools', 'run-parallel.js'),
  };
}

/** Whether the platform looks usable: the directory exists and has been built. */
function platformStatus(automationDir) {
  const p = platformPaths(automationDir);
  const dirExists = automationDir !== '' && fs.existsSync(p.root);
  return {
    automationDir: toPosix(automationDir),
    dirExists,
    built: dirExists && fs.existsSync(p.cli),
    hasParallelRunner: dirExists && fs.existsSync(p.parallelRunner),
  };
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Lists every app the platform has data for, with its stored suites.
 *
 * A "test case" here is one JSON file under artifacts/apps/<package>/test-cases/<module>/. Titles
 * and step counts are read from the files so the dashboard can show a person something meaningful
 * to choose from rather than a bare UUID.
 */
function listApps(automationDir) {
  const { appsDir } = platformPaths(automationDir);
  if (!fs.existsSync(appsDir)) return [];

  const apps = [];
  for (const pkg of fs.readdirSync(appsDir)) {
    const appDir = path.join(appsDir, pkg);
    if (!fs.statSync(appDir).isDirectory()) continue;

    const testCasesDir = path.join(appDir, 'test-cases');
    const modules = [];
    if (fs.existsSync(testCasesDir)) {
      const names = fs.readdirSync(testCasesDir).filter((n) => {
        try {
          return fs.statSync(path.join(testCasesDir, n)).isDirectory();
        } catch {
          return false;
        }
      });
      // Show the modules the platform knows about first, then anything else it happens to hold.
      names.sort((a, b) => {
        const ia = KNOWN_MODULES.indexOf(a);
        const ib = KNOWN_MODULES.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
      });
      for (const moduleName of names) {
        const dir = path.join(testCasesDir, moduleName);
        const cases = [];
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
          const json = safeReadJson(path.join(dir, file));
          if (!json) continue;
          cases.push({
            id: path.basename(file, '.json'),
            title: json.title || '(untitled)',
            steps: Array.isArray(json.steps) ? json.steps.length : 0,
            sequence: json.sequence ?? null,
            tags: json.tags || [],
          });
        }
        cases.sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999) || a.title.localeCompare(b.title));
        if (cases.length) modules.push({ name: moduleName, cases });
      }
    }

    const counts = {};
    for (const sub of ['screen-repository', 'element-repository', 'screenshots']) {
      const d = path.join(appDir, sub);
      counts[sub] = fs.existsSync(d) ? fs.readdirSync(d).length : 0;
    }

    // The navigation graph is what a crawl leaves behind, and it is exactly what the platform
    // demands before it will build tests from a written flow. Reporting it lets the dashboard say
    // so while an app is being chosen, instead of letting the CLI fail after the run has started.
    const crawled = fs.existsSync(path.join(appDir, 'navigation-graph.json'));

    apps.push({
      package: pkg,
      crawled,
      modules,
      totalCases: modules.reduce((n, m) => n + m.cases.length, 0),
      totalSteps: modules.reduce((n, m) => n + m.cases.reduce((s, c) => s + c.steps, 0), 0),
      screensMapped: counts['screen-repository'],
      elementsMapped: counts['element-repository'],
      screenshots: counts.screenshots,
      reports: listReports(automationDir, pkg).length,
    });
  }
  apps.sort((a, b) => a.package.localeCompare(b.package));
  return apps;
}

/** Run reports for one app, newest first. */
function listReports(automationDir, pkg) {
  const dir = path.join(platformPaths(automationDir).appsDir, pkg, 'reports');
  if (!fs.existsSync(dir)) return [];
  const reports = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const full = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    // The JSON report nests its counts under `summary`; they are not top-level. Both shapes are
    // accepted so a future report format that flattens them keeps working rather than silently
    // showing blank verdicts, which is how this was noticed.
    const json = safeReadJson(full.replace(/\.html$/, '.json'));
    const counts = json?.summary ?? json ?? {};
    reports.push({
      file,
      modifiedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
      generatedAt: json?.generatedAt ?? null,
      total: counts.totalTestCases ?? null,
      passed: counts.passed ?? null,
      failed: counts.failed ?? null,
    });
  }
  reports.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return reports;
}

/** Absolute path of a report file, refusing anything that escapes the app's reports folder. */
function resolveReportPath(automationDir, pkg, file) {
  const dir = path.join(platformPaths(automationDir).appsDir, pkg, 'reports');
  const full = path.resolve(dir, file);
  // Path traversal guard: a crafted file name must not be able to read outside the reports folder.
  if (!full.startsWith(path.resolve(dir) + path.sep)) return null;
  return fs.existsSync(full) ? full : null;
}

/** Connected devices, via adb. */
function listDevices(adbPath) {
  return new Promise((resolve) => {
    execFile(adbPath, ['devices', '-l'], { timeout: 15000 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, error: error.message, devices: [] });
        return;
      }
      const devices = [];
      for (const line of String(stdout).split(/\r?\n/).slice(1)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [serial, state, ...rest] = trimmed.split(/\s+/);
        if (!serial || !state) continue;
        const info = rest.join(' ');
        const model = /model:(\S+)/.exec(info)?.[1] || '';
        devices.push({ serial, state, model: model.replace(/_/g, ' ') });
      }
      resolve({ ok: true, devices });
    });
  });
}

/**
 * Apps installed on one phone.
 *
 * This exists so an app can be explored without hunting down its .apk: most apps on a test phone
 * were installed by someone else and the file is long gone. Third-party apps only by default —
 * a phone carries a couple of hundred system packages nobody wants to scroll past.
 */
function listInstalledPackages(adbPath, serial, { includeSystem = false } = {}) {
  return new Promise((resolve) => {
    const args = ['-s', serial, 'shell', 'pm', 'list', 'packages'];
    if (!includeSystem) args.push('-3');
    execFile(adbPath, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, error: error.message, packages: [] });
        return;
      }
      const packages = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('package:'))
        .map((line) => line.slice('package:'.length).trim())
        .filter(Boolean);
      packages.sort((a, b) => a.localeCompare(b));
      resolve({ ok: true, packages });
    });
  });
}

/**
 * Where a package's APK files sit on the phone.
 *
 * More than one path means a split install — the Play Store's normal shape — where the app is
 * delivered as a base plus per-density/per-language pieces. The platform installs a single .apk,
 * and Android rejects a base-only reinstall over a split with INSTALL_FAILED_MISSING_SPLIT, so
 * the count is what tells the caller whether pulling can work at all.
 */
function apkPathsOnDevice(adbPath, serial, packageName) {
  return new Promise((resolve) => {
    execFile(adbPath, ['-s', serial, 'shell', 'pm', 'path', packageName], { timeout: 20000 }, (error, stdout, stderr) => {
      // `pm path` exits non-zero and says nothing at all when the package simply is not installed,
      // which is a normal answer rather than a failure. A real problem — an offline or unauthorised
      // phone — always explains itself on stderr, so silence is what separates the two.
      if (error && String(stderr).trim()) {
        resolve({ ok: false, error: String(stderr).trim(), paths: [] });
        return;
      }
      if (error && !String(stdout).includes('package:')) {
        resolve({ ok: true, paths: [] });
        return;
      }
      const paths = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('package:'))
        .map((line) => line.slice('package:'.length).trim())
        .filter(Boolean);
      resolve({ ok: true, paths });
    });
  });
}

/** Copies one file off the phone. Generous timeout: an APK can be a few hundred MB. */
function pullFile(adbPath, serial, remotePath, destPath) {
  return new Promise((resolve) => {
    execFile(
      adbPath,
      ['-s', serial, 'pull', remotePath, destPath],
      { timeout: 300000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: String(stderr || error.message).trim() });
          return;
        }
        resolve({ ok: true, output: String(stdout).trim() });
      },
    );
  });
}

/**
 * The platform's per-device account assignments, read only so the dashboard can warn before a run.
 *
 * The multi-device runner refuses to start unless every device has its own account, and it says so
 * only once it is already running. Reading the same file here lets the UI point at the missing
 * mapping while the run is still being set up, which is when it can actually be fixed.
 */
function readDeviceAccounts(automationDir) {
  const file = path.join(automationDir, 'config', 'test-accounts.json');
  if (!fs.existsSync(file)) return { exists: false, byPackage: {} };
  const json = safeReadJson(file);
  if (!json) return { exists: true, readable: false, byPackage: {} };

  const byPackage = {};
  for (const [pkg, entry] of Object.entries(json)) {
    if (!entry || typeof entry !== 'object') continue;
    byPackage[pkg] = {
      accounts: Object.keys(entry.accounts || {}),
      deviceAccounts: { ...(entry.deviceAccounts || {}) },
    };
  }
  return { exists: true, readable: true, byPackage };
}

module.exports = {
  platformPaths,
  platformStatus,
  listApps,
  listReports,
  resolveReportPath,
  listDevices,
  listInstalledPackages,
  apkPathsOnDevice,
  pullFile,
  readDeviceAccounts,
  toPosix,
};
