import * as fs from 'fs/promises';
import * as path from 'node:path';
import { ReportStatistic } from '../types/report-statistic.js';

async function readJsonFile(filePath: string): Promise<any> {
    const absolutePath = path.resolve(filePath);
    const fileContents = await fs.readFile(absolutePath, 'utf-8');
    return JSON.parse(fileContents);
}

export async function getReportStats(reportDir: string): Promise<ReportStatistic> {
    const summaryJson = await readJsonFile(path.join(reportDir, 'widgets/summary.json'));
    return summaryJson.statistic;
}
