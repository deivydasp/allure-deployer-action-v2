import { describe, it, expect, vi } from 'vitest';
import { ConsoleNotifier } from '../../src/notifiers/console.notifier.js';
import { NotificationData } from '../../src/interfaces/notification-data.js';

describe('ConsoleNotifier', () => {
    const baseData: NotificationData = {
        resultStatus: { passed: 10, failed: 2, broken: 1, skipped: 3, unknown: 0 },
    };

    it('logs report URL when provided', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const notifier = new ConsoleNotifier();

        await notifier.notify({ ...baseData, reportUrl: 'https://example.com/report' });

        expect(spy).toHaveBeenCalledWith(expect.stringContaining('https://example.com/report'));
    });

    it('logs summary page URL when provided', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const notifier = new ConsoleNotifier();

        await notifier.notify({ ...baseData, summaryPageUrl: 'https://example.com/summary' });

        expect(spy).toHaveBeenCalledWith(expect.stringContaining('https://example.com/summary'));
    });

    it('logs passed count', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const notifier = new ConsoleNotifier();

        await notifier.notify(baseData);

        const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
        expect(allOutput).toContain('Passed');
        expect(allOutput).toContain('10');
    });

    it('logs failed count', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const notifier = new ConsoleNotifier();

        await notifier.notify(baseData);

        const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
        expect(allOutput).toContain('Failed');
        expect(allOutput).toContain('2');
    });

    it('omits zero-count statuses', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const notifier = new ConsoleNotifier();

        await notifier.notify({
            resultStatus: { passed: 5, failed: 0, broken: 0, skipped: 0, unknown: 0 },
        });

        const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
        expect(allOutput).toContain('Passed');
        expect(allOutput).not.toContain('Failed');
        expect(allOutput).not.toContain('Broken');
        expect(allOutput).not.toContain('Skipped');
        expect(allOutput).not.toContain('Unknown');
    });

    it('does not log report URL when not provided', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const notifier = new ConsoleNotifier();

        await notifier.notify({ resultStatus: { passed: 1, failed: 0, broken: 0, skipped: 0, unknown: 0 } });

        const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
        expect(allOutput).not.toContain('report URL');
    });
});
