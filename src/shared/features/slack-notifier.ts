import {Notifier} from "../interfaces/notifier.interface.js";
import {NotificationData} from "../types/notification-data.js";
import {SlackInterface} from "../interfaces/slack.interface.js";

export class SlackNotifier implements Notifier {
    private readonly slackClient: SlackInterface;

    constructor(client: SlackInterface) {
        this.slackClient = client;
    }

    private buildEnvironmentRow(title: string, value: string): any[] {
        return [
            {type: "mrkdwn", text: `${title}:`},
            {type: "plain_text", text: value, emoji: true},
        ];
    }

    private buildEnvironmentBlock(fields: any[]): any {
        return {type: 'section', fields};
    }

    private buildStatusBlock(label: string, emoji: string, count: number): any {
        return {
            type: "context",
            elements: [{type: "mrkdwn", text: `${emoji}  *${label}:* ${count}`}],
        };
    }

    private buildButtonBlock(text: string, url: string): any {
        return {
            type: "actions",
            elements: [{
                type: "button",
                text: {type: "plain_text", text, emoji: true},
                url,
            }],
        };
    }

    async notify({resultStatus, reportUrl, environment}: NotificationData): Promise<void> {
        const blocks: any[] = [];

        if (environment && environment.size > 0) {
            const fields: any[] = [];
            environment.forEach((value, key) => {
                if (key !== '' && value !== '') {
                    fields.push(...this.buildEnvironmentRow(key, value));
                }
            });
            if (fields.length > 0) {
                blocks.push(this.buildEnvironmentBlock(fields));
            }
        }

        if (resultStatus.passed) blocks.push(this.buildStatusBlock("Passed", ":white_check_mark:", resultStatus.passed));
        if (resultStatus.broken) blocks.push(this.buildStatusBlock("Broken", ":warning:", resultStatus.broken));
        if (resultStatus.skipped) blocks.push(this.buildStatusBlock("Skipped", ":next_track_button:", resultStatus.skipped));
        if (resultStatus.failed) blocks.push(this.buildStatusBlock("Failed", ":x:", resultStatus.failed));
        if (resultStatus.unknown) blocks.push(this.buildStatusBlock("Unknown", ":question:", resultStatus.unknown));

        if (reportUrl) blocks.push(this.buildButtonBlock("View report :bar_chart:", reportUrl));

        try {
            await this.slackClient.postMessage(blocks, 'Your test report is ready.');
            console.log('Slack message sent');
        } catch (error) {
            console.error('Error sending Slack message:', error);
        }
    }
}
