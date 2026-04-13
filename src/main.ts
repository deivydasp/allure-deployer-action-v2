import { endGroup, error, info, setFailed, startGroup, warning } from '@actions/core';
import * as github from '@actions/github';
import { RequestError } from '@octokit/request-error';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import normalizeUrl from 'normalize-url';
import { ExecutorInterface } from './interfaces/executor.interface.js';
import { HostingProvider } from './interfaces/hosting-provider.interface.js';
import { NotificationData } from './interfaces/notification-data.js';
import { Notifier } from './interfaces/notifier.interface.js';
import { ReportStatistic } from './interfaces/report-statistic.js';
import inputs from './io.js';
import { ConsoleNotifier } from './notifiers/console.notifier.js';
import { GitHubNotifier } from './notifiers/github.notifier.js';
import { NotifyHandler } from './notifiers/notify-handler.js';
import { Allure, AllureConfig } from './services/allure-report.service.js';
import { GitHubConfig, GithubPagesService } from './services/github-pages.service.js';
import { GitHubService } from './services/github.service.js';
import { copyFiles } from './utilities/copy-files.js';
import { getReportStats, getTestDuration } from './utilities/get-report-stats.js';
import { buildSummaryTable, DeployMeta, RerunInfo, SummaryRow } from './utilities/summary-table.js';
import { copyDirectory } from './utilities/util.js';
import { validateResultsPaths } from './utilities/validate-results-paths.js';

export async function main() {
    if (inputs.mode !== 'deploy' && inputs.mode !== 'summary') {
        setFailed(`Invalid mode '${inputs.mode}'. Expected 'deploy' or 'summary'.`);
        return;
    }
    if (inputs.mode === 'summary') {
        await runSummaryMode();
    } else {
        await runDeployMode();
    }
}

async function runDeployMode() {
    try {
        if (!inputs.allure_results_path) {
            throw new Error("'allure_results_path' is required in deploy mode");
        }
        const { owner, repo, pagesSourcePath, pagesUrl } = await validateGitHubPages();

        // reportDir == workspace/page-source-path/prefix/run-id
        const reportSubDir = path.join(pagesSourcePath, inputs.prefix ?? '', Date.now().toString());
        const reportDir = path.join(inputs.WORKSPACE, reportSubDir);
        const pageUrl = normalizeUrl(`${pagesUrl}/${reportSubDir}`);
        // History lives on gh-pages at {prefix}/history/history.jsonl
        const historyDir = path.join(inputs.WORKSPACE, pagesSourcePath, inputs.prefix ?? '', 'history');
        const historyPath = path.join(historyDir, 'history.jsonl');

        const ghPages = createGitHubPagesService({
            token: inputs.github_token,
            owner,
            repo,
            pageUrl,
            reportDir,
            pagesSourcePath,
            historyPath: inputs.show_history ? historyPath : undefined,
        });

        await mkdir(reportDir, { recursive: true, mode: 0o755 });

        const resultPaths = await validateResultsPaths(inputs.allure_results_path);
        if (resultPaths.length === 0) {
            throw new Error(`No valid allure results found at: ${inputs.allure_results_path}`);
        }
        const reportUrl = await stageDeployment({ host: ghPages, RESULTS_PATHS: resultPaths });

        if (inputs.show_history) {
            await mkdir(historyDir, { recursive: true });
        }

        const config: AllureConfig = {
            RESULTS_STAGING_PATH: inputs.RESULTS_STAGING_PATH,
            REPORTS_DIR: reportDir,
            HISTORY_PATH: historyPath,
            historyLimit: inputs.keep,
            showHistory: inputs.show_history,
            reportName: inputs.report_name,
            reportLanguage: inputs.language,
        };
        const allure = new Allure({ config });
        await generateAllureReport({ allure, reportUrl });
        const wallClockDuration = await getTestDuration(inputs.RESULTS_STAGING_PATH);
        await writeDeployMeta(reportDir, wallClockDuration);
        const reportStats = await getReportStats(reportDir);
        await finalizeDeployment({ host: ghPages, reportDir });
        const rerunInfo = await detectReruns(reportDir, pagesUrl, pagesSourcePath);
        await sendNotifications({
            resultStatus: reportStats.statistic,
            reportUrl,
            environment: allure.readEnvironments(),
            reportName: inputs.report_name,
            duration: wallClockDuration,
            originalReportUrl: rerunInfo?.originalUrl,
            reruns: rerunInfo?.reruns,
            summaryPageUrl: inputs.prefix
                ? normalizeUrl(pagesUrl) + (ghPages.deployVersion ? `?v=${ghPages.deployVersion}` : '')
                : undefined,
        });

        if (inputs.fail_on_test_failure) {
            const { failed, broken, unknown } = reportStats.statistic;
            if (failed > 0 || broken > 0 || unknown > 0) {
                setFailed(`Test failures detected: ${failed} failed, ${broken} broken, ${unknown} unknown. Report: ${reportUrl}`);
            }
        }
    } catch (e) {
        setFailed(`Deployment failed: ${e instanceof Error ? e.message : e}`);
    }
}

