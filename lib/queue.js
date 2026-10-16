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
 */

/** Signals from lib/outcome.js that make every remaining run pointless. */
const ABORT_SIGNALS = ['deviceGone', 'engineUnreachable', 'installFailed'];

function createRunQueue(jobs, { onChange = () => {} } = {}) {
  const pending = [];
  let note = null;

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
    const [first, ...rest] = prepared;
    const started = jobs.start(first);
    pending.push(...rest);
    return started;
  }

  jobs.on('done', (finished) => {
    if (!pending.length) return;

    const signals = finished?.signals ?? {};
    if (ABORT_SIGNALS.some((key) => signals[key])) {
      const waiting = pending.length;
      clear(
        `${waiting} further set${waiting === 1 ? '' : 's'} ${waiting === 1 ? 'was' : 'were'} not run, ` +
          'because the phone or the test engine stopped responding.',
      );
      onChange();
      return;
    }

    const next = pending.shift();
    try {
      jobs.start(next);
    } catch (error) {
      clear(`The next set could not be started: ${error.message}`);
      onChange();
    }
  });

  return { state, clear, start };
}

module.exports = { createRunQueue, ABORT_SIGNALS };
