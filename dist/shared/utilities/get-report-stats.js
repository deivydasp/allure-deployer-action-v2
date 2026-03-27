import * as fs from 'fs/promises';
import * as path from 'node:path';
async function readJsonFile(filePath) {
    const absolutePath = path.resolve(filePath);
    const fileContents = await fs.readFile(absolutePath, 'utf-8');
    return JSON.parse(fileContents);
}
export async function getReportStats(reportDir) {
    // Single-plugin: widgets/statistic.json at root
    // Multi-plugin: awesome/widgets/statistic.json in plugin subdirectory
    const candidates = [
        path.join(reportDir, 'widgets', 'statistic.json'),
        path.join(reportDir, 'awesome', 'widgets', 'statistic.json'),
    ];
    for (const statsPath of candidates) {
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
        catch {
            // try next candidate
        }
    }
    throw new Error(`Failed to read report statistics. Checked: ${candidates.join(', ')}`);
}
