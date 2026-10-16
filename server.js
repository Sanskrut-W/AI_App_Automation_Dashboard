'use strict';

/**
 * Dashboard for the AI mobile test automation platform.
 *
 * Design rule: this application drives the platform from the OUTSIDE. It runs the platform's own
 * CLI as a child process and reads its artifacts folder, and it never writes anything into the
 * platform's directory. Uploads land here, in this app's own uploads/ folder. That is what makes
 * it safe to point at a working checkout — the worst it can do is run a command a developer could
 * have typed.
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const { loadConfig, saveConfig } = require('./lib/config');
const platform = require('./lib/platform');
const appium = require('./lib/appium');
const { JobRunner } = require('./lib/jobs');
const { createRunQueue } = require('./lib/queue');

const config = loadConfig();
const app = express();
const jobs = new JobRunner();

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/** Uploads keep their original name, prefixed with a timestamp so re-uploads never collide. */
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const ok = (res, body) => res.json({ ok: true, ...body });
const fail = (res, message, code = 400) => res.status(code).json({ ok: false, error: message });

/** Status as the browser should see it: the running job plus anything waiting behind it. */
const statusWithQueue = () => ({ ...jobs.status(), queue: runQueue.state() });

const runQueue = createRunQueue(jobs, {
  // The runner emits its own status when a job starts; this covers the changes it cannot see,
  // such as a batch being abandoned with nothing new started in its place.
  onChange: () => jobs.emit('status', statusWithQueue()),
});

const startRuns = (runs) => ({ ...runQueue.start(runs), queue: runQueue.state() });

/** Every run needs the platform present and built; say so once, clearly, rather than per-endpoint. */
function requirePlatform(res) {
  const status = platform.platformStatus(config.automationDir);
  if (!status.dirExists) {
    fail(res, `The automation folder was not found: ${status.automationDir}. Set it in Settings.`, 409);
    return null;
  }
  if (!status.built) {
    fail(res, 'The automation platform has not been built yet. Press "Build platform" first.', 409);
    return null;
  }
  return status;
}

/**
 * Confirms a run can actually get off the ground, before one is started.
 *
 * Each of these used to surface minutes later as a stack trace, at the bottom of a console already
 * carrying thousands of webdriver lines — the platform's CLI does not start Appium and fails the
 * moment it cannot reach it, and a phone that has been unplugged since the page loaded looks
 * perfectly fine in the browser. Checking at the point of pressing the button costs a second and
 * turns all of that into one sentence naming the thing to fix.
 *
 * The engine is started rather than merely reported: needing it running is an implementation
 * detail of the platform, not a decision anyone using a dashboard should have to make.
 */
