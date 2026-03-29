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
        await sendNotifications({
            resultStatus: reportStats.statistic,
            reportUrl,
            environment: allure.readEnvironments(),
            reportName: inputs.report_name,
            duration: wallClockDuration,
        });
    } catch (e) {
        setFailed(`Deployment failed: ${e instanceof Error ? e.message : e}`);
    }
}

async function runSummaryMode() {
    try {
        const { owner, repo, pagesSourcePath, pagesUrl } = await validateGitHubPages();

        // Clone gh-pages (read-only)
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
    const currentRunId = github.context.runId;

    let entries: string[];
    try {
        entries = await readdir(rootDir);
    } catch {
        return rows;
    }

    // Determine which prefixes to scan
    const requestedPrefixes = inputs.prefixes
        ? inputs.prefixes.split(',').map((p) => p.trim()).filter(Boolean)
        : undefined;
    const pipelineMode = !!requestedPrefixes;

    // In pipeline mode, iterate requested prefixes (some may not exist on gh-pages)
    // In standalone mode, iterate existing directories
    const prefixNames = requestedPrefixes ?? entries;

    for (const entryName of prefixNames) {
        if (!requestedPrefixes && !entries.includes(entryName)) continue;

        const prefixDir = path.join(rootDir, entryName);
        const entryStat = await stat(prefixDir).catch(() => null);

        if (!entryStat?.isDirectory()) {
            // Prefix directory doesn't exist on gh-pages
            if (pipelineMode) {
                rows.push({
                    reportName: entryName,
                    stats: { passed: 0, broken: 0, failed: 0, skipped: 0, unknown: 0 },
                    notDeployed: true,
                });
            }
            continue;
        }

        // Find all numeric run dirs (newest first)
        const runs = await readdir(prefixDir).catch(() => [] as string[]);
        const runDirs = runs
            .filter((r) => /^\d+$/.test(r))
            .sort((a, b) => Number(b) - Number(a));

        if (runDirs.length === 0) {
            if (pipelineMode) {
                rows.push({
                    reportName: entryName,
                    stats: { passed: 0, broken: 0, failed: 0, skipped: 0, unknown: 0 },
                    notDeployed: true,
                });
            }
            continue;
        }

        // Read deploy.json from run dirs to find runs matching current runId.
        // Stop early once we find attempt 1 (dirs are sorted newest-first,
        // so once we hit the original attempt there can't be older ones for this run).
        const deployMetas: { dir: string; meta: DeployMeta }[] = [];
        for (const dir of runDirs) {
            const metaPath = path.join(prefixDir, dir, 'deploy.json');
            try {
                if (existsSync(metaPath)) {
                    const raw = JSON.parse(await readFile(metaPath, 'utf8'));
                    if (typeof raw.runId !== 'number' || typeof raw.runAttempt !== 'number') continue;
                    const meta: DeployMeta = raw;
                    if (meta.runId === currentRunId) {
                        deployMetas.push({ dir, meta });
                        if (meta.runAttempt === 1) break; // found the original, no need to go further
                    }
                }
            } catch {
                // skip unreadable meta
            }
        }

        // Sort by attempt (ascending): attempt 1 is the "Report", rest are "Rerun #N"
        deployMetas.sort((a, b) => a.meta.runAttempt - b.meta.runAttempt);

        // In pipeline mode, if no deploy.json matches current runId, the job was likely cancelled/skipped
        if (pipelineMode && deployMetas.length === 0) {
            rows.push({
                reportName: entryName,
                stats: { passed: 0, broken: 0, failed: 0, skipped: 0, unknown: 0 },
                notDeployed: true,
            });
            continue;
        }

        // Use the latest run dir for stats (either latest from current runId, or just the latest overall)
        const primaryDir = deployMetas.length > 0 ? deployMetas[deployMetas.length - 1].dir : runDirs[0];
        const primaryMeta = deployMetas.length > 0 ? deployMetas[deployMetas.length - 1].meta : undefined;

        const latestDir = path.join(prefixDir, primaryDir);
        for (const candidate of ['summary.json', 'awesome/summary.json']) {
            const summaryPath = path.join(latestDir, candidate);
            if (!existsSync(summaryPath)) continue;
            try {
                const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
                const summaryStats = summary.stats ?? summary.statistic;
                if (!summaryStats) continue;

                const reportSubDir = path.join(pagesSourcePath, entryName, primaryDir);

                // Build rerun links from earlier attempts
                const reruns: RerunInfo[] = [];
                if (deployMetas.length > 1) {
                    // First attempt is the "Report" link; subsequent are reruns
                    for (let i = 1; i < deployMetas.length; i++) {
                        const rerunDir = path.join(pagesSourcePath, entryName, deployMetas[i].dir);
                        reruns.push({
                            attempt: deployMetas[i].meta.runAttempt,
                            url: normalizeUrl(`${pagesUrl}/${rerunDir}`),
                        });
                    }
                }

                // Use first attempt as the Report link when reruns exist
                const reportDir =
                    deployMetas.length > 1
                        ? path.join(pagesSourcePath, entryName, deployMetas[0].dir)
                        : reportSubDir;

                rows.push({
                    reportName: summary.name ?? entryName,
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
                });
                break;
            } catch (e) {
                warning(`Failed to read summary for prefix '${entryName}': ${e}`);
            }
        }
    }
    return rows;
}
