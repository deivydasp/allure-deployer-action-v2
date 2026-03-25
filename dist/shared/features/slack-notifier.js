export class SlackNotifier {
    constructor(client) {
        this.slackClient = client;
    }
    buildEnvironmentRow(title, value) {
        return [
            { type: 'mrkdwn', text: `${title}:` },
            { type: 'plain_text', text: value, emoji: true },
        ];
    }
    buildEnvironmentBlock(fields) {
        return { type: 'section', fields };
    }
    buildStatusBlock(label, emoji, count) {
        return {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `${emoji}  *${label}:* ${count}` }],
        };
    }
    buildButtonBlock(text, url) {
        return {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text, emoji: true },
                    url,
                },
            ],
        };
    }
    async notify({ resultStatus, reportUrl, environment }) {
        const blocks = [];
        if (environment && environment.size > 0) {
            const fields = [];
            environment.forEach((value, key) => {
                if (key !== '' && value !== '') {
                    fields.push(...this.buildEnvironmentRow(key, value));
                }
            });
            if (fields.length > 0) {
                blocks.push(this.buildEnvironmentBlock(fields));
            }
        }
        if (resultStatus.passed)
            blocks.push(this.buildStatusBlock('Passed', ':white_check_mark:', resultStatus.passed));
        if (resultStatus.broken)
            blocks.push(this.buildStatusBlock('Broken', ':warning:', resultStatus.broken));
        if (resultStatus.skipped)
            blocks.push(this.buildStatusBlock('Skipped', ':next_track_button:', resultStatus.skipped));
        if (resultStatus.failed)
            blocks.push(this.buildStatusBlock('Failed', ':x:', resultStatus.failed));
        if (resultStatus.unknown)
            blocks.push(this.buildStatusBlock('Unknown', ':question:', resultStatus.unknown));
        if (reportUrl)
            blocks.push(this.buildButtonBlock('View report :bar_chart:', reportUrl));
        try {
            await this.slackClient.postMessage(blocks, 'Your test report is ready.');
            console.log('Slack message sent');
        }
        catch (error) {
            console.error('Error sending Slack message:', error);
        }
    }
}
