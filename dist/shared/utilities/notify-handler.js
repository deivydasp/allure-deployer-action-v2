export class NotifyHandler {
    constructor(notifiers) {
        this.notifiers = notifiers;
    }
    async sendNotifications(data) {
        const promises = this.notifiers.map(async (notifier) => {
            try {
                await notifier.notify(data);
            }
            catch (e) {
                console.warn(`${notifier.constructor.name} failed to send notification.`, e);
            }
        });
        await Promise.all(promises);
    }
}