async function runSummaryMode() {
    try {
        const { owner, repo, pagesSourcePath, pagesUrl } = await validateGitHubPages();

        // Clone gh-pages (read-only)
        await mkdir(inputs.WORKSPACE, { recursive: true });
        const ghPages = createGitHubPagesService({
            token: inputs.github_token,
            owner,
            repo,
            pageUrl: pagesUrl,
            reportDir: inputs.WORKSPACE,
            pagesSourcePath,
        });
        await ghPages.setupBranch();

        // Scan prefixes and read summary.json from each
        const rootDir = path.join(inputs.WORKSPACE, pagesSourcePath);
        const rows = await scanPrefixSummaries(rootDir, pagesUrl, pagesSourcePath);

        if (rows.length === 0) {
            warning('No report summaries found on gh-pages. Skipping summary.');
            return;
        }

        rows.sort((a, b) => (a.notDeployed ? 1 : 0) - (b.notDeployed ? 1 : 0));
        const table = buildSummaryTable(rows);
        const summaryPageLink = `<img src="https://raw.githubusercontent.com/deivydasp/allure-deployer-action-v2/master/assets/allure-logo.svg" width="20" height="20" align="absmiddle" />&nbsp;&nbsp;<a href="${normalizeUrl(pagesUrl)}">Summary Page</a>`;
        const message = `${summaryPageLink}\n\n${table}`;
        const githubService = new GitHubService();
        await githubService.updateSummary(message);
        info(`Summary table written with ${rows.length} report(s).`);
    } catch (e) {
        setFailed(`Summary failed: ${e instanceof Error ? e.message : e}`);
    }
}

async function validateGitHubPages() {
    const token = inputs.github_token;
    if (!token) {
        throw new Error("Github Pages require a valid 'github_token'");
    }

    const repoParts = inputs.github_pages_repo.split('/');
    if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
        throw new Error(`Invalid github_pages_repo format. Expected 'owner/repo', got '${inputs.github_pages_repo}'`);
    }
    const [owner, repo] = repoParts;
    const { data } = await github
        .getOctokit(token)
        .rest.repos.getPages({ owner, repo })
        .catch((e: any) => {
            if (e instanceof RequestError) {
                throw new Error(e.message);
            }
            throw e;
        });

    const expectedBranch = inputs.github_pages_branch ?? 'gh-pages';
    if (data.build_type !== 'legacy' || data.source?.branch !== expectedBranch) {
        startGroup('Configuration Error');
        error(`GitHub Pages must be configured to deploy from '${expectedBranch}' branch.`);
        error(`${github.context.serverUrl}/${inputs.github_pages_repo}/settings/pages`);
        endGroup();
        throw new Error(`GitHub Pages must be configured to deploy from '${expectedBranch}' branch.`);
    }

    if (!data.source?.path || !data.html_url) {
        throw new Error('GitHub Pages API returned incomplete data (missing source path or URL). Is Pages fully configured?');
    }

    const pagesSourcePath = data.source.path.startsWith('/') ? data.source.path.slice(1) : data.source.path;
    return { owner, repo, pagesSourcePath, pagesUrl: data.html_url };
}

