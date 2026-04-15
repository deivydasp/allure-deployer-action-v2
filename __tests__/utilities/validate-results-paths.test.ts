import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateResultsPaths } from '../../src/utilities/validate-results-paths.js';

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
    access: vi.fn(),
}));

import * as fs from 'node:fs/promises';
const mockedAccess = vi.mocked(fs.access);

beforeEach(() => {
    mockedAccess.mockReset();
});

describe('validateResultsPaths', () => {
    it('returns single path when it exists', async () => {
        mockedAccess.mockResolvedValueOnce(undefined);
        const result = await validateResultsPaths('/path/to/results');
        expect(result).toEqual(['/path/to/results']);
    });

    it('returns empty array when single path does not exist', async () => {
        mockedAccess.mockRejectedValueOnce(new Error('ENOENT'));
        const result = await validateResultsPaths('/nonexistent');
        expect(result).toEqual([]);
    });

    it('trims whitespace from single path', async () => {
        mockedAccess.mockResolvedValueOnce(undefined);
        const result = await validateResultsPaths('  /path/to/results  ');
        expect(result).toEqual(['/path/to/results']);
        expect(mockedAccess).toHaveBeenCalledWith('/path/to/results');
    });

    it('returns only existing paths from comma-separated list', async () => {
        mockedAccess
            .mockResolvedValueOnce(undefined)      // first exists
            .mockRejectedValueOnce(new Error())     // second doesn't
            .mockResolvedValueOnce(undefined);      // third exists

        const result = await validateResultsPaths('/a,/b,/c');
        expect(result).toEqual(['/a', '/c']);
    });

    it('trims whitespace from comma-separated paths', async () => {
        mockedAccess.mockResolvedValue(undefined);
        const result = await validateResultsPaths(' /a , /b , /c ');
        expect(result).toEqual(['/a', '/b', '/c']);
    });

    it('returns empty array when no comma-separated paths exist', async () => {
        mockedAccess.mockRejectedValue(new Error('ENOENT'));
        const result = await validateResultsPaths('/a,/b,/c');
        expect(result).toEqual([]);
    });

    it('returns all paths when all exist', async () => {
        mockedAccess.mockResolvedValue(undefined);
        const result = await validateResultsPaths('/a,/b');
        expect(result).toEqual(['/a', '/b']);
    });
});
