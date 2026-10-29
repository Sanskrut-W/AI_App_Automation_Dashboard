'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Draws a batch's per-module reports back into one.
 *
 * The platform writes one report per invocation and runs one module per invocation, so running
 * everything for an app leaves a pile of reports that have to be opened one at a time to answer
 * "did the release pass". This reads those reports back and renders a single document with a
 * section per module.
 *
 * Built here rather than in the platform for the reason the whole dashboard exists: the platform
 * is driven from outside and never written to. The consolidated file therefore lives in this
 * application's own folder, and refers to the platform's screenshots by URL rather than by a
 * relative path that would only resolve from inside the platform's directory.
 *
 * Which module a report belongs to is not recorded in the report itself — the dashboard knows it
 * only because it queued the runs — so the pairing is passed in rather than discovered.
 */

const fmtDuration = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  return `${mins}m ${Math.round((ms % 60000) / 1000)}s`;
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** An id usable in a URL fragment, so the contents list can jump to a section. */
const slug = (value) => String(value).replace(/[^\w-]+/g, '-').toLowerCase();

/** One line's worth of a message, for a summary row that must not wrap three times. */
const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function readJsonReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Turns an absolute screenshot path into a URL this dashboard serves.
 *
 * The platform records where the file sits on disk. A consolidated report is not served from
 * inside the platform's folder, so the on-disk path is useless to the browser; what works is the
 * route that mirrors the artifacts layout.
 */
function screenshotUrl(absolutePath, pkg) {
  if (!absolutePath) return null;
  const normalised = String(absolutePath).replace(/\\/g, '/');
  const match = /\/artifacts\/apps\/([^/]+)\/(.+)$/.exec(normalised);
  if (match) return `/artifacts/${encodeURIComponent(match[1])}/${match[2].split('/').map(encodeURIComponent).join('/')}`;
  // Unrecognised shape: fall back to the app's execution-screenshots folder by file name.
  return `/artifacts/${encodeURIComponent(pkg)}/execution-screenshots/${encodeURIComponent(path.basename(normalised))}`;
}

function renderStep(step, pkg) {
  const passed = String(step.status).toLowerCase() === 'passed';
  const url = screenshotUrl(step.screenshotPath, pkg);
  // Lazy: a batch across every module can carry a couple of thousand screenshots, and a report
  // that fetches them all at once is one nobody waits for.
  const shot = url
    ? `<figure class="shot">${step.screenshotLabel ? `<figcaption>${escapeHtml(step.screenshotLabel)}</figcaption>` : ''}` +
      `<img loading="lazy" src="${escapeHtml(url)}" alt="${escapeHtml(step.screenshotLabel || `Step ${step.stepNumber}`)}"></figure>`
    : '';
  const trace = step.stackTrace ? `<pre class="trace">${escapeHtml(step.stackTrace)}</pre>` : '';
  const expected = step.expectedResult
    ? `<p class="expected"><span>Expected</span> ${escapeHtml(step.expectedResult)}</p>`
    : '';
  return `<li class="step ${passed ? 'pass' : 'fail'}">
  <div class="step-head">
    <span class="step-no">#${escapeHtml(step.stepNumber)}</span>
    <code>${escapeHtml(step.action)}</code>
    <span class="badge ${passed ? 'pass' : 'fail'}">${escapeHtml(step.status)}</span>
    <span class="dur">${fmtDuration(step.durationMs)}</span>
  </div>
  <p class="msg">${escapeHtml(step.message)}</p>
  ${expected}${shot}${trace}
</li>`;
}

