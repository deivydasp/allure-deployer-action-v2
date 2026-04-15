import { describe, it, expect, vi } from 'vitest';
import { GitHubNotifier } from '../../src/notifiers/github.notifier.js';
import { GithubInterface } from '../../src/interfaces/github.interface.js';
import { NotificationData } from '../../src/interfaces/notification-data.js';

vi.mock('@actions/core', () => ({
    warning: vi.fn(),
}));

function createMockClient(): GithubInterface {
    return {
        updateOutput: vi.fn().mockResolvedValue(undefined),
        updatePr: vi.fn().mockResolvedValue(undefined),
        updateSummary: vi.fn().mockResolvedValue(undefined),
    };
}

const baseData: NotificationData = {
    resultStatus: { passed: 10, failed: 0, broken: 0, skipped: 0, unknown: 0 },
    reportUrl: 'https://example.com/report',
};

describe('GitHubNotifier', () => {
    it('sets report_url output when reportUrl is provided', async () => {
        const client = createMockClient();
        const notifier = new GitHubNotifier({ client, writeSummary: false });

        await notifier.notify(baseData);

        expect(client.updateOutput).toHaveBeenCalledWith({
            name: 'report_url',
            value: 'https://example.com/report',
        });
    });

    it('sets summary_page_url output when summaryPageUrl is provided', async () => {
        const client = createMockClient();
        const notifier = new GitHubNotifier({ client, writeSummary: false });

        await notifier.notify({ ...baseData, summaryPageUrl: 'https://example.com/summary' });

        expect(client.updateOutput).toHaveBeenCalledWith({
            name: 'summary_page_url',
            value: 'https://example.com/summary',
        });
    });

    it('posts PR comment when token, prComment, and prNumber are set', async () => {
        const client = createMockClient();
        const notifier = new GitHubNotifier({
            client,
            token: 'tok',
            prComment: true,
            prNumber: 42,
            writeSummary: false,
        });

        await notifier.notify(baseData);

        expect(client.updatePr).toHaveBeenCalledWith({
            message: expect.any(String),
            token: 'tok',
            prNumber: 42,
        });
    });

    it('does not post PR comment when prComment is false', async () => {
        const client = createMockClient();
        const notifier = new GitHubNotifier({
            client,
            token: 'tok',
            prComment: false,
            prNumber: 42,
            writeSummary: false,
        });

        await notifier.notify(baseData);

        expect(client.updatePr).not.toHaveBeenCalled();
    });

    it('does not post PR comment when token is missing', async () => {
        const client = createMockClient();
        const notifier = new GitHubNotifier({
            client,
            prComment: true,
            prNumber: 42,
            writeSummary: false,
        });

        await notifier.notify(baseData);

        expect(client.updatePr).not.toHaveBeenCalled();
    });

    it('writes job summary when writeSummary is true', async () => {
        const client = createMockClient();
        const notifier = new GitHubNotifier({ client, writeSummary: true });

        await notifier.notify(baseData);

        expect(client.updateSummary).toHaveBeenCalledWith(expect.any(String));
    });

    it('does not write job summary when writeSummary is false', async () => {
        const client = createMockClient();
        const notifier = new GitHubNotifier({ client, writeSummary: false });

        await notifier.notify(baseData);

        expect(client.updateSummary).not.toHaveBeenCalled();
    });

    it('defaults writeSummary to true', async () => {
        const client = createMockClient();
        const notifier = new GitHubNotifier({ client });

        await notifier.notify(baseData);

        expect(client.updateSummary).toHaveBeenCalled();
    });

    it('includes summary page link when summaryPageUrl is set', async () => {
        const client = createMockClient();
        const notifier = new GitHubNotifier({ client, writeSummary: true });

        await notifier.notify({ ...baseData, summaryPageUrl: 'https://example.com/summary' });

        const summaryCall = vi.mocked(client.updateSummary).mock.calls[0][0];
        expect(summaryCall).toContain('Summary Page');
        expect(summaryCall).toContain('https://example.com/summary');
    });

    it('handles rejection gracefully', async () => {
        const { warning } = await import('@actions/core');
        const client = createMockClient();
        vi.mocked(client.updateOutput).mockRejectedValue(new Error('network fail'));
        const notifier = new GitHubNotifier({ client, writeSummary: false });

        await notifier.notify(baseData);

        expect(warning).toHaveBeenCalledWith(expect.stringContaining('GitHub notification failed'));
    });

    it('includes summary table with report name', async () => {
        const client = createMockClient();
        const notifier = new GitHubNotifier({ client, writeSummary: true });

        await notifier.notify({ ...baseData, reportName: 'My Test Suite' });

        const summaryCall = vi.mocked(client.updateSummary).mock.calls[0][0];
        expect(summaryCall).toContain('My Test Suite');
    });
});
