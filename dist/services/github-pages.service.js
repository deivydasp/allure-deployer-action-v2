import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { simpleGit, CheckRepoActions } from 'simple-git';
import { context, getOctokit } from '@actions/github';
import pLimit from 'p-limit';
import { info, warning } from '@actions/core';
import normalizeUrl from 'normalize-url';
import inputs from '../io.js';
import { allFulfilledResults, DEFAULT_RETRY_CONFIG, removeTrailingSlash, withRetry } from '../utilities/util.js';
const DAY_MS = 24 * 60 * 60 * 1000;
// No since/until filter: GitHub stops walking at the first commit older than `since`, so a single commit
// with a skewed date would cut off every newer commit beneath it
const RETENTION_QUERY = `query($owner: String!, $repo: String!, $oid: GitObjectID!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    id
    object(oid: $oid) {
      ... on Commit {
        history(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { oid message tree { oid } author { name email date } committer { name email date } }
        }
      }
    }
  }
}`;
const UPDATE_REF_MUTATION = `mutation($repositoryId: ID!, $name: GitRefname!, $beforeOid: GitObjectID!, $afterOid: GitObjectID!) {
  updateRefs(input: { repositoryId: $repositoryId, refUpdates: [{ name: $name, beforeOid: $beforeOid, afterOid: $afterOid, force: true }] }) {
    clientMutationId
  }
}`;
export class GithubPagesService {
    git;
    branch;
    repo;
    owner;
    token;
    reportDir;
    pagesSourcePath;
    pageUrl;
    /** Set during deploy — the version timestamp embedded in the summary page */
    deployVersion;
    historyPath;
    /** Decided once in setupBranch: the branch existed on the remote and is a dedicated Pages branch */
    pruneAllowed = false;
    constructor(config) {
        this.branch = config.branch;
        this.owner = config.owner;
        this.repo = config.repo;
        this.reportDir = config.reportDir;
        this.token = config.token;
        this.git = simpleGit();
        this.pageUrl = config.pageUrl;
        this.pagesSourcePath = config.pagesSourcePath;
        this.historyPath = config.historyPath;
    }
    async init() {
        return this.setupBranch();
    }
    async deploy() {
        return this.deployPages();
    }
    /** Deploys the Allure report to GitHub Pages */
    async deployPages() {
        if (!existsSync(this.reportDir)) {
            throw new Error(`Directory not found: ${this.reportDir}`);
        }
        if (!(await this.git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT))) {
            throw new Error('No repository found. Call setupBranch() to initialize.');
        }
        await this.prepareAndCommit();
        await this.gitPushWithRetry();
        info(`Allure report pages pushed to '${this.reportDir}' on '${this.branch}' branch`);
        if (this.pruneAllowed) {
            try {
                await this.pruneOldCommits();
            }
            catch (error) {
                // Housekeeping only: the report is already published, and a later deploy prunes instead
                warning(`Skipped pruning old commits on '${this.branch}': ${error}`);
            }
        }
    }
    /** Deletes old reports, creates redirect/summary pages, stages the report, and commits */
    async prepareAndCommit() {
        // Running sequentially to avoid git lock issues
        await this.deleteOldReports();
        // Disable Jekyll processing so files like _version are served correctly
        const nojekyllPath = join(inputs.WORKSPACE, this.pagesSourcePath, '.nojekyll');
        if (!existsSync(nojekyllPath)) {
            await writeFile(nojekyllPath, '', 'utf8');
            await this.git.add(nojekyllPath);
        }
        if (inputs.prefix) {
            await this.createRedirectPage(this.pageUrl);
            await this.createRootSummaryPage();
        }
        if (!existsSync(join(this.reportDir, 'index.html'))) {
            throw new Error(`No index.html found in ${this.reportDir}. Deployment aborted.`);
        }
        await this.git.add(`${removeTrailingSlash(this.reportDir)}/*`);
        // Stage history file alongside the report (lives at {prefix}/history/history.jsonl)
        if (this.historyPath && existsSync(this.historyPath)) {
            await this.git.add(this.historyPath);
        }
        await this.git.commit(`Allure report for GitHub run: ${context.runId}`);
    }
    /**
     * Drops branch commits from before the last `commit_retention_days` UTC calendar days (today counts as one),
     * keeping newer commits with their original authors and dates. With 7, the first deploy of a day removes the
     * commits made 7 days ago; later deploys that day find nothing older and do nothing.
     *
     * Runs after the normal push and rewrites history on GitHub's side via the API, reusing trees the server
     * already has: a local rewrite would re-upload every report, because git cannot tell that a commit with
     * no shared history references objects the server already stores. The ref only moves if it still points
     * at the commit just pushed, so a deploy that landed meanwhile is never dropped.
     */
    async pruneOldCommits() {
        const head = (await this.git.revparse(['HEAD'])).trim();
        const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
        const cutoffMs = todayStart - (inputs.commit_retention_days - 1) * DAY_MS;
        const cutoff = new Date(cutoffMs).toISOString();
        const octokit = getOctokit(this.token);
        const commits = [];
        let repositoryId = '';
        let cursor = null;
        do {
            const result = await octokit.graphql(RETENTION_QUERY, {
                owner: this.owner,
                repo: this.repo,
                oid: head,
                cursor,
            });
            const commit = result.repository.object;
            if (!commit)
                throw new Error(`commit ${head} not found on the remote`);
            repositoryId = result.repository.id;
            commits.push(...commit.history.nodes);
            cursor = commit.history.pageInfo.hasNextPage ? commit.history.pageInfo.endCursor : null;
        } while (cursor);
        // Cut below the oldest-positioned commit made since the cutoff, so an out-of-order date in between
        // never drops newer commits; the branch is linear because pushes are always replayed on the tip
        let lastKept = commits.length - 1;
        while (lastKept >= 0 && Date.parse(commits[lastKept].committer.date) < cutoffMs)
            lastKept--;
        if (lastKept < 0 || lastKept === commits.length - 1)
            return;
        const kept = commits.slice(0, lastKept + 1);
        // history() lists newest first; rebuild oldest first on a new root
        let parent;
        for (const node of kept.reverse()) {
            const { data } = await octokit.rest.git.createCommit({
                owner: this.owner,
                repo: this.repo,
                message: node.message,
                tree: node.tree.oid,
                parents: parent ? [parent] : [],
                author: node.author,
                committer: node.committer,
            });
            parent = data.sha;
        }
        if (!parent)
            return;
        try {
            await octokit.graphql(UPDATE_REF_MUTATION, {
                repositoryId,
                name: `refs/heads/${this.branch}`,
                beforeOid: head,
                afterOid: parent,
            });
        }
        catch (error) {
            // GitHub reports a beforeOid mismatch only as a generic "Something went wrong" error
            throw new Error(`branch update rejected, most likely another deploy pushed after ${head.slice(0, 7)}: ${error}`);
        }
        info(`Pruned commits older than ${cutoff.slice(0, 10)} from '${this.branch}', kept ${kept.length} (commit_retention_days: ${inputs.commit_retention_days})`);
    }
    /**
     * Pruning rewrites branch history, so it is limited to a dedicated Pages branch: never the repo's default
     * branch, and never a branch serving Pages from a subfolder (e.g. `main` with `/docs`), where the rest of
     * the tree is source code whose history must survive.
     */
    async isPruneAllowed() {
        if (inputs.commit_retention_days <= 0)
            return false;
        if (this.pagesSourcePath) {
            warning(`commit_retention_days ignored: Pages is served from '/${this.pagesSourcePath}' on '${this.branch}', so the branch likely holds source code`);
            return false;
        }
        try {
            if ((await this.getDefaultBranch()) === this.branch) {
                warning(`commit_retention_days ignored: '${this.branch}' is the repository's default branch`);
                return false;
            }
        }
        catch (error) {
            warning(`commit_retention_days ignored: could not determine the default branch: ${error}`);
            return false;
        }
        return true;
    }
    /** Initializes and sets up the branch for GitHub Pages deployment */
    async setupBranch() {
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
        await this.git.addConfig('http.https://github.com/.extraheader', `AUTHORIZATION: ${headers.Authorization}`, true, 'local');
        const actor = context.actor;
        const senderId = context.payload.sender?.id ?? 41898282; // fallback: github-actions[bot]
        const email = `${senderId}+${actor}@users.noreply.github.com`;
        await this.git.addConfig('user.email', email, true, 'local').addConfig('user.name', actor, true, 'local');
        const remote = `${context.serverUrl}/${this.owner}/${this.repo}.git`;
        await this.git.addRemote('origin', remote);
        const fetchResult = await this.git.fetch('origin', this.branch, { '--depth': 1, '--no-tags': null });
        if (fetchResult.branches.length === 0) {
            await this.createBranchFromDefault();
        }
        else {
            await this.git.checkoutBranch(this.branch, `origin/${this.branch}`);
            // A branch new on the remote is never pruned, even after a retry resets onto a parallel deploy's tip
            this.pruneAllowed = await this.isPruneAllowed();
        }
        return this.pageUrl;
    }
    /** Creates a redirect page that dynamically resolves the latest report URL.
     *  Writes the target URL to a `_latest` file and the redirect page fetches it
     *  with cache-busting, so even a browser-cached page always finds the current report. */
    async createRedirectPage(redirectUrl) {
        const targetUrl = normalizeUrl(`${redirectUrl}/index.html`);
        const prefixDir = join(inputs.WORKSPACE, this.pagesSourcePath, inputs.prefix ?? '');
        // Write target URL to _latest (fetched dynamically by the redirect page)
        const latestPath = join(prefixDir, '_latest');
        await writeFile(latestPath, targetUrl, 'utf8');
        await this.git.add(latestPath);
        // Redirect page fetches _latest with cache-busting to always get the current target
        const htmlContent = `<!DOCTYPE html>
<html><head><script>fetch("_latest?t="+Date.now(),{cache:"no-store"}).then(function(r){return r.text()}).then(function(u){window.location.replace(u.trim())}).catch(function(){document.body.textContent="Failed to load report. Please refresh."});</script></head><body></body></html>`;
        const filePath = join(prefixDir, 'index.html');
        await writeFile(filePath, htmlContent);
        await this.git.add(filePath);
        info(`Redirect 'index.html' created at ${posix.join(this.pagesSourcePath || '/', inputs.prefix ?? '')}`);
    }
    /** Creates a root index.html summary page using allure's built-in summary generator */
    async createRootSummaryPage() {
        try {
            const rootDir = join(inputs.WORKSPACE, this.pagesSourcePath);
            const entries = await readdir(rootDir, { withFileTypes: true });
            const summaries = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const prefixDir = join(rootDir, entry.name);
                // Only include prefixes that have numeric run subdirs (deployed reports)
                const runs = await readdir(prefixDir, { withFileTypes: true }).catch((e) => {
                    warning(`Failed to read prefix directory '${entry.name}': ${e}`);
                    return [];
                });
                const runDirs = runs
                    .filter((r) => r.isDirectory() && /^\d+$/.test(r.name))
                    .sort((a, b) => Number(b.name) - Number(a.name));
                if (runDirs.length === 0)
                    continue;
                const latestDir = join(prefixDir, runDirs[0].name);
                try {
                    for (const candidate of ['summary.json', 'awesome/summary.json']) {
                        const summaryPath = join(latestDir, candidate);
                        if (existsSync(summaryPath)) {
                            const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
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
            let generateSummary;
            try {
                const mod = await import('@allurereport/summary');
                generateSummary = mod.generateSummary ?? mod.default;
            }
            catch (e) {
                warning(`@allurereport/summary not available, skipping root summary page: ${e}`);
                return;
            }
            if (typeof generateSummary !== 'function') {
                warning('@allurereport/summary does not export generateSummary — skipping root summary page');
                return;
            }
            await generateSummary(rootDir, summaries);
            await this.injectDeployBanner(rootDir);
            await this.git.add(join(rootDir, 'index.html'));
            info('Root summary page created');
        }
        catch (e) {
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
    async injectDeployBanner(rootDir) {
        const version = Date.now().toString();
        this.deployVersion = version;
        const versionPath = join(rootDir, '_version');
        await writeFile(versionPath, version, 'utf8');
        await this.git.add(versionPath);
        const indexPath = join(rootDir, 'index.html');
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
        }
        else {
            html += script;
        }
        await writeFile(indexPath, html, 'utf8');
    }
    /** Deletes old Allure reports, keeping the latest `inputs.keep` */
    async deleteOldReports() {
        try {
            const parentDir = dirname(this.reportDir);
            const entries = await readdir(parentDir, { withFileTypes: true });
            // Single pass: filter report directories (name is a Date.now() timestamp)
            const reports = [];
            for (const entry of entries) {
                if (!entry.isDirectory() || !/^\d+$/.test(entry.name))
                    continue;
                reports.push({ dir: join(entry.parentPath, entry.name), name: entry.name });
            }
            if (reports.length > inputs.keep) {
                reports.sort((a, b) => Number(a.name) - Number(b.name));
                const limit = pLimit(10);
                const toDelete = reports.slice(0, reports.length - inputs.keep);
                await allFulfilledResults(toDelete.map(({ dir }) => limit(async () => {
                    await rm(dir, { recursive: true, force: true });
                    info(`Old Report deleted from '${dir}'`);
                })));
                await this.git.add('-u');
            }
        }
        catch (e) {
            warning(`Failed to delete old reports: ${e}`);
        }
    }
    /** Resolves the repository's default branch from the remote */
    async getDefaultBranch() {
        // Use ls-remote instead of symbolic-ref — symbolic-ref requires origin/HEAD
        // which isn't set after a targeted fetch (only after clone or remote set-head).
        const lsRemote = await this.git.listRemote(['--symref', 'origin', 'HEAD']);
        // Output format: "ref: refs/heads/main\tHEAD\n<sha>\tHEAD\n"
        const match = lsRemote.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
        if (!match?.[1]) {
            throw new Error(`Could not determine default branch from ls-remote output: '${lsRemote.trim()}'`);
        }
        return match[1];
    }
    /** Creates a branch from the default branch if it doesn't exist */
    async createBranchFromDefault() {
        const defaultBranch = await this.getDefaultBranch();
        await this.git.fetch('origin', defaultBranch, { '--depth': 1, '--no-tags': null });
        await this.git.checkoutBranch(this.branch, `origin/${defaultBranch}`);
        info(`Branch '${this.branch}' created from '${defaultBranch}'.`);
    }
    /** Handles Git push with retry logic specifically for concurrent push scenarios */
    async gitPushWithRetry() {
        // Backup created lazily on first push rejection — avoids unnecessary I/O on happy path
        const backupDir = join(dirname(inputs.WORKSPACE), 'report-backup');
        const historyBackupDir = join(dirname(inputs.WORKSPACE), 'history-backup');
        let backupCreated = false;
        try {
            await withRetry(async () => {
                if (backupCreated) {
                    // Previous push was rejected — reset to latest remote and re-apply
                    try {
                        await this.git.merge(['--abort']);
                    }
                    catch {
                        /* no merge in progress */
                    }
                    await this.git.fetch('origin', this.branch, { '--depth': 1 });
                    await this.git.reset(['--hard', `origin/${this.branch}`]);
                    await cp(backupDir, this.reportDir, { recursive: true });
                    // Restore history backup — overwrites remote history with our generated version
                    if (this.historyPath && existsSync(historyBackupDir)) {
                        await cp(historyBackupDir, dirname(this.historyPath), { recursive: true });
                    }
                    await this.prepareAndCommit();
                }
                try {
                    await this.git.push('origin', this.branch);
                }
                catch (error) {
                    // Back up report and history before retry — reset --hard will wipe the working tree
                    if (!backupCreated) {
                        await cp(this.reportDir, backupDir, { recursive: true });
                        if (this.historyPath && existsSync(dirname(this.historyPath))) {
                            await cp(dirname(this.historyPath), historyBackupDir, { recursive: true });
                        }
                        backupCreated = true;
                    }
                    throw error;
                }
            }, { ...DEFAULT_RETRY_CONFIG, maxRetries: 5 });
        }
        finally {
            if (backupCreated) {
                await rm(backupDir, { recursive: true, force: true });
                await rm(historyBackupDir, { recursive: true, force: true });
            }
        }
    }
}
