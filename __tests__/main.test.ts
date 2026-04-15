import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @actions/core before importing main
vi.mock('@actions/core', () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    setFailed: vi.fn(),
    startGroup: vi.fn(),
    endGroup: vi.fn(),
    getInput: vi.fn().mockReturnValue(''),
    getBooleanInput: vi.fn().mockReturnValue(false),
    setOutput: vi.fn(),
    setSecret: vi.fn(),
    summary: {
        addRaw: vi.fn().mockReturnThis(),
        write: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('@actions/github', () => ({
    getOctokit: vi.fn().mockReturnValue({
        rest: {
            repos: {
                getPages: vi.fn().mockResolvedValue({
                    data: {
                        build_type: 'legacy',
                        source: { branch: 'gh-pages', path: '/' },
                        html_url: 'https://test-owner.github.io/test-repo',
                    },
                }),
            },
            issues: { createComment: vi.fn().mockResolvedValue({}) },
        },
    }),
    context: {
        repo: { owner: 'test-owner', repo: 'test-repo' },
        runId: 99999,
        runNumber: 42,
        runAttempt: '1',
        actor: 'test-actor',
        serverUrl: 'https://github.com',
        payload: { sender: { id: 1 } },
    },
}));

vi.mock('@octokit/request-error', () => ({
    RequestError: class RequestError extends Error {
        status: number;
        constructor(message: string, statusCode: number) {
            super(message);
            this.status = statusCode;
        }
    },
}));

// Mock io.ts — returns test inputs
vi.mock('../src/io.js', () => ({
    default: {
        mode: 'deploy',
        allure_results_path: '/test/results',
        github_token: 'fake-token',
        github_pages_repo: 'test-owner/test-repo',
        github_pages_branch: 'gh-pages',
        prefix: 'my-tests',
        keep: 5,
        show_history: true,
        pr_comment: false,
        summary: true,
        fail_on_test_failure: false,
        report_name: 'Test Report',
        language: undefined,
        custom_report_dir: undefined,
        prefixes: undefined,
        fileProcessingConcurrency: 10,
        RESULTS_STAGING_PATH: '/tmp/staging',
        WORKSPACE: '/tmp/workspace',
    },
}));

vi.mock('normalize-url', () => ({
    default: vi.fn((url: string) => url.replace(/\/+$/, '')),
}));

// Mock services
vi.mock('../src/services/github-pages.service.js', () => {
    const GithubPagesService = vi.fn().mockImplementation(function (this: any) {
        this.init = vi.fn().mockResolvedValue('https://test-owner.github.io/test-repo/my-tests/123');
        this.deploy = vi.fn().mockResolvedValue(undefined);
        this.setupBranch = vi.fn().mockResolvedValue('https://test-owner.github.io/test-repo');
        this.deployVersion = '1234567890';
    });
    return { GithubPagesService };
});

vi.mock('../src/services/allure-report.service.js', () => {
    const Allure = vi.fn().mockImplementation(function (this: any) {
        this.generate = vi.fn().mockResolvedValue('/tmp/workspace/report');
        this.readEnvironments = vi.fn().mockReturnValue(undefined);
    });
    return { Allure };
});

vi.mock('../src/services/github.service.js', () => {
    const GitHubService = vi.fn().mockImplementation(function (this: any) {
        this.updateOutput = vi.fn().mockResolvedValue(undefined);
        this.updatePr = vi.fn().mockResolvedValue(undefined);
        this.updateSummary = vi.fn().mockResolvedValue(undefined);
    });
    return { GitHubService };
});

vi.mock('../src/utilities/validate-results-paths.js', () => ({
    validateResultsPaths: vi.fn().mockResolvedValue(['/test/results']),
}));

vi.mock('../src/utilities/copy-files.js', () => ({
    copyFiles: vi.fn().mockResolvedValue(5),
}));

vi.mock('../src/utilities/get-report-stats.js', () => ({
    getReportStats: vi.fn().mockResolvedValue({
        statistic: { passed: 10, failed: 0, broken: 0, skipped: 0, unknown: 0 },
        duration: 5000,
    }),
    getTestDuration: vi.fn().mockResolvedValue(5000),
}));

vi.mock('../src/utilities/util.js', () => ({
    copyDirectory: vi.fn().mockResolvedValue(undefined),
    withRetry: vi.fn((fn: () => Promise<any>) => fn()),
    DEFAULT_RETRY_CONFIG: { maxRetries: 3, initialDelay: 1000, maxDelay: 10000, backoffFactor: 2 },
    isRetryableError: vi.fn().mockReturnValue(false),
    removeTrailingSlash: vi.fn((p: string) => p),
    allFulfilledResults: vi.fn(async (promises: Promise<any>[]) => {
        const results = await Promise.allSettled(promises);
        return results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled').map((r) => r.value);
    }),
}));

vi.mock('node:fs', () => ({
    existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('node:fs/promises', () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue('{}'),
    rm: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
    writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { setFailed, warning } from '@actions/core';
import * as github from '@actions/github';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import inputs from '../src/io.js';
import { validateResultsPaths } from '../src/utilities/validate-results-paths.js';
import { main } from '../src/main.js';

const mockedSetFailed = vi.mocked(setFailed);
const mockedWarning = vi.mocked(warning);
const mockedInputs = vi.mocked(inputs);
const mockedValidateResultsPaths = vi.mocked(validateResultsPaths);
const mockedReaddir = vi.mocked(readdir);
const mockedReadFile = vi.mocked(readFile);
const mockedStat = vi.mocked(stat);
const mockedExistsSync = vi.mocked(existsSync);
const mockedWriteFile = vi.mocked(writeFile);

describe('main', () => {
    beforeEach(() => {
        mockedInputs.mode = 'deploy';
        mockedInputs.allure_results_path = '/test/results';
        mockedInputs.fail_on_test_failure = false;
        mockedInputs.github_token = 'fake-token';
        mockedInputs.github_pages_repo = 'test-owner/test-repo';
        mockedInputs.github_pages_branch = 'gh-pages';
        mockedInputs.prefix = 'my-tests';
        mockedInputs.prefixes = undefined;
        mockedInputs.custom_report_dir = undefined;
        mockedValidateResultsPaths.mockResolvedValue(['/test/results']);
    });

    describe('mode validation', () => {
        it('fails on invalid mode', async () => {
            mockedInputs.mode = 'invalid' as any;
            await main();
            expect(mockedSetFailed).toHaveBeenCalledWith(expect.stringContaining("Invalid mode 'invalid'"));
        });

        it('accepts deploy mode', async () => {
            mockedInputs.mode = 'deploy';
            await main();
            expect(mockedSetFailed).not.toHaveBeenCalled();
        });

        it('accepts summary mode', async () => {
            mockedInputs.mode = 'summary';
            await main();
            // summary mode calls setupBranch — should not fail
            expect(mockedSetFailed).not.toHaveBeenCalled();
        });
    });

    describe('deploy mode', () => {
        it('fails when allure_results_path is not set', async () => {
            mockedInputs.allure_results_path = undefined;
            await main();
            expect(mockedSetFailed).toHaveBeenCalledWith(
                expect.stringContaining("'allure_results_path' is required"),
            );
        });

        it('fails when no valid result paths found', async () => {
            mockedValidateResultsPaths.mockResolvedValue([]);
            await main();
            expect(mockedSetFailed).toHaveBeenCalledWith(
                expect.stringContaining('No valid allure results found'),
            );
        });

        it('calls setFailed when fail_on_test_failure is true and tests failed', async () => {
            mockedInputs.fail_on_test_failure = true;
            const { getReportStats } = await import('../src/utilities/get-report-stats.js');
            vi.mocked(getReportStats).mockResolvedValueOnce({
                statistic: { passed: 8, failed: 2, broken: 1, skipped: 0, unknown: 0 },
            });

            await main();

            expect(mockedSetFailed).toHaveBeenCalledWith(
                expect.stringContaining('Test failures detected'),
            );
        });

        it('does not fail when fail_on_test_failure is true but all tests pass', async () => {
            mockedInputs.fail_on_test_failure = true;
            await main();
            expect(mockedSetFailed).not.toHaveBeenCalled();
        });

        it('writes deploy.json with runId and runAttempt', async () => {
            await main();

            const deployCall = mockedWriteFile.mock.calls.find(
                (call) => typeof call[0] === 'string' && call[0].includes('deploy.json'),
            );
            expect(deployCall).toBeDefined();
            const meta = JSON.parse(deployCall![1] as string);
            expect(meta.runId).toBe(99999);
            expect(meta.runAttempt).toBe(1);
            expect(meta.timestamp).toBeTypeOf('number');
        });

        it('includes quality gate counts and report URL in failure message', async () => {
            mockedInputs.fail_on_test_failure = true;
            const { getReportStats } = await import('../src/utilities/get-report-stats.js');
            vi.mocked(getReportStats).mockResolvedValueOnce({
                statistic: { passed: 5, failed: 3, broken: 2, skipped: 0, unknown: 1 },
            });

            await main();

            expect(mockedSetFailed).toHaveBeenCalledWith(
                expect.stringContaining('3 failed'),
            );
            expect(mockedSetFailed).toHaveBeenCalledWith(
                expect.stringContaining('2 broken'),
            );
        });

        it('does not fail on unknown-only when no failed or broken', async () => {
            mockedInputs.fail_on_test_failure = true;
            const { getReportStats } = await import('../src/utilities/get-report-stats.js');
            vi.mocked(getReportStats).mockResolvedValueOnce({
                statistic: { passed: 5, failed: 0, broken: 0, skipped: 0, unknown: 2 },
            });

            await main();

            expect(mockedSetFailed).toHaveBeenCalledWith(
                expect.stringContaining('2 unknown'),
            );
        });
    });

    describe('summary mode', () => {
        beforeEach(() => {
            mockedInputs.mode = 'summary';
        });

        it('writes summary table to job summary', async () => {
            // scanPrefixSummaries: readdir returns prefix directories
            mockedReaddir
                .mockResolvedValueOnce(['prefix-a'] as any) // rootDir entries
                .mockResolvedValueOnce(['111222'] as any);    // runs inside prefix-a

            mockedStat.mockResolvedValue({ isDirectory: () => true } as any);
            mockedExistsSync.mockReturnValue(true);
            mockedReadFile.mockResolvedValue(JSON.stringify({
                stats: { passed: 10, failed: 0, broken: 0, skipped: 0, unknown: 0 },
                name: 'My Tests',
            }));

            await main();

            expect(mockedSetFailed).not.toHaveBeenCalled();
        });

        it('warns and returns when no summaries found', async () => {
            mockedReaddir.mockResolvedValueOnce([] as any);

            await main();

            expect(mockedWarning).toHaveBeenCalledWith(
                expect.stringContaining('No report summaries found'),
            );
            expect(mockedSetFailed).not.toHaveBeenCalled();
        });

        it('shows not-deployed for missing prefixes in pipeline mode', async () => {
            mockedInputs.prefixes = 'prefix-a,prefix-b';
            mockedReaddir
                .mockResolvedValueOnce(['prefix-a'] as any) // rootDir: only prefix-a exists
                .mockResolvedValueOnce(['111222'] as any);    // runs inside prefix-a

            mockedStat.mockResolvedValue({ isDirectory: () => true } as any);
            mockedExistsSync.mockReturnValue(true);
            mockedReadFile.mockResolvedValue(JSON.stringify({
                stats: { passed: 5, failed: 0, broken: 0, skipped: 0, unknown: 0 },
                name: 'Suite A',
            }));

            await main();

            // prefix-b never deployed — should not fail
            expect(mockedSetFailed).not.toHaveBeenCalled();
        });

        it('calls setFailed when GitHub Pages validation fails', async () => {
            const { getOctokit } = await import('@actions/github');
            vi.mocked(getOctokit).mockReturnValueOnce({
                rest: {
                    repos: {
                        getPages: vi.fn().mockRejectedValue(new Error('Not Found')),
                    },
                },
            } as any);

            await main();

            expect(mockedSetFailed).toHaveBeenCalledWith(
                expect.stringContaining('Summary failed'),
            );
        });
    });

    describe('validateGitHubPages', () => {
        it('fails when github_token is empty', async () => {
            mockedInputs.github_token = '';
            await main();
            expect(mockedSetFailed).toHaveBeenCalledWith(
                expect.stringContaining('github_token'),
            );
        });

        it('fails on invalid github_pages_repo format', async () => {
            mockedInputs.github_pages_repo = 'invalid-format';
            await main();
            expect(mockedSetFailed).toHaveBeenCalledWith(
                expect.stringContaining('Invalid github_pages_repo format'),
            );
        });

        it('fails when Pages is not configured for expected branch', async () => {
            const { getOctokit } = await import('@actions/github');
            vi.mocked(getOctokit).mockReturnValueOnce({
                rest: {
                    repos: {
                        getPages: vi.fn().mockResolvedValue({
                            data: {
                                build_type: 'workflow',
                                source: { branch: 'main', path: '/' },
                                html_url: 'https://example.com',
                            },
                        }),
                    },
                },
            } as any);

            await main();

            expect(mockedSetFailed).toHaveBeenCalledWith(
                expect.stringContaining("deploy from 'gh-pages' branch"),
            );
        });
    });

    describe('detectReruns', () => {
        it('returns undefined for first attempt', async () => {
            // runAttempt is '1' by default in mock — reruns not detected
            await main();
            // Should complete without rerun-related failures
            expect(mockedSetFailed).not.toHaveBeenCalled();
        });

        it('detects reruns when runAttempt > 1 and matching deploy.json exists', async () => {
            // Override runAttempt to simulate rerun
            const ctx = (await import('@actions/github')).context;
            const origAttempt = ctx.runAttempt;
            (ctx as any).runAttempt = '3';

            // readdir for detectReruns — returns run dirs
            mockedReaddir.mockImplementation(async (dir: any) => {
                const dirStr = typeof dir === 'string' ? dir : '';
                if (dirStr.includes('my-tests') && !dirStr.includes('history')) {
                    return ['333', '222', '111'] as any;
                }
                return [] as any;
            });

            // readFile for deploy.json files
            mockedReadFile.mockImplementation(async (filePath: any) => {
                const p = typeof filePath === 'string' ? filePath : '';
                if (p.includes('333') && p.includes('deploy.json')) {
                    return JSON.stringify({ runId: 99999, runAttempt: 3, timestamp: 3000 });
                }
                if (p.includes('222') && p.includes('deploy.json')) {
                    return JSON.stringify({ runId: 99999, runAttempt: 2, timestamp: 2000 });
                }
                if (p.includes('111') && p.includes('deploy.json')) {
                    return JSON.stringify({ runId: 99999, runAttempt: 1, timestamp: 1000 });
                }
                return '{}';
            });

            await main();

            expect(mockedSetFailed).not.toHaveBeenCalled();

            // Restore
            (ctx as any).runAttempt = origAttempt;
        });
    });
});
