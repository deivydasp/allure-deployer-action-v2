import { endGroup, error, info, setFailed, startGroup, warning } from '@actions/core';
import * as github from '@actions/github';
import { RequestError } from '@octokit/request-error';
import { existsSync } from 'fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises';
import path from 'node:path';
import normalizeUrl from 'normalize-url';
import { GithubStorage, GithubStorageConfig } from './features/github-storage.js';
import { GithubHost } from './features/hosting/github.host.js';
import { GitHubNotifier } from './features/messaging/github-notifier.js';
import inputs from './io.js';
import { ArtifactService, ArtifactServiceConfig } from './services/artifact.service.js';
import { GitHubConfig, GithubPagesService } from './services/github-pages.service.js';
import { GitHubService } from './services/github.service.js';
import {
    Allure,
    AllureConfig,
    ConsoleNotifier,
    copyFiles,
    ExecutorInterface,
    getReportStats,
    getTestDuration,
    HostingProvider,
    IStorage,
    NotificationData,
    Notifier,
    NotifyHandler,
    validateResultsPaths,
} from './shared/index.js';
import { buildSummaryTable, DeployMeta, RerunInfo, SummaryRow } from './utilities/summary-table.js';
import { copyDirectory } from './utilities/util.js';

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
        if (!inputs.prefix) {
            warning(
                "'prefix' is not set. The following features are disabled: " +
                'root summary page, redirect page, rerun tracking, and summary mode support.',
            );
        }

        const { owner, repo, pagesSourcePath, pagesUrl } = await validateGitHubPages();

        // reportDir with prefix == workspace/page-source-path/prefix/run-id
        // reportDir without a prefix == workspace/page-source-path/run-id
        const reportSubDir = path.join(pagesSourcePath, inputs.prefix ?? '', Date.now().toString());
        const reportDir = path.join(inputs.WORKSPACE, reportSubDir);
        const pageUrl = normalizeUrl(`${pagesUrl}/${reportSubDir}`);
        const host = getGitHubHost({
            token: inputs.github_token,
            owner,
            repo,
            pageUrl,
            reportDir,
            pagesSourcePath,
            workspace: inputs.WORKSPACE,
        });

        await mkdir(reportDir, { recursive: true, mode: 0o755 });

        const resultPaths = await validateResultsPaths(inputs.allure_results_path);
        const storage = inputs.show_history ? await initializeStorage(owner, repo) : undefined;
        const reportUrl = await stageDeployment({ host, storage, RESULTS_PATHS: resultPaths });
        const config: AllureConfig = {
            RESULTS_STAGING_PATH: inputs.RESULTS_STAGING_PATH,
            REPORTS_DIR: reportDir,
            HISTORY_PATH: inputs.HISTORY_PATH,
            historyLimit: inputs.keep,
            showHistory: inputs.show_history,
            reportName: inputs.report_name,
            reportLanguage: inputs.language,
        };
        const allure = new Allure({ config });
        await generateAllureReport({ allure, reportUrl });
        const wallClockDuration = await getTestDuration(inputs.RESULTS_STAGING_PATH);
        await writeDeployMeta(reportDir, wallClockDuration);
        const [reportStats] = await finalizeDeployment({ host, storage, reportDir });
        const rerunInfo = await detectReruns(reportDir, pagesUrl, pagesSourcePath);
        await sendNotifications({
            resultStatus: reportStats.statistic,
            reportUrl,
            environment: allure.readEnvironments(),
            reportName: inputs.report_name,
            duration: wallClockDuration,
            originalReportUrl: rerunInfo?.originalUrl,
            reruns: rerunInfo?.reruns,
        });
    } catch (e) {
        setFailed(`Deployment failed: ${e instanceof Error ? e.message : e}`);
    }
}