async function preflightDevice(res, device, { onProgress } = {}) {
  const listed = await platform.listDevices(config.adbPath);
  if (!listed.ok) {
    fail(res, `adb could not be run, so no phone can be reached: ${listed.error}`, 503);
    return false;
  }
  const found = listed.devices.find((d) => d.serial === device);
  if (!found) {
    const others = listed.devices.filter((d) => d.state === 'device').map((d) => d.serial);
    fail(
      res,
      `The phone ${device} is no longer connected.` +
        (others.length ? ` Connected now: ${others.join(', ')}.` : ' No phone is connected at all.') +
        ' Press Refresh under "Choose a phone".',
      409,
    );
    return false;
  }
  if (found.state !== 'device') {
    fail(
      res,
      found.state === 'unauthorized'
        ? `The phone ${device} has not allowed USB debugging. Unlock it and accept the prompt, then press Refresh.`
        : `The phone ${device} is "${found.state}" rather than ready. Reconnect it and press Refresh.`,
      409,
    );
    return false;
  }

  if (!(await appium.isRunning(config.appiumPort))) {
    onProgress?.('starting the test engine');
    const started = await appium.start({ port: config.appiumPort, cwd: config.automationDir, onLine: () => {} });
    if (!started.started && !started.alreadyRunning) {
      fail(
        res,
        `The test engine could not be started, so nothing can talk to the phone${started.note ? ` (${started.note})` : ''}. ` +
          'Try "Start test engine" and watch for an error.',
        503,
      );
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

app.get('/api/health', async (_req, res) => {
  const status = platform.platformStatus(config.automationDir);
  const devices = await platform.listDevices(config.adbPath);
  ok(res, {
    platform: status,
    appium: { port: config.appiumPort, running: await appium.isRunning(config.appiumPort) },
    adb: { ok: devices.ok, error: devices.error || null, deviceCount: devices.devices.length },
    job: statusWithQueue(),
    config: { automationDir: status.automationDir, port: config.port, appiumPort: config.appiumPort },
  });
});

app.get('/api/devices', async (_req, res) => {
  const result = await platform.listDevices(config.adbPath);
  if (!result.ok) return fail(res, `adb could not be run: ${result.error}`, 500);
  ok(res, { devices: result.devices });
});

/** Apps installed on one phone, flagged with whether the platform has already explored them. */
app.get('/api/devices/:serial/packages', async (req, res) => {
  const result = await platform.listInstalledPackages(config.adbPath, req.params.serial, {
    includeSystem: req.query.all === '1',
  });
  if (!result.ok) return fail(res, `Could not list the apps on that phone: ${result.error}`, 500);
  const explored = new Set(platform.listApps(config.automationDir).map((a) => a.package));
  ok(res, { packages: result.packages.map((name) => ({ name, explored: explored.has(name) })) });
});

/** Per-device account assignments, so the UI can flag a missing one before a multi-device run. */
app.get('/api/parallel/accounts', (_req, res) => {
  ok(res, platform.readDeviceAccounts(config.automationDir));
});

app.get('/api/apps', (_req, res) => {
  const status = platform.platformStatus(config.automationDir);
  if (!status.dirExists) return fail(res, `Automation folder not found: ${status.automationDir}`, 409);
  ok(res, { apps: platform.listApps(config.automationDir) });
});

app.get('/api/apps/:pkg/reports', (req, res) => {
  ok(res, { reports: platform.listReports(config.automationDir, req.params.pkg) });
});

/**
 * Serves an app's artifact files — the HTML reports and the screenshots they link to.
 *
 * The URL deliberately mirrors the on-disk layout, because the report's <img> tags are relative:
 * the platform writes them as "../execution-screenshots/step-1-….png", relative to the report's
 * own folder. A browser resolves that against the URL, not the file, so serving a report from a
 * flat path silently strips the package segment and every screenshot 404s — which is exactly why
 * reports opened from the dashboard showed no images while the same file opened from disk did.
 * Keeping /artifacts/<pkg>/reports/<file> parallel to the folder structure makes the same
 * relative link land on /artifacts/<pkg>/execution-screenshots/<file>, which is where it lives.
 *
 * Built per automation folder rather than once at startup: the folder is a setting, and it can be
 * repointed at another checkout without restarting the dashboard.
 */
const artifactHandlers = new Map();
function artifactsStatic() {
  const { appsDir } = platform.platformPaths(config.automationDir);
  let handler = artifactHandlers.get(appsDir);
  if (!handler) {
    handler = express.static(appsDir, { index: false, dotfiles: 'deny', fallthrough: true });
    artifactHandlers.set(appsDir, handler);
  }
  return handler;
}

app.use('/artifacts', (req, res, next) => {
  const { appsDir } = platform.platformPaths(config.automationDir);
  if (!fs.existsSync(appsDir)) return res.status(404).send('No artifacts folder yet.');
  return artifactsStatic()(req, res, next);
});

/** Older links (and any bookmarks) still work; they land on the layout-mirroring URL above. */
app.get('/report/:pkg/:file', (req, res) => {
  const full = platform.resolveReportPath(config.automationDir, req.params.pkg, req.params.file);
  if (!full) return res.status(404).send('Report not found.');
  res.redirect(302, `/artifacts/${encodeURIComponent(req.params.pkg)}/reports/${encodeURIComponent(req.params.file)}`);
});

app.post('/api/settings', (req, res) => {
  const { automationDir } = req.body || {};
  if (typeof automationDir !== 'string' || !automationDir.trim()) {
    return fail(res, 'Provide the folder that contains the automation platform.');
  }
  const normalised = automationDir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!fs.existsSync(normalised)) return fail(res, `That folder does not exist: ${normalised}`);
  saveConfig({ automationDir: normalised });
  config.automationDir = normalised;
  ok(res, { automationDir: normalised });
});

// ---------------------------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------------------------

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return fail(res, 'No file was received.');
  ok(res, {
    path: platform.toPosix(req.file.path),
    name: req.file.originalname,
    sizeBytes: req.file.size,
  });
});

