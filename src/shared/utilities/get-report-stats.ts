import * as fs from 'fs/promises';
import * as path from 'node:path';
import { ReportStatistic } from '../types/report-statistic.js';

async function readJsonFile(filePath: string): Promise<any> {
    const absolutePath = path.resolve(filePath);
    const fileContents = await fs.readFile(absolutePath, 'utf-8');
    return JSON.parse(fileContents);
}

export interface ReportStats {
    statistic: ReportStatistic;
    duration?: number;
}

export async function getReportStats(reportDir: string): Promise<ReportStats> {
    // Try summary.json first (has both stats and duration)
    const summaryCandidates = [
        path.join(reportDir, 'summary.json'),
        path.join(reportDir, 'awesome', 'summary.json'),
    ];
    for (const summaryPath of summaryCandidates) {
        try {
            const summary = await readJsonFile(summaryPath);
            return {
                statistic: {
                    passed: summary.stats?.passed ?? 0,
                    broken: summary.stats?.broken ?? 0,
                    failed: summary.stats?.failed ?? 0,
                    skipped: summary.stats?.skipped ?? 0,
                    unknown: summary.stats?.unknown ?? 0,
                },
                duration: summary.duration,
            };
        } catch {
            // try next candidate
        }
    }

    // Fallback to statistic.json (no duration)
    const statCandidates = [
        path.join(reportDir, 'widgets', 'statistic.json'),
        path.join(reportDir, 'awesome', 'widgets', 'statistic.json'),
    ];
    for (const statsPath of statCandidates) {
        try {
            const statistic = await readJsonFile(statsPath);
            return {
                statistic: {
                    passed: statistic.passed ?? 0,
                    broken: statistic.broken ?? 0,
                    failed: statistic.failed ?? 0,
                    skipped: statistic.skipped ?? 0,
                    unknown: statistic.unknown ?? 0,
                },
            };
        } catch {
            // try next candidate
        }
    }
    throw new Error(`Failed to read report statistics from ${reportDir}`);
}
