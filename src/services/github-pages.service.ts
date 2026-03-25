import fs, {Dirent} from "fs";
import path from "node:path";
import simpleGit, {CheckRepoActions, SimpleGit} from "simple-git";
import {context} from "@actions/github";
import pLimit from "p-limit";
import * as core from "@actions/core";
const {info} = core;
import normalizeUrl from "normalize-url";
import inputs from "../io.js";
import {GithubPagesInterface} from "../interfaces/github-pages.interface.js";
import {allFulfilledResults, removeTrailingSlash, withRetry} from "../utilities/util.js";

export type GitHubConfig = {
    owner: string;
    repo: string;
    branch: string;
    workspace: string;
    token: string;
    reportDir: string;
    pageUrl: string;
    pagesSourcePath: string;
};

export class GithubPagesService implements GithubPagesInterface {
    private git: SimpleGit;
    readonly branch: string;
    readonly repo: string;
    readonly owner: string;
    private readonly token: string;
    private readonly reportDir: string;
    pagesSourcePath: string;
    private readonly pageUrl: string;

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

    /** Deploys the Allure report to GitHub Pages */
    async deployPages(): Promise<void> {
        await this.ensureValidState();

        if (!fs.existsSync(path.posix.join(this.reportDir, 'index.html'))) {
            core.error(`No index.html found in ${this.reportDir}. Deployment aborted.`);
            process.exit(1);
        }
        await this.git.add(`${removeTrailingSlash(this.reportDir)}/*`);
        
        // Create the commit
        await this.git.commit(`Allure report for GitHub run: ${context.runId}`);
        
        // Push with retry mechanism to handle concurrent updates
        await this.gitPushWithRetry();

        console.log(`Allure report pages pushed to '${this.reportDir}' on '${this.branch}' branch`);
    }

    /** Ensures the repository and required directories are set up */
    private async ensureValidState(): Promise<void> {
        const [reportDirExists, isRepo] = await Promise.all([
            fs.existsSync(this.reportDir),
            this.git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT)
        ]);
        if (!reportDirExists) {
            throw new Error(`Directory not found: ${this.reportDir}`);
        }
        if (!isRepo) {
            throw new Error("No repository found. Call setupBranch() to initialize.");
        }