/**
 * Copies an already-installed app off the phone, so it can be explored without its .apk file.
 *
 * The platform's crawl needs a file: it reads the manifest for the package name and launcher
 * activity, then installs it. Almost no one still has the .apk of an app someone else installed
 * months ago, which made "explore a new app" unusable for the common case. Pulling the installed
 * APK back off the phone gives the platform exactly the file it expects, with no change to it and
 * nothing written outside this app's own uploads folder.
 *
 * A split install is refused rather than half-handled: Android rejects reinstalling a base-only
 * APK over one, so pulling just the base would fail later with INSTALL_FAILED_MISSING_SPLIT — a
 * message that explains nothing at the point it appears.
 */
app.post('/api/device-apk/pull', async (req, res) => {
  const { device, pkg } = req.body || {};
  if (!device) return fail(res, 'Choose a phone first.');
  if (!pkg || !/^[A-Za-z0-9_][\w.]*$/.test(pkg)) return fail(res, 'Choose an app from the phone.');

  const found = await platform.apkPathsOnDevice(config.adbPath, device, pkg);
  if (!found.ok) return fail(res, `Could not ask the phone about ${pkg}: ${found.error}`, 500);
  if (!found.paths.length) return fail(res, `${pkg} is not installed on that phone.`, 404);
  if (found.paths.length > 1) {
    return fail(
      res,
      `${pkg} is installed in ${found.paths.length} parts (a split install, which is how the ` +
        'Play Store delivers apps). The platform installs a single .apk, so this one needs its ' +
        'original .apk file.',
      409,
    );
  }

  const destination = path.join(UPLOAD_DIR, `${Date.now()}-${pkg}.apk`);
  const pulled = await platform.pullFile(config.adbPath, device, found.paths[0], destination);
  if (!pulled.ok) return fail(res, `Could not copy ${pkg} off the phone: ${pulled.error}`, 500);

  let sizeBytes;
  try {
    sizeBytes = fs.statSync(destination).size;
  } catch {
    return fail(res, `The copy reported success but no file arrived for ${pkg}.`, 500);
  }
  ok(res, {
    path: platform.toPosix(destination),
    name: `${pkg}.apk`,
    sizeBytes,
    source: found.paths[0],
  });
});

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

app.get('/api/job', (_req, res) => ok(res, { ...statusWithQueue(), lines: jobs.history() }));

app.post('/api/job/stop', (_req, res) => {
  // Stop means stop: anything queued behind this run is dropped too, which is what someone
  // pressing it during a seventeen-set batch means by it.
  const dropped = runQueue.clear();
  if (dropped) {
    runQueue.clear(`${dropped} queued set${dropped === 1 ? '' : 's'} cancelled as well.`);
  }
  const stopped = jobs.stop();
  ok(res, { stopped });
});

/** Server-sent events: one stream of output lines and status changes for the running job. */
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Replay what has already happened, so a reload mid-run is not a blank console.
  send('status', statusWithQueue());
  for (const line of jobs.history()) send('line', line);

  const onLine = (line) => send('line', line);
  // Re-read rather than forwarding the runner's payload, so every status carries the queue.
  const onStatus = () => send('status', statusWithQueue());
  jobs.on('line', onLine);
  jobs.on('status', onStatus);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    jobs.off('line', onLine);
    jobs.off('status', onStatus);
  });
});

app.post('/api/appium/start', async (_req, res) => {
  const status = platform.platformStatus(config.automationDir);
  if (!status.dirExists) return fail(res, 'Set the automation folder first.', 409);
  const result = await appium.start({
    port: config.appiumPort,
    cwd: config.automationDir,
    onLine: () => {},
  });
  ok(res, result);
});

app.post('/api/appium/stop', async (_req, res) => ok(res, await appium.stop(config.appiumPort)));

app.post('/api/platform/build', (_req, res) => {
  const status = platform.platformStatus(config.automationDir);
  if (!status.dirExists) return fail(res, 'Set the automation folder first.', 409);
  try {
    // npm is a shim on Windows, so this one needs a shell; args are still passed as an array.
    const started = jobs.start({
      label: 'Building the automation platform',
      file: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['run', 'build'],
      cwd: config.automationDir,
      // npm is a .cmd shim on Windows; see the note in jobs.js. Its arguments carry no paths.
      useShell: process.platform === 'win32',
    });
    ok(res, started);
  } catch (error) {
    fail(res, error.message, 409);
  }
});

