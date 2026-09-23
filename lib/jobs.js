'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const os = require('os');

const { createCollector, describe } = require('./outcome');

/**
 * Runs one automation job at a time and streams its output.
 *
 * Deliberately one at a time. A crawl or a run needs exclusive use of the device, and the platform
 * cannot share one: a second UiAutomator2 session on the same device silently terminates the
 * first, and session creation still SUCCEEDS, so a parallel dashboard would appear to work and
 * then fail mid-run with errors that look like flakiness. Serialising here makes that impossible
 * rather than merely unlikely. Genuine parallelism is a matter of more devices, which the
 * platform's own multi-device runner handles.
 *
 * Output is kept in a bounded buffer as well as streamed, so a browser that connects late (or
 * reloads mid-run) still sees what has happened so far instead of an empty console.
 */
const MAX_BUFFERED_LINES = 4000;

class JobRunner extends EventEmitter {
  constructor() {
    super();
    this.current = null;
    this.lines = [];
    this.lastFinished = null;
  }

  isBusy() {
    return this.current !== null;
  }

  status() {
    return {
      busy: this.isBusy(),
      job: this.current
        ? {
            id: this.current.id,
            label: this.current.label,
            command: this.current.printableCommand,
            startedAt: this.current.startedAt,
          }
        : null,
      lastFinished: this.lastFinished,
      lineCount: this.lines.length,
    };
  }

  history() {
    return this.lines.slice();
  }

  #emitLine(stream, text) {
    // Watched as it passes, not read back later: the buffer below keeps only the last few thousand
    // lines, and a crawl emits orders of magnitude more than that.
    //
    // Only the job's real output. The 'meta' lines are this dashboard's own echo of the command,
    // which carries a file path the user chose and can therefore contain anything at all — an apk
    // named INSTALL_FAILED_x.apk would otherwise be read as a failed install.
    if (stream !== 'meta') this.current?.collector.observe(text);
    const line = { stream, text, at: Date.now() };
    this.lines.push(line);
    if (this.lines.length > MAX_BUFFERED_LINES) {
      this.lines.splice(0, this.lines.length - MAX_BUFFERED_LINES);
    }
    this.emit('line', line);
  }

  /**
   * Starts a job.
   *
   * `args` is passed as an array, and by default WITHOUT a shell, so a path containing spaces —
   * the norm under C:\Users\... — cannot break the command or be read as extra arguments. Since
   * every path-carrying job here runs `node`, which is a real executable, that default holds for
   * the cases that matter.
   *
   * `useShell` exists for one specific reason: npm on Windows is a .cmd shim, and current Node
   * refuses to spawn .cmd/.bat without a shell — it throws EINVAL, which is exactly how this was
   * found. Those jobs take fixed arguments with no paths in them, so concatenation is harmless
   * there. Do not set it for anything that passes a file path.
   */
  start({ label, file, args, cwd, useShell = false, kind = 'other' }) {
    if (this.isBusy()) {
      throw new Error('Something is already running. Wait for it to finish, or press Stop.');
    }

    const id = `job_${Date.now()}`;
    const printableCommand = `${file} ${args.join(' ')}`;
    this.lines = [];

    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      shell: useShell,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    this.current = {
      id,
      label,
      printableCommand,
      startedAt: Date.now(),
      child,
      kind,
      collector: createCollector(),
    };
    this.emit('status', this.status());
    this.#emitLine('meta', `> ${label}`);
    this.#emitLine('meta', `> ${printableCommand}`);

    const wire = (stream, streamName) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? '';
        for (const part of parts) this.#emitLine(streamName, part);
      });
      stream.on('end', () => {
        if (pending.trim()) this.#emitLine(streamName, pending);
      });
    };
    wire(child.stdout, 'out');
    wire(child.stderr, 'err');

    const finish = (summary) => {
      if (!this.current || this.current.id !== id) return;
      const signals = this.current.collector.result();
      this.lastFinished = {
        id,
        label,
        ...summary,
        signals,
        // A verdict in words, decided here so every reader of the status agrees on what the run
        // meant — a zero exit code alone does not distinguish a useful crawl from an empty one.
        verdict: describe({ signals, ok: summary.ok, exitCode: summary.exitCode, kind }),
        finishedAt: Date.now(),
      };
      this.current = null;
      this.#emitLine('meta', summary.message);
      this.emit('status', this.status());
      this.emit('done', this.lastFinished);
    };

    child.on('error', (error) => {
      finish({ ok: false, exitCode: null, message: `> failed to start: ${error.message}` });
    });
    child.on('close', (code, signal) => {
      const stopped = signal !== null && code === null;
      finish({
        ok: code === 0,
        exitCode: code,
        signal,
        message: stopped
          ? `> stopped (${signal})`
          : `> finished with exit code ${code}${code === 0 ? '' : ' — see the output above'}`,
      });
    });

    return this.status();
  }

  /** Stops the running job, taking the whole process tree with it. */
  stop() {
    if (!this.current) return false;
    const { child } = this.current;
    this.#emitLine('meta', '> stopping…');
    if (os.platform() === 'win32') {
      // The platform's CLI spawns children of its own (adb, appium clients). Killing only the
      // parent on Windows leaves those running and holding the device, so kill the tree.
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
    return true;
  }
}

module.exports = { JobRunner };
