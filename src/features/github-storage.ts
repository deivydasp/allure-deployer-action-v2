import {IStorage, Order} from "../shared/index.js";
import path from "node:path";
import fs from "fs/promises";
import pLimit from "p-limit";
import {ArtifactService} from "../services/artifact.service.js";
import * as os from "node:os";
import fsSync from "fs";
import unzipper, {Entry} from "unzipper";
import {RequestError} from "@octokit/request-error";
import * as core from "@actions/core";
import inputs from "../io.js";
import {allFulfilledResults} from "../utilities/util.js";


export interface GithubStorageConfig {
    fileProcessingConcurrency: number;
    clean: boolean;
    showHistory: boolean;
    retries: number;
    RESULTS_PATHS: string[];
    RESULTS_STAGING_PATH: string;
    ARCHIVE_DIR: string;
    REPORTS_DIR: string;
}

export class GithubStorage implements IStorage {
    private readonly HISTORY_ARCHIVE_NAME: string
    private readonly RESULTS_ARCHIVE_NAME: string

    constructor(private readonly provider: ArtifactService, readonly args: GithubStorageConfig) {
        this.HISTORY_ARCHIVE_NAME = inputs.prefix ? `${inputs.prefix}-last-history` : 'last-history';
        this.RESULTS_ARCHIVE_NAME = inputs.prefix ? `${inputs.prefix}-allure-results` : 'allure-results';
    }

    async stageFilesFromStorage(): Promise<void> {
        await this.createStagingDirectories();
        const tasks: Promise<void>[] = [];
        if (this.args.showHistory) {
            tasks.push(this.stageHistoryFiles());
        }
        if (this.args.retries > 0) {
            tasks.push(this.stageResultFiles(this.args.retries));
        }
        await allFulfilledResults(tasks);
    }