function renderTestCase(testCase, pkg, id) {
  const passed = String(testCase.status).toLowerCase() === 'passed';
  const steps = Array.isArray(testCase.stepResults) ? testCase.stepResults : [];
  const failedSteps = steps.filter((s) => String(s.status).toLowerCase() !== 'passed').length;
  // Failures start open, passes start closed: a report across every module is far too long to
  // read end to end, and what someone opens it for is whatever went wrong.
  return `<details class="case ${passed ? 'pass' : 'fail'}" id="${escapeHtml(id)}"${passed ? '' : ' open'}>
  <summary>
    <span class="badge ${passed ? 'pass' : 'fail'}">${escapeHtml(testCase.status)}</span>
    <span class="case-title">${escapeHtml(testCase.title)}</span>
    <span class="case-meta">${steps.length} step${steps.length === 1 ? '' : 's'}${failedSteps ? ` · ${failedSteps} failed` : ''} · ${fmtDuration(testCase.durationMs)}</span>
  </summary>
  <ol class="steps">${steps.map((s) => renderStep(s, pkg)).join('')}</ol>
</details>`;
}

/**
 * @param {{module: string, jsonPath: string}[]} parts  one entry per module run, in run order
 * @param {{pkg: string, startedAt?: number}} context
 */
function buildConsolidatedReport(parts, { pkg, startedAt }) {
  const sections = [];
  const missing = [];

  for (const part of parts) {
    const report = part.jsonPath ? readJsonReport(part.jsonPath) : null;
    if (!report?.summary) {
      missing.push(part.module);
      continue;
    }
    const results = Array.isArray(report.summary.results) ? report.summary.results : [];
    sections.push({
      module: part.module,
      generatedAt: report.generatedAt ?? null,
      total: report.summary.totalTestCases ?? results.length,
      passed: report.summary.passed ?? results.filter((r) => String(r.status).toLowerCase() === 'passed').length,
      failed: report.summary.failed ?? results.filter((r) => String(r.status).toLowerCase() !== 'passed').length,
      durationMs: results.reduce((n, r) => n + (r.durationMs || 0), 0),
      results,
    });
  }

  const totals = sections.reduce(
    (acc, s) => ({
      total: acc.total + s.total,
      passed: acc.passed + s.passed,
      failed: acc.failed + s.failed,
      durationMs: acc.durationMs + s.durationMs,
    }),
    { total: 0, passed: 0, failed: 0, durationMs: 0 },
  );

  const generatedAt = new Date().toISOString();
  const allPassed = totals.failed === 0 && totals.total > 0;

  // Every test gets an id of its own, because the list of failures is only useful if each entry
  // leads somewhere. The id has to be assigned here rather than inside the renderer so the list
  // and the section it points into agree on it.
  for (const s of sections) {
    s.id = `m-${slug(s.module)}`;
    s.cases = s.results.map((result, i) => ({ result, id: `${s.id}-t${i}` }));
    s.failures = s.cases
      .filter((c) => String(c.result.status).toLowerCase() !== 'passed')
      .map((c) => {
        const steps = Array.isArray(c.result.stepResults) ? c.result.stepResults : [];
        const firstBad = steps.find((st) => String(st.status).toLowerCase() !== 'passed');
        return {
          id: c.id,
          title: c.result.title,
          step: firstBad ? firstBad.stepNumber : null,
          reason: clip(firstBad?.message ?? c.result.message ?? '', 150),
        };
      });
  }

  const contents = sections
    .map(
      (s) => `<tr class="${s.failed ? 'has-fail' : ''}">
      <td><a href="#${s.id}">${escapeHtml(s.module)}</a></td>
      <td class="num">${s.total}</td>
      <td class="num pass">${s.passed}</td>
      <td class="num ${s.failed ? 'fail' : ''}">${s.failed ? `<a href="#f-${slug(s.module)}">${s.failed}</a>` : 0}</td>
      <td class="num">${fmtDuration(s.durationMs)}</td>
    </tr>`,
    )
    .join('');

  /**
   * Every failure in the batch, in one place.
   *
   * The question a batch report is opened to answer is "what broke", and the answer used to be
   * spread across however many sections happened to contain a failure — on a full run that is
   * seventeen sections and several hundred passing tests to scroll past. Grouped by set, because
   * a set failing wholesale and a set failing in one place mean different things.
   */
  const failureGroups = sections
    .filter((s) => s.failures.length)
    .map(
      (s) => `<div class="f-group" id="f-${slug(s.module)}">
      <h3>${escapeHtml(s.module)} <span class="f-count">${s.failures.length} of ${s.total}</span></h3>
      <ul>${s.failures
        .map(
          (f) => `<li>
        <a class="f-title" href="#${f.id}">${escapeHtml(f.title)}</a>
        <span class="f-why">${f.step != null ? `failed at step ${escapeHtml(f.step)}` : 'failed'}${f.reason ? ` · ${escapeHtml(f.reason)}` : ''}</span>
      </li>`,
        )
        .join('')}</ul>
    </div>`,
    )
    .join('');

  const failPanel = totals.failed
    ? `<details class="failures" id="failures">
    <summary><span class="chev"></span><span class="f-head">${totals.failed} failed test case${totals.failed === 1 ? '' : 's'}</span><span class="f-hint">show the list</span></summary>
    <div class="f-body">${failureGroups}</div>
  </details>`
    : '';

  // Sets with a failure open themselves; the rest fold away. On a full run the sections that
  // passed are the bulk of the document and none of the reason anyone opened it.
  const body = sections
    .map(
      (s) => `<details class="module" id="${s.id}"${s.failed ? ' open' : ''}>
  <summary class="module-head">
    <span class="chev"></span>
    <h2>${escapeHtml(s.module)}</h2>
    <span class="badge ${s.failed ? 'fail' : 'pass'}">${s.passed}/${s.total} passed</span>
    <span class="dur">${fmtDuration(s.durationMs)}</span>
    <a class="top" href="#top">back to top</a>
  </summary>
  <div class="module-body">${s.cases.map((c) => renderTestCase(c.result, pkg, c.id)).join('')}</div>
</details>`,
    )
    .join('');

  const missingNote = missing.length
    ? `<p class="note">No report was produced for: ${escapeHtml(missing.join(', '))}. Those sets either did not run or ended before a report was written.</p>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pkg)} — consolidated test report</title>
<style>
  :root { --ink:#16202c; --soft:#55636f; --line:#dde4ec; --pass:#1a7f4b; --fail:#c0392b; --bg:#f4f6f9; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "Segoe UI",system-ui,sans-serif}
  .wrap{max-width:1000px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:26px;margin:0 0 4px}
  .sub{color:var(--soft);margin:0 0 20px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:22px}
  .card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 14px}
  .card .n{font-size:24px;font-weight:700;line-height:1}
  .card .l{font-size:12px;color:var(--soft);margin-top:4px}
  .card.pass .n{color:var(--pass)} .card.fail .n{color:var(--fail)}
  .card.is-link{cursor:pointer}
  .card.is-link:hover,.card.is-link:focus-visible{border-color:var(--fail);outline:none;box-shadow:0 1px 8px rgba(192,57,43,.16)}
  .card .see{display:block;font-size:11px;font-weight:700;color:var(--fail);margin-top:6px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:26px}
  th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}
  th{background:#f8fafc;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--soft)}
  tr:last-child td{border-bottom:0}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  td.pass{color:var(--pass)} td.fail{color:var(--fail);font-weight:700}
  tr.has-fail td:first-child a{font-weight:700}
  a{color:#1f6feb}
  summary{list-style:none}
  summary::-webkit-details-marker{display:none}
  .chev{flex:none;width:8px;height:8px;border-right:2px solid var(--soft);border-bottom:2px solid var(--soft);transform:rotate(-45deg);transition:transform .15s ease}
  details[open]>summary .chev{transform:rotate(45deg)}
  .modules-bar{display:flex;align-items:center;gap:8px;margin:0 0 12px}
  .modules-bar h2{font-size:12px;margin:0 auto 0 0;text-transform:uppercase;letter-spacing:.5px;color:var(--soft)}
  .modules-bar button{font:inherit;font-size:12px;padding:5px 11px;border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:6px;cursor:pointer}
  .modules-bar button:hover{border-color:#aebbc9}
  .module{margin-bottom:14px}
  .module>summary{display:flex;align-items:center;gap:10px;cursor:pointer;background:#fff;border:1px solid var(--line);border-radius:8px;padding:11px 13px;position:sticky;top:0;z-index:2}
  .module>summary:hover{border-color:#aebbc9}
  .module[open]>summary{border-radius:8px 8px 0 0}
  .module-head h2{font-size:17px;margin:0}
  .module-head .top{margin-left:auto;font-size:12px}
  .module-body{border:1px solid var(--line);border-top:0;border-radius:0 0 8px 8px;background:#fbfcfe;padding:12px}
  .module-body:empty{display:none}
  .failures{border:1px solid #f1cec7;background:#fff7f5;border-radius:8px;margin-bottom:22px}
  .failures>summary{display:flex;align-items:center;gap:9px;cursor:pointer;padding:11px 14px}
  .failures>summary .chev{border-color:var(--fail)}
  .f-head{font-weight:700;color:var(--fail)}
  .f-hint{margin-left:auto;font-size:12px;color:var(--soft)}
  .failures[open] .f-hint{visibility:hidden}
  .f-body{padding:0 14px 12px}
  .f-group+.f-group{margin-top:14px}
  .f-group h3{font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:.5px;color:var(--soft)}
  .f-count{color:var(--fail);font-weight:700}
  .f-group ul{margin:0;padding:0;list-style:none}
  .f-group li{background:#fff;border:1px solid var(--line);border-left:3px solid var(--fail);border-radius:6px;padding:7px 11px;margin-bottom:6px}
  .f-title{display:block;font-weight:600}
  .f-why{display:block;font-size:12px;color:var(--soft);margin-top:2px}
  .badge{font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:20px}
  .badge.pass{background:#e8f6ee;color:var(--pass)} .badge.fail{background:#fdecea;color:var(--fail)}
  .dur{font-size:12px;color:var(--soft)}
  .case{background:#fff;border:1px solid var(--line);border-left-width:3px;border-radius:7px;margin-bottom:8px}
  .case.pass{border-left-color:var(--pass)} .case.fail{border-left-color:var(--fail)}
  .case>summary{cursor:pointer;padding:10px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .case-title{font-weight:600;flex:1;min-width:200px}
  .case-meta{font-size:12px;color:var(--soft)}
  .steps{margin:0;padding:0 12px 12px 34px}
  .step{margin-bottom:10px}
  .step-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .step-no{font-size:12px;color:var(--soft)}
  code{background:#f1f4f8;padding:1px 6px;border-radius:4px;font-size:12px}
  .msg{margin:3px 0}
  .expected{margin:2px 0;font-size:12.5px;color:var(--soft)}
  .expected span{font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:.4px;margin-right:4px}
  .shot{margin:8px 0}
  .shot figcaption{font-size:12px;color:var(--soft);margin-bottom:4px}
  /* A fixed height rather than a maximum, so a lazy screenshot occupies its space before it has
     loaded. Left to themselves these arrive after the jump that brought you here and shove the
     thing you jumped to hundreds of pixels down the page. */
  .shot img{height:300px;max-width:300px;object-fit:contain;object-position:left top;border:1px solid var(--line);border-radius:6px;display:block;background:#f1f4f8}
  .trace{background:#fdf2f0;border:1px solid #f3d5cf;border-radius:6px;padding:8px;font-size:12px;overflow-x:auto;white-space:pre-wrap}
  .note{background:#fdf7ea;border-left:3px solid #b3720a;padding:10px 12px;border-radius:0 6px 6px 0}
  /* Sticky set headings would otherwise cover whatever a jump lands on. */
  .case,.module,.f-group{scroll-margin-top:66px}
  .flash{animation:flash 1.5s ease-out}
  @keyframes flash{0%{box-shadow:0 0 0 3px #f0b429}100%{box-shadow:0 0 0 3px rgba(240,180,41,0)}}
  @media print{.module>summary{position:static}.case{break-inside:avoid}.modules-bar button,.f-hint{display:none}}
</style></head>
<body><div class="wrap" id="top">
  <h1>${escapeHtml(pkg)}</h1>
  <p class="sub">Consolidated report · ${sections.length} set${sections.length === 1 ? '' : 's'} of tests run together · ${escapeHtml(new Date(generatedAt).toLocaleString())}</p>

  <div class="cards">
    <div class="card"><div class="n">${sections.length}</div><div class="l">sets of tests</div></div>
    <div class="card"><div class="n">${totals.total}</div><div class="l">test cases</div></div>
    <div class="card pass"><div class="n">${totals.passed}</div><div class="l">passed</div></div>
    <div class="card ${totals.failed ? 'fail is-link' : ''}"${totals.failed ? ' data-opens="failures" role="button" tabindex="0" title="List every failed test case"' : ''}><div class="n">${totals.failed}</div><div class="l">failed</div>${totals.failed ? '<span class="see">list them →</span>' : ''}</div>
    <div class="card"><div class="n">${fmtDuration(totals.durationMs)}</div><div class="l">total run time</div></div>
  </div>

  ${missingNote}
  ${failPanel}

  <table>
    <thead><tr><th>Set of tests</th><th class="num">Tests</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Time</th></tr></thead>
    <tbody>${contents}</tbody>
  </table>

  <div class="modules-bar">
    <h2>Sets of tests${totals.failed ? ' · sets with a failure are already open' : ''}</h2>
    <button type="button" data-modules="open">Expand all</button>
    <button type="button" data-modules="shut">Collapse all</button>
  </div>

  ${body}
</div>
<script>
(function () {
  var open = function (el) {
    for (var node = el; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
  };

  /* A jump has to open what it lands in, or the target sits inside a folded section and the page
     appears not to have moved at all. */
  var jumpTo = function (id) {
    if (id === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return true; }
    var target = document.getElementById(id);
    if (!target) return false;
    open(target);
    /* preventDefault stops the browser setting the hash itself, and without it the address bar
       still shows the top of the report — so a failing test cannot be sent to anyone. */
    if (history.replaceState) history.replaceState(null, '', '#' + id);
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
    return true;
  };

  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var link = e.target.closest('a[href^="#"]');
    if (link) {
      var id = decodeURIComponent(link.getAttribute('href').slice(1));
      /* stopPropagation because these links sit inside a <summary>: without it the browser
         follows the link and toggles the section it was in. */
      if (jumpTo(id)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    var card = e.target.closest('[data-opens]');
    if (card) {
      var panel = document.getElementById(card.getAttribute('data-opens'));
      if (panel) { panel.open = !panel.open; if (panel.open) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      return;
    }
    var all = e.target.closest('[data-modules]');
    if (all) {
      var want = all.getAttribute('data-modules') === 'open';
      document.querySelectorAll('.module').forEach(function (m) { m.open = want; });
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var card = e.target.closest && e.target.closest('[data-opens]');
    if (card) { e.preventDefault(); card.click(); }
  });

  /* Printing a folded report prints the folds. */
  window.addEventListener('beforeprint', function () {
    document.querySelectorAll('details:not([open])').forEach(function (d) { d.dataset.shut = '1'; d.open = true; });
  });
  window.addEventListener('afterprint', function () {
    document.querySelectorAll('details[data-shut]').forEach(function (d) { d.open = false; delete d.dataset.shut; });
  });

  if (location.hash.length > 1) jumpTo(decodeURIComponent(location.hash.slice(1)));
})();
</script>
</body></html>`;

  return {
    html,
    summary: {
      generatedAt,
      package: pkg,
      startedAt: startedAt ?? null,
      consolidated: true,
      moduleCount: sections.length,
      modules: sections.map((s) => ({ name: s.module, total: s.total, passed: s.passed, failed: s.failed })),
      totalTestCases: totals.total,
      passed: totals.passed,
      failed: totals.failed,
      durationMs: totals.durationMs,
      allPassed,
      missing,
    },
  };
}

