import { NotificationData } from './notification-data.js';

export interface Notifier {
    notify(data: NotificationData): Promise<void>;
}
