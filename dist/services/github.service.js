import * as github from "@actions/github";
import * as core from "@actions/core";
import { DEFAULT_RETRY_CONFIG, withRetry } from "../utilities/util.js";
export class GitHubService {
    async updateOutput({ name, value }) {
        try {
            core.setOutput(name, value);
        }
        catch (_e) {
            // ignore
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
            core.info(`Pull Request comment posted on PR #${prNumber}!`);
        }
        catch (e) {
            console.warn('Failed to update PR:', e);
        }
    }
    async updateSummary(message) {
        await core.summary.addRaw(message, true).write();
    }
}
