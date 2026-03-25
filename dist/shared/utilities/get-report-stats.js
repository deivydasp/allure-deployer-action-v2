import * as fs from 'fs/promises';
import * as path from "node:path";
async function readJsonFile(filePath) {
    const absolutePath = path.posix.resolve(filePath);
    const fileContents = await fs.readFile(absolutePath, 'utf-8');
    return JSON.parse(fileContents);
}
export async function getReportStats(reportDir) {
    const summaryJson = await readJsonFile(path.posix.join(reportDir, "widgets/summary.json"));
    return summaryJson.statistic;
}
