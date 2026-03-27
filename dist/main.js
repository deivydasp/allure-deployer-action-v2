import { endGroup, error, info, setFailed, startGroup, warning } from '@actions/core';
import * as github from '@actions/github';
import { RequestError } from '@octokit/request-error';
import { mkdir } from 'fs/promises';
import path from 'node:path';
import normalizeUrl from 'normalize-url';
import { GithubStorage } from './features/github-storage.js';
import { GithubHost } from './features/hosting/github.host.js';
import { GitHubNotifier } from './features/messaging/github-notifier.js';
import inputs from './io.js';
import { ArtifactService } from './services/artifact.service.js';
import { GithubPagesService } from './services/github-pages.service.js';
import { GitHubService } from './services/github.service.js';
import { Allure, ConsoleNotifier, copyFiles, getReportStats, NotifyHandler, validateResultsPaths, } from './shared/index.js';
import { copyDirectory } from './utilities/util.js';
export async function main() {
    await executeDeployment();
}
async function executeDeployment() {
    try {
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
            .rest.repos.getPages({
            owner,
            repo,
        })
            .catch((e) => {
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
        const pagesSourcePath = data.source.path.startsWith('/') ? data.source.path.slice(1) : data.source.path;
        // reportDir with prefix == workspace/page-source-path/prefix/run-id
        // reportDir without a prefix == workspace/page-source-path/run-id
        const reportSubDir = path.join(pagesSourcePath, inputs.prefix ?? '', Date.now().toString());
        const reportDir = path.join(inputs.WORKSPACE, reportSubDir);
        const pageUrl = normalizeUrl(`${data.html_url}/${reportSubDir}`);
        const host = getGitHubHost({
            token,
            owner,
            repo,
            pageUrl,
            reportDir,
            pagesSourcePath,
            workspace: inputs.WORKSPACE,
        });
        await mkdir(reportDir, { recursive: true, mode: 0o755 });
        const resultPaths = await validateResultsPaths(inputs.allure_results_path);
        const storage = inputs.show_history ? await initializeStorage(owner, repo, reportDir) : undefined;
        const reportUrl = await stageDeployment({ host, storage, RESULTS_PATHS: resultPaths });
        const config = {
            RESULTS_STAGING_PATH: inputs.RESULTS_STAGING_PATH,
            REPORTS_DIR: reportDir,
            reportName: inputs.report_name,
        };
        const allure = new Allure({ config });
        await generateAllureReport({ allure, reportUrl });
        const [resultsStats] = await finalizeDeployment({ host, storage, reportDir });
        await sendNotifications(resultsStats, reportUrl, allure.environments);
    }
    catch (e) {
        setFailed(`Deployment failed: ${e instanceof Error ? e.message : e}`);
    }
}
function getGitHubHost({ token, owner, repo, reportDir, workspace, pageUrl, pagesSourcePath, }) {
    const branch = inputs.github_pages_branch;
    const config = {
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
async function initializeStorage(owner, repo, reportDir) {
    const config = {
        owner,
        repo,
        token: inputs.github_token,
    };
    const service = new ArtifactService(config);
    if (await service.hasArtifactReadPermission()) {
        const storageConfig = {
            ARCHIVE_DIR: inputs.ARCHIVE_DIR,
            REPORTS_DIR: reportDir,
            RESULTS_STAGING_PATH: inputs.RESULTS_STAGING_PATH,
            fileProcessingConcurrency: inputs.fileProcessingConcurrency,
            showHistory: inputs.show_history,
        };
        return new GithubStorage(service, storageConfig);
    }
    warning("GitHub token does not have 'actions: write' permission to access GitHub Artifacts. History will not be included in test reports");
    return undefined;
}
async function stageDeployment({ storage, host, RESULTS_PATHS, }) {
    info('Staging files...');
    const copyResultsFiles = copyFiles({
        from: RESULTS_PATHS,
        to: inputs.RESULTS_STAGING_PATH,
        concurrency: inputs.fileProcessingConcurrency,
    });
    //run sequentially to avoid memory spikes
    const result = await host.init();
    await copyResultsFiles;
    if (inputs.show_history) {
        await storage?.stageFilesFromStorage();
    }
    info('Files staged successfully.');
    return result;
}
async function generateAllureReport({ allure, reportUrl }) {
    info('Generating Allure report...');
    const result = await allure.generate(createExecutor(reportUrl));
    info('Report generated successfully!');
    return result;
}
function createExecutor(reportUrl) {
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
function createGitHubBuildUrl() {
    const { context } = github;
    return normalizeUrl(`${github.context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`);
}
async function finalizeDeployment({ storage, host, reportDir, }) {
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
async function copyReportToCustomDir(reportDir) {
    if (inputs.custom_report_dir) {
        try {
            await copyDirectory(reportDir, inputs.custom_report_dir);
        }
        catch (e) {
            error(`${e}`);
        }
    }
}
async function sendNotifications(resultStatus, reportUrl, environment) {
    const notifiers = [new ConsoleNotifier()];
    const token = inputs.github_token;
    const prNumber = github.context.payload.pull_request?.number;
    const prComment = inputs.pr_comment;
    const githubNotifierClient = new GitHubService();
    notifiers.push(new GitHubNotifier({ client: githubNotifierClient, token, prNumber, prComment }));
    const notificationData = { resultStatus, reportUrl, environment };
    await new NotifyHandler(notifiers).sendNotifications(notificationData);
}
