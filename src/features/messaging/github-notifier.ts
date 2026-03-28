import { GithubInterface } from '../../interfaces/github.interface.js';
import { NotificationData, Notifier } from '../../shared/index.js';
import { GitHubService } from '../../services/github.service.js';

export type GitHubNotifierConfig = {
    client: GithubInterface;
    prNumber?: number;
    token?: string;
    prComment?: boolean;
};

export class GitHubNotifier implements Notifier {
    client: GitHubService;
    prNumber?: number;
    token?: string;
    prComment?: boolean;
    constructor({ client, prNumber, prComment, token }: GitHubNotifierConfig) {
        this.client = client;
        this.prNumber = prNumber;
        this.token = token;
        this.prComment = prComment;
    }

    async notify(data: NotificationData): Promise<void> {
        const { passed, failed, broken, skipped, unknown } = data.resultStatus;
        const total = passed + failed + broken + skipped + unknown;

        const chartUrl = `https://allurecharts.qameta.workers.dev`;
        const pie = `<img src="${chartUrl}/pie?passed=${passed}&failed=${failed}&broken=${broken}&skipped=${skipped}&unknown=${unknown}&size=32" width="28" height="28" />`;

        const dot = (type: string, count: number) =>
            count > 0
                ? `<img alt="${type}" src="${chartUrl}/dot?type=${type}&size=8" />&nbsp;${count}`
                : '';

        const stats = [
            dot('passed', passed),
            dot('failed', failed),
            dot('broken', broken),
            dot('skipped', skipped),
            dot('unknown', unknown),
        ]
            .filter(Boolean)
            .join('&nbsp;&nbsp;&nbsp;');

        const reportName = data.reportName ?? 'Allure Report';
        const duration = data.duration ? this.formatDuration(data.duration) : '';
        const reportLink = data.reportUrl
            ? `<a href="${data.reportUrl}" target="_blank">View</a>`
            : '';

        let message = `| | Name | Duration | Stats | Total | Report |\n`;
        message += `|-|-|-|-|-|-|\n`;
        message += `| ${pie} | ${reportName} | ${duration} | ${stats} | ${total} | ${reportLink} |\n`;

        const promises: Promise<void>[] = [];
        if (data.reportUrl) {
            promises.push(this.client.updateOutput({ name: 'report_url', value: data.reportUrl }));
        }
        if (this.token && this.prComment && this.prNumber) {
            promises.push(this.client.updatePr({ message, token: this.token, prNumber: this.prNumber }));
        }
        promises.push(this.client.updateSummary(message.trim()));
        await Promise.allSettled(promises);
    }

    private formatDuration(ms: number): string {
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ${s % 60}s`;
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
    }
}
