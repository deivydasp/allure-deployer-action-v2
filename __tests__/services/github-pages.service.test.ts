import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GithubPagesService, GitHubConfig } from '../../src/services/github-pages.service.js';

vi.mock('@actions/core', () => ({
    info: vi.fn(),
    warning: vi.fn(),
}));

vi.mock('@actions/github', () => ({
    context: {
        actor: 'test-actor',
        runId: 12345,
        serverUrl: 'https://github.com',
        payload: { sender: { id: 99 } },
    },
    getOctokit: vi.fn(() => mockOctokit),
}));

const mockOctokit = {
    graphql: vi.fn(),
    rest: {
        git: {
            createCommit: vi.fn(async ({ tree }: { tree: string }) => ({ data: { sha: `new-${tree}` } })),
        },
    },
};

// Mock io.ts — the main challenge. This module executes at import time.
vi.mock('../../src/io.js', () => ({
    default: {
        WORKSPACE: '/tmp/workspace',
        prefix: 'my-prefix',
        keep: 5,
        commit_retention_days: 0,
        RESULTS_STAGING_PATH: '/tmp/staging',
    },
}));

vi.mock('normalize-url', () => ({
    default: vi.fn((url: string) => url),
}));

// Mock simple-git
const mockGit = {
    cwd: vi.fn().mockReturnThis(),
    init: vi.fn().mockReturnThis(),
    checkIsRepo: vi.fn().mockResolvedValue(false),
    addConfig: vi.fn().mockReturnThis(),
    addRemote: vi.fn().mockReturnThis(),
    fetch: vi.fn().mockResolvedValue({ branches: [{ name: 'gh-pages' }] }),
    checkoutBranch: vi.fn().mockReturnThis(),
    add: vi.fn().mockReturnThis(),
    commit: vi.fn().mockReturnThis(),
    push: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockReturnThis(),
    merge: vi.fn().mockReturnThis(),
    listRemote: vi.fn().mockResolvedValue('ref: refs/heads/main\tHEAD\nabc123\tHEAD\n'),
    revparse: vi.fn().mockResolvedValue('tip123\n'),
};

vi.mock('simple-git', () => ({
    simpleGit: vi.fn(() => mockGit),
    CheckRepoActions: { IS_REPO_ROOT: 'IS_REPO_ROOT' },
}));

