import { warning } from '@actions/core';
export class NotifyHandler {
    notifiers;
    constructor(notifiers) {
        this.notifiers = notifiers;
    }
    async sendNotifications(data) {
        const promises = this.notifiers.map(async (notifier) => {
            try {
                await notifier.notify(data);
            }
            catch (e) {
                warning(`${notifier.constructor.name} failed to send notification. ${e}`);
            }
        });
        await Promise.all(promises);
    }
}