    unzipToStaging(zipFilePath: string, outputDir: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            fsSync.createReadStream(zipFilePath)
                .pipe(unzipper.Parse())
                .on("entry", async (entry: Entry) => {
                    const fullPath = path.posix.join(outputDir, entry.path);
                    entry.pipe(fsSync.createWriteStream(fullPath));
                })
                .on("close", () => resolve(true))
                .on("error", (err) => {
                    console.warn("Unzip file error");
                    reject(err);
                });
        });
    }

    async uploadArtifacts(): Promise<void> {
        const promises: Promise<void>[] = [];
        if(this.args.showHistory) {
            promises.push(this.uploadHistory());
        }
        if(this.args.retries > 0) {
            promises.push(this.uploadNewResults());
        }
        await allFulfilledResults(promises);
    }

    // ============= Private Helper Methods =============

    /**
     * Ensures the local directories exist.
     */
    private async createStagingDirectories(): Promise<void> {
        await allFulfilledResults([
            fs.mkdir(this.args.ARCHIVE_DIR, {recursive: true}),
            fs.mkdir(this.args.RESULTS_STAGING_PATH, {recursive: true})
        ])
    }

    /**
     * Downloads and stages the history archive.
     */
    private async stageHistoryFiles(): Promise<void> {
        const files = await this.provider.getFiles({
            maxResults: 10,
            matchGlob: this.HISTORY_ARCHIVE_NAME,
            order: Order.byNewestToOldest
        });

        if (files.length === 0) {
            console.warn("No history files found to stage.");
            return;
        }

        const limit = pLimit(this.args.fileProcessingConcurrency);
        const tasks: Promise<any>[] = [];
        if (files.length > 1) {
            const filesToDelete = files.splice(1)
            for (const file of filesToDelete) {
                tasks.push(limit(async () => {
                    try {
                        await this.provider.deleteFile(file.id);
                    } catch (error) {
                        if (error instanceof RequestError && error.status === 403) {
                            core.warning(`Failed to delete outdated Allure History file. Ensure that GitHub token has 'actions: write' permission`)
                        } else {
                            console.warn("Delete file error:", error);
                        }
                    }
                }))
            }
        }

        const downloadedPaths = await this.provider.download({
            files: [files[0]],
            destination: this.args.ARCHIVE_DIR,
        });
        if (downloadedPaths.length > 0) {
            const stagingDir = path.join(this.args.RESULTS_STAGING_PATH, "history");
            await fs.mkdir(stagingDir, {recursive: true});
            tasks.push(this.unzipToStaging(downloadedPaths[0], stagingDir));
        }
        await allFulfilledResults(tasks);
    }

    /**
     * Stages the result files and deletes older files exceeding the retry limit.
     * @param retries - Maximum number of files to keep.
     */
    private async stageResultFiles(retries: number): Promise<void> {
        const files = await this.provider.getFiles({
            order: Order.byOldestToNewest,
            matchGlob: this.RESULTS_ARCHIVE_NAME,
            maxResults: retries
        });
        if (files.length === 0) return

        const limit = pLimit(this.args.fileProcessingConcurrency);
        const tasks: Promise<void>[] = [];
        if (files.length > retries) {
            const filesToDelete = files.slice(0, files.length - retries);
            for (const file of filesToDelete) {
                tasks.push(limit(async () => {
                    try {
                        await this.provider.deleteFile(file.id);
                    } catch (error) {
                        if (error instanceof RequestError && error.status === 403) {
                            core.warning(`Failed to delete outdated Allure Result files. Ensure that GitHub token has 'actions: write' permission`)
                        } else {
                            console.warn("Delete file error:", error);
                        }
                    }
                }))
            }
        }

        const downloadedPaths = await this.provider.download({
            files,
            destination: this.args.ARCHIVE_DIR,
        });

        for (const filePath of downloadedPaths) {
            tasks.push(limit(async () => {
                await this.unzipToStaging(filePath, this.args.RESULTS_STAGING_PATH);
            }))
        }
        await allFulfilledResults(tasks);
    }

    /**
     * Returns the path for the history folder.
     */
    private getHistoryFolder(): string {
        return path.join(this.args.REPORTS_DIR, "history");
    }

    /**
     * Zips and uploads new results to the remote storage.
     *
     */
    private async uploadNewResults(): Promise<void> {
        let resultPath: string
        if (this.args.RESULTS_PATHS.length == 1) {
            resultPath = this.args.RESULTS_PATHS[0]
        } else {
            resultPath = path.join(os.tmpdir(), 'allure-deployer-results-temp')
            // Copy result files from multiple result directories to a temporary directory for upload
            await this.copyResultFiles({from: this.args.RESULTS_PATHS, to: resultPath})
        }
        await this.provider.upload(resultPath, this.RESULTS_ARCHIVE_NAME);
    }

    /**
     * Zips and uploads the history archive to the remote storage.
     */
    private async uploadHistory(): Promise<void> {
        await this.provider.upload(this.getHistoryFolder(), this.HISTORY_ARCHIVE_NAME);
    }

    private async copyResultFiles({
                                      from,
                                      to,
                                      concurrency = 10,
                                      overwrite = false,
                                      exclude = ['executor.json', 'environment.properties']
                                  }: {
        from: string[]; // array of result directories
        to: string;
        concurrency?: number;
        overwrite?: boolean;
        exclude?: string[]
    }): Promise<number> {
        const limit = pLimit(concurrency); // Limit concurrency
        const copyPromises = [];
        let successCount = 0;

        // Ensure the destination directory exists
        await fs.mkdir(to, {recursive: true});

        // Iterate over each directory in the `from` array
        for (const dir of from) {
            try {
                // Get the list of files from the current directory
                const directoryEntries = await fs.readdir(dir, {withFileTypes: true});

                for (const file of directoryEntries) {
                    // Skip directories in Allure Result path, process files only
                    if (!file.isFile()) continue;
                    // Skip excluded files
                    if (exclude.includes(path.basename(file.name))) continue

                    copyPromises.push(
                        limit(async () => {
                            try {
                                const fileToCopy = path.join(dir, file.name);
                                const destination = path.join(to, file.name);
                                await fs.cp(fileToCopy, destination, {force: overwrite, errorOnExist: false});
                                successCount++;
                            } catch (error) {
                                console.log(`Error copying file ${file.name} from ${dir}:`, error);
                            }
                        })
                    );
                }
            } catch (error) {
                console.log(`Error reading directory: ${dir}`, error);
            }
        }

        await Promise.all(copyPromises); // Wait for all copy operations to complete
        return successCount;
    }

}