'use strict';

/**
 * Turns a run's output into a short, honest verdict.
 *
 * A crawl prints well over a hundred thousand lines, of which about six matter. Two things follow
 * from that. The console keeps only a tail, so the interesting lines are usually long gone by the
 * time the run ends — which is why these are matched as the output streams past rather than read
 * back afterwards. And "exit code 0" is not the same as "this achieved something": most of the
 * disappointing runs in this project's history finished successfully, having explored two screens
 * and found nothing to write tests from. The verdict says which of those happened.
 *
 * Patterns are matched against the platform's own log lines. If the platform's wording changes a
 * signal simply stops being reported — the verdict degrades to saying less, never to being wrong.
 */

/**
 * `last` keeps the most recent match rather than the first: a pipeline reports its counts once per
 * phase, and the final one is the one that describes the run.
 */
const SIGNALS = [
  { key: 'screensDiscovered', pattern: /"screensDiscovered":\s*(\d+)/, number: true, last: true },
  { key: 'elementsVisited', pattern: /"elementsVisited":\s*(\d+)/, number: true, last: true },
  { key: 'testCasesGenerated', pattern: /"testCasesGenerated":\s*(\d+)/, number: true, last: true },
  { key: 'screensAnalyzed', pattern: /"screensAnalyzed":\s*(\d+)/, number: true, last: true },
  { key: 'crawlComplete', pattern: /Crawl complete/, flag: true },
  { key: 'safetyLimit', pattern: /Crawl safety limit reached/, count: true },
  { key: 'noMenu', pattern: /No hamburger\/navigation menu was found/, flag: true },
  { key: 'noSignUp', pattern: /No sign-up trigger was found/, flag: true },
  { key: 'noLogin', pattern: /No login trigger was found/, flag: true },
  { key: 'reportPath', pattern: /HTML report:\s*(\S+\.html)/, last: true },

  // Failures worth naming, because each has a different fix and the raw text says so poorly.
  { key: 'fatal', pattern: /^\s*(?:Import failed|Execution failed|Pipeline failed|Crawl failed):\s*(.+)$/, last: true },
  { key: 'installFailed', pattern: /(INSTALL_FAILED_[A-Z_]+)/, last: true },
  { key: 'sessionLost', pattern: /A session is either terminated or not started/, count: true },
  { key: 'instrumentationDied', pattern: /instrumentation process is not running/, count: true },
  { key: 'engineUnreachable', pattern: /ECONNREFUSED[^\n]*:4723|Failed to create session/, flag: true },
  { key: 'deviceGone', pattern: /device '[^']*' not found|device offline|device unauthorized/, flag: true },
];

/** A stateful matcher fed one output line at a time. */
function createCollector() {
  const found = Object.create(null);
  return {
    observe(text) {
      const line = String(text);
      for (const signal of SIGNALS) {
        const match = signal.pattern.exec(line);
        if (!match) continue;
        if (signal.count) {
          found[signal.key] = (found[signal.key] ?? 0) + 1;
        } else if (signal.flag) {
          found[signal.key] = true;
        } else if (signal.last || found[signal.key] === undefined) {
          const value = match[1] ?? true;
          found[signal.key] = signal.number ? Number(value) : value;
        }
      }
    },
    result() {
      return { ...found };
    },
  };
}

/**
 * Plain-language verdict for a finished run.
 *
 * Returns `{ tone, headline, details }` — tone being 'good' | 'warn' | 'bad', so the dashboard can
 * colour it without re-deciding what the run meant.
 */
function describe({ signals = {}, ok, exitCode, kind }) {
  const details = [];

  // A failure explains itself first; nothing below it matters if the run never got going.
  if (signals.engineUnreachable) {
    return {
      tone: 'bad',
      headline: 'The test engine was not reachable, so nothing ran.',
      details: ['Press "Start test engine" and try again.'],
    };
  }
  if (signals.deviceGone) {
    return {
      tone: 'bad',
      headline: 'The phone disconnected, so the run could not finish.',
      details: ['Check the USB cable, unlock the phone, then press Refresh under "Choose a phone".'],
    };
  }
  if (signals.installFailed) {
    const split = /MISSING_SPLIT/.test(signals.installFailed);
    return {
      tone: 'bad',
      headline: `The app could not be installed (${signals.installFailed}).`,
      details: [
        split
          ? 'This app was delivered in several pieces by the Play Store, so its base file cannot be installed on its own. Use the original .apk.'
          : 'The app on the phone may be a newer version, or signed by a different key. Uninstall it from the phone and try again.',
      ],
    };
  }
  if (signals.fatal) {
    return { tone: 'bad', headline: String(signals.fatal), details: [] };
  }
  if (!ok) {
    return {
      tone: 'bad',
      headline: `The run stopped with exit code ${exitCode ?? 'unknown'}.`,
      details: ['The reason should be in the last few lines of the output above.'],
    };
  }

  // Succeeded — but say what it actually produced, because "finished" is not "useful".
  if (kind === 'crawl') {
    const screens = signals.screensDiscovered ?? 0;
    const elements = signals.elementsVisited ?? 0;
    const generated = signals.testCasesGenerated ?? 0;

    if (signals.safetyLimit) {
      details.push(
        `Exploration stopped early ${signals.safetyLimit} time(s) at the limits you set. Raise "how many screens" for more coverage.`,
      );
    }
    const missing = [
      signals.noLogin ? 'sign-in' : null,
      signals.noSignUp ? 'sign-up' : null,
      signals.noMenu ? 'menu' : null,
    ].filter(Boolean);
    if (missing.length) {
      details.push(
        `No ${missing.join(', ')} was recognised on the screens it reached, so no tests were written for ${missing.length === 1 ? 'it' : 'those'}.`,
      );
    }
    if (screens > 0) {
      details.push('This app can now be used in "Create tests from a flow".');
    }

    const tone = screens === 0 ? 'bad' : screens < 3 ? 'warn' : 'good';
    return {
      tone,
      headline:
        screens === 0
          ? 'The run finished but mapped no screens.'
          : `Explored ${screens} screen${screens === 1 ? '' : 's'} and recorded ${elements} element${elements === 1 ? '' : 's'}${generated ? `, writing ${generated} test case${generated === 1 ? '' : 's'}` : ''}.`,
      details,
    };
  }

  if (kind === 'import') {
    const generated = signals.testCasesGenerated ?? 0;
    return {
      tone: generated > 0 ? 'good' : 'warn',
      headline:
        generated > 0
          ? `Created ${generated} test case${generated === 1 ? '' : 's'} from your sheet.`
          : 'The sheet was read but no test cases came out of it.',
      details:
        generated > 0
          ? ['Run them from "Run tests", under the "manual" set.']
          : ['Check that the steps in the sheet describe buttons and fields the app actually has.'],
    };
  }

  if (signals.sessionLost || signals.instrumentationDied) {
    details.push(
      'The phone dropped its automation session at least once during the run, which usually shows up as steps failing for no clear reason.',
    );
  }
  if (signals.reportPath) details.push('A report was written — see the Results tab.');

  return { tone: 'good', headline: 'Finished.', details };
}

module.exports = { createCollector, describe, SIGNALS };
