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
    /** Creates a root index.html summary page listing all report prefixes */
    async createRootSummaryPage() {
        try {
            const rootDir = path.join(inputs.WORKSPACE, this.pagesSourcePath ?? '');
            const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
            const projects = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const indexPath = path.join(rootDir, entry.name, 'index.html');
                if (fs.existsSync(indexPath)) {
                    projects.push({ name: entry.name, href: `${entry.name}/` });
                }
            }
            if (projects.length === 0)
                return;
            projects.sort((a, b) => a.name.localeCompare(b.name));
            const projectCards = projects
                .map((p) => `      <a href="${p.href}" class="card">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 16l4-8 4 4 4-6"/></svg>
        <span>${p.name}</span>
      </a>`)
                .join('\n');
            const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Allure Reports</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; padding: 2rem; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 1.5rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; }
    .card { display: flex; align-items: center; gap: 0.75rem; padding: 1rem 1.25rem; background: #fff; border-radius: 8px; text-decoration: none; color: #333; border: 1px solid #e0e0e0; transition: box-shadow 0.15s; }
    .card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .card svg { color: #4caf50; flex-shrink: 0; }
  </style>
</head>
<body>
  <h1>Allure Reports</h1>
  <div class="grid">
${projectCards}
  </div>
</body>
</html>`;
            const filePath = path.join(rootDir, 'index.html');
            await fs.promises.writeFile(filePath, html);
            await this.git.add(filePath);
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
