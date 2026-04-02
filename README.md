# Allure Deployer Action

Deploy Allure 3 test reports to GitHub Pages with History, Report Aggregation, and a Summary Landing Page.

**Supported Runners:**
- `ubuntu-latest`
- `macos-latest`
- `windows-latest`
- `Self-hosted runner` — ensure [firewall rules are configured](https://github.com/actions/toolkit/tree/main/packages/artifact#breaking-changes).

## Features

- Generates **Allure 3** reports (no Java required)
- Deploys to **GitHub Pages** with unique URLs per run
- **History tracking** across runs via GitHub Artifacts
- **Summary landing page** at the GitHub Pages root listing all report prefixes with stats (powered by `@allurereport/summary`), with deploy-in-progress and new version banners
- **Job summary table** with pie charts, colored status dots, and report links
- **Combined summary mode** — aggregate multiple parallel test jobs into one summary table
- **Re-run tracking** — detects re-run attempts via `deploy.json` metadata
- **PR comments** with test results summary
- **Multi-project** support via `prefix` — multiple test suites on one GitHub Pages site
- **Concurrent-safe** — parallel workflows can deploy different prefixes simultaneously (5 push retries)
- **Cache-proof redirects** — prefix redirect pages always resolve the latest report, even when browser-cached

## Example 1: Deploy to GitHub Pages

```yaml
jobs:
  gh-pages:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pages: read
    steps:
      - uses: actions/checkout@v6
      - name: Run tests
        run: # Run tests that produce allure-results
      - name: Deploy Allure Report
        uses: deivydasp/allure-deployer-action@v2
        with:
          allure_results_path: 'allure-results'
```

---

## Example 2: Pull Request comment with report link

```yaml
on:
  pull_request:
jobs:
  allure-pr:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pages: read
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v6
      - name: Run tests
        run: # Run tests that produce allure-results
      - name: Deploy Allure Report
        uses: deivydasp/allure-deployer-action@v2
        with:
          allure_results_path: 'allure-results'
          pr_comment: 'true'
```

---

## Example 3: Multi-project setup

```yaml
- name: Deploy API tests
  uses: deivydasp/allure-deployer-action@v2
  with:
    allure_results_path: 'api-test-results'
    prefix: 'api-tests'

- name: Deploy E2E tests
  uses: deivydasp/allure-deployer-action@v2
  with:
    allure_results_path: 'e2e-test-results'
    prefix: 'e2e-tests'
```

This creates separate report sections at `/api-tests/` and `/e2e-tests/` with a summary landing page at the root.

---

## Example 4: Combined summary for parallel test jobs

When running multiple test jobs in parallel, suppress individual summaries and use a combined summary job:

```yaml
jobs:
  test-api:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pages: read
    steps:
      - uses: actions/checkout@v6
      - run: # Run API tests
      - uses: deivydasp/allure-deployer-action@v2
        with:
          allure_results_path: 'api-results'
          prefix: 'api-tests'
          report_name: 'API Tests'
          summary: 'false'

  test-e2e:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pages: read
    steps:
      - uses: actions/checkout@v6
      - run: # Run E2E tests
      - uses: deivydasp/allure-deployer-action@v2
        with:
          allure_results_path: 'e2e-results'
          prefix: 'e2e-tests'
          report_name: 'E2E Tests'
          summary: 'false'

  allure-summary:
    needs: [test-api, test-e2e]
    if: '!cancelled()'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pages: read
    steps:
      - uses: deivydasp/allure-deployer-action@v2
        with:
          mode: summary
          prefixes: 'api-tests,e2e-tests'
```

The summary job produces one table with all test results, showing "Not deployed" for any cancelled/skipped jobs.

## More examples

- [Deploy to GitHub Pages](examples/deploy-github-pages.yaml)
- [Aggregate multiple Allure results](examples/aggregate-report.yaml)
- [Deploy to another GitHub repository](examples/deploy-external-repo.yaml)
- [Multi-project setup with prefix](examples/multi-projects-gh-pages.yaml)
- [PR comment with report link](examples/pr-comment.yaml)
- [Combined summary for parallel jobs](examples/combined-summary.yaml)


## Configuration Options (Inputs)

| Name                  | Description                                                                                    | Default             | Required |
|-----------------------|------------------------------------------------------------------------------------------------|---------------------|----------|
| `mode`                | Action mode: `deploy` (generate and deploy report) or `summary` (read gh-pages and write combined summary). | `deploy` | No |
| `allure_results_path` | Path(s) to Allure results. Separate multiple paths with commas. Required in deploy mode. Fails early if no valid paths are found. | —                   | No       |
| `github_token`        | GitHub token or PAT for GitHub Pages deployment and `pr_comment`.                              | `github.token`      | No       |
| `github_pages_branch` | Branch used for GitHub Pages deployments.                                                      | `gh-pages`          | No       |
| `github_pages_repo`   | GitHub repository to deploy GitHub Pages to. Format: `owner/repo`.                             | `github.repository` | No       |
| `show_history`        | Display history from previous runs.                                                            | `true`              | No       |
| `report_name`         | Custom name/title for the report.                                                              | —                   | No       |
| `language`            | Allure report language.                                                                        | —                   | No       |
| `custom_report_dir`   | Directory to copy the generated report into, for use in subsequent workflow steps.              | —                   | No       |
| `prefix`              | Prefix to uniquely identify test report artifacts. Required for summary page, redirect page, rerun tracking, and summary mode. | —  | No       |
| `keep`                | Number of test reports to keep alive. Also limits history entries.                              | `10`                | No       |
| `pr_comment`          | Post report info as a PR comment. Requires `pull_requests: write` and `issues: write`.         | `true`              | No       |
| `summary`             | Write a GitHub Actions job summary after deployment. Set to `false` when using a separate summary job. | `true` | No |
| `prefixes`            | Comma-separated list of prefixes to include in summary mode. If omitted, all prefixes are scanned. | — | No |

## Outputs

| Name               | Description                                                       |
|--------------------|-------------------------------------------------------------------|
| `report_url`       | URL of the test report.                                           |
| `summary_page_url` | URL of the summary landing page (available when `prefix` is set). |


## Setup Notes

- **GitHub Pages:**
  - `github_token` must have `contents: write` (to push report files) and `pages: read` (to verify Pages configuration).
  - History is stored on the gh-pages branch alongside reports — no `actions: write` needed.
  - GitHub Pages must be configured to deploy from the `github_pages_branch` (default: `gh-pages`).
  - Summary mode only needs `contents: read` and `pages: read`.
- **Pull Request Comments:**
  - `github_token` must have `pull_requests: write` and `issues: write`.
- **No Java Required:**
  - This action uses Allure 3 (`allure` npm package), which is pure JavaScript. No Java runtime needed.

## Contributing and Licensing

- **License:** BSD-3 License. See the [LICENSE](LICENSE) file for details.
- **Contributing:** Contributions are welcome! Open issues or submit pull requests to help improve this action.
