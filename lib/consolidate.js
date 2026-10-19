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

function renderTestCase(testCase, pkg) {
  const passed = String(testCase.status).toLowerCase() === 'passed';
  const steps = Array.isArray(testCase.stepResults) ? testCase.stepResults : [];
  const failedSteps = steps.filter((s) => String(s.status).toLowerCase() !== 'passed').length;
  // Failures start open, passes start closed: a report across every module is far too long to
  // read end to end, and what someone opens it for is whatever went wrong.
  return `<details class="case ${passed ? 'pass' : 'fail'}"${passed ? '' : ' open'}>
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

  const contents = sections
    .map(
      (s) => `<tr class="${s.failed ? 'has-fail' : ''}">
      <td><a href="#m-${slug(s.module)}">${escapeHtml(s.module)}</a></td>
      <td class="num">${s.total}</td>
      <td class="num pass">${s.passed}</td>
      <td class="num ${s.failed ? 'fail' : ''}">${s.failed}</td>
      <td class="num">${fmtDuration(s.durationMs)}</td>
    </tr>`,
    )
    .join('');

  const body = sections
    .map(
      (s) => `<section class="module" id="m-${slug(s.module)}">
  <div class="module-head">
    <h2>${escapeHtml(s.module)}</h2>
    <span class="badge ${s.failed ? 'fail' : 'pass'}">${s.passed}/${s.total} passed</span>
    <span class="dur">${fmtDuration(s.durationMs)}</span>
    <a class="top" href="#top">back to top</a>
  </div>
  ${s.results.map((r) => renderTestCase(r, pkg)).join('')}
</section>`,
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
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:26px}
  th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}
  th{background:#f8fafc;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--soft)}
  tr:last-child td{border-bottom:0}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  td.pass{color:var(--pass)} td.fail{color:var(--fail);font-weight:700}
  tr.has-fail td:first-child a{font-weight:700}
  a{color:#1f6feb}
  .module{margin-bottom:30px}
  .module-head{display:flex;align-items:center;gap:10px;padding-bottom:8px;border-bottom:2px solid var(--line);margin-bottom:12px;position:sticky;top:0;background:var(--bg);padding-top:10px;z-index:2}
  .module-head h2{font-size:19px;margin:0}
  .module-head .top{margin-left:auto;font-size:12px}
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
  .shot img{max-width:300px;max-height:300px;border:1px solid var(--line);border-radius:6px;display:block}
  .trace{background:#fdf2f0;border:1px solid #f3d5cf;border-radius:6px;padding:8px;font-size:12px;overflow-x:auto;white-space:pre-wrap}
  .note{background:#fdf7ea;border-left:3px solid #b3720a;padding:10px 12px;border-radius:0 6px 6px 0}
  @media print{.module-head{position:static}.case{break-inside:avoid}}
</style></head>
<body><div class="wrap" id="top">
  <h1>${escapeHtml(pkg)}</h1>
  <p class="sub">Consolidated report · ${sections.length} set${sections.length === 1 ? '' : 's'} of tests run together · ${escapeHtml(new Date(generatedAt).toLocaleString())}</p>

  <div class="cards">
    <div class="card"><div class="n">${sections.length}</div><div class="l">sets of tests</div></div>
    <div class="card"><div class="n">${totals.total}</div><div class="l">test cases</div></div>
    <div class="card pass"><div class="n">${totals.passed}</div><div class="l">passed</div></div>
    <div class="card ${totals.failed ? 'fail' : ''}"><div class="n">${totals.failed}</div><div class="l">failed</div></div>
    <div class="card"><div class="n">${fmtDuration(totals.durationMs)}</div><div class="l">total run time</div></div>
  </div>

  ${missingNote}

  <table>
    <thead><tr><th>Set of tests</th><th class="num">Tests</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Time</th></tr></thead>
    <tbody>${contents}</tbody>
  </table>

  ${body}
</div></body></html>`;

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
