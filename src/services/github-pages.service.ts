import { existsSync, mkdirSync, rmSync, type Dirent } from 'node:fs';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import simpleGit, { CheckRepoActions, SimpleGit } from 'simple-git';
import { context } from '@actions/github';
import pLimit from 'p-limit';
import { info, warning } from '@actions/core';
import normalizeUrl from 'normalize-url';
import inputs from '../io.js';
import { HostingProvider } from '../interfaces/hosting-provider.interface.js';
import { allFulfilledResults, DEFAULT_RETRY_CONFIG, removeTrailingSlash, withRetry } from '../utilities/util.js';

export type GitHubConfig = {
    owner: string;
    repo: string;
    branch: string;
    token: string;
    reportDir: string;
    pageUrl: string;
    pagesSourcePath: string;
};

export class GithubPagesService implements HostingProvider {
    private git: SimpleGit;
    readonly branch: string;
    readonly repo: string;
    readonly owner: string;
    private readonly token: string;
    private readonly reportDir: string;
    private readonly pagesSourcePath: string;
    private readonly pageUrl: string;
    /** Set during deploy — the version timestamp embedded in the summary page */
    deployVersion?: string;

    constructor(config: GitHubConfig) {
        this.branch = config.branch;
        this.owner = config.owner;
        this.repo = config.repo;
        this.reportDir = config.reportDir;
        this.token = config.token;
        this.git = simpleGit();
        this.pageUrl = config.pageUrl;
        this.pagesSourcePath = config.pagesSourcePath;
    }

    async init(): Promise<string> {
        return this.setupBranch();
    }

    async deploy(): Promise<void> {
        return this.deployPages();
    }

    /** Deploys the Allure report to GitHub Pages */
    async deployPages(): Promise<void> {
        if (!existsSync(this.reportDir)) {
            throw new Error(`Directory not found: ${this.reportDir}`);
        }
        if (!(await this.git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT))) {
            throw new Error('No repository found. Call setupBranch() to initialize.');
        }

        await this.prepareAndCommit();
        await this.gitPushWithRetry();

