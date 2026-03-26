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

`dist/` is committed to git (GitHub Actions runs it directly). `node_modules/` is not — ncc bundles all dependencies.

## Architecture

**ESM-only project** — uses `"type": "module"` with `.js` extensions in all TypeScript imports.

### Deployment Flow (src/main.ts)

1. **Validate** — Checks GitHub token, verifies Pages is configured for the target branch
2. **Stage** — Copies allure-results to staging, downloads history artifacts from GitHub Artifacts (runs sequentially to avoid memory spikes)
3. **Generate** — Uses `allure-commandline` via `src/shared/features/allure.ts` to produce the HTML report
4. **Deploy** — Git push to gh-pages branch, upload artifacts, copy to custom dir (parallel)
5. **Notify** — Console, GitHub PR comment, and Actions job summary

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
│   ├── github-pages.service.ts       # Git operations (clone, commit, push, cleanup)
│   ├── artifact.service.ts           # GitHub Artifacts API (upload/download/list/delete)
│   └── github.service.ts             # GitHub API (PR comments, outputs, summaries)
├── utilities/
│   ├── util.ts                       # Retry logic, file helpers
│   └── cleanup.ts                    # Post-action cleanup (no-op)
└── shared/                           # Inlined abstractions (formerly allure-deployer-shared)
    ├── index.ts                      # Barrel export
    ├── interfaces/                   # HostingProvider, IStorage, StorageProvider, Notifier, etc.
    ├── types/                        # ReportStatistic, NotificationData
    ├── features/                     # Allure report gen, ConsoleNotifier
    ├── services/                     # AllureService (CLI wrapper)
    └── utilities/                    # NotifyHandler, validateResultsPaths, copyFiles, getReportStats
```

### Key Modules

- **`src/services/github-pages.service.ts`** — The most complex file. Handles git clone (shallow, depth=1), branch creation, old report cleanup (respects `keep` setting), redirect page generation, and commit+push with retry for concurrency conflicts.
- **`src/features/github-storage.ts`** — Downloads previous history archives from GitHub Artifacts, unzips them to staging, uploads new archives after report generation. Uses `p-limit` for concurrency control.
- **`src/services/artifact.service.ts`** — Low-level GitHub Artifacts API wrapper using Octokit. Handles download via HTTPS streams, sorting by creation time, permission checking.
- **`src/shared/`** — Inlined from the former `allure-deployer-shared` npm package. Contains shared interfaces, Allure CLI wrapper, console notifier, and file utilities.

## Key Patterns

- **Dependency injection** — services passed as constructor args (e.g., `GithubHost` wraps `GithubPagesService`)
- **Interface segregation** — small interfaces: `HostingProvider` (init/deploy), `IStorage` (stage/upload/unzip), `Notifier` (notify)
- **Retry with exponential backoff** — `withRetry()` in `src/utilities/util.ts` (3 retries, 1-10s delay, 2x backoff)
- **Concurrency control** — `p-limit` for parallel file operations and API calls
- **Sequential staging** — file copy and artifact download run sequentially to control memory on runners
- **Graceful degradation** — if GitHub token lacks `actions: write`, history is skipped with a warning instead of failing
- **Consistent logging** — all logging uses `@actions/core` (`info`, `warning`, `error`, `setFailed`) for proper GitHub Actions UI integration
