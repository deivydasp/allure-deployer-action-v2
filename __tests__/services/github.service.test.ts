import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../../src/services/github.service.js';

vi.mock('@actions/core', () => ({
    info: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn(),
    summary: {
        addRaw: vi.fn().mockReturnThis(),
        write: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('@actions/github', () => ({
    getOctokit: vi.fn(),
    context: {
        repo: { owner: 'test-owner', repo: 'test-repo' },
    },
}));

vi.mock('../../src/utilities/util.js', () => ({
    withRetry: vi.fn((fn: () => Promise<void>) => fn()),
    DEFAULT_RETRY_CONFIG: { maxRetries: 3, initialDelay: 1000, maxDelay: 10000, backoffFactor: 2 },
}));

import { setOutput, summary, warning } from '@actions/core';
import * as github from '@actions/github';

const mockedSetOutput = vi.mocked(setOutput);
const mockedWarning = vi.mocked(warning);
const mockedSummary = vi.mocked(summary);
const mockedGetOctokit = vi.mocked(github.getOctokit);

describe('GitHubService', () => {
    let service: GitHubService;

    beforeEach(() => {
        service = new GitHubService();
    });

    describe('updateOutput', () => {
        it('sets GitHub Actions output', async () => {
            await service.updateOutput({ name: 'report_url', value: 'https://example.com' });
            expect(mockedSetOutput).toHaveBeenCalledWith('report_url', 'https://example.com');
        });

        it('warns on failure instead of throwing', async () => {
            mockedSetOutput.mockImplementation(() => { throw new Error('output failed'); });
            await service.updateOutput({ name: 'test', value: 'val' });
            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining("Failed to set output 'test'"));
        });
    });

    describe('updatePr', () => {
        it('creates a comment on the PR', async () => {
            const createComment = vi.fn().mockResolvedValue({});
            mockedGetOctokit.mockReturnValue({
                rest: {
                    issues: { createComment },
                },
            } as any);

            await service.updatePr({ message: 'Test report', token: 'token123', prNumber: 42 });

            expect(createComment).toHaveBeenCalledWith({
                owner: 'test-owner',
                repo: 'test-repo',
                issue_number: 42,
                body: 'Test report',
            });
        });

        it('warns on failure instead of throwing', async () => {
            mockedGetOctokit.mockReturnValue({
                rest: {
                    issues: {
                        createComment: vi.fn().mockRejectedValue(new Error('API error')),
                    },
                },
            } as any);

            await service.updatePr({ message: 'msg', token: 'tok', prNumber: 1 });
            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Failed to update PR'));
        });
    });

    describe('updateSummary', () => {
        it('writes job summary', async () => {
            await service.updateSummary('Summary content');
            expect(mockedSummary.addRaw).toHaveBeenCalledWith('Summary content', true);
            expect(mockedSummary.write).toHaveBeenCalled();
        });

        it('warns on failure instead of throwing', async () => {
            mockedSummary.write.mockRejectedValueOnce(new Error('write failed'));
            await service.updateSummary('content');
            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Failed to write job summary'));
        });
    });
});
