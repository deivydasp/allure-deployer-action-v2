import { info, warning } from '@actions/core';
import { GithubInterface } from '../interfaces/github.interface.js';
import { NotificationData } from '../interfaces/notification-data.js';
import { Notifier } from '../interfaces/notifier.interface.js';
import { GitHubService } from '../services/github.service.js';
import { buildSummaryTable } from '../utilities/summary-table.js';

export type GitHubNotifierConfig = {
    client: GithubInterface;
    prNumber?: number;
    token?: string;
    prComment?: boolean;
    /** Identifies this report's PR comment across runs; defaults to 'default' */
    commentKey?: string;
    writeSummary?: boolean;
};

export class GitHubNotifier implements Notifier {
    client: GitHubService;
    prNumber?: number;
    token?: string;
    prComment?: boolean;
    commentKey: string;
    writeSummary: boolean;
    constructor({ client, prNumber, prComment, token, commentKey, writeSummary }: GitHubNotifierConfig) {
        this.client = client;
        this.prNumber = prNumber;
        this.token = token;
        this.prComment = prComment;
        this.commentKey = commentKey || 'default';
        this.writeSummary = writeSummary ?? true;
    }

    async notify(data: NotificationData): Promise<void> {
        const table = buildSummaryTable([
            {
                reportName: data.reportName ?? 'Allure Report',
                reportUrl: data.originalReportUrl ?? data.reportUrl,
                stats: data.resultStatus,
                duration: data.duration,
                reruns: data.reruns,
            },
        ]);
        const message = data.summaryPageUrl
            ? `<img src="https://raw.githubusercontent.com/deivydasp/allure-deployer-action-v2/master/assets/allure-logo.png" alt="allure" align="absmiddle" />&nbsp;&nbsp;<a href="${data.summaryPageUrl}">Summary Page</a>\n\n${table}`
            : table;

        const promises: Promise<void>[] = [];
        if (data.reportUrl) {
            promises.push(this.client.updateOutput({ name: 'report_url', value: data.reportUrl }));
        }
        if (data.summaryPageUrl) {
            promises.push(this.client.updateOutput({ name: 'summary_page_url', value: data.summaryPageUrl }));
        }
        if (this.prComment) {
            if (!this.prNumber) {
                info(
                    'Skipping PR comment: no pull request number. Set the pr_number input when the workflow is not triggered by a pull_request event.',
                );
            } else if (!this.token) {
                info('Skipping PR comment: no github_token.');
            } else {
                promises.push(
                    this.client.updatePr({
                        message,
                        token: this.token,
                        prNumber: this.prNumber,
                        commentKey: this.commentKey,
                    }),
                );
            }
        }
        if (this.writeSummary) {
            promises.push(this.client.updateSummary(message));
        }
        const results = await Promise.allSettled(promises);
        for (const result of results) {
            if (result.status === 'rejected') {
                warning(`GitHub notification failed: ${result.reason}`);
            }
        }
    }
}
