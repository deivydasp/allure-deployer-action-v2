import fs from 'fs';
import path from 'node:path';
import simpleGit, { CheckRepoActions } from 'simple-git';
import { context } from '@actions/github';
import pLimit from 'p-limit';
import { info, warning } from '@actions/core';
import normalizeUrl from 'normalize-url';
import inputs from '../io.js';
import { allFulfilledResults, removeTrailingSlash, withRetry } from '../utilities/util.js';
export class GithubPagesService {
    constructor(config) {
        this.branch = config.branch;
        this.owner = config.owner;
        this.repo = config.repo;
        this.reportDir = config.reportDir;
        this.token = config.token;
        this.git = simpleGit();
        this.pageUrl = config.pageUrl;
        this.pagesSourcePath = config.pagesSourcePath;
    }
    /** Deploys the Allure report to GitHub Pages */
    async deployPages() {
        await this.ensureValidState();
        if (!fs.existsSync(path.join(this.reportDir, 'index.html'))) {
            throw new Error(`No index.html found in ${this.reportDir}. Deployment aborted.`);
        }
        await this.git.add(`${removeTrailingSlash(this.reportDir)}/*`);
        // Create the commit
        await this.git.commit(`Allure report for GitHub run: ${context.runId}`);
        // Push with retry mechanism to handle concurrent updates
        await this.gitPushWithRetry();
        info(`Allure report pages pushed to '${this.reportDir}' on '${this.branch}' branch`);
    }
    /** Ensures the repository and required directories are set up */
    async ensureValidState() {
        const [reportDirExists, isRepo] = await Promise.all([
            fs.existsSync(this.reportDir),
            this.git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT),
        ]);
        if (!reportDirExists) {
            throw new Error(`Directory not found: ${this.reportDir}`);
        }
        if (!isRepo) {
            throw new Error('No repository found. Call setupBranch() to initialize.');
        }
        // Running them sequentially to avoid git lock issues
        await this.deleteOldReports();
        await this.createRedirectPage(normalizeUrl(`${this.pageUrl}`));
        await this.createRootSummaryPage();
    }
    /** Initializes and sets up the branch for GitHub Pages deployment */
    async setupBranch() {
        await this.git.cwd(inputs.WORKSPACE);
        if (await this.git.checkIsRepo()) {
            fs.rmSync(inputs.WORKSPACE, { recursive: true, force: true });
            fs.mkdirSync(inputs.WORKSPACE, { recursive: true });
            await this.git.cwd(inputs.WORKSPACE);
        }
        await this.git.init();
        const headers = {
            Authorization: `Basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`,
        };
        await this.git.addConfig('http.https://github.com/.extraheader', `AUTHORIZATION: ${headers.Authorization}`, true, 'local');
        const actor = context.actor;
        const email = `${context.payload.sender?.id}+${actor}@users.noreply.github.com`;
        await this.git.addConfig('user.email', email, true, 'local').addConfig('user.name', actor, true, 'local');
        const remote = `${context.serverUrl}/${this.owner}/${this.repo}.git`;
        await this.git.addRemote('origin', remote);
        const fetchResult = await this.git.fetch('origin', this.branch, { '--depth': 1, '--no-tags': null });
        if (fetchResult.branches.length === 0) {
            await this.createBranchFromDefault();
        }
        else {
            await this.git.checkoutBranch(this.branch, `origin/${this.branch}`);
        }
        return this.pageUrl;
    }
    /** Creates a redirect page for the Allure report */
    async createRedirectPage(redirectUrl) {
        const htmlContent = `<!DOCTYPE html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; URL=${normalizeUrl(`${redirectUrl}/index.html`)}">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">`;
        const filePath = path.join(inputs.WORKSPACE, this.pagesSourcePath ?? '', inputs.prefix ?? '', 'index.html');
        await fs.promises.writeFile(filePath, htmlContent);
        await this.git.add(filePath);
        info(`Redirect 'index.html' created at ${path.posix.join(this.pagesSourcePath || '/', inputs.prefix ?? '')}`);
    }
    /** Creates a root index.html summary page using allure's built-in summary generator */
    async createRootSummaryPage() {
        try {
            const rootDir = path.join(inputs.WORKSPACE, this.pagesSourcePath ?? '');
            const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
            const summaries = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const prefixDir = path.join(rootDir, entry.name);
                // Only include prefixes that have numeric run subdirs (deployed reports)
                const runs = await fs.promises.readdir(prefixDir, { withFileTypes: true }).catch(() => []);
                const runDirs = runs
                    .filter((r) => r.isDirectory() && /^\d+$/.test(r.name))
                    .sort((a, b) => Number(b.name) - Number(a.name));
                if (runDirs.length === 0)
                    continue;
                const latestDir = path.join(prefixDir, runDirs[0].name);
                try {
                    for (const candidate of ['summary.json', 'awesome/summary.json']) {
                        const summaryPath = path.join(latestDir, candidate);
                        if (fs.existsSync(summaryPath)) {
                            const summary = JSON.parse(await fs.promises.readFile(summaryPath, 'utf8'));
                            summary.name = summary.name ?? entry.name;
                            summary.href = `${entry.name}/`;
                            summaries.push(summary);
                            break;
                        }
                    }
                }
                catch (e) {
                    warning(`Failed to read summary for prefix '${entry.name}': ${e}`);
                }
            }
            if (summaries.length === 0)
                return;
            let summaryModule;
            try {
                summaryModule = await import('@allurereport/summary');
            }
            catch (e) {
                warning(`@allurereport/summary not available, skipping root summary page: ${e}`);
                return;
            }
            const generateSummary = summaryModule.generateSummary ?? summaryModule.default;
            await generateSummary(rootDir, summaries);
            await this.git.add(path.join(rootDir, 'index.html'));
            info('Root summary page created');
        }
        catch (e) {
            warning(`Failed to create root summary page: ${e}`);
        }
    }
    /** Deletes old Allure reports, keeping the latest `inputs.keep` */
    async deleteOldReports() {
        try {
            const parentDir = path.dirname(this.reportDir);
            const entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
            // Single pass: filter report directories and collect mtime
            const reports = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const dirPath = path.join(entry.parentPath, entry.name);
                if (fs.existsSync(path.join(dirPath, 'index.html'))) {
                    const stats = await fs.promises.stat(dirPath);
                    reports.push({ dir: dirPath, mtimeMs: stats.mtimeMs });
                }
            }
            if (reports.length > 1 && reports.length >= inputs.keep) {
                reports.sort((a, b) => a.mtimeMs - b.mtimeMs);
                const limit = pLimit(10);
                const toDelete = reports.slice(0, reports.length - inputs.keep);
                await allFulfilledResults(toDelete.map(({ dir }) => limit(async () => {
                    await fs.promises.rm(dir, { recursive: true, force: true });
                    info(`Old Report deleted from '${dir}'`);
                })));
                await this.git.add('-u');
            }
        }
        catch (e) {
            warning(`Failed to delete old reports: ${e}`);
        }
    }
    /** Creates a branch from the default branch if it doesn't exist */
    async createBranchFromDefault() {
        const defaultBranch = (await this.git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']))
            .trim()
            .split('/')
            .pop();
        await this.git.checkoutBranch(this.branch, `origin/${defaultBranch}`);
        info(`Branch '${this.branch}' created from '${defaultBranch}'.`);
    }
    /** Handles Git push with retry logic specifically for concurrent push scenarios */
    async gitPushWithRetry() {
        await withRetry(async () => {
            try {
                // Pull to fetch and merge remote changes in one operation
                // Specify merge strategy to handle divergent branches
                try {
                    await this.git.pull(['--no-rebase', 'origin', this.branch]);
                    info('Successfully pulled remote changes');
                }
                catch (pullError) {
                    warning(`Pull failed: ${pullError}. Will try direct push...`);
                }
                // Push to remote
                await this.git.push('origin', this.branch);
            }
            catch (error) {
                warning(`Push attempt failed: ${error.message}`);
                throw error; // Let the retry mechanism handle it
            }
        });
    }
}
