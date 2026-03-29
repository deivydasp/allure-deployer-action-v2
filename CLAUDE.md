# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GitHub Action that deploys Allure test reports to **GitHub Pages** with history and report aggregation. Runs on ubuntu, macOS, Windows, and self-hosted runners.

## Build & Development Commands

```bash
npm run build          # TypeScript compile + ncc bundle (dist/main/ and dist/cleanup/)
npm run lint           # ESLint on src/
```

The action runs on **Node 24**. The build produces two ncc bundles:
- `dist/main/index.js` — main action entry point
- `dist/cleanup/index.js` — post-action cleanup (currently no-op)

`dist/` is committed to git (GitHub Actions runs it directly). `node_modules/` is not — ncc bundles all dependencies except `allure` and `@allurereport/summary` which are externalized (`-e` flags) and installed separately in `dist/main/node_modules/`.

### Build Pipeline

The build script does:
1. `tsc` — compile TypeScript
2. `ncc build` — bundle into `dist/main/index.js` with `allure` and `@allurereport/summary` as externals
3. `ncc build` — bundle cleanup into `dist/cleanup/index.js`
4. `node scripts/patch-dist-package.js` — adds `overrides: { "d3-time": "3" }` to `dist/main/package.json` to fix npm hoisting issue where d3-time@1.x gets hoisted over d3-time@3.x (breaking d3-scale)
5. `npm install allure@^3.3.1` in `dist/main/` — installs the allure CLI and its dependency tree

## Architecture

**ESM-only project** — uses `"type": "module"` with `.js` extensions in all TypeScript imports.

### Allure 3 Integration

Uses the **`allure` npm package (v3.x)** — a pure JavaScript CLI (no Java required). Report generation uses `allure generate --config allurerc.json` with a dynamically generated config file that enables the `awesome` plugin.

Key details:
- **Config-driven**: `src/shared/features/allure.ts` generates `allurerc.json` at runtime with plugin config, history path, and history limit
- **CLI invocation**: `src/shared/services/allure.service.ts` spawns `node cli.js` (resolved from the allure package) as a child process
- **History**: Uses JSONL format (`history.jsonl`) stored as GitHub Artifacts. The `allure awesome` plugin reads/appends history via `--history-path` config. Post-generation, history is truncated to the `keep` limit and patched with the report URL for clickable history links.
- **History redirect**: Creates `awesome/index.html` redirect in single-plugin reports because Allure 3's awesome theme appends `/awesome` to history URLs

### Two Modes (src/main.ts)

The action has two modes controlled by the `mode` input:

**Deploy mode** (`mode: deploy`, default):
1. **Validate** — Checks GitHub token, verifies Pages is configured for the target branch
2. **Stage** — Copies allure-results to staging, downloads history.jsonl from GitHub Artifacts (runs sequentially to avoid memory spikes)
3. **Generate** — Uses `allure generate --config allurerc.json` via `src/shared/features/allure.ts` to produce the HTML report, then post-processes history (URL patching + truncation)
4. **Metadata** — Writes `deploy.json` to the report directory with `runId`, `runAttempt`, `wallClockDuration`, `timestamp` for summary mode and re-run tracking
5. **Deploy** — `prepareAndCommit` (delete old reports, redirect page, summary page, stage, commit), then push with retry. On push rejection (concurrent workflows), resets to latest remote, restores report from backup, re-runs `prepareAndCommit`, and pushes again. Upload history artifact and copy to custom dir run in parallel.
6. **Notify** — Console, GitHub PR comment, and Actions job summary (skipped when `summary: false`)

**Summary mode** (`mode: summary`):
1. **Validate** — Same GitHub Pages validation as deploy mode
2. **Clone** — Shallow clone of gh-pages branch (read-only)
3. **Scan** — Reads `summary.json` and `deploy.json` from each prefix's latest report directory. Detects re-runs by matching `runId` across report dirs. In pipeline mode (`prefixes` specified), shows "Not deployed" for expected prefixes that weren't deployed in this run.
4. **Render** — Builds a combined summary table with pie charts, status dots, duration, and report links. Dynamic "Rerun #N" columns appear when re-runs are detected.
5. **Write** — Writes the table to `GITHUB_STEP_SUMMARY`

### Root Summary Page

`src/services/github-pages.service.ts` generates a root `index.html` on gh-pages using `@allurereport/summary` (same SPA as the official allure3-demo). It scans all prefix directories, reads each latest report's `summary.json` for stats, and produces an interactive landing page. Generated as part of `prepareAndCommit`, which also runs during push retries on the latest remote state, so it always reflects reports from parallel workflows.

