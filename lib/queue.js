'use strict';

/**
 * Runs waiting their turn behind the one in progress.
 *
 * The platform executes exactly one module per invocation and a phone can only hold one session,
 * so "run every set of tests" is necessarily a sequence rather than one command. Keeping that
 * sequence on the server rather than in the browser means closing the tab does not abandon a
 * batch halfway through.
 *
 * What stops a batch is the interesting decision. Tests failing is a result — the remaining sets
 * are still worth running, and stopping there would hide whatever else is broken. A phone that has
 * gone away, an engine that is not answering, or an app that will not install makes every queued
 * run fail identically, so those end the batch rather than repeating the same error another
 * sixteen times.
 *
 * A batch also remembers what each of its runs produced, so the whole thing can be reported on
 * together once it finishes. One invocation writes one report, so a seventeen-set batch leaves
 * seventeen of them; the record kept here is what lets those be drawn back together.
 */

/** Signals from lib/outcome.js that make every remaining run pointless. */
const ABORT_SIGNALS = ['deviceGone', 'engineUnreachable', 'installFailed'];

function createRunQueue(jobs, { onChange = () => {}, onBatchComplete = () => {} } = {}) {
  const pending = [];
  let note = null;
  /** The run now in progress, kept so its output can be filed against the right set. */
  let current = null;
  /** Accumulates across a multi-set batch; null when a single set is running on its own. */
  let batch = null;

  const state = () => ({
    pending: pending.length,
    upcoming: pending.map((job) => job.queueLabel),
    note,
  });

  function clear(newNote = null) {
    const dropped = pending.length;
    pending.length = 0;
    note = newNote;
    return dropped;
  }

  function finishBatch() {
    if (!batch) return;
    const completed = batch;
    batch = null;
    // Reported even when the batch was cut short: what did run is still worth seeing together.
    if (completed.records.length > 1) onBatchComplete(completed);
  }

  function launch(run) {
    current = run;
    jobs.start(run);
  }

  /**
   * Starts the first run and queues the rest.
   *
   * Positions are written into the labels here so the live progress line says which set of how
   * many is running, instead of leaving someone to count finished runs in the console.
   */
  function start(runs) {
    if (!Array.isArray(runs) || !runs.length) throw new Error('Nothing to run.');
    const total = runs.length;
    const prepared = runs.map((run, index) => ({
      ...run,
      label: total > 1 ? `${run.label} — set ${index + 1} of ${total}` : run.label,
      queueLabel: run.queueLabel ?? run.label,
    }));
    note = null;
    batch = total > 1 ? { total, startedAt: Date.now(), records: [] } : null;
    const [first, ...rest] = prepared;
    const started = (launch(first), jobs.status());
    pending.push(...rest);
    return started;
  }

  jobs.on('done', (finished) => {
    const justRan = current;
    current = null;
    if (batch && justRan) {
      batch.records.push({
        module: justRan.queueLabel,
        pkg: justRan.pkg ?? null,
        signals: finished?.signals ?? {},
        ok: finished?.ok ?? false,
      });
    }

    if (!pending.length) {
      finishBatch();
      return;
    }

    const signals = finished?.signals ?? {};
    if (ABORT_SIGNALS.some((key) => signals[key])) {
      const waiting = pending.length;
      clear(
        `${waiting} further set${waiting === 1 ? '' : 's'} ${waiting === 1 ? 'was' : 'were'} not run, ` +
          'because the phone or the test engine stopped responding.',
      );
      finishBatch();
      onChange();
      return;
    }

    try {
      launch(pending.shift());
    } catch (error) {
      clear(`The next set could not be started: ${error.message}`);
      finishBatch();
      onChange();
    }
  });

  return { state, clear, start };
}

module.exports = { createRunQueue, ABORT_SIGNALS };