vi.mock('node:fs', () => ({
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
    cp: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(),
    rm: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('p-limit', () => ({
    default: vi.fn(() => (fn: () => Promise<void>) => fn()),
}));

vi.mock('../../src/utilities/util.js', () => ({
    withRetry: vi.fn((fn: () => Promise<any>) => fn()),
    DEFAULT_RETRY_CONFIG: { maxRetries: 3, initialDelay: 1, maxDelay: 5, backoffFactor: 2 },
    allFulfilledResults: vi.fn(async (promises: Promise<any>[]) => {
        const results = await Promise.allSettled(promises);
        return results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled').map((r) => r.value);
    }),
    removeTrailingSlash: vi.fn((p: string) => p),
}));

import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { info, warning } from '@actions/core';
import ioMock from '../../src/io.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedRmSync = vi.mocked(rmSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedReaddir = vi.mocked(readdir);
const mockedRm = vi.mocked(rm);
const mockedCp = vi.mocked(cp);
const mockedWriteFile = vi.mocked(writeFile);
const mockedReadFile = vi.mocked(readFile);
const mockedWarning = vi.mocked(warning);
const mockedInfo = vi.mocked(info);

function createConfig(overrides: Partial<GitHubConfig> = {}): GitHubConfig {
    return {
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'gh-pages',
        token: 'test-token',
        reportDir: '/tmp/workspace/docs/my-prefix/123456',
        pageUrl: 'https://test-owner.github.io/test-repo/docs/my-prefix/123456',
        pagesSourcePath: 'docs',
        historyPath: '/tmp/workspace/docs/my-prefix/history/history.jsonl',
        ...overrides,
    };
}

describe('GithubPagesService', () => {
    beforeEach(() => {
        Object.values(mockGit).forEach((fn) => {
            if (typeof fn.mockClear === 'function') fn.mockClear();
        });
        mockGit.checkIsRepo.mockResolvedValue(false);
        mockGit.fetch.mockResolvedValue({ branches: [{ name: 'gh-pages' }] });
        mockGit.push.mockResolvedValue(undefined);
        mockedExistsSync.mockReturnValue(true);
    });

    describe('setupBranch', () => {
        it('initializes git repo and checks out existing branch', async () => {
            const service = new GithubPagesService(createConfig());
            await service.setupBranch();

            expect(mockGit.init).toHaveBeenCalled();
            expect(mockGit.addRemote).toHaveBeenCalledWith(
                'origin',
                'https://github.com/test-owner/test-repo.git',
            );
            expect(mockGit.fetch).toHaveBeenCalledWith('origin', 'gh-pages', { '--depth': 1, '--no-tags': null });
            expect(mockGit.checkoutBranch).toHaveBeenCalledWith('gh-pages', 'origin/gh-pages');
        });

        it('creates branch from default when fetch returns no branches', async () => {
            mockGit.fetch.mockResolvedValueOnce({ branches: [] });
            mockGit.listRemote.mockResolvedValue('ref: refs/heads/main\tHEAD\nabc123\tHEAD\n');

            const service = new GithubPagesService(createConfig());
            await service.setupBranch();

            expect(mockGit.listRemote).toHaveBeenCalledWith(['--symref', 'HEAD']);
            expect(mockGit.fetch).toHaveBeenCalledWith('origin', 'main', { '--depth': 1, '--no-tags': null });
            expect(mockGit.checkoutBranch).toHaveBeenCalledWith('gh-pages', 'origin/main');
        });

        it('removes existing workspace if it is a repo', async () => {
            mockGit.checkIsRepo.mockResolvedValueOnce(true); // first checkIsRepo returns true
            const service = new GithubPagesService(createConfig());
            await service.setupBranch();

            expect(mockedRmSync).toHaveBeenCalledWith('/tmp/workspace', { recursive: true, force: true });
            expect(mockedMkdirSync).toHaveBeenCalledWith('/tmp/workspace', { recursive: true });
        });

        it('configures git user from context', async () => {
            const service = new GithubPagesService(createConfig());
            await service.setupBranch();

            expect(mockGit.addConfig).toHaveBeenCalledWith(
                'user.email',
                '99+test-actor@users.noreply.github.com',
                true,
                'local',
            );
            expect(mockGit.addConfig).toHaveBeenCalledWith(
                'user.name',
                'test-actor',
                true,
                'local',
            );
        });
    });

    describe('deployPages', () => {
        it('throws when report directory does not exist', async () => {
            mockedExistsSync.mockReturnValueOnce(false);
            const service = new GithubPagesService(createConfig());
            await expect(service.deployPages()).rejects.toThrow('Directory not found');
        });

        it('throws when not in a git repo', async () => {
            mockGit.checkIsRepo.mockResolvedValue(false);
            const service = new GithubPagesService(createConfig());
            await expect(service.deployPages()).rejects.toThrow('No repository found');
        });

        it('commits and pushes when everything is valid', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            mockedReaddir.mockResolvedValue([]);

            const service = new GithubPagesService(createConfig());
            await service.deployPages();

            expect(mockGit.commit).toHaveBeenCalledWith(expect.stringContaining('12345'));
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
        });

        it('throws when no index.html in report dir', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            mockedReaddir.mockResolvedValue([]);
            mockedExistsSync
                .mockReturnValueOnce(true)  // reportDir exists
                .mockReturnValueOnce(true)  // .nojekyll exists
                .mockReturnValueOnce(false); // index.html does NOT exist

            const service = new GithubPagesService(createConfig());
            await expect(service.deployPages()).rejects.toThrow('No index.html found');
        });
    });

    describe('deleteOldReports', () => {
        it('deletes oldest reports when over keep limit', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            mockedReaddir.mockResolvedValueOnce([
                { name: '100', isDirectory: () => true, parentPath: '/tmp/workspace/docs/my-prefix' },
                { name: '200', isDirectory: () => true, parentPath: '/tmp/workspace/docs/my-prefix' },
                { name: '300', isDirectory: () => true, parentPath: '/tmp/workspace/docs/my-prefix' },
                { name: '400', isDirectory: () => true, parentPath: '/tmp/workspace/docs/my-prefix' },
                { name: '500', isDirectory: () => true, parentPath: '/tmp/workspace/docs/my-prefix' },
                { name: '600', isDirectory: () => true, parentPath: '/tmp/workspace/docs/my-prefix' },
                { name: '700', isDirectory: () => true, parentPath: '/tmp/workspace/docs/my-prefix' },
            ] as any);

            const config = createConfig();
            // Modify inputs.keep via the mock — we set keep=5 in the mock
            const service = new GithubPagesService(config);
            await service.deployPages();

            // With 7 reports and keep=5, 2 oldest should be deleted
            expect(mockedRm).toHaveBeenCalledTimes(2);
        });

        it('skips non-numeric directories', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            // readdir for deleteOldReports (parent dir of reportDir)
            mockedReaddir.mockResolvedValueOnce([
                { name: '100', isDirectory: () => true, parentPath: '/p' },
                { name: 'latest', isDirectory: () => true, parentPath: '/p' },
                { name: '_version', isDirectory: () => false, parentPath: '/p' },
            ] as any)
            // readdir for createRootSummaryPage (root dir)
            .mockResolvedValueOnce([]);

            const service = new GithubPagesService(createConfig());
            await service.deployPages();

            // Only 1 numeric dir, keep=5, nothing to delete
            expect(mockedRm).not.toHaveBeenCalled();
        });

        it('warns when readdir fails for old reports', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            mockedReaddir
                .mockRejectedValueOnce(new Error('permission denied')) // deleteOldReports
                .mockResolvedValueOnce([]); // createRootSummaryPage

            const service = new GithubPagesService(createConfig());
            await service.deployPages();

            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Failed to delete old reports'));
        });
    });

    describe('createRedirectPage', () => {
        it('writes _latest file and redirect index.html', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            mockedReaddir.mockResolvedValue([]);

            const service = new GithubPagesService(createConfig());
            await service.deployPages();

            // _latest file written with target URL
            const latestCall = mockedWriteFile.mock.calls.find(
                (call) => typeof call[0] === 'string' && call[0].includes('_latest'),
            );
            expect(latestCall).toBeDefined();
            expect(latestCall![1]).toContain('index.html');

            // redirect index.html written
            const redirectCall = mockedWriteFile.mock.calls.find(
                (call) => typeof call[0] === 'string' && call[0].includes('my-prefix') &&
                    call[0].endsWith('index.html') && !call[0].includes('123456'),
            );
            expect(redirectCall).toBeDefined();
            expect(redirectCall![1]).toContain('_latest');
            expect(redirectCall![1]).toContain('cache');
        });

        it('stages both _latest and index.html in git', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            mockedReaddir.mockResolvedValue([]);

            const service = new GithubPagesService(createConfig());
            await service.deployPages();

            const addCalls = mockGit.add.mock.calls.map((c: any[]) => c[0]);
            expect(addCalls.some((p: string) => p.includes('_latest'))).toBe(true);
        });
    });

    describe('createRootSummaryPage', () => {
        it('skips when no prefix directories have numeric run dirs', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            // deleteOldReports
            mockedReaddir.mockResolvedValueOnce([]);
            // createRootSummaryPage — rootDir entries
            mockedReaddir.mockResolvedValueOnce([
                { name: 'prefix-a', isDirectory: () => true },
            ] as any);
            // runs inside prefix-a — no numeric dirs
            mockedReaddir.mockResolvedValueOnce([
                { name: 'latest', isDirectory: () => true },
                { name: '_version', isDirectory: () => false },
            ] as any);

            const service = new GithubPagesService(createConfig());
            await service.deployPages();

            // No summary generation attempted since summaries is empty
            expect(mockGit.add).not.toHaveBeenCalledWith(
                expect.stringContaining('docs/index.html'),
            );
        });

        it('warns when @allurereport/summary is not available', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            // deleteOldReports
            mockedReaddir.mockResolvedValueOnce([]);
            // createRootSummaryPage — rootDir entries
            mockedReaddir.mockResolvedValueOnce([
                { name: 'prefix-a', isDirectory: () => true },
            ] as any);
            // runs inside prefix-a
            mockedReaddir.mockResolvedValueOnce([
                { name: '111', isDirectory: () => true },
            ] as any);
            // existsSync for summary.json — return true for report index.html and summary.json
            mockedExistsSync.mockReturnValue(true);
            mockedReadFile.mockResolvedValue(JSON.stringify({
                stats: { passed: 5, failed: 0, broken: 0, skipped: 0, unknown: 0 },
                name: 'Test Suite',
            }));

            const service = new GithubPagesService(createConfig());
            await service.deployPages();

            // The import of @allurereport/summary will fail in test environment
            expect(mockedWarning).toHaveBeenCalledWith(
                expect.stringContaining('summary'),
            );
        });
    });

    describe('injectDeployBanner', () => {
        it('sets deployVersion on the service instance', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            mockedReaddir.mockResolvedValueOnce([]);
            // createRootSummaryPage — make it reach injectDeployBanner
            mockedReaddir.mockResolvedValueOnce([
                { name: 'prefix-a', isDirectory: () => true },
            ] as any);
            mockedReaddir.mockResolvedValueOnce([
                { name: '111', isDirectory: () => true },
            ] as any);
            mockedExistsSync.mockReturnValue(true);
            mockedReadFile.mockResolvedValue(JSON.stringify({
                stats: { passed: 1, failed: 0, broken: 0, skipped: 0, unknown: 0 },
            }));

            const service = new GithubPagesService(createConfig());
            // deployVersion is undefined before deploy
            expect(service.deployVersion).toBeUndefined();
        });
    });

    describe('gitPushWithRetry', () => {
        it('pushes successfully on first attempt', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            mockedReaddir.mockResolvedValue([]);

            const service = new GithubPagesService(createConfig());
            await service.deployPages();

            expect(mockGit.push).toHaveBeenCalledTimes(1);
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
            // No backup created on happy path
            expect(mockedCp).not.toHaveBeenCalled();
        });

        it('creates backup and retries on push failure', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            mockedReaddir.mockResolvedValue([]);

            // Make withRetry actually call the function multiple times
            const { withRetry } = await import('../../src/utilities/util.js');
            vi.mocked(withRetry).mockImplementationOnce(async (fn: any) => {
                try {
                    await fn();
                } catch {
                    // Simulate retry — call again
                    await fn();
                }
            });

            mockGit.push
                .mockRejectedValueOnce(new Error('failed to push some refs'))
                .mockResolvedValueOnce(undefined);

            const service = new GithubPagesService(createConfig());
            await service.deployPages();

            // Backup created on first failure
            expect(mockedCp).toHaveBeenCalledWith(
                expect.stringContaining('123456'),
                expect.stringContaining('report-backup'),
                { recursive: true },
            );
        });

        it('cleans up backups in finally block', async () => {
            mockGit.checkIsRepo.mockResolvedValue(true);
            mockedReaddir.mockResolvedValue([]);

            const { withRetry } = await import('../../src/utilities/util.js');
            vi.mocked(withRetry).mockImplementationOnce(async (fn: any) => {
                try { await fn(); } catch { await fn(); }
            });
            mockGit.push
                .mockRejectedValueOnce(new Error('failed to push some refs'))
                .mockResolvedValueOnce(undefined);

            const service = new GithubPagesService(createConfig());
            await service.deployPages();

            // Backups cleaned up
            expect(mockedRm).toHaveBeenCalledWith(
                expect.stringContaining('report-backup'),
                { recursive: true, force: true },
            );
            expect(mockedRm).toHaveBeenCalledWith(
                expect.stringContaining('history-backup'),
                { recursive: true, force: true },
            );
        });
    });

    describe('createBranchFromDefault', () => {
        it('throws when ls-remote output cannot determine default branch', async () => {
            mockGit.fetch.mockResolvedValueOnce({ branches: [] });
            mockGit.listRemote.mockResolvedValue('invalid output');

            const service = new GithubPagesService(createConfig());
            await expect(service.setupBranch()).rejects.toThrow('Could not determine default branch');
        });
    });

    describe('commit retention', () => {
        const DAY = 24 * 60 * 60 * 1000;
        let remoteDefaultBranch: string;

        const node = (oid: string, date: string) => ({
            oid,
            message: `Allure report ${oid}`,
            tree: { oid: `tree-${oid}` },
            author: { name: 'ci', email: 'ci@x', date },
            committer: { name: 'ci', email: 'ci@x', date },
        });

        /** One page of the retention query: `older` commits before the cutoff, `kept` newest first */
        const page = (older: number, kept: ReturnType<typeof node>[], endCursor: string | null = null) => ({
            repository: {
                id: 'repo-id',
                object: {
                    older: { totalCount: older },
                    kept: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes: kept },
                },
            },
        });

        const queryCalls = () => mockOctokit.graphql.mock.calls.filter(([q]) => String(q).startsWith('query'));
        const mutationCalls = () => mockOctokit.graphql.mock.calls.filter(([q]) => String(q).includes('updateRefs'));

        /** Runs setupBranch then deployPages, like main.ts does */
        async function setupAndDeploy(overrides: Partial<GitHubConfig> = {}): Promise<void> {
            mockGit.checkIsRepo.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
            const service = new GithubPagesService(createConfig({ pagesSourcePath: '', ...overrides }));
            await service.setupBranch();
            await service.deployPages();
        }

        beforeEach(() => {
            ioMock.commit_retention_days = 7;
            remoteDefaultBranch = 'main';
            mockGit.checkIsRepo.mockReset();
            mockGit.listRemote.mockImplementation(
                (async () => `ref: refs/heads/${remoteDefaultBranch}\tHEAD\nabc123\tHEAD\n`) as any,
            );
            mockedReaddir.mockResolvedValue([]);
            mockedWarning.mockClear();
            mockOctokit.graphql.mockReset();
            mockOctokit.rest.git.createCommit.mockClear();
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-10-12T08:00:00Z'));
        });

        afterEach(() => {
            ioMock.commit_retention_days = 0;
            mockGit.listRemote.mockReset();
            mockGit.listRemote.mockResolvedValue('ref: refs/heads/main\tHEAD\nabc123\tHEAD\n');
            vi.useRealTimers();
        });

        it('does nothing when commit_retention_days is 0', async () => {
            ioMock.commit_retention_days = 0;

            await setupAndDeploy();

            expect(mockOctokit.graphql).not.toHaveBeenCalled();
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
        });

        it('08:00 drops the commits from 7 days ago, keeping newer ones oldest first on a new root', async () => {
            mockOctokit.graphql
                .mockResolvedValueOnce(
                    page(2, [
                        node('tip123', '2026-10-12T08:00:00Z'),
                        node('d1', '2026-10-11T09:00:00Z'),
                        node('d6', '2026-10-06T09:00:00Z'),
                    ]),
                )
                .mockResolvedValueOnce({});

            await setupAndDeploy();

            // Normal push first — never forced
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
            // Cutoff = start of the UTC day 6 days ago: today plus the 6 previous days are kept
            expect(queryCalls()[0][1]).toMatchObject({
                oid: 'tip123',
                cutoff: '2026-10-06T00:00:00.000Z',
                olderUntil: '2026-10-05T23:59:59.000Z',
            });

            const created = mockOctokit.rest.git.createCommit.mock.calls.map(([args]) => args);
            expect(created.map((c) => [c.tree, c.parents])).toEqual([
                ['tree-d6', []],
                ['tree-d1', ['new-tree-d6']],
                ['tree-tip123', ['new-tree-d1']],
            ]);
            expect(created[0]).toMatchObject({
                message: 'Allure report d6',
                author: { name: 'ci', email: 'ci@x', date: '2026-10-06T09:00:00Z' },
                committer: { name: 'ci', email: 'ci@x', date: '2026-10-06T09:00:00Z' },
            });

            expect(mutationCalls()[0][1]).toEqual({
                repositoryId: 'repo-id',
                name: 'refs/heads/gh-pages',
                beforeOid: 'tip123',
                afterOid: 'new-tree-tip123',
            });
        });

        it('16:00 finds nothing older and only does the normal push', async () => {
            vi.setSystemTime(new Date('2026-10-12T16:00:00Z'));
            mockOctokit.graphql.mockResolvedValueOnce(page(0, [node('tip123', '2026-10-12T16:00:00Z')]));

            await setupAndDeploy();

            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
            expect(queryCalls()).toHaveLength(1);
            expect(mockOctokit.rest.git.createCommit).not.toHaveBeenCalled();
            expect(mutationCalls()).toHaveLength(0);
        });

        it('with 1 keeps only today', async () => {
            ioMock.commit_retention_days = 1;
            mockOctokit.graphql.mockResolvedValueOnce(page(0, []));

            await setupAndDeploy();

            expect(queryCalls()[0][1]).toMatchObject({ cutoff: '2026-10-12T00:00:00.000Z' });
        });

        it('pages through more than 100 kept commits', async () => {
            mockOctokit.graphql
                .mockResolvedValueOnce(page(5, [node('tip123', '2026-10-12T08:00:00Z')], 'cursor-1'))
                .mockResolvedValueOnce(page(5, [node('d3', '2026-10-09T09:00:00Z')]))
                .mockResolvedValueOnce({});

            await setupAndDeploy();

            expect(queryCalls()[1][1]).toMatchObject({ cursor: 'cursor-1' });
            const created = mockOctokit.rest.git.createCommit.mock.calls.map(([args]) => args.tree);
            expect(created).toEqual(['tree-d3', 'tree-tip123']);
        });

        it('skips with a warning when another deploy moved the branch meanwhile', async () => {
            mockOctokit.graphql
                .mockResolvedValueOnce(page(2, [node('tip123', '2026-10-12T08:00:00Z')]))
                .mockRejectedValueOnce(new Error('Expected refs/heads/gh-pages to point to tip123'));

            await expect(setupAndDeploy()).resolves.toBeUndefined();

            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Skipped pruning old commits'));
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
        });

        it('does not fail the deploy when the API is unavailable', async () => {
            mockOctokit.graphql.mockRejectedValueOnce(new Error('Resource not accessible by integration'));

            await expect(setupAndDeploy()).resolves.toBeUndefined();

            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Skipped pruning old commits'));
            expect(mockOctokit.rest.git.createCommit).not.toHaveBeenCalled();
        });

        it('never prunes the repository default branch', async () => {
            remoteDefaultBranch = 'gh-pages';

            await setupAndDeploy();

            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('default branch'));
            expect(mockOctokit.graphql).not.toHaveBeenCalled();
        });

        it('never prunes a branch serving Pages from a subfolder', async () => {
            await setupAndDeploy({ pagesSourcePath: 'docs' });

            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('/docs'));
            expect(mockOctokit.graphql).not.toHaveBeenCalled();
        });

        it('never prunes a branch that is new on the remote', async () => {
            mockGit.fetch.mockResolvedValueOnce({ branches: [] });

            await setupAndDeploy();

            expect(mockOctokit.graphql).not.toHaveBeenCalled();
        });

        it('keeps the cutoff stable until the UTC day ends', async () => {
            vi.setSystemTime(new Date(Date.parse('2026-10-12T00:00:00Z') + DAY - 1));
            mockOctokit.graphql.mockResolvedValueOnce(page(0, []));

            await setupAndDeploy();

            expect(queryCalls()[0][1]).toMatchObject({ cutoff: '2026-10-06T00:00:00.000Z' });
        });
    });

});
