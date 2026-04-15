import { describe, it, expect, vi } from 'vitest';
import { NotifyHandler } from '../../src/notifiers/notify-handler.js';
import { Notifier } from '../../src/interfaces/notifier.interface.js';
import { NotificationData } from '../../src/interfaces/notification-data.js';

vi.mock('@actions/core', () => ({
    warning: vi.fn(),
}));

import { warning } from '@actions/core';

const baseData: NotificationData = {
    resultStatus: { passed: 5, failed: 0, broken: 0, skipped: 0, unknown: 0 },
};

function createMockNotifier(name: string = 'MockNotifier'): Notifier {
    const notifier = {
        notify: vi.fn().mockResolvedValue(undefined),
        constructor: { name },
    };
    Object.defineProperty(notifier, 'constructor', { value: { name } });
    return notifier as unknown as Notifier;
}

describe('NotifyHandler', () => {
    it('calls notify on all notifiers', async () => {
        const n1 = createMockNotifier();
        const n2 = createMockNotifier();
        const handler = new NotifyHandler([n1, n2]);

        await handler.sendNotifications(baseData);

        expect(n1.notify).toHaveBeenCalledWith(baseData);
        expect(n2.notify).toHaveBeenCalledWith(baseData);
    });

    it('warns but does not throw when a notifier fails', async () => {
        const good = createMockNotifier('GoodNotifier');
        const bad = createMockNotifier('BadNotifier');
        vi.mocked(bad.notify).mockRejectedValue(new Error('send failed'));

        const handler = new NotifyHandler([bad, good]);
        await handler.sendNotifications(baseData);

        // Good notifier still called despite bad one failing
        expect(good.notify).toHaveBeenCalledWith(baseData);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('BadNotifier'));
    });

    it('handles empty notifier list', async () => {
        const handler = new NotifyHandler([]);
        await expect(handler.sendNotifications(baseData)).resolves.toBeUndefined();
    });
});
