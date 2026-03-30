import { warning } from '@actions/core';
import { buildSummaryTable } from '../utilities/summary-table.js';
export class GitHubNotifier {
    client;
    prNumber;
    token;
    prComment;
    writeSummary;
    constructor({ client, prNumber, prComment, token, writeSummary }) {
        this.client = client;
        this.prNumber = prNumber;
        this.token = token;
        this.prComment = prComment;
        this.writeSummary = writeSummary ?? true;
    }
    async notify(data) {
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
            ? `<img src="https://raw.githubusercontent.com/deivydasp/allure-deployer-action-v2/master/assets/allure-logo.svg" width="20" height="20" align="absmiddle" />&nbsp;&nbsp;<a href="${data.summaryPageUrl}">Summary Page</a>\n\n${table}`
            : table;
        const promises = [];
        if (data.reportUrl) {
            promises.push(this.client.updateOutput({ name: 'report_url', value: data.reportUrl }));
        }
        if (data.summaryPageUrl) {
            promises.push(this.client.updateOutput({ name: 'summary_page_url', value: data.summaryPageUrl }));
        }
        if (this.token && this.prComment && this.prNumber) {
            promises.push(this.client.updatePr({ message, token: this.token, prNumber: this.prNumber }));
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