        // await Promise.all([
        //     this.deleteOldReports(),
        //     this.createRedirectPage(normalizeUrl(`${this.pageUrl}/${this.subFolder}`))
        // ]) Running them together cause git lock issues
        await this.deleteOldReports();
        await this.createRedirectPage(normalizeUrl(`${this.pageUrl}`));
    }

    /** Initializes and sets up the branch for GitHub Pages deployment */
    async setupBranch(): Promise<string> {

        await this.git.cwd(inputs.WORKSPACE)
        if (await this.git.checkIsRepo()) {
            fs.rmSync(inputs.WORKSPACE, { recursive: true, force: true });
            fs.mkdirSync(inputs.WORKSPACE, { recursive: true });
            await this.git.cwd(inputs.WORKSPACE)
        }
        await this.git.init();

        const headers = {
            Authorization: `Basic ${Buffer.from(`x-access-token:${this.token}`).toString("base64")}`,
        };

        await this.git.addConfig(
            "http.https://github.com/.extraheader",
            `AUTHORIZATION: ${headers.Authorization}`,
            true,
            "local"
        );

        const actor = context.actor;
        const email = `${context.payload.sender?.id}+${actor}@users.noreply.github.com`;

        await this.git
            .addConfig("user.email", email, true, "local")
            .addConfig("user.name", actor, true, "local");

        const remote = `${context.serverUrl}/${this.owner}/${this.repo}.git`;
        await this.git.addRemote("origin", remote);

        const fetchResult = await this.git.fetch("origin", this.branch, { "--depth": 1 , "--no-tags": null });

        if (fetchResult.branches.length === 0) {
            await this.createBranchFromDefault();
        } else {
            await this.git.checkoutBranch(this.branch, `origin/${this.branch}`);
        }

        return this.pageUrl;
    }

    /** Creates a redirect page for the Allure report */
    private async createRedirectPage(redirectUrl: string): Promise<void> {
        const htmlContent = `<!DOCTYPE html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; URL=${normalizeUrl(`${redirectUrl}/index.html`)}">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">`;

        const filePath = path.posix.join(inputs.WORKSPACE, this.pagesSourcePath ?? '', inputs.prefix ?? '', 'index.html');
        await fs.promises.writeFile(filePath, htmlContent);
        await this.git.add(filePath);
        info(`Redirect 'index.html' created at ${path.posix.join(this.pagesSourcePath || '/', inputs.prefix ?? '')}`);
    }

    /** Deletes old Allure reports, keeping the latest `inputs.keep` */
    private async deleteOldReports(): Promise<void> {
        try {
            const parentDIr = path.posix.dirname(this.reportDir)
            const entries: Dirent[] = await fs.promises.readdir(parentDIr, {withFileTypes: true});
            const limit = pLimit(10);
            let paths = (
                await allFulfilledResults(
                    entries.map((entry) =>
                        limit(async () => {
                            const reportIndexHtmlPath = path.posix.join(entry.parentPath, entry.name, 'index.html');
                            if (entry.isDirectory() && fs.existsSync(reportIndexHtmlPath)) {
                                return path.dirname(reportIndexHtmlPath); // Return directory name of index.html
                            }
                            return undefined
                        })
                    )
                )
            ).filter(Boolean) as string[];

            if (paths.length > 1 && paths.length >= inputs.keep) {
                paths = await this.sortPathsByModifiedTime(paths)
                const pathsToDelete = paths.slice(0, paths.length - inputs.keep);
                await Promise.all(
                    pathsToDelete.map((pathToDelete) =>
                        limit(async () => {
                            await fs.promises.rm(pathToDelete, {recursive: true, force: true});
                            info(`Old Report deleted from '${pathToDelete}'`);
                        })
                    )
                );
                await this.git.add("-u");
            }
        } catch (e) {
            console.warn("Failed to delete old reports:", e);
        }
    }

    async sortPathsByModifiedTime(paths: string[]): Promise<string[]> {
        const limit = pLimit(5);
        const fileStats: Awaited<{ file: string; mtimeMs: number }>[] = await Promise.all(
            paths.map((file: string) => limit(async () => {
                const stats = await fs.promises.stat(file);
                return {file, mtimeMs: stats.mtimeMs};
            }))
        );
        fileStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
        return fileStats.map((item) => item.file);
    }

    /** Recursively retrieves all file paths from a directory */
    // private async getFilePathsFromDir(dir: string): Promise<string[]> {
    //     const files: string[] = [];
    //     const limit = pLimit(10);
    //
    //     const readDirectory = async (currentDir: string) => {
    //         const entries: Dirent[] = await fs.promises.readdir(currentDir, {withFileTypes: true});
    //
    //         await Promise.all(
    //             entries.map((entry) =>
    //                 limit(async () => {
    //                     const fullPath = path.join(currentDir, entry.name);
    //                     if (entry.isDirectory()) {
    //                         await readDirectory(fullPath);
    //                     } else {
    //                         files.push(fullPath);
    //                     }
    //                 })
    //             )
    //         );
    //     };
    //
    //     await readDirectory(dir);
    //     return files;
    // }

    /** Creates a branch from the default branch if it doesn't exist */
    private async createBranchFromDefault(): Promise<void> {
        const defaultBranch = (await this.git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]))
            .trim()
            .split("/")
            .pop()!;

        await this.git.checkoutBranch(this.branch, `origin/${defaultBranch}`);
        console.log(`Branch '${this.branch}' created from '${defaultBranch}'.`);
    }
    
    /** Handles Git push with retry logic specifically for concurrent push scenarios */
    private async gitPushWithRetry(): Promise<void> {
        await withRetry(async () => {
            try {
                // Pull to fetch and merge remote changes in one operation
                // Specify merge strategy to handle divergent branches
                try {
                    await this.git.pull(["--no-rebase", "origin", this.branch]);
                    console.log("Successfully pulled remote changes");
                } catch (pullError: any) {
                    console.warn(`Pull failed: ${pullError}. Will try direct push...`);
                }
                
                // Push to remote
                await this.git.push("origin", this.branch);
            } catch (error: any) {
                console.warn(`Push attempt failed: ${error.message}`);
                throw error; // Let the retry mechanism handle it
            }
        });
    }
}