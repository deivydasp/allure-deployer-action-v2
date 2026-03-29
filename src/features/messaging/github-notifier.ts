import { GithubInterface } from '../../interfaces/github.interface.js';
import { NotificationData, Notifier } from '../../shared/index.js';
import { GitHubService } from '../../services/github.service.js';
import { buildSummaryTable } from '../../utilities/summary-table.js';

export type GitHubNotifierConfig = {
    client: GithubInterface;
    prNumber?: number;
    token?: string;
    prComment?: boolean;
    writeSummary?: boolean;
};

export class GitHubNotifier implements Notifier {
    client: GitHubService;
    prNumber?: number;
    token?: string;
    prComment?: boolean;
    writeSummary: boolean;
    constructor({ client, prNumber, prComment, token, writeSummary }: GitHubNotifierConfig) {
        this.client = client;
        this.prNumber = prNumber;
        this.token = token;
        this.prComment = prComment;
        this.writeSummary = writeSummary ?? true;
    }

    async notify(data: NotificationData): Promise<void> {
        const message = buildSummaryTable([
            {
                reportName: data.reportName ?? 'Allure Report',
                reportUrl: data.reportUrl,
                stats: data.resultStatus,
                duration: data.duration,
            },
        ]);

        const promises: Promise<void>[] = [];
        if (data.reportUrl) {
            promises.push(this.client.updateOutput({ name: 'report_url', value: data.reportUrl }));
        }
        if (this.token && this.prComment && this.prNumber) {
            promises.push(this.client.updatePr({ message, token: this.token, prNumber: this.prNumber }));
        }
        if (this.writeSummary) {
            promises.push(this.client.updateSummary(message));
        }
        await Promise.allSettled(promises);
    }
}
