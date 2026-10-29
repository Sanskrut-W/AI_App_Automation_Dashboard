'use strict';

/* Front end for the automation control panel.
   No framework and no build step on purpose: this has to start with `npm start` and keep working
   after months of nobody touching it. */

const state = {
  device: null,
  devices: [],
  apps: [],
  busy: false,
  apkPath: null,
  excelPath: null,
  /** 'file' = an .apk the user picked; 'device' = an app already installed on the chosen phone. */
  apkSource: 'file',
  devicePackages: [],
  /** Per-device account assignments, used to warn before a multi-device run rather than during it. */
  accounts: { byPackage: {} },
  /** One row per phone for a multi-device run: { key, device, pkg, testCaseIds }. */
  parallelRows: [],
  parallelSeeded: false,
};

let nextRowKey = 1;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

let toastTimer = null;
function toast(message, isBad = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('is-bad', Boolean(isBad));
  node.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-shown'), isBad ? 7000 : 3800);
}

async function api(pathname, options = {}) {
  const res = await fetch(pathname, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    throw new Error(`The server returned an unreadable response (${res.status}).`);
  }
  if (!res.ok || body.ok === false) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

/* ---------------------------------------------------------------- status */

function setChip(id, level, text) {
  const chip = $(id);
  chip.classList.remove('is-good', 'is-warn', 'is-bad');
  if (level) chip.classList.add(`is-${level}`);
  chip.querySelector('.chip-text').textContent = text;
}

async function refreshHealth() {
  try {
    const h = await api('/api/health');
    if (!h.platform.dirExists) setChip('#chipPlatform', 'bad', 'Platform folder missing');
    else if (!h.platform.built) setChip('#chipPlatform', 'warn', 'Platform needs building');
    else setChip('#chipPlatform', 'good', 'Platform ready');

    setChip('#chipAppium', h.appium.running ? 'good' : 'warn',
      h.appium.running ? 'Test engine running' : 'Test engine stopped');

    if (!h.adb.ok) setChip('#chipDevices', 'bad', 'Cannot reach phones');
    else if (h.adb.deviceCount === 0) setChip('#chipDevices', 'warn', 'No phone connected');
    else setChip('#chipDevices', 'good', `${h.adb.deviceCount} phone${h.adb.deviceCount === 1 ? '' : 's'}`);

    $('#automationDir').value = h.config.automationDir;
    $('#btnBuild').disabled = !h.platform.dirExists;
    applyBusy(h.job.busy, h.job.job, h.job.queue);
    // Survives a reload: the verdict of the last run is worth seeing even after closing the tab.
    if (!h.job.busy) renderVerdict(h.job.lastFinished, h.job.queue?.note);
  } catch (error) {
    setChip('#chipPlatform', 'bad', 'Dashboard server unreachable');
    console.error(error);
  }
}

function applyBusy(busy, job, queue) {
  state.busy = busy;
  $('#btnStop').disabled = !busy;
  // Say how many sets are still waiting, so a long batch does not look like one stuck run.
  const waiting = queue?.pending
    ? ` · ${queue.pending} more set${queue.pending === 1 ? '' : 's'} waiting`
    : '';
  $('#jobLabel').textContent = busy && job ? job.label + waiting : 'Nothing running';
  for (const id of ['#btnCrawl', '#btnRun', '#btnImport', '#btnBuild', '#btnStartEngine', '#btnStopEngine', '#btnParallel']) {
    const node = $(id);
    if (node) node.disabled = busy;
  }
  // Runs last: an app with no crawl behind it keeps Import disabled even when nothing is running.
  renderImportHint();
}

/* ---------------------------------------------------------------- devices */

async function refreshDevices() {
  const list = $('#deviceList');
  list.replaceChildren(el('p', 'muted', 'Looking for phones…'));
  try {
    const { devices } = await api('/api/devices');
    state.devices = devices;
    renderParallelRows();
    list.replaceChildren();
    if (!devices.length) {
      list.append(el('p', 'muted', 'No phone found. Connect one by USB, unlock it, and allow USB debugging when it asks.'));
      state.device = null;
      return;
    }
    // Keep the previous choice if it is still plugged in; otherwise pick the first usable phone.
    const usable = devices.filter((d) => d.state === 'device');
    if (!usable.some((d) => d.serial === state.device)) {
      state.device = usable.length ? usable[0].serial : null;
    }
    for (const device of devices) {
      const usableNow = device.state === 'device';
      const row = el('div', `device${device.serial === state.device ? ' is-selected' : ''}${usableNow ? '' : ' is-unusable'}`);
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'device';
      radio.checked = device.serial === state.device;
      radio.disabled = !usableNow;
      const info = el('div');
      info.append(el('div', 'device-name', device.model || 'Android phone'));
      info.append(el('div', 'device-serial', device.serial));
      row.append(radio, info);
      row.append(el('div', 'device-state',
        usableNow ? 'ready' : device.state === 'unauthorized' ? 'unlock the phone and allow USB debugging' : device.state));
      if (usableNow) {
        row.addEventListener('click', () => {
          if (state.device === device.serial) return;
          state.device = device.serial;
          // The installed-app list belongs to one phone, so it cannot outlive the choice of phone.
          state.devicePackages = [];
          state.apkPath = null;
          refreshDevices();
          if (state.apkSource === 'device') refreshDevicePackages();
        });
      }
      list.append(row);
    }
  } catch (error) {
    list.replaceChildren(el('p', 'muted', error.message));
  }
}

/* ---------------------------------------------------------------- apps already on the phone */

function setApkSource(source) {
  state.apkSource = source;
  state.apkPath = null;
  $('#apkFileField').hidden = source !== 'file';
  $('#apkDeviceField').hidden = source !== 'device';
  if (source === 'device' && !state.devicePackages.length) refreshDevicePackages();
}

async function refreshDevicePackages() {
  const select = $('#devicePackage');
  const hint = $('#devicePackageHint');
  if (!state.device) {
    select.replaceChildren();
    hint.textContent = 'Choose a phone in step 1 first.';
    return;
  }
  const previous = select.value;
  select.replaceChildren();
  hint.textContent = 'Reading the list of apps from the phone…';
  try {
    const query = $('#showSystemApps').checked ? '?all=1' : '';
    const { packages } = await api(`/api/devices/${encodeURIComponent(state.device)}/packages${query}`);
    state.devicePackages = packages;
    if (!packages.length) {
      hint.textContent = 'No apps found on that phone.';
      return;
    }
    for (const pkg of packages) {
      // Marking what has already been explored stops the same app being crawled twice by mistake,
      // which is otherwise easy: the list is package names, not the names shown on the phone.
      const option = el('option', null, pkg.explored ? `${pkg.name}  — already explored` : pkg.name);
      option.value = pkg.name;
      select.append(option);
    }
    if (previous && packages.some((p) => p.name === previous)) select.value = previous;
    hint.textContent = `${packages.length} apps on this phone. It will be copied off the phone when you press Start.`;
  } catch (error) {
    hint.textContent = error.message;
  }
}

/* ---------------------------------------------------------------- apps */

async function refreshApps() {
  try {
    const { apps } = await api('/api/apps');
    state.apps = apps;
    fillAppSelect('#runApp', apps);
    // Building tests from a flow needs a crawl behind it, so that list says which apps qualify.
    fillAppSelect('#importApp', apps, { markUncrawled: true });
    fillAppSelect('#resultsApp', apps);
    renderImportHint();
    renderModules();
    renderSummary();
    renderReports();
    renderParallelModules();
    renderParallelRows();
  } catch (error) {
    toast(error.message, true);
  }
}

async function refreshAccounts() {
  try {
    state.accounts = await api('/api/parallel/accounts');
  } catch {
    // Only used to warn early; a run still fails loudly on its own if accounts are missing.
    state.accounts = { byPackage: {} };
  }
  renderParallelRows();
}

function fillAppSelect(sel, apps, { markUncrawled = false } = {}) {
  const node = $(sel);
  const previous = node.value;
  node.replaceChildren();
  if (!apps.length) {
    const opt = el('option', null, 'No apps yet — explore an app first');
    opt.value = '';
    node.append(opt);
    return;
  }
  for (const app of apps) {
    const counts = `${app.totalCases} test${app.totalCases === 1 ? '' : 's'}`;
    const label = markUncrawled && !app.crawled
      ? `${app.package}  (${counts}) — not explored yet`
      : `${app.package}  (${counts})`;
    const opt = el('option', null, label);
    opt.value = app.package;
    node.append(opt);
  }
  if (previous && apps.some((a) => a.package === previous)) node.value = previous;
}

/**
 * Says whether the chosen app can actually have tests built from a flow.
 *
 * An app can hold test cases and reports and still have no crawl behind it — its crawl data may
 * predate this checkout or have been cleared — so "it is in the list" is not the same as "this
 * will work". Saying which one it is here saves a run that can only fail.
 */
function renderImportHint() {
  const node = $('#importHint');
  if (!node) return;
  const app = currentApp('#importApp');
  const button = $('#btnImport');
  if (!app) {
    node.textContent = '';
    if (button) button.disabled = state.busy;
    return;
  }
  if (app.crawled) {
    node.textContent = `${app.package} was explored: ${app.elementsMapped} elements across ${app.screensMapped} screens are available to match your steps against.`;
    node.classList.remove('is-bad');
  } else {
    node.textContent = `${app.package} has never been explored, so there is nothing to match your steps against. Run "Explore a new app" on it first.`;
    node.classList.add('is-bad');
  }
  if (button) button.disabled = state.busy || !app.crawled;
}

function currentApp(sel) {
  return state.apps.find((a) => a.package === $(sel).value) || null;
}

/**
 * The sets of tests an app holds, as ticks rather than a dropdown.
 *
 * Several can be picked at once because a full regression means running every set, and the
 * platform runs exactly one per invocation — so the dashboard queues them rather than making
 * someone come back and start the next one seventeen times.
 */
function renderModules() {
  const app = currentApp('#runApp');
  const host = $('#moduleList');
  const previous = new Set(selectedModules());
  host.replaceChildren();

  const modules = app?.modules || [];
  if (!modules.length) {
    host.append(el('p', 'muted', app ? 'No tests stored for this app yet.' : 'Choose an app first.'));
    renderCases();
    renderModuleHint();
    return;
  }

  for (const m of modules) {
    const row = el('label', 'case');
    const box = el('input');
    box.type = 'checkbox';
    box.value = m.name;
    // Keep ticks across a refresh, and start with one set chosen rather than none.
    box.checked = previous.size ? previous.has(m.name) : m === modules[0];
    box.addEventListener('change', () => {
      renderCases();
      renderModuleHint();
    });
    row.append(box);
    row.append(el('span', 'case-title', m.name));
    row.append(el('span', 'case-steps', `${m.cases.length} test${m.cases.length === 1 ? '' : 's'}`));
    host.append(row);
  }
  renderCases();
  renderModuleHint();
}

function selectedModules() {
  const host = $('#moduleList');
  if (!host) return [];
  return [...host.querySelectorAll('input:checked')].map((i) => i.value);
}

function renderModuleHint() {
  const node = $('#moduleHint');
  if (!node) return;
  const app = currentApp('#runApp');
  const chosen = selectedModules();
  if (!chosen.length) {
    node.textContent = 'Nothing ticked — tick at least one set to run.';
    return;
  }
  if (chosen.length === 1) {
    node.textContent = 'One set. You can narrow it to individual tests below.';
    return;
  }
  const tests = (app?.modules || [])
    .filter((m) => chosen.includes(m.name))
    .reduce((n, m) => n + m.cases.length, 0);
  node.textContent =
    `${chosen.length} sets, ${tests} tests in total. They run one after another, heaviest first — ` +
    'a phone can only run one set at a time.';
}

function renderCases() {
  const app = currentApp('#runApp');
  const chosen = selectedModules();
  const list = $('#caseList');
  list.replaceChildren();

  // Choosing individual tests only means something inside one set. With several ticked, the whole
  // of each is run, so offering a tick list here would promise something that will not happen —
  // and the controls that go with it are turned off rather than left looking available.
  const single = chosen.length === 1;
  for (const id of ['#btnSelectAll', '#btnSelectNone']) {
    const node = $(id);
    if (node) node.disabled = !single;
  }
  const caseHint = $('#caseHint');
  if (caseHint) {
    caseHint.textContent = single
      ? 'Leave everything unticked to run the whole set in its normal order.'
      : '';
  }

  if (!single) {
    list.append(el('p', 'muted', chosen.length
      ? `All tests in the ${chosen.length} ticked sets will run. Tick just one set to choose individual tests.`
      : 'Tick a set of tests above.'));
    return;
  }

  const mod = app?.modules.find((m) => m.name === chosen[0]);
  if (!mod || !mod.cases.length) {
    list.append(el('p', 'muted', 'Nothing to show.'));
    return;
  }
  for (const testCase of mod.cases) {
    const row = el('label', 'case');
    const box = el('input');
    box.type = 'checkbox';
    box.value = testCase.id;
    row.append(box);
    row.append(el('span', 'case-title', testCase.title));
    row.append(el('span', 'case-steps', `${testCase.steps} steps`));
    list.append(row);
  }
}

function selectedCaseIds() {
  return [...$('#caseList').querySelectorAll('input:checked')].map((i) => i.value);
}

function renderSummary() {
  const grid = $('#appSummary');
  grid.replaceChildren();
  if (!state.apps.length) {
    grid.append(el('p', 'muted', 'No apps yet.'));
    return;
  }
  for (const app of state.apps) {
    const tile = el('div', 'summary-tile');
    tile.append(el('div', 'pkg', app.package));
    const nums = el('div', 'nums');
    nums.innerHTML =
      `<b>${app.totalCases}</b> tests · ${app.totalSteps} steps<br>` +
      `${app.screensMapped} screens · ${app.elementsMapped} elements mapped`;
    tile.append(nums);
    grid.append(tile);
  }
}

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return '';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${Math.round(bytes / 1048576)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/**
 * Puts the bundle's size on the download link.
 *
 * Screenshots run to better than half a megabyte each, so a batch across every set can bundle to
 * a few hundred — worth knowing before clicking rather than after. Asked for separately because
 * measuring it means stat-ing every screenshot the report refers to, which is not something to do
 * for twenty-five rows while the list is being drawn.
 */
async function annotateDownloadSize(link, pkg, report) {
  try {
    const kind = report.consolidated ? 'consolidated' : 'report';
    const { bytes } = await api(
      `/api/apps/${encodeURIComponent(pkg)}/reports/${encodeURIComponent(report.file)}/size?kind=${kind}`,
    );
    if (link.isConnected) link.textContent = `Download (${formatBytes(bytes)})`;
  } catch {
    // The link still works; only the size is missing.
  }
}

async function renderReports() {
  const pkg = $('#resultsApp').value;
  const list = $('#reportList');
  list.replaceChildren();
  if (!pkg) {
    list.append(el('p', 'muted', 'Choose an app.'));
    return;
  }
  try {
    const { reports } = await api(`/api/apps/${encodeURIComponent(pkg)}/reports`);
    if (!reports.length) {
      list.append(el('p', 'muted', 'No runs yet for this app.'));
      return;
    }
    for (const report of reports.slice(0, 25)) {
      const row = el('div', `report${report.consolidated ? ' is-consolidated' : ''}`);
      const link = el('a', null, report.consolidated ? 'Open consolidated report' : 'Open report');
      // The server gives each report its own URL: a consolidated one is this app's own file, an
      // individual one mirrors the platform's layout so its relative screenshots resolve.
      link.href = report.url
        || `/artifacts/${encodeURIComponent(pkg)}/reports/${encodeURIComponent(report.file)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      row.append(link);
      if (report.consolidated) {
        row.append(el('span', 'tag', `${report.moduleCount} sets`));
      }

      // A plain "save page as" would keep the HTML and lose every screenshot, so the download is
      // a bundle of the report with its images — and says how big it is before you commit to it.
      const download = el('a', 'download-link', 'Download');
      download.href = `/download/${report.consolidated ? 'consolidated' : 'report'}`
        + `/${encodeURIComponent(pkg)}/${encodeURIComponent(report.file)}`;
      download.title = 'The report and its screenshots, as a zip';
      download.download = '';
      row.append(download);
      annotateDownloadSize(download, pkg, report);
      const when = el('time', null, new Date(report.modifiedAt).toLocaleString());
      when.dateTime = report.modifiedAt;
      row.append(when);
      if (report.total !== null) {
        const allPassed = report.failed === 0 && report.total > 0;
        row.append(el('span', `verdict ${allPassed ? 'pass' : 'fail'}`,
          `${report.passed}/${report.total} passed`));
      }
      list.append(row);
    }
  } catch (error) {
    list.replaceChildren(el('p', 'muted', error.message));
  }
}

/* ---------------------------------------------------------------- several phones at once */

/** Every module name across all apps, since each row may be running a different app. */
function parallelModuleNames() {
  const names = new Set();
  for (const app of state.apps) for (const m of app.modules) names.add(m.name);
  return [...names].sort();
}

function renderParallelModules() {
  const node = $('#parallelModule');
  const previous = node.value;
  const names = parallelModuleNames();
  node.replaceChildren();
  if (!names.length) {
    const option = el('option', null, 'No tests stored yet');
    option.value = '';
    node.append(option);
    return;
  }
  for (const name of names) {
    const option = el('option', null, name);
    option.value = name;
    node.append(option);
  }
  if (previous && names.includes(previous)) node.value = previous;
}

const usableDevices = () => state.devices.filter((d) => d.state === 'device');

const blankParallelRow = () => ({ key: nextRowKey++, device: '', pkg: '', testCaseIds: [] });

/**
 * Seeds one row per connected phone — the arrangement this tab exists for.
 *
 * Seeding waits for the phone list rather than running on the first render: adb answers a moment
 * after the page loads, and the apps list often answers first, so seeding eagerly would fill the
 * tab with a single row naming no phone and never correct itself. Once seeded it never re-seeds,
 * so rows the user has since changed are left alone.
 */
function ensureParallelRows() {
  if (state.parallelSeeded) {
    if (!state.parallelRows.length) state.parallelRows.push(blankParallelRow());
    return;
  }
  const devices = usableDevices();
  if (!devices.length) {
    if (!state.parallelRows.length) state.parallelRows.push(blankParallelRow());
    return;
  }
  state.parallelRows = devices.map((device) => ({
    key: nextRowKey++,
    device: device.serial,
    pkg: '',
    testCaseIds: [],
  }));
  state.parallelSeeded = true;
}

/**
 * Why a phone cannot take part in a run yet.
 *
 * The platform's multi-device runner refuses to start unless every phone has its own account, and
 * it only says so once launched — by which point the setup screen is gone. Saying it here means it
 * can be fixed while it is still being set up.
 */
function accountWarning(device, pkg) {
  if (!device || !pkg) return null;
  const entry = state.accounts.byPackage?.[pkg];
  if (!entry) return `No test accounts are set up for ${pkg}.`;
  if (!entry.deviceAccounts?.[device]) return `This phone has no account of its own for ${pkg}.`;
  return null;
}

function renderParallelRows() {
  const host = $('#parallelRows');
  if (!host) return;
  ensureParallelRows();
  const moduleName = $('#parallelModule')?.value || '';
  const devices = usableDevices();
  const duplicates = new Set(
    state.parallelRows
      .map((r) => r.device)
      .filter((d, i, all) => d && all.indexOf(d) !== i),
  );

  host.replaceChildren();
  for (const row of state.parallelRows) {
    const app = state.apps.find((a) => a.package === row.pkg) || null;
    const cases = app?.modules.find((m) => m.name === moduleName)?.cases || [];
    const warning = accountWarning(row.device, row.pkg);
    const isDuplicate = row.device && duplicates.has(row.device);

    const node = el('div', `parallel-row${warning || isDuplicate ? ' is-warn' : ''}`);

    const phoneField = el('div', 'field');
    phoneField.append(el('label', null, 'Phone'));
    const phoneSelect = el('select');
    const blank = el('option', null, devices.length ? 'Choose a phone' : 'No phone connected');
    blank.value = '';
    phoneSelect.append(blank);
    for (const device of devices) {
      const option = el('option', null, `${device.model || 'Android phone'} — ${device.serial}`);
      option.value = device.serial;
      phoneSelect.append(option);
    }
    phoneSelect.value = row.device;
    phoneSelect.addEventListener('change', () => {
      row.device = phoneSelect.value;
      renderParallelRows();
    });
    phoneField.append(phoneSelect);

    const appField = el('div', 'field');
    appField.append(el('label', null, 'App'));
    const appSelect = el('select');
    const noApp = el('option', null, state.apps.length ? 'Choose an app' : 'No apps yet');
    noApp.value = '';
    appSelect.append(noApp);
    for (const candidate of state.apps) {
      const option = el('option', null, candidate.package);
      option.value = candidate.package;
      appSelect.append(option);
    }
    appSelect.value = row.pkg;
    appSelect.addEventListener('change', () => {
      row.pkg = appSelect.value;
      row.testCaseIds = [];
      renderParallelRows();
    });
    appField.append(appSelect);

    /* Tests are ticked, not Ctrl-clicked.
       A native multiple-select hid its own state: the titles were cut off, the only cue that
       something was chosen was a grey highlight, and picking a second one needed a keyboard
       instruction printed underneath. This is the same tick list the Run tests tab already uses,
       so the two screens now behave the same way. */
    const testSection = el('div', 'prow-tests');
    const testHead = el('div', 'prow-tests-head');
    const countLabel = el('span', 'prow-count');
    const describeCount = () => {
      countLabel.textContent = cases.length
        ? `${row.testCaseIds.length} of ${cases.length} selected`
        : '';
    };
    testHead.append(el('span', 'prow-tests-label', 'Tests to run'), countLabel);

    const pickAll = el('button', 'btn btn-ghost btn-sm', 'Select all');
    const pickNone = el('button', 'btn btn-ghost btn-sm', 'Clear');
    pickAll.type = 'button';
    pickNone.type = 'button';
    pickAll.disabled = !cases.length;
    pickNone.disabled = !cases.length;
    const testActions = el('div', 'inline-actions');
    testActions.append(pickAll, pickNone);
    testHead.append(testActions);
    testSection.append(testHead);

    const testList = el('div', 'case-list prow-case-list');
    if (!cases.length) {
      testList.append(el('p', 'muted', row.pkg
        ? `This app has no ${moduleName || 'tests'} tests.`
        : 'Choose an app to see its tests.'));
    }
    for (const testCase of cases) {
      const line = el('label', 'case');
      const box = el('input');
      box.type = 'checkbox';
      box.value = testCase.id;
      box.checked = row.testCaseIds.includes(testCase.id);
      box.addEventListener('change', () => {
        row.testCaseIds = [...testList.querySelectorAll('input:checked')].map((i) => i.value);
        // Only the count is redrawn: re-rendering every row on each tick would throw away the
        // reader's place in a long list.
        describeCount();
      });
      line.append(box, el('span', 'case-title', testCase.title), el('span', 'case-steps', `${testCase.steps} steps`));
      testList.append(line);
    }
    const setAll = (checked) => {
      for (const box of testList.querySelectorAll('input')) box.checked = checked;
      row.testCaseIds = checked ? cases.map((c) => c.id) : [];
      describeCount();
    };
    pickAll.addEventListener('click', () => setAll(true));
    pickNone.addEventListener('click', () => setAll(false));
    describeCount();
    testSection.append(testList);

    const remove = el('button', 'btn btn-ghost btn-sm prow-remove', 'Remove');
    remove.type = 'button';
    remove.title = 'Remove this phone from the run';
    // A bare word at the end of a row reads as a label; the cross says it is an action.
    remove.insertAdjacentHTML('afterbegin',
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>');
    remove.addEventListener('click', () => {
      state.parallelRows = state.parallelRows.filter((r) => r.key !== row.key);
      renderParallelRows();
    });

    // Header carries who and what; the body carries which tests. One row reads as a sentence.
    const head = el('div', 'prow-head');
    head.append(el('span', 'prow-index', `Phone ${state.parallelRows.indexOf(row) + 1}`));
    head.append(phoneField, appField, remove);

    node.append(head, testSection);
    if (isDuplicate) {
      node.append(el('p', 'row-warn', 'This phone is already used by another row — a phone can only run one set of tests at a time.'));
    } else if (warning) {
      node.append(el('p', 'row-warn', `${warning} Add it under config/test-accounts.json → ${row.pkg}.deviceAccounts.`));
    }
    host.append(node);
  }
}

/* ---------------------------------------------------------------- uploads */

async function uploadFile(input, label) {
  const file = input.files?.[0];
  if (!file) throw new Error(`Choose a ${label} first.`);
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body: form });
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error || 'Upload failed.');
  return body;
}

/* ---------------------------------------------------------------- console */

const consoleNode = () => $('#console');

/**
 * The console is written once per animation frame, and keeps only a tail.
 *
 * A crawl streams Appium's webdriver log at well over a hundred lines a second, and connecting
 * replays the whole 4000-line backlog in a single burst. Appending each line as it arrived cost a
 * forced synchronous layout every time — reading scrollHeight to decide whether to auto-scroll —
 * so opening the page mid-crawl meant thousands of back-to-back reflows against a DOM that never
 * stopped growing. Chrome offered to kill the tab, which is how this was found. Batching gives one
 * DOM write and one layout read per frame however fast the job talks, and the cap keeps each of
 * those a fixed cost rather than one that degrades over the length of a run.
 */
const MAX_CONSOLE_LINES = 2000;
let pendingLines = [];
let flushHandle = null;

function flushConsole() {
  flushHandle = null;
  const node = consoleNode();
  if (!node || !pendingLines.length) return;

  // One layout read for the whole batch, taken before anything is appended.
  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;

  const batch = pendingLines;
  pendingLines = [];
  const fragment = document.createDocumentFragment();
  for (const line of batch) {
    fragment.append(el(
      'span',
      line.stream === 'meta' ? 'l-meta' : line.stream === 'err' ? 'l-err' : null,
      `${line.text}\n`,
    ));
  }
  node.append(fragment);

  // A running tail, not a transcript. The platform writes the full output to its own logs folder,
  // so nothing is lost by dropping what has scrolled far out of sight.
  for (let excess = node.childElementCount - MAX_CONSOLE_LINES; excess > 0; excess -= 1) {
    node.firstElementChild?.remove();
  }

  // Only auto-scroll if the reader was already at the bottom, so scrolling back to read something
  // is not yanked away by new output.
  if (atBottom) node.scrollTop = node.scrollHeight;
}

function appendLine(line) {
  pendingLines.push(line);
  // A replay burst can queue far more than will ever be shown; drop the excess before it is DOM.
  if (pendingLines.length > MAX_CONSOLE_LINES) {
    pendingLines.splice(0, pendingLines.length - MAX_CONSOLE_LINES);
  }
  if (flushHandle === null) flushHandle = requestAnimationFrame(flushConsole);
}

function clearConsole() {
  pendingLines = [];
  if (flushHandle !== null) {
    cancelAnimationFrame(flushHandle);
    flushHandle = null;
  }
  consoleNode().replaceChildren();
}

/**
 * Shows what a finished run actually achieved.
 *
 * The console is where a run's output goes, but the one line that says whether it worked is buried
 * somewhere in tens of thousands of webdriver lines, and "finished with exit code 0" is printed
 * just as cheerfully for a crawl that mapped nothing as for one that mapped the whole app.
 */
function renderVerdict(lastFinished, queueNote) {
  const node = $('#verdict');
  if (!node) return;
  const verdict = lastFinished?.verdict;
  if (!verdict && !queueNote) {
    node.hidden = true;
    return;
  }
  node.replaceChildren();
  node.className = `verdict is-${verdict?.tone ?? 'warn'}`;
  if (verdict) {
    node.append(el('p', 'verdict-head', verdict.headline));
    for (const detail of verdict.details || []) node.append(el('p', 'verdict-detail', detail));
  }
  // A batch that was cut short has to say so, rather than just vanishing from the progress line.
  if (queueNote) node.append(el('p', 'verdict-detail', queueNote));
  node.hidden = false;
}

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('line', (event) => appendLine(JSON.parse(event.data)));
  source.addEventListener('status', (event) => {
    const status = JSON.parse(event.data);
    applyBusy(status.busy, status.job, status.queue);
    if (status.busy) {
      // Last run's verdict is not the verdict of the one now starting.
      $('#verdict').hidden = true;
    } else {
      renderVerdict(status.lastFinished, status.queue?.note);
      // A run just ended: suites and reports may have changed.
      refreshApps();
      refreshHealth();
    }
  });
  source.addEventListener('open', () => clearConsole());
  source.onerror = () => {
    // EventSource reconnects on its own; the replay on reconnect restores the output.
  };
}

/* ---------------------------------------------------------------- wiring */

function wireTabs() {
  $('#tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-active', t === tab);
    for (const p of document.querySelectorAll('.tabpanel')) {
      p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab);
    }
  });
}

function requireDevice() {
  if (!state.device) {
    toast('Choose a phone first (step 1).', true);
    return false;
  }
  return true;
}

function wireActions() {
  $('#btnRefreshDevices').addEventListener('click', refreshDevices);
  $('#btnRefreshApps').addEventListener('click', refreshApps);
  $('#runApp').addEventListener('change', renderModules);
  $('#importApp').addEventListener('change', renderImportHint);
  $('#resultsApp').addEventListener('change', renderReports);
  const setAllModules = (checked) => {
    for (const box of $('#moduleList').querySelectorAll('input')) box.checked = checked;
    renderCases();
    renderModuleHint();
  };
  $('#btnModulesAll').addEventListener('click', () => setAllModules(true));
  $('#btnModulesNone').addEventListener('click', () => setAllModules(false));

  $('#btnSelectAll').addEventListener('click', () => {
    for (const i of $('#caseList').querySelectorAll('input')) i.checked = true;
  });
  $('#btnSelectNone').addEventListener('click', () => {
    for (const i of $('#caseList').querySelectorAll('input')) i.checked = false;
  });
  $('#btnClearLog').addEventListener('click', () => clearConsole());

  $('#apkSource').addEventListener('change', (event) => {
    if (event.target.name === 'apkSource') setApkSource(event.target.value);
  });
  $('#btnRefreshPackages').addEventListener('click', refreshDevicePackages);
  $('#showSystemApps').addEventListener('change', refreshDevicePackages);
  $('#devicePackage').addEventListener('change', () => {
    // A different app means the copy taken from the phone is the wrong file.
    state.apkPath = null;
  });

  $('#parallelModule').addEventListener('change', () => {
    for (const row of state.parallelRows) row.testCaseIds = [];
    renderParallelRows();
  });
  $('#btnAddParallelRow').addEventListener('click', () => {
    const used = new Set(state.parallelRows.map((r) => r.device));
    const free = usableDevices().find((d) => !used.has(d.serial));
    state.parallelRows.push({ key: nextRowKey++, device: free?.serial ?? '', pkg: '', testCaseIds: [] });
    renderParallelRows();
  });
  $('#btnParallel').addEventListener('click', async () => {
    const moduleName = $('#parallelModule').value;
    if (!moduleName) {
      toast('There are no stored tests to run yet.', true);
      return;
    }
    const runs = state.parallelRows
      .filter((row) => row.device && row.pkg && row.testCaseIds.length)
      .map((row) => ({ device: row.device, pkg: row.pkg, testCaseIds: row.testCaseIds }));
    if (!runs.length) {
      toast('Give at least one row a phone, an app and at least one test.', true);
      return;
    }
    const blocked = state.parallelRows
      .filter((row) => row.device && row.pkg && row.testCaseIds.length)
      .map((row) => accountWarning(row.device, row.pkg))
      .filter(Boolean);
    if (blocked.length) {
      toast(`${blocked[0]} Each phone needs its own account before they can run together.`, true);
      return;
    }
    try {
      await api('/api/run/parallel', {
        method: 'POST',
        body: JSON.stringify({ runs, module: moduleName }),
      });
      toast(`Running on ${runs.length} phone${runs.length === 1 ? '' : 's'} — watch Live progress.`);
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('#apkFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    state.apkPath = null;
    $('#apkHint').textContent = file
      ? `${file.name} — ${(file.size / 1048576).toFixed(1)} MB. It will be uploaded when you press Start.`
      : 'Nothing chosen yet.';
  });
  $('#excelFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    state.excelPath = null;
    $('#excelHint').textContent = file ? `${file.name} chosen.` : 'Nothing chosen yet.';
  });

  $('#btnStop').addEventListener('click', async () => {
    try {
      await api('/api/job/stop', { method: 'POST', body: '{}' });
      toast('Stopping…');
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('#btnStartEngine').addEventListener('click', async () => {
    toast('Starting the test engine — this takes a few seconds…');
    try {
      const r = await api('/api/appium/start', { method: 'POST', body: '{}' });
      toast(r.alreadyRunning ? 'The test engine was already running.'
        : r.started ? 'Test engine started.' : `Could not start it: ${r.note || 'unknown reason'}`, !r.started && !r.alreadyRunning);
    } catch (error) {
      toast(error.message, true);
    }
    refreshHealth();
  });

  $('#btnStopEngine').addEventListener('click', async () => {
    try {
      const r = await api('/api/appium/stop', { method: 'POST', body: '{}' });
      toast(r.stopped ? 'Test engine stopped.' : r.note || 'Nothing to stop.');
    } catch (error) {
      toast(error.message, true);
    }
    refreshHealth();
  });

  $('#btnBuild').addEventListener('click', async () => {
    try {
      await api('/api/platform/build', { method: 'POST', body: '{}' });
      toast('Building the platform — watch Live progress.');
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('#btnCrawl').addEventListener('click', async () => {
    if (!requireDevice()) return;
    try {
      if (!state.apkPath && state.apkSource === 'device') {
        const pkg = $('#devicePackage').value;
        if (!pkg) throw new Error('Choose an app from the phone first.');
        toast(`Copying ${pkg} off the phone…`);
        const pulled = await api('/api/device-apk/pull', {
          method: 'POST',
          body: JSON.stringify({ device: state.device, pkg }),
        });
        state.apkPath = pulled.path;
        $('#devicePackageHint').textContent =
          `${pulled.name} copied off the phone (${(pulled.sizeBytes / 1048576).toFixed(1)} MB).`;
      }
      if (!state.apkPath) {
        toast('Uploading the app file…');
        const uploaded = await uploadFile($('#apkFile'), 'app file (.apk)');
        state.apkPath = uploaded.path;
        $('#apkHint').textContent = `${uploaded.name} uploaded.`;
      }
      await api('/api/run/crawl', {
        method: 'POST',
        body: JSON.stringify({
          apkPath: state.apkPath,
          device: state.device,
          maxScreens: $('#maxScreens').value,
          maxDepth: $('#maxDepth').value,
          crawlOnly: $('#crawlOnly').checked,
          loginMobile: $('#loginMobile').value.trim(),
          loginPassword: $('#loginPassword').value,
        }),
      });
      toast('Exploring the app — watch Live progress.');
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('#btnRun').addEventListener('click', async () => {
    if (!requireDevice()) return;
    try {
      await api('/api/run/execute', {
        method: 'POST',
        body: JSON.stringify({
          pkg: $('#runApp').value,
          modules: selectedModules(),
          device: state.device,
          testCaseIds: selectedCaseIds(),
        }),
      });
      const sets = selectedModules().length;
      toast(sets > 1
        ? `Running ${sets} sets one after another — watch Live progress.`
        : 'Running — watch Live progress.');
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('#btnImport').addEventListener('click', async () => {
    try {
      if (!state.excelPath) {
        toast('Uploading your flow file…');
        const uploaded = await uploadFile($('#excelFile'), 'flow file (.xlsx)');
        state.excelPath = uploaded.path;
        $('#excelHint').textContent = `${uploaded.name} uploaded.`;
      }
      await api('/api/run/import', {
        method: 'POST',
        body: JSON.stringify({ pkg: $('#importApp').value, excelPath: state.excelPath }),
      });
      toast('Creating tests — watch Live progress.');
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('#btnSettings').addEventListener('click', () => $('#settingsDialog').showModal());
  $('#btnSaveSettings').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ automationDir: $('#automationDir').value }),
      });
      $('#settingsMsg').textContent = 'Saved.';
      $('#settingsDialog').close();
      toast('Settings saved.');
      refreshHealth();
      refreshApps();
    } catch (error) {
      $('#settingsMsg').textContent = error.message;
    }
  });
}

/* ---------------------------------------------------------------- start */

wireTabs();
wireActions();
connectStream();
refreshHealth();
refreshDevices();
refreshApps();
refreshAccounts();
setInterval(refreshHealth, 10000);
