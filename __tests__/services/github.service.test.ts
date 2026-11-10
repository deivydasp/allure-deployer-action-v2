import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService, prCommentMarker } from '../../src/services/github.service.js';

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
        const marker = '<!-- allure-deployer-action:api -->';

        function mockOctokit(existingComments: { id: number; body?: string }[] = []) {
            const issues = {
                listComments: vi.fn(),
                createComment: vi.fn().mockResolvedValue({}),
                deleteComment: vi.fn().mockResolvedValue({}),
            };
            const paginate = vi.fn().mockResolvedValue(existingComments);
            mockedGetOctokit.mockReturnValue({ paginate, rest: { issues } } as any);
            return { issues, paginate };
        }

        it('creates a marked comment when the PR has none for this report', async () => {
            const { issues, paginate } = mockOctokit([{ id: 1, body: 'unrelated' }]);

            await service.updatePr({ message: 'Test report', token: 'token123', prNumber: 42, commentKey: 'api' });

            expect(paginate).toHaveBeenCalledWith(issues.listComments, expect.objectContaining({ issue_number: 42 }));
            expect(issues.deleteComment).not.toHaveBeenCalled();
            expect(issues.createComment).toHaveBeenCalledWith({
                owner: 'test-owner',
                repo: 'test-repo',
                issue_number: 42,
                body: `${marker}\nTest report`,
            });
        });

        it('posts a new comment, then deletes the earlier ones for the same report', async () => {
            const { issues } = mockOctokit([
                { id: 1, body: `${marker}\nold` },
                { id: 2, body: '<!-- allure-deployer-action:ui -->\nother report' },
                { id: 3, body: `${marker}\nnewer` },
                { id: 4, body: `> quoting ${marker}\nby hand` },
            ]);

            await service.updatePr({ message: 'Test report', token: 'tok', prNumber: 42, commentKey: 'api' });

            expect(issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ body: `${marker}\nTest report` }));
            expect(issues.deleteComment.mock.calls.map(([c]) => c.comment_id)).toEqual([1, 3]);
            expect(issues.createComment.mock.invocationCallOrder[0]).toBeLessThan(
                issues.deleteComment.mock.invocationCallOrder[0],
            );
        });

        it('keeps the earlier comment when posting the new one fails', async () => {
            const { issues } = mockOctokit([{ id: 3, body: `${marker}\nold` }]);
            issues.createComment.mockRejectedValue(new Error('API error'));

            await service.updatePr({ message: 'Test report', token: 'tok', prNumber: 42, commentKey: 'api' });

            expect(issues.deleteComment).not.toHaveBeenCalled();
            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Failed to update PR'));
        });

        it('warns and carries on when an earlier comment cannot be deleted', async () => {
            const { issues } = mockOctokit([
                { id: 1, body: `${marker}\nold` },
                { id: 2, body: `${marker}\nolder` },
            ]);
            issues.deleteComment.mockRejectedValueOnce(new Error('Forbidden'));

            await service.updatePr({ message: 'Test report', token: 'tok', prNumber: 42, commentKey: 'api' });

            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Failed to delete earlier PR comment 1'));
            expect(issues.deleteComment).toHaveBeenCalledTimes(2);
        });

        it('warns instead of throwing when the client cannot be created', async () => {
            mockedGetOctokit.mockImplementationOnce(() => {
                throw new Error('bad token');
            });

            await expect(
                service.updatePr({ message: 'm', token: 't', prNumber: 1, commentKey: 'api' }),
            ).resolves.toBeUndefined();
            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Failed to update PR'));
        });

        it('warns on failure instead of throwing', async () => {
            const { issues } = mockOctokit();
            issues.createComment.mockRejectedValue(new Error('API error'));

            await service.updatePr({ message: 'msg', token: 'tok', prNumber: 1, commentKey: 'api' });
            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Failed to update PR'));
        });
    });

    describe('prCommentMarker', () => {
        it('keeps the key from closing the HTML comment early', () => {
            expect(prCommentMarker('a--b')).toBe('<!-- allure-deployer-action:a-b -->');
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
