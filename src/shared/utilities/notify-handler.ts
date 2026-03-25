import {NotificationData} from "../types/notification-data.js";
import {Notifier} from "../interfaces/notifier.interface.js";

export class NotifyHandler {
    private notifiers: Notifier[];

    constructor(notifiers: Notifier[]) {
        this.notifiers = notifiers;
    }

    async sendNotifications(data: NotificationData): Promise<void> {
        const promises = this.notifiers.map(async (notifier) => {
            try {
                await notifier.notify(data);
            } catch (e) {
                console.warn(`${notifier.constructor.name} failed to send notification.`, e);
            }
        });
        await Promise.all(promises);
    }
}
