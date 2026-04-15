# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GitHub Action that deploys Allure test reports to **GitHub Pages** with history and report aggregation. Runs on ubuntu, macOS, Windows, and self-hosted runners.

## Build & Development Commands

```bash
npm test               # Run unit tests (vitest) — run before build
npm run build          # TypeScript compile + ncc bundle (dist/main/ and dist/cleanup/)
npm run lint           # ESLint on src/
```

### Testing

A CI workflow (`.github/workflows/ci.yml`) runs automatically on push to master when source or config files change. It:
1. Runs unit tests (`npm test`), validates the build (`tsc --noEmit`), and lint (`eslint`)
2. Triggers all 9 integration test workflows (3 at a time via `max-parallel: 3`)

#### Unit Tests

```bash
npm test               # Run once (CI)
npm run test:watch     # Watch mode (development)
```

Unit tests use **vitest** with `pool: 'forks'` (required for `@actions/core` compatibility). Tests are in `__tests__/` mirroring the `src/` structure. Always run `npm test` before `npm run build` — tests catch library breakage before the bundle is produced.

After pushing, verify CI and test results:

```bash
# Check CI status
gh run list --workflow=ci.yml --limit 1

# Check all test results (~2 minutes after push)
gh run list --limit 12 --json name,status,conclusion --jq '.[] | select(.name != "pages build and deployment" and .name != "CI") | "\(.conclusion // .status)\t\(.name)"'
```

Tests can also be triggered manually: `gh workflow run "Test: Basic Deploy"` etc.

All test workflows use `workflow_dispatch`, test the action from `./` (current commit), and deploy to the repo's own gh-pages branch using fixtures in `test-fixtures/`.

The action runs on **Node 24**. The build produces two ncc bundles:
- `dist/main/index.js` — main action entry point
- `dist/cleanup/index.js` — post-action cleanup (currently no-op)

`dist/` is committed to git (GitHub Actions runs it directly). `node_modules/` is not — ncc bundles all dependencies except `allure` and `@allurereport/summary` which are externalized (`-e` flags) and installed separately in `dist/main/node_modules/`.

### Build Pipeline

Before building, always run tests: `npm test && npm run build`

The build script does:
1. `tsc` — compile TypeScript
2. `ncc build` — bundle into `dist/main/index.js` with `allure` and `@allurereport/summary` as externals
3. `ncc build` — bundle cleanup into `dist/cleanup/index.js`
4. `node scripts/patch-dist-package.js` — adds `overrides: { "d3-time": "3" }` to `dist/main/package.json` to fix npm hoisting issue where d3-time@1.x gets hoisted over d3-time@3.x (breaking d3-scale)
5. `npm install allure@^3.3.1` in `dist/main/` — installs the allure CLI and its dependency tree

## Architecture

**ESM-only project** — uses `"type": "module"` with `.js` extensions in all TypeScript imports. TypeScript target is `es2022`.

### Allure 3 Integration

Uses the **`allure` npm package (v3.x)** — a pure JavaScript CLI (no Java required). Report generation uses `allure generate --config allurerc.json` with a dynamically generated config file that enables the `awesome` plugin.

Key details:
- **Config-driven**: `src/services/allure-report.service.ts` generates `allurerc.json` at runtime with plugin config, history path, and history limit
- **CLI invocation**: `src/services/allure.service.ts` spawns `node cli.js` (resolved from the allure package) as a child process. Uses `AbortController` with a 5-minute timeout. Listens on `close` event (not `exit`) to ensure stdio streams are fully flushed before reading output.
- **History**: Uses JSONL format (`history.jsonl`) stored on the gh-pages branch at `{prefix}/history/history.jsonl`. After shallow clone, history is already on disk. The `allure awesome` plugin reads/appends history via `--history-path` config. Post-generation, history is truncated to the `keep` limit and patched with the report URL for clickable history links. History is committed atomically with the report.
- **History redirect**: Creates `awesome/index.html` redirect in single-plugin reports because Allure 3's awesome theme appends `/awesome` to history URLs

