import { GithubInterface } from '../interfaces/github.interface.js';
import * as github from '@actions/github';
import { info, setOutput, summary, warning } from '@actions/core';
import { DEFAULT_RETRY_CONFIG, withRetry } from '../utilities/util.js';

export class GitHubService implements GithubInterface {
    async updateOutput({ name, value }: { name: string; value: string }): Promise<void> {
        try {
            setOutput(name, value);
        } catch (e) {
            warning(`Failed to set output '${name}': ${e}`);
        }
    }
    async updatePr({
        message,
        token,
        prNumber,
        commentKey,
    }: {
        message: string;
        token: string;
        prNumber: number;
        commentKey: string;
    }): Promise<void> {
        const marker = prCommentMarker(commentKey);
        const body = `${marker}\n${message}`;
        const { owner, repo } = github.context.repo;
        try {
            const octokit = github.getOctokit(token);
            const existing = await withRetry(async () => {
                const comments = await octokit.paginate(octokit.rest.issues.listComments, {
                    owner,
                    repo,
                    issue_number: prNumber,
                    per_page: 100,
                });
                // Only bodies that start with the marker: one merely quoting it is someone else's comment.
                // Latest one wins if an earlier race ever left two.
                return comments.filter((c) => c.body?.startsWith(marker)).pop();
            }, DEFAULT_RETRY_CONFIG);

            if (existing) {
                try {
                    await withRetry(
                        () => octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body }),
                        DEFAULT_RETRY_CONFIG,
                    );
                    info(`Pull Request comment updated on PR #${prNumber}!`);
                    return;
                } catch (e) {
                    // e.g. the comment was written by another token's user, or deleted meanwhile
                    warning(`Failed to update existing PR comment ${existing.id}, posting a new one: ${e}`);
                }
            }
            await withRetry(
                () => octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body }),
                DEFAULT_RETRY_CONFIG,
            );
            info(`Pull Request comment posted on PR #${prNumber}!`);
        } catch (e) {
            warning(`Failed to update PR: ${e}`);
        }
    }
    async updateSummary(message: string): Promise<void> {
        try {
            await summary.addRaw(message, true).write();
        } catch (e) {
            warning(`Failed to write job summary: ${e}`);
        }
    }
}

/** Hidden marker identifying this action's comment for one report, so a later run edits it instead of adding another */
export function prCommentMarker(commentKey: string): string {
    // `--` would end the HTML comment early
    return `<!-- allure-deployer-action:${commentKey.replace(/-{2,}/g, '-')} -->`;
}