/**
 * Turns a finished batch into one report on disk, and says where it went.
 *
 * Which module produced which report is known only because the dashboard queued the runs — the
 * platform's report does not record it — so the pairing comes from the batch record rather than
 * from the files. Returns null when there is nothing worth consolidating, which is the normal
 * outcome for a batch that fell over before any set produced a report.
 */
function consolidateBatchToDisk(batch, { baseDir }) {
  const parts = (batch?.records ?? [])
    .filter((record) => record.module)
    .map((record) => ({
      module: record.module,
      htmlPath: record.signals?.reportPath ?? null,
      jsonPath: record.signals?.reportPath
        ? String(record.signals.reportPath).replace(/\.html$/i, '.json')
        : null,
    }));

  const pkg = batch?.records?.find((r) => r.pkg)?.pkg;
  if (!pkg || !parts.some((p) => p.jsonPath && fs.existsSync(p.jsonPath))) return null;

  const built = buildConsolidatedReport(parts, { pkg, startedAt: batch.startedAt });
  if (!built.summary.moduleCount) return null;

  const dir = path.join(baseDir, pkg);
  fs.mkdirSync(dir, { recursive: true });
  const base = `consolidated-${batch.startedAt || Date.now()}`;
  const htmlPath = path.join(dir, `${base}.html`);

  fs.writeFileSync(htmlPath, built.html, 'utf8');
  fs.writeFileSync(
    path.join(dir, `${base}.json`),
    `${JSON.stringify(
      {
        ...built.summary,
        // Basenames of the per-set reports folded into this one, so the Results list can show
        // the report that answers the question instead of the seventeen behind it.
        parts: parts.map((p) => ({ module: p.module, file: p.htmlPath ? path.basename(p.htmlPath) : null })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return { htmlPath, file: `${base}.html`, summary: built.summary };
}

/**
 * Prepares a report and its screenshots as a set of zip entries.
 *
 * A report is only readable where its images resolve. The copies this dashboard serves point at
 * the /artifacts route, and the platform's own point at a path relative to its reports folder —
 * neither survives being saved somewhere else, which is what makes a plain "save page as" produce
 * a report with every image broken. Here both are rewritten to sit beside the HTML in the bundle,
 * so the file opens anywhere with its screenshots intact.
 *
 * @param {string} htmlPath     the report to bundle
 * @param {string} artifactsDir the platform's artifacts/apps directory, for resolving images
 * @param {string} pkg
 */
function planReportBundle(htmlPath, artifactsDir, pkg) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const seen = new Map();

  const rewritten = html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/gi, (match, before, src, after) => {
    const resolved = resolveScreenshot(src, artifactsDir, pkg, htmlPath);
    if (!resolved) return match;
    if (!seen.has(resolved)) seen.set(resolved, path.basename(resolved));
    return `${before}screenshots/${encodeURIComponent(seen.get(resolved))}${after}`;
  });

  const entries = [{ name: 'report.html', data: rewritten }];
  for (const [absolute, name] of seen) {
    entries.push({ name: `screenshots/${name}`, path: absolute });
  }
  return entries;
}

/** Where a report's <img src> actually lives on disk, for either URL shape. */
function resolveScreenshot(src, artifactsDir, pkg, htmlPath) {
  if (/^(?:https?:)?\/\//i.test(src) || src.startsWith('data:')) return null;

  // The consolidated shape: /artifacts/<pkg>/<rest>
  const served = /^\/artifacts\/([^/]+)\/(.+)$/.exec(src);
  if (served) {
    const decoded = decodeURIComponent(served[2]).split('/').map(decodeURIComponent).join(path.sep);
    return path.join(artifactsDir, decodeURIComponent(served[1]), decoded);
  }

  // The platform's own shape: relative to the report's folder, e.g. ../execution-screenshots/x.png
  if (!src.startsWith('/')) {
    return path.resolve(path.dirname(htmlPath), decodeURIComponent(src));
  }
  return path.join(artifactsDir, pkg, decodeURIComponent(src.replace(/^\/+/, '')));
}

module.exports = {
  buildConsolidatedReport,
  consolidateBatchToDisk,
  planReportBundle,
  screenshotUrl,
  fmtDuration,
};