        info(`Allure report pages pushed to '${this.reportDir}' on '${this.branch}' branch`);
    }

    /** Deletes old reports, creates redirect/summary pages, stages the report, and commits */
    private async prepareAndCommit(): Promise<void> {
        // Running sequentially to avoid git lock issues
        await this.deleteOldReports();

        // Disable Jekyll processing so files like _version are served correctly
        const nojekyllPath = path.join(inputs.WORKSPACE, this.pagesSourcePath, '.nojekyll');
        if (!existsSync(nojekyllPath)) {
            await writeFile(nojekyllPath, '', 'utf8');
            await this.git.add(nojekyllPath);
        }

        if (inputs.prefix) {
            await this.createRedirectPage(this.pageUrl);
            await this.createRootSummaryPage();
        }

        if (!existsSync(path.join(this.reportDir, 'index.html'))) {
            throw new Error(`No index.html found in ${this.reportDir}. Deployment aborted.`);
        }
        await this.git.add(`${removeTrailingSlash(this.reportDir)}/*`);
        await this.git.commit(`Allure report for GitHub run: ${context.runId}`);
    }

    /** Initializes and sets up the branch for GitHub Pages deployment */
    async setupBranch(): Promise<string> {
        await this.git.cwd(inputs.WORKSPACE);
        if (await this.git.checkIsRepo()) {
            rmSync(inputs.WORKSPACE, { recursive: true, force: true });
            mkdirSync(inputs.WORKSPACE, { recursive: true });
            await this.git.cwd(inputs.WORKSPACE);
        }
        await this.git.init();

        const headers = {
            Authorization: `Basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`,
        };

        await this.git.addConfig(
            'http.https://github.com/.extraheader',
            `AUTHORIZATION: ${headers.Authorization}`,
            true,
            'local',
        );

        const actor = context.actor;
        const senderId = context.payload.sender?.id ?? 41898282; // fallback: github-actions[bot]
        const email = `${senderId}+${actor}@users.noreply.github.com`;

        await this.git.addConfig('user.email', email, true, 'local').addConfig('user.name', actor, true, 'local');

        const remote = `${context.serverUrl}/${this.owner}/${this.repo}.git`;
        await this.git.addRemote('origin', remote);

        const fetchResult = await this.git.fetch('origin', this.branch, { '--depth': 1, '--no-tags': null });

        if (fetchResult.branches.length === 0) {
            await this.createBranchFromDefault();
        } else {
            await this.git.checkoutBranch(this.branch, `origin/${this.branch}`);
        }

        return this.pageUrl;
    }

    /** Creates a redirect page that dynamically resolves the latest report URL.
     *  Writes the target URL to a `_latest` file and the redirect page fetches it
     *  with cache-busting, so even a browser-cached page always finds the current report. */
    private async createRedirectPage(redirectUrl: string): Promise<void> {
        const targetUrl = normalizeUrl(`${redirectUrl}/index.html`);
        const prefixDir = path.join(inputs.WORKSPACE, this.pagesSourcePath, inputs.prefix ?? '');

        // Write target URL to _latest (fetched dynamically by the redirect page)
        const latestPath = path.join(prefixDir, '_latest');
        await writeFile(latestPath, targetUrl, 'utf8');
        await this.git.add(latestPath);

        // Redirect page fetches _latest with cache-busting to always get the current target
        const htmlContent = `<!DOCTYPE html>
<html><head><script>fetch("_latest?t="+Date.now(),{cache:"no-store"}).then(function(r){return r.text()}).then(function(u){window.location.replace(u.trim())}).catch(function(){document.body.textContent="Failed to load report. Please refresh."});</script></head><body></body></html>`;

        const filePath = path.join(prefixDir, 'index.html');
        await writeFile(filePath, htmlContent);
        await this.git.add(filePath);
        info(`Redirect 'index.html' created at ${path.posix.join(this.pagesSourcePath || '/', inputs.prefix ?? '')}`);
    }

    /** Creates a root index.html summary page using allure's built-in summary generator */
    private async createRootSummaryPage(): Promise<void> {
        try {
            const rootDir = path.join(inputs.WORKSPACE, this.pagesSourcePath);
            const entries = await readdir(rootDir, { withFileTypes: true });

            const summaries: Record<string, unknown>[] = [];
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const prefixDir = path.join(rootDir, entry.name);

                // Only include prefixes that have numeric run subdirs (deployed reports)
                const runs = await readdir(prefixDir, { withFileTypes: true }).catch((e: unknown) => {
                    warning(`Failed to read prefix directory '${entry.name}': ${e}`);
                    return [] as Dirent[];
                });
                const runDirs = (runs as Dirent[])
                    .filter((r) => r.isDirectory() && /^\d+$/.test(r.name))
                    .sort((a, b) => Number(b.name) - Number(a.name));

                if (runDirs.length === 0) continue;

                const latestDir = path.join(prefixDir, runDirs[0].name);
                try {
                    for (const candidate of ['summary.json', 'awesome/summary.json']) {
                        const summaryPath = path.join(latestDir, candidate);
                        if (existsSync(summaryPath)) {
                            const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
                            // Normalize Allure v2 format (statistic) to v3 format (stats)
                            if (!summary.stats && summary.statistic) {
                                summary.stats = summary.statistic;
                            }
                            summary.name = summary.name ?? entry.name;
                            summary.href = `${entry.name}/`;
                            summaries.push(summary);
                            break;
                        }
                    }
                } catch (e) {
                    warning(`Failed to read summary for prefix '${entry.name}': ${e}`);
                }
            }

            if (summaries.length === 0) return;

            let generateSummary: ((output: string, summaries: any[]) => Promise<string | undefined>) | undefined;
            try {
                const mod = await import('@allurereport/summary');
                generateSummary = mod.generateSummary ?? mod.default;
            } catch (e) {
                warning(`@allurereport/summary not available, skipping root summary page: ${e}`);
                return;
            }
            if (typeof generateSummary !== 'function') {
                warning('@allurereport/summary does not export generateSummary — skipping root summary page');
                return;
            }
            await generateSummary(rootDir, summaries);
            await this.injectDeployBanner(rootDir);
            await this.git.add(path.join(rootDir, 'index.html'));
            info('Root summary page created');
        } catch (e) {
            warning(`Failed to create root summary page: ${e}`);
        }
    }

    /**
     * Injects a staleness-detection script into the summary page.
     * Writes a _version file (timestamp) committed alongside index.html. The script:
     * - If `?v=` query param is present and differs from the embedded version, shows
     *   "Deployment in progress" banner immediately (no refresh button).
     * - Polls `_version` from the same Pages origin with cache-busting (10s for first
     *   5 minutes, then 30s). When the fetched version differs, replaces any existing
     *   banner with "A newer version is available" (with refresh button) and stops polling.
     * - Pauses polling when tab is hidden, checks immediately on focus.
     * - Pushes page content down so the banner doesn't overlap.
     * Works for both public and private repos since it uses the same origin.
     */
    private async injectDeployBanner(rootDir: string): Promise<void> {
        const version = Date.now().toString();
        this.deployVersion = version;
        const versionPath = path.join(rootDir, '_version');
        await writeFile(versionPath, version, 'utf8');
        await this.git.add(versionPath);

        const indexPath = path.join(rootDir, 'index.html');
        let html = await readFile(indexPath, 'utf8');

        const script = [
            '<script>document.addEventListener("DOMContentLoaded",function(){',
            'var v="', version, '";var done=false;var slow=false;',
            'var expected=new URLSearchParams(location.search).get("v");',
            'var el=null;',
            'function banner(msg,btn){if(el)el.remove();',
            'var b=document.createElement("div");',
            'b.style.cssText="position:fixed;top:0;left:0;right:0;z-index:99999;background:#ef6c00',
            ';color:#fff;padding:10px 16px;font:14px/1.4 -apple-system,sans-serif;',
            'display:flex;align-items:center;justify-content:center;gap:8px";',
            'b.innerHTML=msg+(btn?\'<button onclick="location.reload()"style="background:#fff;',
            'color:#ef6c00;border:none;border-radius:4px;padding:4px 12px;cursor:pointer;',
            'font:inherit;font-weight:600">\\u21bb Refresh</button>\':"");',
            'document.body.prepend(b);document.body.style.marginTop=b.offsetHeight+"px";el=b}',
            'if(expected&&Number(expected)>Number(v))banner("\\u26a0\\ufe0f Deployment in progress \\u2014',
            ' you may be seeing outdated results.\\xa0",false);',
            'function c(){if(done)return;',
            'fetch("_version?t="+Date.now(),{cache:"no-store"})',
            '.then(function(r){return r.ok?r.text():Promise.reject()})',
            '.then(function(t){if(t.trim()!==v){done=true;clearInterval(i);',
            'banner("\\u26a0\\ufe0f A newer version is available.\\xa0",true)}})',
            '.catch(function(){})}',
            'c();var i=setInterval(function(){if(!slow&&Date.now()-', version, '>300000)',
            '{slow=true;clearInterval(i);i=setInterval(c,30000)}else{c()}},10000);',
            'document.addEventListener("visibilitychange",function(){if(!document.hidden)c()})',
            '});</script>',
        ].join('');

        if (html.includes('</head>')) {
            html = html.replace('</head>', `${script}</head>`);
        } else {
            html += script;
        }

        await writeFile(indexPath, html, 'utf8');
    }

    /** Deletes old Allure reports, keeping the latest `inputs.keep` */
    private async deleteOldReports(): Promise<void> {
        try {
            const parentDir = path.dirname(this.reportDir);
            const entries: Dirent[] = await readdir(parentDir, { withFileTypes: true });

            // Single pass: filter report directories (name is a Date.now() timestamp)
            const reports: { dir: string; name: string }[] = [];
            for (const entry of entries) {
                if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
                reports.push({ dir: path.join(entry.parentPath, entry.name), name: entry.name });
            }

            // Account for the incoming report (not yet on disk) by keeping one fewer old report
            if (reports.length >= inputs.keep) {
                reports.sort((a, b) => Number(a.name) - Number(b.name));
                const limit = pLimit(10);
                const toDelete = reports.slice(0, reports.length - inputs.keep + 1);
                await allFulfilledResults(
                    toDelete.map(({ dir }) =>
                        limit(async () => {
                            await rm(dir, { recursive: true, force: true });
                            info(`Old Report deleted from '${dir}'`);
                        }),
                    ),
                );
                await this.git.add('-u');
            }
        } catch (e) {
            warning(`Failed to delete old reports: ${e}`);
        }
    }

    /** Creates a branch from the default branch if it doesn't exist */
    private async createBranchFromDefault(): Promise<void> {
        // Use ls-remote instead of symbolic-ref — symbolic-ref requires origin/HEAD
        // which isn't set after a targeted fetch (only after clone or remote set-head).
        const lsRemote = await this.git.listRemote(['--symref', 'HEAD']);
        // Output format: "ref: refs/heads/main\tHEAD\n<sha>\tHEAD\n"
        const match = lsRemote.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
        if (!match?.[1]) {
            throw new Error(`Could not determine default branch from ls-remote output: '${lsRemote.trim()}'`);
        }
        const defaultBranch = match[1];

        await this.git.fetch('origin', defaultBranch, { '--depth': 1, '--no-tags': null });
        await this.git.checkoutBranch(this.branch, `origin/${defaultBranch}`);
        info(`Branch '${this.branch}' created from '${defaultBranch}'.`);
    }

    /** Handles Git push with retry logic specifically for concurrent push scenarios */
    private async gitPushWithRetry(): Promise<void> {
        // Backup created lazily on first push rejection — avoids unnecessary I/O on happy path
        const backupDir = path.join(path.dirname(inputs.WORKSPACE), 'report-backup');
        let backupCreated = false;

        try {
            await withRetry(async () => {
                if (backupCreated) {
                    // Previous push was rejected — reset to latest remote and re-apply
                    try {
                        await this.git.merge(['--abort']);
                    } catch {
                        /* no merge in progress */
                    }
                    await this.git.fetch('origin', this.branch, { '--depth': 1 });
                    await this.git.reset(['--hard', `origin/${this.branch}`]);
                    await cp(backupDir, this.reportDir, { recursive: true });
                    await this.prepareAndCommit();
                }

                try {
                    await this.git.push('origin', this.branch);
                } catch (error: unknown) {
                    // Back up report before retry — reset --hard will wipe the working tree
                    if (!backupCreated) {
                        await cp(this.reportDir, backupDir, { recursive: true });
                        backupCreated = true;
                    }
                    throw error;
                }
            }, { ...DEFAULT_RETRY_CONFIG, maxRetries: 5 });
        } finally {
            if (backupCreated) {
                await rm(backupDir, { recursive: true, force: true });
            }
        }
    }
}