### Two Modes (src/main.ts)

The action has two modes controlled by the `mode` input:

**Deploy mode** (`mode: deploy`, default):
1. **Validate** — Checks GitHub token, verifies Pages is configured for the target branch
2. **Stage** — Copies allure-results to staging. History is already available on disk from the shallow clone at `{prefix}/history/history.jsonl`.
3. **Generate** — Uses `allure generate --config allurerc.json` via `src/services/allure-report.service.ts` to produce the HTML report, then post-processes history (URL patching + truncation)
4. **Metadata** — Writes `deploy.json` to the report directory with `runId`, `runAttempt`, `wallClockDuration`, `timestamp` for summary mode and re-run tracking
5. **Deploy** — Report stats and custom dir copy are done *before* deploy to avoid race conditions with `git reset --hard`. Then `prepareAndCommit` (delete old reports, redirect page, summary page, stage report + history, commit), then push with retry. On push rejection, backup is created lazily (only on first rejection to skip I/O on happy path) for both report and history, then resets to latest remote, restores from backup, re-runs `prepareAndCommit`, and pushes again.
6. **Notify** — Console, GitHub PR comment, and Actions job summary (skipped when `summary: false`). Includes summary page URL link (with allure logo icon).
7. **Quality gate** — If `fail_on_test_failure` is `true`, checks for failed/broken tests and calls `setFailed()` with counts and report URL. Runs after deploy and notify so the report is always accessible.

**Summary mode** (`mode: summary`):
1. **Validate** — Same GitHub Pages validation as deploy mode
2. **Clone** — Shallow clone of gh-pages branch (read-only)
3. **Scan** — Reads `summary.json` and `deploy.json` from each prefix's latest report directory. Detects re-runs by matching `runId` across report dirs. In pipeline mode (`prefixes` specified), shows "Not deployed" for expected prefixes that weren't deployed in this run.
4. **Render** — Builds a combined summary table with pie charts, status dots, duration, and report links. Dynamic "Rerun #N" columns appear when re-runs are detected.
5. **Write** — Writes the table to `GITHUB_STEP_SUMMARY`

### Root Summary Page

`src/services/github-pages.service.ts` generates a root `index.html` on gh-pages using `@allurereport/summary` (same SPA as the official allure3-demo). It scans all prefix directories, reads each latest report's `summary.json` for stats, and produces an interactive landing page. Generated as part of `prepareAndCommit`, which also runs during push retries on the latest remote state, so it always reflects reports from parallel workflows. A `.nojekyll` file is added to ensure all files (including `_version`) are served correctly.

**Staleness detection banner**: The summary page includes a client-side script that detects stale content via two mechanisms:
1. **Deploy-in-progress**: The summary page URL in job summary/PR includes `?v=<timestamp>`. If the page's embedded version differs from the URL param, it shows a "Deployment in progress" banner (no refresh button) — polling continues until the deploy completes, then transitions to the next banner.
2. **Newer version available**: Polls `_version` from the same Pages origin with cache-busting (10s for first 5 min, then 30s). When a new deploy completes and `_version` changes, shows "A newer version is available" with a refresh button.

The summary page URL is surfaced as the `summary_page_url` action output and shown in job summary, PR comments, and console output (only when `prefix` is set).

### Source Structure

