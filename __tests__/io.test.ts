import { describe, it, expect, vi, beforeEach } from 'vitest';

const rawInputs: Record<string, string> = {};

vi.mock('@actions/core', () => ({
    getInput: vi.fn((name: string) => rawInputs[name] ?? ''),
    getBooleanInput: vi.fn(() => false),
    setSecret: vi.fn(),
    warning: vi.fn(),
}));

import { warning } from '@actions/core';

/** io.ts reads inputs at import time, so each case re-imports it */
async function loadCommitRetentionDays(value: string): Promise<number> {
    rawInputs.commit_retention_days = value;
    vi.resetModules();
    return (await import('../src/io.js')).default.commit_retention_days;
}

describe('commit_retention_days input', () => {
    beforeEach(() => {
        vi.mocked(warning).mockClear();
    });

    it.each([
        ['', 0],
        ['0', 0],
        ['7', 7],
        [' 30 ', 30],
    ])('accepts %j as %d', async (value, expected) => {
        expect(await loadCommitRetentionDays(value)).toBe(expected);
        expect(warning).not.toHaveBeenCalled();
    });

    it.each(['weekly', '7d', '0.5', '-1'])('disables pruning with a warning for %j', async (value) => {
        expect(await loadCommitRetentionDays(value)).toBe(0);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('Invalid commit_retention_days'));
    });
});

async function loadPrNumber(value: string): Promise<number | undefined> {
    rawInputs.pr_number = value;
    vi.resetModules();
    return (await import('../src/io.js')).default.pr_number;
}

describe('pr_number input', () => {
    beforeEach(() => {
        vi.mocked(warning).mockClear();
        // Left behind by the commit_retention_days cases, whose invalid values warn on import
        delete rawInputs.commit_retention_days;
    });

    it.each([
        ['', undefined],
        ['42', 42],
        [' 1473 ', 1473],
    ])('accepts %j as %j', async (value, expected) => {
        expect(await loadPrNumber(value)).toBe(expected);
        expect(warning).not.toHaveBeenCalled();
    });

    it.each(['0', '#42', '4.2', '-1', 'abc'])('ignores %j with a warning', async (value) => {
        expect(await loadPrNumber(value)).toBeUndefined();
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('Invalid pr_number'));
    });
});
