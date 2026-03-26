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

        const logo = `<img src="https://raw.githubusercontent.com/deivydasp/allure-deployer-action-v2/master/assets/allure-logo.svg" width="20" height="20" alt="Allure" align="top">`;
        let message = '';
        if (data.reportUrl) {
            message += `${logo}&nbsp;**Test Report**: [${data.reportUrl}](${data.reportUrl})\n`;
        }

        message += `\n| 🟢 **Passed** | 🔴 **Failed** | 🟡 **Broken** | ⚪ **Skipped** | 🟣 **Unknown** |\n`;
        message += `|---|---|---|---|---|\n`;
        message += `| ${passed} | ${failed} | ${broken} | ${skipped} | ${unknown} |\n`;
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
}
