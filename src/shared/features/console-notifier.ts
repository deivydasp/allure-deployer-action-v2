import { Notifier } from '../interfaces/notifier.interface.js';
import { NotificationData } from '../types/notification-data.js';
import { ReportStatistic } from '../types/report-statistic.js';

export class ConsoleNotifier implements Notifier {
    private writeStatuses(status: ReportStatistic): string {
        const lines: string[] = [];
        if (status.passed) lines.push(`🟢 Passed            : ${status.passed}`);
        if (status.failed) lines.push(`🔴 Failed            : ${status.failed}`);
        if (status.broken) lines.push(`🟡 Broken            : ${status.broken}`);
        if (status.skipped) lines.push(`⚪ Skipped           : ${status.skipped}`);
        if (status.unknown) lines.push(`🟣 Unknown           : ${status.unknown}`);
        return lines.join('\n');
    }

    async notify(data: NotificationData): Promise<void> {
        const reportUrl = data.reportUrl;
        if (reportUrl) {
            console.log(`\n📊 Test report URL   : ${reportUrl}`);
        }
        console.log(`\n${this.writeStatuses(data.resultStatus)}\n`);
    }
}
