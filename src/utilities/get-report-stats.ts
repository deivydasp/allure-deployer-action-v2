import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ReportStatistic } from '../interfaces/report-statistic.js';

async function readJsonFile(filePath: string): Promise<any> {
    const absolutePath = resolve(filePath);
    const fileContents = await readFile(absolutePath, 'utf-8');
    return JSON.parse(fileContents);
}

/**
 * Computes wall-clock test duration by finding min(start) and max(stop)
 * across all result files. This gives the real elapsed time even when
 * tests run in parallel.
 */
export async function getTestDuration(resultsDir: string): Promise<number | undefined> {
    try {
        const files = await readdir(resultsDir);
        let minStart = Infinity;
        let maxStop = 0;
        for (const file of files) {
            if (!file.endsWith('-result.json')) continue;
            try {
                const result = await readJsonFile(join(resultsDir, file));
                if (result.start) minStart = Math.min(minStart, result.start);
                if (result.stop) maxStop = Math.max(maxStop, result.stop);
            } catch {
                // skip malformed result files
            }
        }
        if (minStart < Infinity && maxStop > 0 && maxStop >= minStart) {
            return maxStop - minStart;
        }
    } catch {
        // results dir not readable
    }
    return undefined;
}

export interface ReportStats {
    statistic: ReportStatistic;
    duration?: number;
}

export async function getReportStats(reportDir: string): Promise<ReportStats> {
    // Try summary.json first (has both stats and duration)
    const summaryCandidates = [
        join(reportDir, 'summary.json'),
        join(reportDir, 'awesome', 'summary.json'),
    ];
    for (const summaryPath of summaryCandidates) {
        try {
            const summary = await readJsonFile(summaryPath);
            const stats = summary.stats ?? summary.statistic;
            if (stats) {
                return {
                    statistic: {
                        passed: stats.passed ?? 0,
                        broken: stats.broken ?? 0,
                        failed: stats.failed ?? 0,
                        skipped: stats.skipped ?? 0,
                        unknown: stats.unknown ?? 0,
                    },
                    duration: summary.duration,
                };
            }
        } catch {
            // try next candidate
        }
    }

    // Fallback to statistic.json (no duration)
    const statCandidates = [
        join(reportDir, 'widgets', 'statistic.json'),
        join(reportDir, 'awesome', 'widgets', 'statistic.json'),
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