/**
 * Crawl an app and generate whatever suites the platform recognises.
 *
 * Maps onto the platform's full-run mode. `crawlOnly` is offered because the default behaviour
 * ends by executing the hamburger-menu suite, which is meaningless for an app that has no such
 * menu and simply wastes a device for several minutes.
 */
app.post('/api/run/crawl', async (req, res) => {
  if (!requirePlatform(res)) return;
  const { apkPath, device, maxScreens, maxDepth, crawlOnly, loginMobile, loginPassword } = req.body || {};
  if (!apkPath) return fail(res, 'Choose an app file (.apk) first.');
  if (!fs.existsSync(apkPath)) return fail(res, `That app file no longer exists: ${apkPath}`);
  if (!device) return fail(res, 'Choose a device to run on.');
  if (jobs.isBusy()) return fail(res, 'Something is already running. Wait for it to finish, or press Stop.', 409);
  if (!(await preflightDevice(res, device))) return;

  const args = [platform.platformPaths(config.automationDir).cli, '--apk', apkPath, '--device', device];
  if (Number(maxScreens) > 0) args.push('--max-screens', String(Number(maxScreens)));
  if (Number(maxDepth) > 0) args.push('--max-depth', String(Number(maxDepth)));
  if (crawlOnly) args.push('--crawl-only');
  // The platform requires both credentials together, or neither; enforce that here so the run
  // does not start and then skip login generation with a warning the user will not read.
  if (loginMobile || loginPassword) {
    if (!loginMobile || !loginPassword) {
      return fail(res, 'For login test generation, enter BOTH the mobile number and the password, or leave both empty.');
    }
    args.push('--login-mobile', String(loginMobile), '--login-password', String(loginPassword));
  }

  try {
    ok(res, jobs.start({
      label: `Exploring ${path.basename(apkPath)} on ${device}`,
      file: config.nodePath,
      args,
      cwd: config.automationDir,
      kind: 'crawl',
    }));
  } catch (error) {
    fail(res, error.message, 409);
  }
});

/** Run a stored suite, or specific cases from it. */
app.post('/api/run/execute', async (req, res) => {
  if (!requirePlatform(res)) return;
  const { pkg, module: moduleName, modules, device, testCaseIds } = req.body || {};
  if (!pkg) return fail(res, 'Choose an app.');
  if (!device) return fail(res, 'Choose a device to run on.');

  // `modules` is the current shape; `module` is still accepted so an older page keeps working.
  const wanted = Array.isArray(modules) && modules.length
    ? [...new Set(modules.filter((name) => typeof name === 'string' && name))]
    : moduleName ? [moduleName] : [];
  if (!wanted.length) return fail(res, 'Tick at least one set of tests to run.');

  const stored = platform.listApps(config.automationDir).find((a) => a.package === pkg);
  const known = new Map((stored?.modules ?? []).map((m) => [m.name, m.cases.length]));
  const unknown = wanted.filter((name) => !known.has(name));
  if (unknown.length) {
    return fail(res, `${pkg} has no stored tests for: ${unknown.join(', ')}.`, 409);
  }

  if (jobs.isBusy()) return fail(res, 'Something is already running. Wait for it to finish, or press Stop.', 409);
  if (!(await preflightDevice(res, device))) return;

  // Picking individual tests only means something within one set; across several the whole of each
  // is run, which is what ticking several sets is asking for.
  const chosenIds = wanted.length === 1 && Array.isArray(testCaseIds)
    ? testCaseIds.filter((id) => /^[\w.-]+$/.test(id))
    : [];

  // Run the heaviest sets first. A batch that is going to fail on a missing account or a flat
  // phone battery then does so early, rather than after an hour of the small ones.
  const ordered = [...wanted].sort((a, b) => known.get(b) - known.get(a) || a.localeCompare(b));

  const runs = ordered.map((name) => {
    const args = [
      platform.platformPaths(config.automationDir).cli,
      '--execute-only',
      '--package', pkg,
      '--module', name,
      '--device', device,
    ];
    for (const id of chosenIds) args.push('--test-case-id', id);
    const selection = chosenIds.length
      ? `${chosenIds.length} selected test(s) from ${name}`
      : `all ${known.get(name)} ${name} test(s)`;
    return {
      label: `Running ${selection} for ${pkg} on ${device}`,
      queueLabel: name,
      file: config.nodePath,
      args,
      cwd: config.automationDir,
      kind: 'execute',
    };
  });

  try {
    ok(res, startRuns(runs));
  } catch (error) {
    fail(res, error.message, 409);
  }
});

