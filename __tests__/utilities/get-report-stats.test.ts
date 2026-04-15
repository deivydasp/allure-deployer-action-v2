import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTestDuration, getReportStats } from '../../src/utilities/get-report-stats.js';

vi.mock('node:fs/promises', () => ({
    readdir: vi.fn(),
    readFile: vi.fn(),
}));

import * as fs from 'node:fs/promises';
const mockedReaddir = vi.mocked(fs.readdir);
const mockedReadFile = vi.mocked(fs.readFile);

beforeEach(() => {
    mockedReaddir.mockReset();
    mockedReadFile.mockReset();
});

describe('getTestDuration', () => {
    it('computes wall-clock duration from min(start) to max(stop)', async () => {
        mockedReaddir.mockResolvedValue([
            'test1-result.json',
            'test2-result.json',
            'other.json',
        ] as any);
        mockedReadFile
            .mockResolvedValueOnce(JSON.stringify({ start: 1000, stop: 3000 }))
            .mockResolvedValueOnce(JSON.stringify({ start: 500, stop: 4000 }));

        const duration = await getTestDuration('/results');
        expect(duration).toBe(3500); // 4000 - 500
    });

    it('returns undefined when no result files exist', async () => {
        mockedReaddir.mockResolvedValue(['other.json', 'readme.md'] as any);
        const duration = await getTestDuration('/results');
        expect(duration).toBeUndefined();
    });

    it('returns undefined when results dir is not readable', async () => {
        mockedReaddir.mockRejectedValue(new Error('ENOENT'));
        const duration = await getTestDuration('/nonexistent');
        expect(duration).toBeUndefined();
    });

    it('skips malformed result files', async () => {
        mockedReaddir.mockResolvedValue([
            'good-result.json',
            'bad-result.json',
        ] as any);
        mockedReadFile
            .mockResolvedValueOnce(JSON.stringify({ start: 1000, stop: 2000 }))
            .mockResolvedValueOnce('not valid json');

        const duration = await getTestDuration('/results');
        expect(duration).toBe(1000);
    });

    it('returns undefined when stop < start', async () => {
        mockedReaddir.mockResolvedValue(['test-result.json'] as any);
        mockedReadFile.mockResolvedValueOnce(JSON.stringify({ start: 5000, stop: 1000 }));
        const duration = await getTestDuration('/results');
        expect(duration).toBeUndefined();
    });

    it('returns undefined when result has no start/stop', async () => {
        mockedReaddir.mockResolvedValue(['test-result.json'] as any);
        mockedReadFile.mockResolvedValueOnce(JSON.stringify({ name: 'test' }));
        const duration = await getTestDuration('/results');
        expect(duration).toBeUndefined();
    });
});

describe('getReportStats', () => {
    it('reads stats from summary.json (v3 format)', async () => {
        mockedReadFile.mockResolvedValueOnce(
            JSON.stringify({
                stats: { passed: 10, failed: 2, broken: 1, skipped: 3, unknown: 0 },
                duration: 5000,
            }),
        );

        const result = await getReportStats('/report');
        expect(result.statistic).toEqual({
            passed: 10, failed: 2, broken: 1, skipped: 3, unknown: 0,
        });
        expect(result.duration).toBe(5000);
    });

    it('reads stats from summary.json (v2 format with statistic field)', async () => {
        mockedReadFile.mockResolvedValueOnce(
            JSON.stringify({
                statistic: { passed: 5, failed: 1, broken: 0, skipped: 2, unknown: 0 },
                duration: 3000,
            }),
        );

        const result = await getReportStats('/report');
        expect(result.statistic).toEqual({
            passed: 5, failed: 1, broken: 0, skipped: 2, unknown: 0,
        });
    });

    it('falls back to awesome/summary.json', async () => {
        mockedReadFile
            .mockRejectedValueOnce(new Error('ENOENT')) // summary.json fails
            .mockResolvedValueOnce(
                JSON.stringify({
                    stats: { passed: 8, failed: 0, broken: 0, skipped: 0, unknown: 0 },
                }),
            );

        const result = await getReportStats('/report');
        expect(result.statistic.passed).toBe(8);
    });

    it('falls back to widgets/statistic.json', async () => {
        mockedReadFile
            .mockRejectedValueOnce(new Error()) // summary.json
            .mockRejectedValueOnce(new Error()) // awesome/summary.json
            .mockResolvedValueOnce(
                JSON.stringify({ passed: 7, failed: 1, broken: 0, skipped: 0, unknown: 0 }),
            );

        const result = await getReportStats('/report');
        expect(result.statistic).toEqual({
            passed: 7, failed: 1, broken: 0, skipped: 0, unknown: 0,
        });
        expect(result.duration).toBeUndefined();
    });

    it('falls back to awesome/widgets/statistic.json', async () => {
        mockedReadFile
            .mockRejectedValueOnce(new Error()) // summary.json
            .mockRejectedValueOnce(new Error()) // awesome/summary.json
            .mockRejectedValueOnce(new Error()) // widgets/statistic.json
            .mockResolvedValueOnce(
                JSON.stringify({ passed: 3, failed: 0, broken: 0, skipped: 1, unknown: 0 }),
            );

        const result = await getReportStats('/report');
        expect(result.statistic.passed).toBe(3);
        expect(result.statistic.skipped).toBe(1);
    });

    it('throws when all candidates fail', async () => {
        mockedReadFile.mockRejectedValue(new Error('ENOENT'));
        await expect(getReportStats('/report')).rejects.toThrow('Failed to read report statistics');
    });

    it('defaults missing stat fields to 0', async () => {
        mockedReadFile.mockResolvedValueOnce(
            JSON.stringify({ stats: { passed: 5 } }),
        );

        const result = await getReportStats('/report');
        expect(result.statistic).toEqual({
            passed: 5, failed: 0, broken: 0, skipped: 0, unknown: 0,
        });
    });
});
