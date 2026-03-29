import * as github from '@actions/github';
import { info, setOutput, summary, warning } from '@actions/core';
import { DEFAULT_RETRY_CONFIG, withRetry } from '../utilities/util.js';
export class GitHubService {
    async updateOutput({ name, value }) {
        try {
            setOutput(name, value);
        }
        catch (e) {
            warning(`Failed to set output '${name}': ${e}`);
        }
    }
    async updatePr({ message, token, prNumber }) {
        try {
            // Update the PR body
            const work = async () => {
                await github.getOctokit(token).rest.issues.createComment({
                    owner: github.context.repo.owner,
                    repo: github.context.repo.repo,
                    issue_number: prNumber,
                    body: message,
                });
            };
            await withRetry(work, DEFAULT_RETRY_CONFIG);
            info(`Pull Request comment posted on PR #${prNumber}!`);
        }
        catch (e) {
            warning(`Failed to update PR: ${e}`);
        }
    }
    async updateSummary(message) {
        try {
            await summary.addRaw(message, true).write();
        }
        catch (e) {
            warning(`Failed to write job summary: ${e}`);
        }
    }
}
