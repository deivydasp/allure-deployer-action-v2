export class ConsoleNotifier {
    writeStatuses(status) {
        const lines = [];
        if (status.passed)
            lines.push(`  Passed  : ${status.passed}`);
        if (status.broken)
            lines.push(`  Broken  : ${status.broken}`);
        if (status.skipped)
            lines.push(`  Skipped : ${status.skipped}`);
        if (status.failed)
            lines.push(`  Failed  : ${status.failed}`);
        if (status.unknown)
            lines.push(`  Unknown : ${status.unknown}`);
        return lines.join('\n');
    }
    async notify(data) {
        const reportUrl = data.reportUrl;
        if (reportUrl) {
            console.log(`\nTest report URL: ${reportUrl}`);
        }
        console.log(`\n${this.writeStatuses(data.resultStatus)}\n`);
    }
}
