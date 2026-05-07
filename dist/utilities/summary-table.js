// Allure's public Cloudflare worker for pie/dot chart images (same as allure-action uses)
const CHART_URL = 'https://allurecharts.qameta.workers.dev';
function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}
function buildRow(row, showFirstColumn, rerunAttempts) {
    if (row.notDeployed || !row.stats) {
        let result = `| — | **${row.reportName}** | — | <em>Not deployed in this run</em> | —`;
        if (showFirstColumn)
            result += ` | —`;
        for (let i = 0; i < rerunAttempts.length; i++) {
            result += ` | —`;
        }
        return `${result} |`;
    }
    const { passed, failed, broken, skipped, unknown } = row.stats;
    const total = passed + failed + broken + skipped + unknown;
    const pie = `<img src="${CHART_URL}/pie?passed=${passed}&failed=${failed}&broken=${broken}&skipped=${skipped}&unknown=${unknown}&size=32" width="28" height="28" />`;
    const dot = (type, count) => count > 0
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
    let result = `| ${pie} | **${row.reportName}** | ${duration} | ${stats} | ${total}`;
    if (showFirstColumn) {
        // "Original" column links to the attempt-1 deploy. Empty when this prefix
        // has no attempt-1 deploy (e.g. it first ran on a rerun).
        const reportCol = row.reportUrl ? `<a href="${row.reportUrl}">View</a>` : '—';
        result += ` | ${reportCol}`;
    }
    // Rerun columns are absolute by GitHub runAttempt: column "Rerun #(N-1)" matches runAttempt = N.
    // Only attempts that produced at least one deploy across all rows are shown.
    for (const attempt of rerunAttempts) {
        const rerun = row.reruns?.find((r) => r.attempt === attempt);
        result += ` | ${rerun ? `<a href="${rerun.url}">View</a>` : '—'}`;
    }
    return `${result} |`;
}
export function buildSummaryTable(rows) {
    // Collect unique rerun attempts that have at least one deploy across all rows.
    // Empty leading/middle attempts (e.g. build-failure runs) collapse to nothing.
    const rerunAttemptsSet = new Set();
    for (const row of rows) {
        for (const rerun of row.reruns ?? []) {
            rerunAttemptsSet.add(rerun.attempt);
        }
    }
    const rerunAttempts = [...rerunAttemptsSet].sort((a, b) => a - b);
    // First column is shown when at least one row has an attempt-1 deploy. If no row has
    // an attempt-1 deploy AND there are rerun columns, the first column would be all
    // dashes — drop it. If there are no rerun columns either (e.g. all "Not deployed"),
    // keep a "Report" column so the table still has a deploy slot.
    const someHasAtt1 = rows.some((r) => !r.notDeployed && r.reportUrl);
    const showFirstColumn = someHasAtt1 || rerunAttempts.length === 0;
    let header = `| | Name | Duration | Stats | Total`;
    let separator = `|-|-|-|-|-`;
    if (showFirstColumn) {
        const label = rerunAttempts.length > 0 ? 'Original' : 'Report';
        header += ` | ${label}`;
        separator += `|-`;
    }
    for (const attempt of rerunAttempts) {
        // Column "Rerun #(N-1)" represents GitHub runAttempt = N
        header += ` | Rerun #${attempt - 1}`;
        separator += `|-`;
    }
    header += ` |`;
    separator += `|`;
    const tableRows = rows.map((r) => buildRow(r, showFirstColumn, rerunAttempts)).join('\n');
    return `${header}\n${separator}\n${tableRows}`;
}
