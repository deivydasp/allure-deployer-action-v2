# Allure Deployer Action

Deploy Allure test reports to GitHub Pages with History, Report Aggregation, and Slack integration.

**Supported Runners:**
- `ubuntu-latest`
- `macos-latest`
- `windows-latest`
- `Self-hosted runner` — ensure you have a Java runtime installed and [firewall rules configured](https://github.com/actions/toolkit/tree/main/packages/artifact#breaking-changes).

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
      - name: Run test
        run: #Run test and create allure results
      - name: Deploy Reports to GitHub Pages with History
        uses: deivydasp/allure-deployer-action@v2
        with:
          allure_results_path: 'allure-results'
          show_history: 'true'
```

---

## Example 2: Print test report URL as Pull Request comment

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
      - name: Run test
        run: #Run test and create allure results
      - name: Deploy Reports to GitHub Pages on Pull Request
        uses: deivydasp/allure-deployer-action@v2
        with:
          pr_comment: 'true'
          allure_results_path: 'allure-results'
          show_history: 'true'
```

PR comment example:
```markdown
**Test Report**: https://your-username.github.io/your-repo/123456
| Passed | Broken | Skipped | Failed | Unknown |
|--------|--------|---------|--------|---------|
| 15     | 2      | 0       | 1      | 0       |
```

---

## More examples

- [Aggregate multiple Allure results](examples/aggregate-report.yaml)
- [Deploy and notify in Slack](examples/deploy-slack.yaml)
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
| `language`            | Allure report language.                                                                        | `en`                | No       |
| `custom_report_dir`   | Directory to copy the generated report into, for use in subsequent workflow steps.              | —                   | No       |
| `prefix`              | Prefix to uniquely identify test report artifacts when managing multiple projects.              | —                   | No       |
| `keep`                | Number of test reports to keep alive.                                                          | `10`                | No       |
| `pr_comment`          | Post report info as a PR comment. Requires `pull_requests: write` and `issues: write`.         | `true`              | No       |
| `slack_channel`       | Slack channel ID for report notifications.                                                     | —                   | No       |
| `slack_token`         | Slack app token for sending notifications.                                                     | —                   | No       |

## Outputs

| Name         | Description             |
|--------------|-------------------------|
| `report_url` | URL of the test report. |


## Setup Notes

- **GitHub Pages:**
  - `github_token` must have `contents: write` (to push report files) and `actions: write` (to back up History as GitHub Artifacts).
  - GitHub Pages must be configured to deploy from the `github_pages_branch` (default: `gh-pages`).
- **Pull Request Comments:**
  - `github_token` must have `pull_requests: write` and `issues: write`.
- **Slack Integration:**
  - Create a Slack app and generate a token. Provide both `slack_channel` and `slack_token`.

## Contributing and Licensing

- **License:** BSD-3 License. See the [LICENSE](LICENSE) file for details.
- **Contributing:** Contributions are welcome! Open issues or submit pull requests to help improve this action.
