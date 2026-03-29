import { ReportStatistic } from '../shared/index.js';

const CHART_URL = 'https://allurecharts.qameta.workers.dev';

export interface SummaryRow {
    reportName: string;
    reportUrl?: string;
    stats: ReportStatistic;
    duration?: number;
}

function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

function buildRow(row: SummaryRow): string {
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

    return `| ${pie} | **${row.reportName}** | ${duration} | ${stats} | ${total} | ${reportCol} |`;
}

export function buildSummaryTable(rows: SummaryRow[]): string {
    const header = `| | Name | Duration | Stats | Total | Report |\n|-|-|-|-|-|-|`;
    const tableRows = rows.map(buildRow).join('\n');
    return `${header}\n${tableRows}`;
}
