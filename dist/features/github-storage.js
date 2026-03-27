import { Order } from '../shared/index.js';
import path from 'node:path';
import fs from 'fs/promises';
import pLimit from 'p-limit';
import fsSync from 'fs';
import unzipper from 'unzipper';
import { RequestError } from '@octokit/request-error';
import { warning } from '@actions/core';
import inputs from '../io.js';
import { allFulfilledResults } from '../utilities/util.js';
export class GithubStorage {
    constructor(provider, args) {
        this.provider = provider;
        this.args = args;
        this.HISTORY_ARCHIVE_NAME = inputs.prefix ? `${inputs.prefix}-last-history` : 'last-history';
    }
    async stageFilesFromStorage() {
        await this.createStagingDirectories();
        if (this.args.showHistory) {
            await this.stageHistoryFiles();
        }
    }
    unzipToStaging(zipFilePath, outputDir) {
        return new Promise((resolve, reject) => {
            const writePromises = [];
            fsSync
                .createReadStream(zipFilePath)
                .pipe(unzipper.Parse())
                .on('entry', (entry) => {
                if (entry.type === 'Directory') {
                    entry.autodrain();
                    return;
                }
                const fullPath = path.join(outputDir, entry.path);
                const writePromise = new Promise((res, rej) => {
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
                }
                catch (err) {
                    reject(err);
                }
            })
                .on('error', (err) => {
                warning('Unzip file error');
                reject(err);
            });
        });
    }
    async uploadArtifacts() {
        if (this.args.showHistory) {
            await this.uploadHistory();
        }
    }
    // ============= Private Helper Methods =============
    /**
     * Ensures the local directories exist.
     */
    async createStagingDirectories() {
        await Promise.all([
            fs.mkdir(this.args.ARCHIVE_DIR, { recursive: true }),
            fs.mkdir(this.args.RESULTS_STAGING_PATH, { recursive: true }),
        ]);
    }
    /**
     * Downloads and stages the history archive.
     */
    async stageHistoryFiles() {
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
        const tasks = [];
        if (files.length > 1) {
            const filesToDelete = files.splice(1);
            for (const file of filesToDelete) {
                tasks.push(limit(async () => {
                    try {
                        await this.provider.deleteFile(file.id);
                    }
                    catch (error) {
                        if (error instanceof RequestError && error.status === 403) {
                            warning(`Failed to delete outdated Allure History file. Ensure that GitHub token has 'actions: write' permission`);
                        }
                        else {
                            warning(`Delete file error: ${error}`);
                        }
                    }
                }));
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
     * Uploads the history.jsonl file to the remote storage.
     */
    async uploadHistory() {
        try {
            await fs.access(this.args.HISTORY_PATH);
            const historyDir = path.dirname(this.args.HISTORY_PATH);
            await this.provider.upload(historyDir, this.HISTORY_ARCHIVE_NAME);
        }
        catch {
            warning('No history file found. History upload skipped.');
        }
    }
}
