import { IStorage, Order } from '../shared/index.js';
import path from 'node:path';
import fs from 'fs/promises';
import pLimit from 'p-limit';
import { ArtifactService } from '../services/artifact.service.js';
import fsSync from 'fs';
import unzipper, { Entry } from 'unzipper';
import { RequestError } from '@octokit/request-error';
import { warning } from '@actions/core';
import inputs from '../io.js';
import { allFulfilledResults } from '../utilities/util.js';

export interface GithubStorageConfig {
    fileProcessingConcurrency: number;
    showHistory: boolean;
    RESULTS_STAGING_PATH: string;
    ARCHIVE_DIR: string;
    REPORTS_DIR: string;
    HISTORY_PATH: string;
}

export class GithubStorage implements IStorage {
    private readonly HISTORY_ARCHIVE_NAME: string;

    constructor(
        private readonly provider: ArtifactService,
        readonly args: GithubStorageConfig,
    ) {
        this.HISTORY_ARCHIVE_NAME = inputs.prefix ? `${inputs.prefix}-last-history` : 'last-history';
    }

    async stageFilesFromStorage(): Promise<void> {
        await this.createStagingDirectories();
        if (this.args.showHistory) {
            await this.stageHistoryFiles();
        }
    }

    unzipToStaging(zipFilePath: string, outputDir: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const writePromises: Promise<void>[] = [];

            fsSync
                .createReadStream(zipFilePath)
                .pipe(unzipper.Parse())
                .on('entry', (entry: Entry) => {
                    if (entry.type === 'Directory') {
                        entry.autodrain();
                        return;
                    }
                    const fullPath = path.join(outputDir, entry.path);
                    const writePromise = new Promise<void>((res, rej) => {
                        const writeStream = fsSync.createWriteStream(fullPath);
                        writeStream.on('finish', res);
                        writeStream.on('error', (err) => {
                            entry.autodrain();
                            rej(err);
                        });
                        entry.pipe(writeStream);
                    });
                    writePromises.push(writePromise);
                })
                .on('close', async () => {
                    try {
                        await Promise.all(writePromises);
                        resolve(true);
                    } catch (err) {
                        reject(err);
                    }
                })
                .on('error', (err) => {
                    warning('Unzip file error');
                    reject(err);
                });
        });
    }

    async uploadArtifacts(): Promise<void> {
        if (this.args.showHistory) {
            await this.uploadHistory();
        }
    }

    // ============= Private Helper Methods =============

    /**
     * Ensures the local directories exist.
     */
    private async createStagingDirectories(): Promise<void> {
        await Promise.all([
            fs.mkdir(this.args.ARCHIVE_DIR, { recursive: true }),
            fs.mkdir(this.args.RESULTS_STAGING_PATH, { recursive: true }),
        ]);
    }

    /**
     * Downloads and stages the history archive.
     */
    private async stageHistoryFiles(): Promise<void> {
        const files = await this.provider.getFiles({
            maxResults: 10,
            matchGlob: this.HISTORY_ARCHIVE_NAME,
            order: Order.byNewestToOldest,
        });

        if (files.length === 0) {
            warning('No history files found to stage.');
            return;
        }

        const limit = pLimit(this.args.fileProcessingConcurrency);
        const tasks: Promise<any>[] = [];
        if (files.length > 1) {
            const filesToDelete = files.splice(1);
            for (const file of filesToDelete) {
                tasks.push(
                    limit(async () => {
                        try {
                            await this.provider.deleteFile(file.id);
                        } catch (error) {
                            if (error instanceof RequestError && error.status === 403) {
                                warning(
                                    `Failed to delete outdated Allure History file. Ensure that GitHub token has 'actions: write' permission`,
                                );
                            } else {
                                warning(`Delete file error: ${error}`);
                            }
                        }
                    }),
                );
            }
        }

        const downloadedPaths = await this.provider.download({
            files: [files[0]],
            destination: this.args.ARCHIVE_DIR,
        });
        if (downloadedPaths.length > 0) {
            const historyDir = path.dirname(this.args.HISTORY_PATH);
            await fs.mkdir(historyDir, { recursive: true });
            tasks.push(this.unzipToStaging(downloadedPaths[0], historyDir));
        }
        await allFulfilledResults(tasks);
    }

    /**
     * Uploads only the history.jsonl file to the remote storage.
     */
    private async uploadHistory(): Promise<void> {
        try {
            await fs.access(this.args.HISTORY_PATH);
            const historyDir = path.dirname(this.args.HISTORY_PATH);
            await this.provider.uploadFile(this.args.HISTORY_PATH, historyDir, this.HISTORY_ARCHIVE_NAME);
        } catch {
            warning('No history file found. History upload skipped.');
        }
    }

}