function createGitHubPagesService({
    token,
    owner,
    repo,
    reportDir,
    pageUrl,
    pagesSourcePath,
    historyPath,
}: Omit<GitHubConfig, 'branch'>): GithubPagesService {
    const branch = inputs.github_pages_branch ?? 'gh-pages';
    const config: GitHubConfig = {
        owner,
        repo,
        token,
        branch,
        reportDir,
        pageUrl,
        pagesSourcePath,
        historyPath,
    };
    return new GithubPagesService(config);
}

async function stageDeployment({
    host,
    RESULTS_PATHS,
}: {
    host: HostingProvider;
    RESULTS_PATHS: string[];
}) {
    info('Staging files...');

    // host.init (git clone) and copyFiles run concurrently.
    // After clone, history is already available on disk at {prefix}/history/history.jsonl.
    const [result] = await Promise.all([
        host.init(),
        copyFiles({
            from: RESULTS_PATHS,
            to: inputs.RESULTS_STAGING_PATH,
            concurrency: inputs.fileProcessingConcurrency,
        }),
    ]);
    info('Files staged successfully.');
    return result;
}

async function generateAllureReport({ allure, reportUrl }: { allure: Allure; reportUrl?: string }) {
    info('Generating Allure report...');
    await allure.generate(createExecutor(reportUrl));
    info('Report generated successfully!');
}

async function writeDeployMeta(reportDir: string, wallClockDuration?: number): Promise<void> {
    const meta: DeployMeta = {
        runId: github.context.runId,
        runAttempt: Number(github.context.runAttempt) || 1,
        wallClockDuration,
        timestamp: Date.now(),
    };
    await writeFile(path.join(reportDir, 'deploy.json'), JSON.stringify(meta), 'utf8');
}

/**
 * Detects previous attempts for the current runId by scanning deploy.json files
 * in the prefix directory. Returns rerun info if this is attempt > 1.
 */
async function detectReruns(
    reportDir: string,
    pagesUrl: string,
    pagesSourcePath: string,
): Promise<{ originalUrl: string; reruns: RerunInfo[] } | undefined> {
    // Rerun tracking requires prefix (for URL construction) and attempt > 1
    const runAttempt = Number(github.context.runAttempt);
    if (!runAttempt || runAttempt <= 1 || !inputs.prefix) return undefined;

    try {
        const prefixDir = path.dirname(reportDir);
        const runs = await readdir(prefixDir);
        const runDirs = runs
            .filter((r) => /^\d+$/.test(r))
            .sort((a, b) => Number(b) - Number(a));

        const deployMetas = await findDeployMetasForRun(prefixDir, runDirs, github.context.runId);
        if (deployMetas.length <= 1) return undefined;

        deployMetas.sort((a, b) => a.meta.runAttempt - b.meta.runAttempt);

        const originalDir = path.join(pagesSourcePath, inputs.prefix, deployMetas[0].dir);
        const originalUrl = normalizeUrl(`${pagesUrl}/${originalDir}`);

        const reruns: RerunInfo[] = [];
        for (let i = 1; i < deployMetas.length; i++) {
            const rerunDir = path.join(pagesSourcePath, inputs.prefix, deployMetas[i].dir);
            reruns.push({
                attempt: deployMetas[i].meta.runAttempt,
                url: normalizeUrl(`${pagesUrl}/${rerunDir}`),
            });
        }

        return { originalUrl, reruns };
    } catch (e) {
        warning(`Failed to detect reruns: ${e}`);
        return undefined;
    }
}

function createExecutor(reportUrl?: string): ExecutorInterface {
    const buildName = `GitHub Run ID: ${github.context.runId}`;
    const reportName = inputs.report_name;
    return {
        reportName,
        name: 'Allure Deployer Action',
        reportUrl,
        buildUrl: createGitHubBuildUrl(),
        buildName,
        buildOrder: github.context.runNumber,
        type: 'github',
    };
}

