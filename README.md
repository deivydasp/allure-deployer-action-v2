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
- **Summary landing page** at the GitHub Pages root listing all report prefixes with stats
- **Clickable history** navigation between previous report runs
- **PR comments** with test results summary
- **Multi-project** support via `prefix` — multiple test suites on one GitHub Pages site
- **Concurrent-safe** — parallel workflows can deploy different prefixes simultaneously

## Example 1: Deploy to GitHub Pages

```yaml
jobs:
  gh-pages:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      actions: write
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
      actions: write
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

## More examples

- [Aggregate multiple Allure results](examples/aggregate-report.yaml)
- [Deploy to another GitHub repository](examples/deploy-external-repo.yaml)
- [Multi-project setup with prefix](examples/multi-projects-gh-pages.yaml)
- [PR comment with report link](examples/pr-comment.yaml)


## Configuration Options (Inputs)

| Name                  | Description                                                                                    | Default             | Required |
|-----------------------|------------------------------------------------------------------------------------------------|---------------------|----------|
| `allure_results_path` | Path(s) to Allure results. Separate multiple paths with commas.                                | —                   | Yes      |
| `github_token`        | GitHub token or PAT for GitHub Pages deployment and `pr_comment`.                              | `github.token`      | No       |
| `github_pages_branch` | Branch used for GitHub Pages deployments.                                                      | `gh-pages`          | No       |
| `github_pages_repo`   | GitHub repository to deploy GitHub Pages to. Format: `owner/repo`.                             | `github.repository` | No       |
| `show_history`        | Display history from previous runs.                                                            | `true`              | No       |
| `report_name`         | Custom name/title for the report.                                                              | —                   | No       |
| `language`            | Allure report language.                                                                        | —                   | No       |
| `custom_report_dir`   | Directory to copy the generated report into, for use in subsequent workflow steps.              | —                   | No       |
| `prefix`              | Prefix to uniquely identify test report artifacts when managing multiple projects.              | —                   | No       |
| `keep`                | Number of test reports to keep alive. Also limits history entries.                              | `10`                | No       |
| `pr_comment`          | Post report info as a PR comment. Requires `pull_requests: write` and `issues: write`.         | `true`              | No       |

## Outputs

| Name         | Description             |
|--------------|-------------------------|
| `report_url` | URL of the test report. |


## Setup Notes

- **GitHub Pages:**
  - `github_token` must have `contents: write` (to push report files) and `actions: write` (to back up history as GitHub Artifacts).
  - GitHub Pages must be configured to deploy from the `github_pages_branch` (default: `gh-pages`).
- **Pull Request Comments:**
  - `github_token` must have `pull_requests: write` and `issues: write`.
- **No Java Required:**
  - This action uses Allure 3 (`allure` npm package), which is pure JavaScript. No Java runtime needed.

## Contributing and Licensing

- **License:** BSD-3 License. See the [LICENSE](LICENSE) file for details.
- **Contributing:** Contributions are welcome! Open issues or submit pull requests to help improve this action.
