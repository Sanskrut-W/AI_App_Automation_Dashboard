# Mobile Test Automation — Control Panel

A web dashboard for the AI mobile test automation platform, so the whole thing can be used without
touching a command line.

## Starting it

```
cd AI_Automation_Dashboard
npm install        # first time only
npm start
```

Then open **http://localhost:4000**.

## What you can do from it

| Tab | What it does |
| --- | --- |
| **Explore a new app** | Point it at an app — an `.apk` you have, **or one already installed on the phone**. It walks the screens on its own, records every button and field, and writes tests for any sign-in, sign-up or menu it recognises. |
| **Run tests** | Pick an app, pick a set of tests (or individual ones), run them on a connected phone. |
| **Run on several phones** | One row per phone, each with its own app and its own tests, all running at the same time through the platform multi-device runner. |
| **Create tests from a flow** | Upload a spreadsheet describing a journey; it becomes real, runnable tests using the elements recorded when the app was explored. |
| **Results** | Every run's report, newest first, with pass/fail counts and a link to the full report with screenshots. Running several sets together produces one consolidated report with a section per set. |

The header also has **Start test engine** (the platform needs Appium running and does not start it
itself), **Build platform**, and a live progress console with a **Stop** button.

## How it relates to the automation platform

The dashboard is a **separate application**. It does two things to the platform:

1. Runs the platform's own CLI as a child process — the same commands a developer would type.
2. Reads the platform's `artifacts/` folder to list apps, tests and reports.

It never writes anything into the platform's directory. Uploaded APKs and spreadsheets are stored
in this project's own `uploads/` folder. So pointing it at a working checkout is safe: the worst it
can do is run a command that was already available.

Point it at a different copy of the platform in **Settings**, or with an environment variable:

```
set AUTOMATION_DIR=D:\some\other\checkout
npm start
```

## Configuration

`config.json`:

| Key | Meaning |
| --- | --- |
| `automationDir` | Folder containing the automation platform |
| `port` | Port the dashboard listens on (default 4000) |
| `appiumPort` | Port the test engine uses (default 4723) |
| `adbPath`, `nodePath` | Override if these are not on `PATH` |

`AUTOMATION_DIR`, `PORT` and `APPIUM_PORT` override the file.

## Things worth knowing

**One job at a time, by design.** A crawl or a test run needs exclusive use of the phone, and the
platform cannot share one — starting a second session on the same device silently kills the first,
*and the second one still reports success*, so a dashboard that allowed two would appear to work
and then fail mid-run with errors that look like random flakiness. The dashboard refuses instead.
Running on several phones at once is a different thing: it is a single job that fans out
internally, one worker per phone, which is what **Run on several phones** uses.

**Exploring an app that is already on the phone.** Choose *It is already on the phone* and pick it
from the list. The dashboard copies the installed `.apk` back off the phone into `uploads/` and
hands that to the platform — exactly the file it would have received from an upload. Apps the Play
Store delivers in several pieces (a *split* install) cannot be used this way, because Android
refuses to reinstall the base piece on its own; the dashboard says so up front rather than failing
later with `INSTALL_FAILED_MISSING_SPLIT`. Those still need their original `.apk`.

**Every phone in a parallel run needs its own account.** Two phones sharing one account sign each
other out mid-run. The mapping lives in the platform's `config/test-accounts.json` under
`<package>.deviceAccounts`; rows turn amber when a phone has no account for the app it is set to
run, so it can be fixed before the run rather than during it.

**Several sets of tests give one report.** The platform runs one module per invocation and writes
one report per invocation, so running everything for an app used to leave a pile of reports that
had to be opened one at a time. Tick several sets and they are queued, and when the batch finishes
the dashboard draws their reports into a single document — overall totals, a contents table, then a
section per set. The per-set reports it folded in are hidden behind it in the Results list rather
than sitting alongside as near-duplicates. The consolidated file is written into this project's own
`reports/` folder, never the platform's, and refers to the platform's screenshots by URL.

**Reports download as a bundle, not a page.** Saving a report from the browser keeps the HTML and
loses every screenshot, because the images are served by this dashboard rather than sitting next to
the file. The Download link gives a zip of the report with its screenshots and the image references
rewritten to point inside it, so it opens on a machine that has never heard of this application.
The link shows the size first: screenshots run to better than half a megabyte each, and a run
covering a large module can bundle to tens of megabytes.

**A run is checked before it starts.** The phone is re-checked against adb at the moment you press
the button — not when the page loaded — and the test engine is started for you if it is not already
running. Both used to surface minutes later as a stack trace at the bottom of a console already
carrying thousands of lines.

**Finishing is not the same as succeeding.** A crawl that reaches two screens and recognises no
sign-in, sign-up or menu still exits 0. Every run therefore ends with a one-line verdict above the
console saying what it actually produced — screens mapped, tests written, what was not found, and
whether the app is now usable in **Create tests from a flow**. Failures name the thing to fix
(engine down, phone unplugged, app could not be installed) instead of leaving it in the log.

**The phone must be connected and authorised.** If a phone shows as `unauthorized`, unlock it and
accept the USB debugging prompt. If nothing is listed, the cable or port is usually the problem.

**Exploring is capped on purpose.** "How many screens" and "how deep" keep a first look at a new
app to a few minutes. Apps whose screen changes on every keypress (a calculator, for example) make
many screens look distinct, so start small.

**Test generation only covers recognised patterns.** The crawler works on any app, but the
automatic test writing recognises sign-in, sign-up and menu flows. An app with none of those will
be fully mapped and produce no tests — use **Create tests from a flow** for those.

## Layout

```
server.js          HTTP API, static hosting, request validation
lib/config.js      config.json + environment overrides
lib/platform.js    read-only view of the platform: apps, suites, reports, devices
lib/jobs.js        runs one CLI job at a time, buffers and streams its output
lib/outcome.js     watches a run's output and turns it into a plain-language verdict
lib/queue.js       runs several sets of tests back to back, and knows what stops a batch
lib/consolidate.js draws a batch's per-set reports into one document, and bundles one for download
lib/zip.js         a small streaming zip writer, so a bundle needs no extra dependency
lib/appium.js      starts/stops/checks the test engine
public/            the dashboard itself (no build step, no framework)
uploads/           APKs and spreadsheets uploaded through the dashboard, and APKs copied off phones
reports/           consolidated reports this dashboard writes (the platform's own are untouched)
```
