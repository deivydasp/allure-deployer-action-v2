import { describe, it, expect, vi } from 'vitest';
import { isRetryableError, removeTrailingSlash, withRetry, copyDirectory, allFulfilledResults, RetryConfig } from '../../src/utilities/util.js';

vi.mock('@actions/core', () => ({
    info: vi.fn(),
    warning: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
    cp: vi.fn().mockResolvedValue(undefined),
}));

import { warning } from '@actions/core';

describe('isRetryableError', () => {
    it('returns true for 408 Request Timeout', () => {
        expect(isRetryableError({ status: 408 })).toBe(true);
    });

    it('returns true for 429 Too Many Requests', () => {
        expect(isRetryableError({ status: 429 })).toBe(true);
    });

    it('returns true for 500 Internal Server Error', () => {
        expect(isRetryableError({ status: 500 })).toBe(true);
    });

    it('returns true for 502 Bad Gateway', () => {
        expect(isRetryableError({ status: 502 })).toBe(true);
    });

    it('returns true for 503 Service Unavailable', () => {
        expect(isRetryableError({ status: 503 })).toBe(true);
    });

    it('returns true for 504 Gateway Timeout', () => {
        expect(isRetryableError({ status: 504 })).toBe(true);
    });

    it('returns false for 404 Not Found', () => {
        expect(isRetryableError({ status: 404 })).toBe(false);
    });

    it('returns false for 401 Unauthorized', () => {
        expect(isRetryableError({ status: 401 })).toBe(false);
    });

    it('returns true when message contains rate limit', () => {
        expect(isRetryableError({ message: 'API rate limit exceeded' })).toBe(true);
    });

    it('returns true when message contains timeout', () => {
        expect(isRetryableError({ message: 'Connection timeout' })).toBe(true);
    });

    it('returns true when message contains network error', () => {
        expect(isRetryableError({ message: 'network error occurred' })).toBe(true);
    });

    it('returns true for git push rejection messages', () => {
        expect(isRetryableError({ message: 'tip of your current branch is behind' })).toBe(true);
        expect(isRetryableError({ message: 'failed to push some refs' })).toBe(true);
        expect(isRetryableError({ message: 'non-fast-forward update rejected' })).toBe(true);
        expect(isRetryableError({ message: '[rejected] master -> master' })).toBe(true);
    });

    it('returns false for non-retryable error', () => {
        expect(isRetryableError({ status: 401, message: 'Bad credentials' })).toBe(false);
    });

    it('returns false for error with no status or message', () => {
        expect(isRetryableError({})).toBe(false);
    });
});

describe('removeTrailingSlash', () => {
    it('removes trailing forward slash', () => {
        expect(removeTrailingSlash('/foo/bar/')).toBe('/foo/bar');
    });

    it('removes trailing backslash', () => {
        expect(removeTrailingSlash('C:\\path\\')).toBe('C:\\path');
    });

    it('leaves paths without trailing slash unchanged', () => {
        expect(removeTrailingSlash('/foo/bar')).toBe('/foo/bar');
    });

    it('preserves root slash', () => {
        expect(removeTrailingSlash('/')).toBe('/');
    });

    it('preserves single backslash', () => {
        expect(removeTrailingSlash('\\')).toBe('\\');
    });

    it('handles empty string', () => {
        expect(removeTrailingSlash('')).toBe('');
    });
});

describe('withRetry', () => {
    const fastConfig: RetryConfig = {
        maxRetries: 3,
        initialDelay: 1,
        maxDelay: 5,
        backoffFactor: 2,
    };

    it('returns result on first success', async () => {
        const op = vi.fn().mockResolvedValue('ok');
        const result = await withRetry(op, fastConfig);
        expect(result).toBe('ok');
        expect(op).toHaveBeenCalledTimes(1);
    });

    it('retries on retryable error and succeeds', async () => {
        const op = vi.fn()
            .mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' })
            .mockResolvedValueOnce('recovered');

        const result = await withRetry(op, fastConfig);
        expect(result).toBe('recovered');
        expect(op).toHaveBeenCalledTimes(2);
    });

    it('throws immediately on non-retryable error', async () => {
        const op = vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' });

        await expect(withRetry(op, fastConfig)).rejects.toMatchObject({
            status: 401,
            message: 'Unauthorized',
        });
        expect(op).toHaveBeenCalledTimes(1);
    });

    it('throws after exhausting all retries', async () => {
        const op = vi.fn().mockRejectedValue({ status: 503, message: 'down' });

        await expect(withRetry(op, fastConfig)).rejects.toThrow('Failed after 3 attempts');
        expect(op).toHaveBeenCalledTimes(3);
    });

    it('preserves original error as cause after exhausting retries', async () => {
        const original = { status: 503, message: 'down' };
        const op = vi.fn().mockRejectedValue(original);

        try {
            await withRetry(op, fastConfig);
        } catch (e: any) {
            expect(e.cause).toBe(original);
        }
    });

    it('logs warning on each retry', async () => {
        const op = vi.fn()
            .mockRejectedValueOnce({ status: 429, message: 'rate limited' })
            .mockResolvedValueOnce('ok');

        await withRetry(op, fastConfig);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('Attempt 1 failed'));
    });

    it('retries on git push rejection', async () => {
        const op = vi.fn()
            .mockRejectedValueOnce({ message: 'failed to push some refs' })
            .mockResolvedValueOnce('pushed');

        const result = await withRetry(op, fastConfig);
        expect(result).toBe('pushed');
        expect(op).toHaveBeenCalledTimes(2);
    });
});

describe('copyDirectory', () => {
    it('copies recursively and logs', async () => {
        const { cp } = await import('node:fs/promises');
        const { info } = await import('@actions/core');
        await copyDirectory('/src', '/dest');
        expect(cp).toHaveBeenCalledWith('/src', '/dest', { recursive: true });
        expect(info).toHaveBeenCalledWith(expect.stringContaining('/src'));
    });
});

describe('allFulfilledResults', () => {
    it('returns values from fulfilled promises', async () => {
        const results = await allFulfilledResults([
            Promise.resolve('a'),
            Promise.resolve('b'),
        ]);
        expect(results).toEqual(['a', 'b']);
    });

    it('filters out rejected promises and warns', async () => {
        const results = await allFulfilledResults([
            Promise.resolve('ok'),
            Promise.reject(new Error('fail')),
            Promise.resolve('also ok'),
        ]);
        expect(results).toEqual(['ok', 'also ok']);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('fail'));
    });

    it('returns empty array when all rejected', async () => {
        const results = await allFulfilledResults([
            Promise.reject('err1'),
            Promise.reject('err2'),
        ]);
        expect(results).toEqual([]);
    });

    it('returns empty array for empty input', async () => {
        const results = await allFulfilledResults([]);
        expect(results).toEqual([]);
    });
});