/**
 * Turn a described flow into executable tests.
 *
 * This is the platform's Excel import: it builds real test cases from a written flow, matching
 * each described step against the elements a previous crawl captured. It therefore needs the app
 * to have been crawled first, which the UI states rather than leaving to be discovered.
 */
app.post('/api/run/import', (req, res) => {
  if (!requirePlatform(res)) return;
  const { pkg, excelPath } = req.body || {};
  if (!pkg) return fail(res, 'Choose the app these tests are for.');
  if (!excelPath) return fail(res, 'Choose your flow file (.xlsx) first.');
  if (!fs.existsSync(excelPath)) return fail(res, `That file no longer exists: ${excelPath}`);

  // Checked here rather than left to the CLI: building tests from a written flow matches each step
  // against elements a crawl recorded, so an app that has never been crawled cannot work. The
  // platform does say so, but only after the job has started, buried in the run's output.
  const app = platform.listApps(config.automationDir).find((a) => a.package === pkg);
  if (app && !app.crawled) {
    return fail(
      res,
      `${pkg} has never been explored, so there are no buttons or fields to match your steps ` +
        'against. Run "Explore a new app" on it first — the steps in your sheet are matched to ' +
        'what the explore step records.',
      409,
    );
  }

  // A renamed .csv or an old .xls reaches the platform as "the workbook has no worksheets", which
  // reads like a problem with the sheet's contents rather than with the file itself.
  let magic = Buffer.alloc(0);
  try {
    const handle = fs.openSync(excelPath, 'r');
    magic = Buffer.alloc(2);
    fs.readSync(handle, magic, 0, 2, 0);
    fs.closeSync(handle);
  } catch {
    return fail(res, `That file could not be read: ${excelPath}`);
  }
  if (magic.toString('latin1') !== 'PK') {
    return fail(
      res,
      'That file is not a real .xlsx workbook. If it is an older .xls or a .csv, open it in Excel and use "Save As" → Excel Workbook (.xlsx).',
    );
  }

  try {
    ok(res, jobs.start({
      label: `Creating tests for ${pkg} from ${path.basename(excelPath)}`,
      kind: 'import',
      file: config.nodePath,
      args: [
        platform.platformPaths(config.automationDir).cli,
        '--import-test-cases',
        '--package', pkg,
        '--excel-file', excelPath,
      ],
      cwd: config.automationDir,
    }));
  } catch (error) {
    fail(res, error.message, 409);
  }
});

/** Run the same suite on several devices at once, via the platform's multi-device runner. */
app.post('/api/run/parallel', (req, res) => {
  const status = requirePlatform(res);
  if (!status) return;
  if (!status.hasParallelRunner) return fail(res, 'This platform copy has no multi-device runner.', 409);
  const { runs, module: moduleName } = req.body || {};
  if (!Array.isArray(runs) || !runs.length) return fail(res, 'Add at least one device and test.');

  const args = [platform.platformPaths(config.automationDir).parallelRunner, '--module', moduleName || 'manual'];
  const seenDevices = new Set();
  for (const run of runs) {
    if (!run.device || !run.pkg || !run.testCaseIds?.length) {
      return fail(res, 'Each row needs a device, an app and at least one test.');
    }
    // One phone shows one app on one screen, so two rows on the same device are not parallelism:
    // the second session would silently terminate the first and the run would fail as flakiness.
    if (seenDevices.has(run.device)) {
      return fail(res, `${run.device} appears twice. Give each phone one row — a phone can only run one test at a time.`);
    }
    seenDevices.add(run.device);
    args.push('--run', `${run.device}@${run.pkg}=${run.testCaseIds.join(',')}`);
  }
  try {
    ok(res, jobs.start({
      label: `Running on ${runs.length} device(s) at once`,
      file: config.nodePath,
      args,
      cwd: config.automationDir,
    }));
  } catch (error) {
    fail(res, error.message, 409);
  }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.listen(config.port, () => {
  const status = platform.platformStatus(config.automationDir);
  console.log('');
  console.log('  AI Automation Dashboard');
  console.log(`  Open:     http://localhost:${config.port}`);
  console.log(`  Platform: ${status.automationDir}${status.dirExists ? '' : '   <-- NOT FOUND'}`);
  console.log(`  Built:    ${status.built ? 'yes' : 'no — use the Build button in the dashboard'}`);
  console.log('');
});
