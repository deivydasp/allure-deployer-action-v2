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
    /** Creates a root index.html summary page listing all report prefixes with stats */
    async createRootSummaryPage() {
        try {
            const rootDir = path.join(inputs.WORKSPACE, this.pagesSourcePath ?? '');
            const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
            const projects = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const prefixDir = path.join(rootDir, entry.name);
                if (!fs.existsSync(path.join(prefixDir, 'index.html')))
                    continue;
                const project = { name: entry.name, href: `${entry.name}/` };
                // Find latest report run dir and read its summary.json
                try {
                    const runs = await fs.promises.readdir(prefixDir, { withFileTypes: true });
                    const runDirs = runs
                        .filter((r) => r.isDirectory() && /^\d+$/.test(r.name))
                        .sort((a, b) => Number(b.name) - Number(a.name));
                    if (runDirs.length > 0) {
                        const latestDir = path.join(prefixDir, runDirs[0].name);
                        // Check both single-plugin and multi-plugin paths
                        for (const candidate of ['summary.json', 'awesome/summary.json']) {
                            const summaryPath = path.join(latestDir, candidate);
                            if (fs.existsSync(summaryPath)) {
                                const summary = JSON.parse(await fs.promises.readFile(summaryPath, 'utf8'));
                                project.stats = summary.stats;
                                project.status = summary.status;
                                project.duration = summary.duration;
                                project.createdAt = summary.createdAt;
                                break;
                            }
                        }
                    }
                }
                catch {
                    // stats unavailable — card will show without them
                }
                projects.push(project);
            }
            if (projects.length === 0)
                return;
            projects.sort((a, b) => a.name.localeCompare(b.name));
            const html = this.renderSummaryPage(projects);
            const filePath = path.join(rootDir, 'index.html');
            await fs.promises.writeFile(filePath, html);
            await this.git.add(filePath);
            info('Root summary page created');
        }
        catch (e) {
            warning(`Failed to create root summary page: ${e}`);
        }
    }
    renderSummaryPage(projects) {
        const statusColor = {
            passed: '#4caf50',
            failed: '#e53935',
            broken: '#ff9800',
            unknown: '#9e9e9e',
        };
        const formatDuration = (ms) => {
            if (!ms)
                return '';
            const s = Math.floor(ms / 1000);
            if (s < 60)
                return `${s}s`;
            const m = Math.floor(s / 60);
            if (m < 60)
                return `${m}m ${s % 60}s`;
            return `${Math.floor(m / 60)}h ${m % 60}m`;
        };
        const cards = projects
            .map((p) => {
            const color = statusColor[p.status ?? 'unknown'] ?? statusColor.unknown;
            const statsHtml = p.stats
                ? `<div class="stats">
            <span class="stat passed">${p.stats.passed ?? 0}</span>
            <span class="stat failed">${p.stats.failed ?? 0}</span>
            <span class="stat broken">${p.stats.broken ?? 0}</span>
            <span class="stat skipped">${p.stats.skipped ?? 0}</span>
          </div>
          <div class="meta">${p.stats.total} tests${p.duration ? ' &middot; ' + formatDuration(p.duration) : ''}${p.createdAt ? ' &middot; ' + new Date(p.createdAt).toLocaleDateString() : ''}</div>`
                : '';
            return `    <a href="${p.href}" class="card">
      <div class="status-bar" style="background:${color}"></div>
      <div class="card-body">
        <div class="card-name">${p.name}</div>
        ${statsHtml}
      </div>
    </a>`;
        })
            .join('\n');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allure Reports</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#1a1a2e;color:#e0e0e0;min-height:100vh}
header{background:#16213e;padding:1.25rem 2rem;display:flex;align-items:center;gap:.75rem;border-bottom:1px solid #0f3460}
header svg{width:28px;height:28px}
header h1{font-size:1.25rem;font-weight:500;color:#fff}
main{max-width:1200px;margin:0 auto;padding:2rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem}
.card{display:flex;background:#16213e;border-radius:10px;text-decoration:none;color:#e0e0e0;overflow:hidden;transition:transform .15s,box-shadow .15s;border:1px solid #0f3460}
.card:hover{transform:translateY(-2px);box-shadow:0 4px 20px rgba(0,0,0,.3)}
.status-bar{width:5px;flex-shrink:0}
.card-body{padding:1rem 1.25rem;flex:1;min-width:0}
.card-name{font-size:1rem;font-weight:600;color:#fff;margin-bottom:.5rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stats{display:flex;gap:.75rem;margin-bottom:.35rem}
.stat{font-size:.85rem;font-weight:500}
.stat::before{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;content:'';vertical-align:middle}
.stat.passed::before{background:#4caf50}
.stat.failed::before{background:#e53935}
.stat.broken::before{background:#ff9800}
.stat.skipped::before{background:#9e9e9e}
.meta{font-size:.75rem;color:#888}
</style>
</head>
<body>
<header>
<svg viewBox="0 0 32 32" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M22.2 4.7a3.6 3.6 0 015.1 0A15.9 15.9 0 0132 16a3.6 3.6 0 01-7.2 0c0-2.4-1-4.6-2.6-6.2a3.6 3.6 0 010-5.1z" fill="#7E22CE"/><path fill-rule="evenodd" clip-rule="evenodd" d="M12.4 3.6A3.6 3.6 0 0116 0a15.9 15.9 0 0111.3 4.7 3.6 3.6 0 01-5.1 5.1A8.8 8.8 0 0016 7.2a3.6 3.6 0 01-3.6-3.6z" fill="#A855F7"/><path fill-rule="evenodd" clip-rule="evenodd" d="M0 16C0 7.2 7.2 0 16 0a3.6 3.6 0 010 7.2A8.8 8.8 0 007.2 16c0 2.4 1 4.6 2.6 6.2a3.6 3.6 0 01-5.1 5.1A15.9 15.9 0 010 16z" fill="#06B6D4"/><path fill-rule="evenodd" clip-rule="evenodd" d="M4.7 22.2a3.6 3.6 0 015.1 0A8.8 8.8 0 0016 24.8a3.6 3.6 0 010 7.2 15.9 15.9 0 01-11.3-4.7 3.6 3.6 0 010-5.1z" fill="#8B5CF6"/><path fill-rule="evenodd" clip-rule="evenodd" d="M28.4 12.4a3.6 3.6 0 013.6 3.6C32 24.8 24.8 32 16 32a3.6 3.6 0 010-7.2 8.8 8.8 0 008.8-8.8 3.6 3.6 0 013.6-3.6z" fill="#7C3AED"/></svg>
<h1>Allure Reports</h1>
</header>
<main>
<div class="grid">
${cards}
</div>
</main>
</body>
</html>`;
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