### Source Structure

```
src/
├── index.ts                          # Entry point → calls main()
├── main.ts                           # Core orchestration
├── io.ts                             # Reads GitHub Actions inputs
├── interfaces/                       # Interfaces for this repo's services
├── features/
│   ├── github-storage.ts             # IStorage impl using GitHub Artifacts
│   ├── hosting/github.host.ts        # HostingProvider impl for GitHub Pages
│   └── messaging/github-notifier.ts  # Notifier impl for PR comments + job summary
├── services/
│   ├── github-pages.service.ts       # Git operations (clone, commit, push, cleanup, summary page)
│   ├── artifact.service.ts           # GitHub Artifacts API (upload/download/list/delete)
│   └── github.service.ts             # GitHub API (PR comments, outputs, summaries)
├── utilities/
│   ├── util.ts                       # Retry logic, file helpers
│   ├── summary-table.ts              # Summary table rendering (pie charts, dots, rerun columns)
│   └── cleanup.ts                    # Post-action cleanup (no-op)
└── shared/                           # Inlined abstractions (formerly allure-deployer-shared)
    ├── index.ts                      # Barrel export
    ├── interfaces/                   # HostingProvider, IStorage, StorageProvider, Notifier, etc.
    ├── types/                        # ReportStatistic, NotificationData
    ├── features/                     # Allure report gen (allurerc config, history post-processing)
    ├── services/                     # AllureService (CLI wrapper via child_process.spawn)
    └── utilities/                    # NotifyHandler, validateResultsPaths, copyFiles, getReportStats
scripts/
    └── patch-dist-package.js         # Adds d3-time override to dist/main/package.json
```

### Key Modules

- **`src/services/github-pages.service.ts`** — The most complex file. Handles git clone (shallow, depth=1), branch creation, old report cleanup (sorts by timestamp directory name, respects `keep` setting), redirect page, root summary page (via `@allurereport/summary`), and commit+push with retry. On concurrent push conflicts, backs up the report, resets to remote, restores and re-applies all changes cleanly.
- **`src/shared/features/allure.ts`** — Generates `allurerc.json` config, runs `allure generate`, post-processes history (URL patching, truncation), creates history redirect for single-plugin reports.
- **`src/shared/services/allure.service.ts`** — Resolves the allure CLI binary path from the `allure` package and spawns it as a child process.
- **`src/features/github-storage.ts`** — Downloads previous history.jsonl from GitHub Artifacts, stages it for allure, uploads the updated file after report generation. Handles concurrent artifact deletion gracefully (404 = already deleted by parallel workflow).
- **`src/services/artifact.service.ts`** — Low-level GitHub Artifacts API wrapper using Octokit. Handles download via HTTPS streams, sorting by creation time, permission checking.
- **`src/shared/utilities/get-report-stats.ts`** — Reads report statistics from `widgets/statistic.json` (single-plugin) or `awesome/widgets/statistic.json` (multi-plugin).

## Key Patterns

- **Dependency injection** — services passed as constructor args (e.g., `GithubHost` wraps `GithubPagesService`)
- **Interface segregation** — small interfaces: `HostingProvider` (init/deploy), `IStorage` (stage/upload), `Notifier` (notify)
- **Retry with exponential backoff** — `withRetry()` in `src/utilities/util.ts` (3 retries, 1-10s delay, 2x backoff)
- **Concurrency control** — `p-limit` for parallel file operations and API calls
- **Sequential staging** — git clone and file copy run concurrently, then artifact download runs after both complete to control memory on runners
- **Graceful degradation** — if GitHub token lacks `actions: write`, history is skipped with a warning instead of failing
- **Consistent logging** — all logging uses `@actions/core` (`info`, `warning`, `error`, `setFailed`) for proper GitHub Actions UI integration
- **Config-driven report generation** — dynamically generated `allurerc.json` passed to `allure generate --config` for full control over plugins, history, and report options
- **Deploy metadata** — `deploy.json` written to each report directory with `runId`, `runAttempt`, `wallClockDuration`, `timestamp` for summary mode duration and re-run tracking
- **Summary table** — shared `buildSummaryTable()` utility used by both deploy mode (single row) and summary mode (multi-row). Uses allure's public chart worker for pie/dot images. Dynamic rerun columns only appear when re-runs detected.
