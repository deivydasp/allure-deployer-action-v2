import { GithubInterface} from "../interfaces/github.interface.js";
import * as github from "@actions/github";
import * as core from "@actions/core";
import {DEFAULT_RETRY_CONFIG, withRetry} from "../utilities/util.js";

export class GitHubService implements GithubInterface {

    async updateOutput({name, value}: { name: string, value: string }): Promise<void> {
        try {
            core.setOutput(name, value);
        } catch (_e) {
            // ignore
        }
    }
    async updatePr({message, token, prNumber}: { message: string, token: string, prNumber: number }): Promise<void> {
        try {
            // Update the PR body
            const work = async () => {
                await github.getOctokit(token).rest.issues.createComment({
                    owner: github.context.repo.owner,
                    repo: github.context.repo.repo,
                    issue_number: prNumber,
                    body: message,
                });
            }
            await withRetry(work, DEFAULT_RETRY_CONFIG);
            core.info(`Pull Request comment posted on PR #${prNumber}!`);
        } catch (e) {
            console.warn('Failed to update PR:', e);
        }
    }
    async updateSummary(message: string): Promise<void> {
        await core.summary.addRaw(message, true).write();
    }
}