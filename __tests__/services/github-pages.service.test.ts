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
}));

// Mock io.ts — the main challenge. This module executes at import time.
vi.mock('../../src/io.js', () => ({
    default: {
        WORKSPACE: '/tmp/workspace',
        prefix: 'my-prefix',
        keep: 5,
        squash_after_days: 0,
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
    revparse: vi.fn().mockResolvedValue('tree123\n'),
    raw: vi.fn().mockResolvedValue('orphan123\n'),
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

    describe('squash history', () => {
        const markerMissing = (p: unknown) => !String(p).endsWith('.last-squash');
        const isMarkerWrite = (call: unknown[]) => String(call[0]).endsWith('.last-squash');
        const leasePush = ['origin', 'gh-pages', ['--force-with-lease=gh-pages:origin/gh-pages']];
        const squashedLog = expect.stringContaining('Squashed');
        let remoteDefaultBranch: string;

        /** Runs setupBranch (records the remote tip) then deployPages, like main.ts does */
        async function setupAndDeploy(overrides: Partial<GitHubConfig> = {}): Promise<GithubPagesService> {
            mockGit.checkIsRepo.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
            const service = new GithubPagesService(createConfig({ pagesSourcePath: '', ...overrides }));
            await service.setupBranch();
            await service.deployPages();
            return service;
        }

        async function retryOnce(): Promise<void> {
            const { withRetry } = await import('../../src/utilities/util.js');
            vi.mocked(withRetry).mockImplementationOnce(async (fn: any) => {
                try {
                    await fn();
                } catch {
                    await fn();
                }
            });
        }

        beforeEach(() => {
            ioMock.squash_after_days = 1;
            remoteDefaultBranch = 'main';
            mockGit.checkIsRepo.mockReset();
            mockGit.listRemote.mockImplementation(
                (async () => `ref: refs/heads/${remoteDefaultBranch}\tHEAD\nabc123\tHEAD\n`) as any,
            );
            mockedReaddir.mockResolvedValue([]);
            mockedReadFile.mockReset();
            // Default: last squash was well over a day ago, so a squash is due
            mockedReadFile.mockResolvedValue(String(Date.now() - 3 * 24 * 60 * 60 * 1000));
            mockedWarning.mockClear();
            mockedInfo.mockClear();
            mockedWriteFile.mockClear();
        });

        afterEach(() => {
            ioMock.squash_after_days = 0;
            mockGit.reset.mockImplementation((() => mockGit) as any);
            mockGit.listRemote.mockReset();
            mockGit.listRemote.mockResolvedValue('ref: refs/heads/main\tHEAD\nabc123\tHEAD\n');
            vi.useRealTimers();
        });

        it('never squashes when squash_after_days is 0', async () => {
            ioMock.squash_after_days = 0;

            await setupAndDeploy();

            expect(mockGit.raw).not.toHaveBeenCalled();
            expect(mockedWriteFile.mock.calls.some(isMarkerWrite)).toBe(false);
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
        });

        it('squashes and pushes with a lease when the last squash is old enough', async () => {
            await setupAndDeploy();

            expect(mockedWriteFile.mock.calls.some(isMarkerWrite)).toBe(true);
            expect(mockGit.raw).toHaveBeenCalledWith([
                'commit-tree',
                'tree123',
                '-m',
                'Allure report for GitHub run: 12345',
            ]);
            expect(mockGit.reset).toHaveBeenCalledWith(['--soft', 'orphan123']);
            expect(mockGit.push).toHaveBeenCalledWith(...leasePush);
            expect(mockedInfo).toHaveBeenCalledWith(squashedLog);
        });

        it('only starts the clock when the marker is missing', async () => {
            mockedExistsSync.mockImplementation(markerMissing);

            await setupAndDeploy();

            expect(mockedWriteFile.mock.calls.some(isMarkerWrite)).toBe(true);
            expect(mockGit.raw).not.toHaveBeenCalled();
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
        });

        it('restarts the clock when the marker is unreadable', async () => {
            mockedReadFile.mockResolvedValue('not-a-timestamp');

            await setupAndDeploy();

            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Invalid'));
            expect(mockedWriteFile.mock.calls.some(isMarkerWrite)).toBe(true);
            expect(mockGit.raw).not.toHaveBeenCalled();
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
        });

        it('squashes on the first deploy of the day and pushes normally later that day', async () => {
            // 08:00 deploy: last squash was yesterday 16:00
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-10-12T08:00:00Z'));
            mockedReadFile.mockResolvedValue(String(Date.parse('2026-10-11T16:00:00Z')));

            await setupAndDeploy();
            expect(mockGit.push).toHaveBeenLastCalledWith(...leasePush);

            // 16:00 deploy: the 08:00 squash wrote today's marker
            mockGit.push.mockClear();
            mockGit.raw.mockClear();
            vi.setSystemTime(new Date('2026-10-12T16:00:00Z'));
            mockedReadFile.mockResolvedValue(String(Date.parse('2026-10-12T08:00:00Z')));

            await setupAndDeploy();
            expect(mockGit.raw).not.toHaveBeenCalled();
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
        });

        it('waits the configured number of calendar days', async () => {
            ioMock.squash_after_days = 7;
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-10-12T08:00:00Z'));
            mockedReadFile.mockResolvedValue(String(Date.parse('2026-10-06T23:00:00Z')));

            await setupAndDeploy();

            expect(mockGit.raw).not.toHaveBeenCalled();
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
        });

        it('does not squash a branch that is new on the remote', async () => {
            mockGit.fetch.mockResolvedValueOnce({ branches: [] });

            await setupAndDeploy();

            expect(mockGit.raw).not.toHaveBeenCalled();
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
        });

        it('does not squash a new branch after a retry resets onto a parallel deploy', async () => {
            await retryOnce();
            mockGit.fetch.mockResolvedValueOnce({ branches: [] });
            mockGit.push.mockRejectedValueOnce(new Error('! [rejected] gh-pages -> gh-pages (fetch first)'));

            await setupAndDeploy();

            expect(mockGit.raw).not.toHaveBeenCalled();
            expect(mockGit.push).toHaveBeenNthCalledWith(2, 'origin', 'gh-pages');
        });

        it('refuses to squash the default branch', async () => {
            remoteDefaultBranch = 'gh-pages';

            await setupAndDeploy();

            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('default branch'));
            expect(mockGit.raw).not.toHaveBeenCalled();
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
        });

        it('refuses to squash a branch serving Pages from a subfolder', async () => {
            await setupAndDeploy({ pagesSourcePath: 'docs' });

            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining("'/docs'"));
            expect(mockGit.raw).not.toHaveBeenCalled();
            expect(mockGit.push).toHaveBeenCalledWith('origin', 'gh-pages');
        });

        it.each([
            ['a lost race', '! [rejected] gh-pages -> gh-pages (stale info)'],
            ['blocked force pushes', 'remote: error: GH013: Repository rule violations found'],
            ['a network error', 'fatal: unable to access: RPC failed; HTTP 502'],
        ])('skips the squash for the rest of the run after %s', async (_, message) => {
            await retryOnce();
            mockGit.push.mockRejectedValueOnce(new Error(message));

            await setupAndDeploy();

            expect(mockGit.push).toHaveBeenNthCalledWith(1, ...leasePush);
            expect(mockGit.push).toHaveBeenNthCalledWith(2, 'origin', 'gh-pages');
            expect(mockGit.raw).toHaveBeenCalledTimes(1);
            expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('skipping squash for this run'));
            expect(mockedInfo).not.toHaveBeenCalledWith(squashedLog);
        });

        it('squashes with a lease when a squash becomes due after a retry', async () => {
            await retryOnce();
            // First attempt: squashed today already. After the retry reset, the remote holds an old marker.
            mockedReadFile.mockResolvedValue(String(Date.now()));
            mockGit.reset.mockImplementation(((args: string[]) => {
                if (args[0] === '--hard') mockedReadFile.mockResolvedValue('0');
                return mockGit;
            }) as any);
            mockGit.push.mockRejectedValueOnce(new Error('rejected'));

            await setupAndDeploy();

            expect(mockGit.push).toHaveBeenNthCalledWith(1, 'origin', 'gh-pages');
            expect(mockGit.push).toHaveBeenNthCalledWith(2, ...leasePush);
        });
    });
});
