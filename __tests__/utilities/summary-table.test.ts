import { describe, it, expect } from 'vitest';
import { buildSummaryTable, SummaryRow } from '../../src/utilities/summary-table.js';

describe('buildSummaryTable', () => {
    const baseStats = { passed: 10, failed: 2, broken: 1, skipped: 3, unknown: 0 };

    it('builds a table with a single row', () => {
        const rows: SummaryRow[] = [
            { reportName: 'Unit Tests', reportUrl: 'https://example.com/report', stats: baseStats, duration: 5000 },
        ];
        const table = buildSummaryTable(rows);
        expect(table).toContain('| Name |');
        expect(table).toContain('| Report');
        expect(table).toContain('**Unit Tests**');
        expect(table).toContain('5s');
        expect(table).toContain('<a href="https://example.com/report">View</a>');
    });

    it('builds a table with multiple rows', () => {
        const rows: SummaryRow[] = [
            { reportName: 'Unit', stats: baseStats },
            { reportName: 'E2E', stats: { passed: 5, failed: 0, broken: 0, skipped: 0, unknown: 0 } },
        ];
        const table = buildSummaryTable(rows);
        expect(table).toContain('**Unit**');
        expect(table).toContain('**E2E**');
    });

    it('shows "Not deployed" for notDeployed rows', () => {
        const rows: SummaryRow[] = [
            { reportName: 'Skipped Suite', notDeployed: true },
        ];
        const table = buildSummaryTable(rows);
        expect(table).toContain('Not deployed in this run');
        expect(table).toContain('**Skipped Suite**');
    });

    it('includes rerun columns when reruns exist', () => {
        const rows: SummaryRow[] = [
            {
                reportName: 'Tests',
                stats: baseStats,
                reportUrl: 'https://example.com/original',
                reruns: [
                    { attempt: 2, url: 'https://example.com/rerun1' },
                    { attempt: 3, url: 'https://example.com/rerun2' },
                ],
            },
        ];
        const table = buildSummaryTable(rows);
        expect(table).toContain('Original');
        expect(table).toContain('Rerun #1');
        expect(table).toContain('Rerun #2');
        expect(table).toContain('https://example.com/rerun1');
        expect(table).toContain('https://example.com/rerun2');
    });

    it('uses "Report" label when no reruns exist', () => {
        const rows: SummaryRow[] = [
            { reportName: 'Tests', stats: baseStats },
        ];
        const table = buildSummaryTable(rows);
        expect(table).toContain('| Report');
        expect(table).not.toContain('Original');
        expect(table).not.toContain('Rerun');
    });

    it('formats duration correctly for seconds', () => {
        const rows: SummaryRow[] = [
            { reportName: 'Fast', stats: baseStats, duration: 45000 },
        ];
        const table = buildSummaryTable(rows);
        expect(table).toContain('45s');
    });

    it('formats duration correctly for minutes', () => {
        const rows: SummaryRow[] = [
            { reportName: 'Medium', stats: baseStats, duration: 125000 },
        ];
        const table = buildSummaryTable(rows);
        expect(table).toContain('2m 5s');
    });

    it('formats duration correctly for hours', () => {
        const rows: SummaryRow[] = [
            { reportName: 'Long', stats: baseStats, duration: 3725000 },
        ];
        const table = buildSummaryTable(rows);
        expect(table).toContain('1h 2m');
    });

    it('includes pie chart image', () => {
        const rows: SummaryRow[] = [
            { reportName: 'Tests', stats: baseStats },
        ];
        const table = buildSummaryTable(rows);
        expect(table).toContain('allurecharts.qameta.workers.dev/pie');
        expect(table).toContain('passed=10');
        expect(table).toContain('failed=2');
    });

    it('includes dot images for non-zero counts', () => {
        const rows: SummaryRow[] = [
            { reportName: 'Tests', stats: { passed: 5, failed: 0, broken: 0, skipped: 0, unknown: 0 } },
        ];
        const table = buildSummaryTable(rows);
        expect(table).toContain('dot?type=passed');
        expect(table).not.toContain('dot?type=failed');
    });

    it('computes total from all stat fields', () => {
        const rows: SummaryRow[] = [
            { reportName: 'Tests', stats: { passed: 1, failed: 2, broken: 3, skipped: 4, unknown: 5 } },
        ];
        const table = buildSummaryTable(rows);
        expect(table).toContain('| 15 |');
    });

    it('shows dash for missing report URL', () => {
        const rows: SummaryRow[] = [
            { reportName: 'Tests', stats: baseStats },
        ];
        const table = buildSummaryTable(rows);
        // No <a href> in the report column
        expect(table).not.toContain('<a href="">');
    });

    it('handles rerun columns for notDeployed rows', () => {
        const rows: SummaryRow[] = [
            {
                reportName: 'Active',
                stats: baseStats,
                reruns: [{ attempt: 2, url: 'https://example.com/rerun' }],
            },
            { reportName: 'Missing', notDeployed: true },
        ];
        const table = buildSummaryTable(rows);
        // notDeployed row should have dash in the rerun column
        const lines = table.split('\n');
        const missingRow = lines.find((l) => l.includes('Missing'));
        expect(missingRow).toContain('—');
    });
});