```
src/
├── index.ts                              # Entry point → calls main()
├── main.ts                               # Core orchestration
├── io.ts                                 # Reads GitHub Actions inputs
├── interfaces/                           # All interfaces and types
│   ├── command.interface.ts              # CommandRunner (CLI execution contract)
│   ├── executor.interface.ts             # ExecutorInterface (report metadata)
│   ├── github.interface.ts               # GithubInterface (PR, summary, output)
│   ├── hosting-provider.interface.ts     # HostingProvider (init/deploy)
│   ├── inputs.interface.ts               # Inputs, DefaultConfig
│   ├── notification-data.ts              # NotificationData type
│   ├── notifier.interface.ts             # Notifier (notify contract)
│   └── report-statistic.ts              # ReportStatistic type
├── services/                             # All service implementations
│   ├── allure.service.ts                 # Allure CLI spawner (child_process)
│   ├── allure-report.service.ts          # Report generation (allurerc config, history post-processing)
│   ├── github.service.ts                 # GitHub API (PR comments, outputs, summaries)
│   └── github-pages.service.ts           # Git operations (clone, commit, push, cleanup, summary page, history)
├── notifiers/                            # Notification implementations
│   ├── console.notifier.ts              # Console output notifier
│   ├── github.notifier.ts               # PR comments + job summary notifier
│   └── notify-handler.ts                 # Orchestrates multiple notifiers
└── utilities/
    ├── cleanup.ts                        # Post-action cleanup (no-op)
    ├── copy-files.ts                     # Concurrent file copying
    ├── get-report-stats.ts               # Report statistics extraction
    ├── summary-table.ts                  # Summary table rendering (pie charts, dots, rerun columns)
    ├── util.ts                           # Retry logic, file helpers
    └── validate-results-paths.ts         # Input path validation
scripts/
    └── patch-dist-package.js             # Adds d3-time override to dist/main/package.json
```

### Key Modules

- **`src/services/github-pages.service.ts`** — The most complex file. Implements `HostingProvider` directly. Handles git clone (shallow, depth=1), branch creation (uses `git ls-remote --symref HEAD` to discover default branch), old report cleanup (filters by numeric timestamp directory name, accounts for incoming report in `keep` count), redirect page (dynamic — writes target URL to `_latest` file, redirect page fetches it with cache-busting so even a cached page always resolves the current report), root summary page (via `@allurereport/summary`), and commit+push with retry (5 attempts). On concurrent push conflicts, lazily backs up the report, resets to remote, restores and re-applies all changes cleanly.
- **`src/services/allure-report.service.ts`** — Generates `allurerc.json` config, runs `allure generate`, post-processes history (URL patching, truncation), creates history redirect for single-plugin reports.
- **`src/services/allure.service.ts`** — Resolves the allure CLI binary path from the `allure` package and spawns it as a child process.
- **`src/utilities/get-report-stats.ts`** — Reads report statistics from `summary.json` (supporting both `stats` and `statistic` fields for v2/v3 compat), falling back to `widgets/statistic.json` (single-plugin) or `awesome/widgets/statistic.json` (multi-plugin).

## Key Patterns

- **Dependency injection** — services passed as constructor args (e.g., `GithubHost` wraps `GithubPagesService`)
- **Interface segregation** — small interfaces: `HostingProvider` (init/deploy), `Notifier` (notify)
- **Retry with exponential backoff** — `withRetry()` in `src/utilities/util.ts` (3 retries, 1-10s delay, 2x backoff). Preserves original error as `cause` on the wrapping error for stack trace debugging.
- **Concurrency control** — `p-limit` for parallel file operations
- **Consistent logging** — all logging uses `@actions/core` (`info`, `warning`, `error`, `setFailed`) for proper GitHub Actions UI integration. All `catch` blocks log warnings (no silent swallowing).
- **Consistent fs imports** — named imports from `node:fs` (sync) and `node:fs/promises` (async) throughout. No `fs.promises.*` pattern.
- **Input validation** — empty result paths throw early with clear message, `runAttempt` is coerced to number with fallback to 1, branch defaults are applied before validation
- **Config-driven report generation** — dynamically generated `allurerc.json` passed to `allure generate --config` for full control over plugins, history, and report options
- **Deploy metadata** — `deploy.json` written to each report directory with `runId`, `runAttempt`, `wallClockDuration`, `timestamp` for summary mode duration and re-run tracking
- **Summary table** — shared `buildSummaryTable()` utility used by both deploy mode (single row) and summary mode (multi-row). Uses allure's public chart worker for pie/dot images. Dynamic rerun columns only appear when re-runs detected.
