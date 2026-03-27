import * as fs from 'fs/promises';
import * as path from 'node:path';
import { ReportStatistic } from '../types/report-statistic.js';

async function readJsonFile(filePath: string): Promise<any> {
    const absolutePath = path.resolve(filePath);
    const fileContents = await fs.readFile(absolutePath, 'utf-8');
    return JSON.parse(fileContents);
}

export async function getReportStats(reportDir: string): Promise<ReportStatistic> {
    const statistic = await readJsonFile(path.join(reportDir, 'widgets/statistic.json'));
    return {
        passed: statistic.passed ?? 0,
        broken: statistic.broken ?? 0,
        failed: statistic.failed ?? 0,
        skipped: statistic.skipped ?? 0,
        unknown: statistic.unknown ?? 0,
    };
}