async function runSummaryMode() {
    try {
        const { owner, repo, pagesSourcePath, pagesUrl } = await validateGitHubPages();

        // Clone gh-pages (read-only)
        await mkdir(inputs.WORKSPACE, { recursive: true });
        const host = getGitHubHost({
            token: inputs.github_token,
            owner,
            repo,
            pageUrl: pagesUrl,
            reportDir: inputs.WORKSPACE,
            pagesSourcePath,
            workspace: inputs.WORKSPACE,
        });
        await host.init();

        // Scan prefixes and read summary.json from each
        const rootDir = path.join(inputs.WORKSPACE, pagesSourcePath);
        const rows = await scanPrefixSummaries(rootDir, pagesUrl, pagesSourcePath);

        if (rows.length === 0) {
            warning('No report summaries found on gh-pages. Skipping summary.');
            return;
        }

        const table = buildSummaryTable(rows);
        const githubService = new GitHubService();
        await githubService.updateSummary(table);
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

    const repoParts = inputs.github_pages_repo!.split('/');
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

    if (data.build_type !== 'legacy' || data.source?.branch !== inputs.github_pages_branch) {
        startGroup('Configuration Error');
        error(`GitHub Pages must be configured to deploy from '${inputs.github_pages_branch}' branch.`);
        error(`${github.context.serverUrl}/${inputs.github_pages_repo}/settings/pages`);
        endGroup();
        throw new Error(`GitHub Pages must be configured to deploy from '${inputs.github_pages_branch}' branch.`);
    }

    const pagesSourcePath = data.source!.path.startsWith('/') ? data.source!.path.slice(1) : data.source!.path;
    return { owner, repo, pagesSourcePath, pagesUrl: data.html_url! };
}

function getGitHubHost({
    token,
    owner,
    repo,
    reportDir,
    workspace,
    pageUrl,
    pagesSourcePath,
}: {
    token: string;
    owner: string;
    repo: string;
    reportDir: string;
    workspace: string;
    pageUrl: string;
    pagesSourcePath: string;
}): GithubHost {
    const branch = inputs.github_pages_branch!;
    const config: GitHubConfig = {
        owner,
        repo,
        workspace,
        token,
        branch,
        reportDir,
        pageUrl,
        pagesSourcePath,
    };
    return new GithubHost(new GithubPagesService(config));
}

async function initializeStorage(
    owner: string,
    repo: string,
): Promise<IStorage | undefined> {
    const config: ArtifactServiceConfig = {
        owner,
        repo,
        token: inputs.github_token,
    };
    const service = new ArtifactService(config);
    if (await service.hasArtifactReadPermission()) {
        const storageConfig: GithubStorageConfig = {
            ARCHIVE_DIR: inputs.ARCHIVE_DIR,
            RESULTS_STAGING_PATH: inputs.RESULTS_STAGING_PATH,
            HISTORY_PATH: inputs.HISTORY_PATH,
            fileProcessingConcurrency: inputs.fileProcessingConcurrency,
            showHistory: inputs.show_history,
        };
        return new GithubStorage(service, storageConfig);
    }
    warning(
        "GitHub token does not have 'actions: write' permission to access GitHub Artifacts. History will not be included in test reports",
    );
    return undefined;
}

async function stageDeployment({
    storage,
    host,
    RESULTS_PATHS,
}: {
    storage?: IStorage;
    host: HostingProvider;
    RESULTS_PATHS: string[];
}) {
    info('Staging files...');

    const copyResultsFiles = copyFiles({
        from: RESULTS_PATHS,
        to: inputs.RESULTS_STAGING_PATH,
        concurrency: inputs.fileProcessingConcurrency,
    });
    // host.init (git clone) and copyFiles run concurrently.
    // stageFilesFromStorage (artifact download + unzip) runs after both complete to avoid memory spikes on small runners.
    const result = await host.init();
    await copyResultsFiles;
    if (inputs.show_history) {
        await storage?.stageFilesFromStorage();
    }
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
        runAttempt: github.context.runAttempt,
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
    if (github.context.runAttempt <= 1 || !inputs.prefix) return undefined;

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
    storage,
    host,
    reportDir,
}: {
    storage?: IStorage;
    host: HostingProvider;
    reportDir: string;
}) {
    info('Finalizing deployment...');
    const result = await Promise.all([
        getReportStats(reportDir),
        host.deploy(),
        storage?.uploadArtifacts(),
        copyReportToCustomDir(reportDir),
    ]);
    info('Deployment finalized.');
    return result;
}

async function copyReportToCustomDir(reportDir: string): Promise<void> {
    if (inputs.custom_report_dir) {
        try {
            await copyDirectory(reportDir, inputs.custom_report_dir);
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
    } catch {
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

    const runs = await readdir(prefixDir).catch(() => [] as string[]);
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
 * Returns results sorted by attempt ascending.
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
            if (existsSync(metaPath)) {
                const raw = JSON.parse(await readFile(metaPath, 'utf8'));
                if (typeof raw.runId !== 'number' || typeof raw.runAttempt !== 'number') continue;
                if (raw.runId === runId) {
                    deployMetas.push({ dir, meta: raw as DeployMeta });
                    if (raw.runAttempt === 1) break;
                }
            }
        } catch {
            // skip unreadable meta
        }
    }
    return deployMetas.sort((a, b) => a.meta.runAttempt - b.meta.runAttempt);
}

/** Reads summary.json from a specific report directory (tries both single/multi-plugin paths). */
async function readSummaryFromDir(reportDir: string): Promise<any | undefined> {
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
async function findLatestSummary(prefixDir: string): Promise<any | undefined> {
    const runs = await readdir(prefixDir).catch(() => [] as string[]);
    const latestRunDir = runs
        .filter((r) => /^\d+$/.test(r))
        .sort((a, b) => Number(b) - Number(a))[0];
    if (!latestRunDir) return undefined;
    return readSummaryFromDir(path.join(prefixDir, latestRunDir));
}
