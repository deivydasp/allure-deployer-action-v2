import { ReportStatistic } from '../interfaces/report-statistic.js';

// Allure's public Cloudflare worker for pie/dot chart images (same as allure-action uses)
const CHART_URL = 'https://allurecharts.qameta.workers.dev';

export interface DeployMeta {
    runId: number;
    runAttempt: number;
    wallClockDuration?: number;
    timestamp: number;
}

export interface RerunInfo {
    attempt: number;
    url: string;
}

export interface SummaryRow {
    reportName: string;
    reportUrl?: string;
    stats?: ReportStatistic;
    duration?: number;
    reruns?: RerunInfo[];
    notDeployed?: boolean;
}

function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

function buildRow(row: SummaryRow, maxReruns: number): string {
    if (row.notDeployed || !row.stats) {
        let result = `| — | **${row.reportName}** | — | <em>Not deployed in this run</em> | — | —`;
        for (let i = 1; i <= maxReruns; i++) {
            result += ` | —`;
        }
        return `${result} |`;
    }

    const { passed, failed, broken, skipped, unknown } = row.stats;
    const total = passed + failed + broken + skipped + unknown;

    const pie = `<img src="${CHART_URL}/pie?passed=${passed}&failed=${failed}&broken=${broken}&skipped=${skipped}&unknown=${unknown}&size=32" width="28" height="28" />`;

    const dot = (type: string, count: number) =>
        count > 0
            ? `<img alt="${type}" src="${CHART_URL}/dot?type=${type}&size=8" />&nbsp;${count}`
            : '';

    const stats = [
        dot('passed', passed),
        dot('failed', failed),
        dot('broken', broken),
        dot('skipped', skipped),
        dot('unknown', unknown),
    ]
        .filter(Boolean)
        .join('&nbsp;&nbsp;&nbsp;');

    const duration = row.duration ? formatDuration(row.duration) : '';
    const reportCol = row.reportUrl
        ? `<a href="${row.reportUrl}" target="_blank">View</a>`
        : '';

    let result = `| ${pie} | **${row.reportName}** | ${duration} | ${stats} | ${total} | ${reportCol}`;

    // Add rerun columns
    for (let i = 1; i <= maxReruns; i++) {
        const rerun = row.reruns?.find((r) => r.attempt === i + 1);
        result += ` | ${rerun ? `<a href="${rerun.url}" target="_blank">View</a>` : '—'}`;
    }

    return `${result} |`;
}

export function buildSummaryTable(rows: SummaryRow[]): string {
    // Find the highest rerun attempt across all rows (attempt 2 = Rerun #1, attempt 3 = Rerun #2, etc.)
    const maxAttempt = Math.max(1, ...rows.flatMap((r) => r.reruns?.map((rr) => rr.attempt) ?? [1]));
    const rerunCount = maxAttempt - 1; // attempt 1 is the original, reruns start at attempt 2

    const reportLabel = rerunCount > 0 ? 'Original' : 'Report';
    let header = `| | Name | Duration | Stats | Total | ${reportLabel}`;
    let separator = `|-|-|-|-|-|-`;
    for (let i = 1; i <= rerunCount; i++) {
        header += ` | Rerun #${i}`;
        separator += `|-`;
    }
    header += ` |`;
    separator += `|`;

    const tableRows = rows.map((r) => buildRow(r, rerunCount)).join('\n');
    return `${header}\n${separator}\n${tableRows}`;
}