function createGitHubBuildUrl(): string {
    const { context } = github;
    return normalizeUrl(
        `${github.context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
    );
}

async function finalizeDeployment({
    host,
    reportDir,
}: {
    host: HostingProvider;
    reportDir: string;
}) {
    info('Finalizing deployment...');
    // Copy report before deploy — deploy's push retry does git reset --hard which wipes the working tree
    await copyReportToCustomDir(reportDir);
    await host.deploy();
    info('Deployment finalized.');
}

async function copyReportToCustomDir(reportDir: string): Promise<void> {
    if (inputs.custom_report_dir) {
        try {
            await copyDirectory(reportDir, path.resolve(inputs.custom_report_dir));
        } catch (e) {
            error(`${e}`);
        }
    }
}

async function sendNotifications(data: NotificationData) {
    const notifiers: Notifier[] = [new ConsoleNotifier()];
    const token = inputs.github_token;
    const prNumber = github.context.payload.pull_request?.number;
    const prComment = inputs.pr_comment;
    const githubNotifierClient = new GitHubService();
    notifiers.push(
        new GitHubNotifier({ client: githubNotifierClient, token, prNumber, prComment, writeSummary: inputs.summary }),
    );
    await new NotifyHandler(notifiers).sendNotifications(data);
}

async function scanPrefixSummaries(
    rootDir: string,
    pagesUrl: string,
    pagesSourcePath: string,
): Promise<SummaryRow[]> {
    const rows: SummaryRow[] = [];

    let dirEntries: string[];
    try {
        dirEntries = await readdir(rootDir);
    } catch (e) {
        warning(`Failed to read root directory '${rootDir}': ${e}`);
        return rows;
    }

    // Determine which prefixes to scan and whether to show "not deployed" indicators
    const requestedPrefixes = inputs.prefixes
        ? inputs.prefixes.split(',').map((p) => p.trim()).filter(Boolean)
        : undefined;

    // In pipeline mode (prefixes specified), iterate requested prefixes — some may not exist on gh-pages.
    // In standalone mode, iterate existing directories only.
    const prefixNames = requestedPrefixes ?? dirEntries;

    for (const prefixName of prefixNames) {
        // Case-insensitive match to find actual directory name on disk
        const dirName = dirEntries.find((e) => e.toLowerCase() === prefixName.toLowerCase());

        if (dirName) {
            const prefixDir = path.join(rootDir, dirName);
            const row = await scanSinglePrefix(prefixDir, dirName, pagesUrl, pagesSourcePath);
            if (row) {
                rows.push(row);
                continue;
            }
            // Pipeline mode: prefix exists but not deployed in this run
            if (requestedPrefixes) {
                const summary = await findLatestSummary(prefixDir);
                rows.push({ reportName: summary?.name ?? prefixName, notDeployed: true });
            }
        } else if (requestedPrefixes) {
            // Pipeline mode: prefix never deployed
            rows.push({ reportName: prefixName, notDeployed: true });
        }
    }
    return rows;
}

async function scanSinglePrefix(
    prefixDir: string,
    dirName: string,
    pagesUrl: string,
    pagesSourcePath: string,
): Promise<SummaryRow | undefined> {
    const entryStat = await stat(prefixDir).catch(() => null);
    if (!entryStat?.isDirectory()) return undefined;

    const runs = await readdir(prefixDir).catch((e: unknown) => {
        warning(`Failed to read prefix directory '${dirName}': ${e}`);
        return [] as string[];
    });
    const runDirs = runs
        .filter((r) => /^\d+$/.test(r))
        .sort((a, b) => Number(b) - Number(a));

    if (runDirs.length === 0) return undefined;

    const deployMetas = await findDeployMetasForRun(prefixDir, runDirs, github.context.runId);

    deployMetas.sort((a, b) => a.meta.runAttempt - b.meta.runAttempt);

    // If prefixes were specified (pipeline mode) and no deploy.json matches, report as not deployed
    if (inputs.prefixes && deployMetas.length === 0) return undefined;

    // Use latest attempt for stats, or latest run dir if no meta matches
    const primaryDir = deployMetas.length > 0 ? deployMetas[deployMetas.length - 1].dir : runDirs[0];
    const primaryMeta = deployMetas.length > 0 ? deployMetas[deployMetas.length - 1].meta : undefined;

    const summary = await readSummaryFromDir(path.join(prefixDir, primaryDir));
    if (!summary) return undefined;

    const summaryStats = summary.stats ?? summary.statistic;
    if (!summaryStats) return undefined;

    // Build rerun links
    const reruns: RerunInfo[] = [];
    if (deployMetas.length > 1) {
        for (let i = 1; i < deployMetas.length; i++) {
            const rerunDir = path.join(pagesSourcePath, dirName, deployMetas[i].dir);
            reruns.push({
                attempt: deployMetas[i].meta.runAttempt,
                url: normalizeUrl(`${pagesUrl}/${rerunDir}`),
            });
        }
    }

    // Use first attempt as Report link when reruns exist, otherwise latest
    const reportDir = deployMetas.length > 1
        ? path.join(pagesSourcePath, dirName, deployMetas[0].dir)
        : path.join(pagesSourcePath, dirName, primaryDir);

    return {
        reportName: summary.name ?? dirName,
        reportUrl: normalizeUrl(`${pagesUrl}/${reportDir}`),
        stats: {
            passed: summaryStats.passed ?? 0,
            broken: summaryStats.broken ?? 0,
            failed: summaryStats.failed ?? 0,
            skipped: summaryStats.skipped ?? 0,
            unknown: summaryStats.unknown ?? 0,
        },
        duration: primaryMeta?.wallClockDuration,
        reruns: reruns.length > 0 ? reruns : undefined,
    };
}

/**
 * Scans run directories for deploy.json files matching a specific runId.
 * Stops early once attempt 1 is found (dirs are sorted newest-first).
 * Results are unsorted — callers are responsible for ordering.
 */
async function findDeployMetasForRun(
    prefixDir: string,
    runDirs: string[],
    runId: number,
): Promise<{ dir: string; meta: DeployMeta }[]> {
    const deployMetas: { dir: string; meta: DeployMeta }[] = [];
    for (const dir of runDirs) {
        const metaPath = path.join(prefixDir, dir, 'deploy.json');
        try {
            const raw = JSON.parse(await readFile(metaPath, 'utf8'));
            if (typeof raw.runId !== 'number' || typeof raw.runAttempt !== 'number') continue;
            if (raw.runId === runId) {
                deployMetas.push({ dir, meta: raw as DeployMeta });
                if (raw.runAttempt === 1) break;
            }
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                warning(`Failed to read deploy.json in ${dir}: ${e}`);
            }
        }
    }
    return deployMetas;
}

interface SummaryJson {
    name?: string;
    stats?: ReportStatistic;
    statistic?: ReportStatistic;
}

/** Reads summary.json from a specific report directory (tries both single/multi-plugin paths). */
async function readSummaryFromDir(reportDir: string): Promise<SummaryJson | undefined> {
    for (const candidate of ['summary.json', 'awesome/summary.json']) {
        const summaryPath = path.join(reportDir, candidate);
        if (!existsSync(summaryPath)) continue;
        try {
            return JSON.parse(await readFile(summaryPath, 'utf8'));
        } catch (e) {
            warning(`Failed to read ${summaryPath}: ${e}`);
        }
    }
    return undefined;
}

/** Finds the latest run directory under a prefix and reads its summary.json. */
async function findLatestSummary(prefixDir: string): Promise<SummaryJson | undefined> {
    const runs = await readdir(prefixDir).catch((e: unknown) => {
        warning(`Failed to read directory for latest summary: ${e}`);
        return [] as string[];
    });
    const latestRunDir = runs
        .filter((r) => /^\d+$/.test(r))
        .sort((a, b) => Number(b) - Number(a))[0];
    if (!latestRunDir) return undefined;
    return readSummaryFromDir(path.join(prefixDir, latestRunDir));
}
