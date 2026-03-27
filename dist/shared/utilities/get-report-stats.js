import * as fs from 'fs/promises';
import * as path from 'node:path';
async function readJsonFile(filePath) {
    const absolutePath = path.resolve(filePath);
    const fileContents = await fs.readFile(absolutePath, 'utf-8');
    return JSON.parse(fileContents);
}
export async function getReportStats(reportDir) {
    const statsPath = path.join(reportDir, 'widgets', 'statistic.json');
    try {
        const statistic = await readJsonFile(statsPath);
        return {
            passed: statistic.passed ?? 0,
            broken: statistic.broken ?? 0,
            failed: statistic.failed ?? 0,
            skipped: statistic.skipped ?? 0,
            unknown: statistic.unknown ?? 0,
        };
    }
    catch (e) {
        throw new Error(`Failed to read report statistics from ${statsPath}: ${e instanceof Error ? e.message : e}`);
    }
}
