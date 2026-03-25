import { NotificationData } from '../types/notification-data.js';

export interface Notifier {
    notify(data: NotificationData): Promise<void>;
}
