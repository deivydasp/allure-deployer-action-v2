import { Order } from '../shared/index.js';
import { DefaultArtifactClient } from '@actions/artifact';
import pLimit from 'p-limit';
import { DEFAULT_RETRY_CONFIG, allFulfilledResults, getAbsoluteFilePaths, withRetry } from '../utilities/util.js';
import { Octokit } from '@octokit/rest';
import https from 'https';
import fs from 'fs';
import path from 'node:path';
import * as github from '@actions/github';
export class ArtifactService {
    constructor({ token, repo, owner }) {
        this.artifactClient = new DefaultArtifactClient();
        this.octokit = new Octokit({ auth: token, baseUrl: github.context.apiUrl });
        this.owner = owner;
        this.repo = repo;
    }
    async hasArtifactReadPermission() {
        try {
            await this.getFiles({ maxResults: 1 });
            return true;
        }
        catch (_e) {
            return false;
        }
    }
    async deleteFile(id) {
        const operation = async () => {
            return await this.octokit.request('DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}', {
                owner: this.owner,
                repo: this.repo,
                artifact_id: id,
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            });
        };
        await withRetry(operation, DEFAULT_RETRY_CONFIG);
    }
    deleteFiles(_matchGlob) {
        throw new Error('Not implemented');
    }
    async download({ destination, concurrency = 5, files, }) {
        const limit = pLimit(concurrency);
        const promises = [];
        for (const file of files) {
            promises.push(limit(async () => {
                const filePath = path.join(destination, `${file.id}.zip`);
                const operation = async () => {
                    return await this.octokit.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', {
                        owner: this.owner,
                        repo: this.repo,
                        artifact_id: file.id,
                        archive_format: 'zip',
                        headers: {
                            'X-GitHub-Api-Version': '2022-11-28',
                        },
                    });
                };
                const urlResponse = await withRetry(operation, DEFAULT_RETRY_CONFIG);
                const artifactUrl = urlResponse.url;
                return new Promise((resolve, reject) => {
                    https
                        .get(artifactUrl, (response) => {
                        if (response.statusCode !== 200) {
                            response.resume();
                            reject(new Error(`Failed to get '${artifactUrl}' (${response.statusCode}) ${response.statusMessage}`));
                            return;
                        }
                        const fileStream = fs.createWriteStream(filePath);
                        response.on('error', (err) => {
                            fileStream.destroy();
                            fs.unlink(filePath, () => reject(err));
                        });
                        fileStream.on('error', (err) => {
                            response.destroy();
                            fs.unlink(filePath, () => reject(err));
                        });
                        fileStream.on('finish', () => {
                            fileStream.close();
                            resolve(filePath);
                        });
                        response.pipe(fileStream);
                    })
                        .on('error', (err) => {
                        fs.unlink(filePath, () => reject(err));
                    });
                });
            }));
        }
        return await allFulfilledResults(promises);
    }
    async getFiles({ matchGlob, order = Order.byOldestToNewest, maxResults, }) {
        const operation = async () => {
            return await this.octokit.request('GET /repos/{owner}/{repo}/actions/artifacts', {
                owner: this.owner,
                repo: this.repo,
                name: matchGlob,
                per_page: maxResults,
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            });
        };
        const response = await withRetry(operation, DEFAULT_RETRY_CONFIG);
        const files = response.data.artifacts.filter((file) => file.created_at && !file.expired);
        return this.sortFiles(files, order);
    }
    sortFiles(files, order) {
        if (!files || files.length < 2) {
            return files;
        }
        return files.sort((a, b) => {
            const aTime = new Date(a.created_at).getTime();
            const bTime = new Date(b.created_at).getTime();
            return order === Order.byOldestToNewest ? aTime - bTime : bTime - aTime;
        });
    }
    async upload(filePath, destination) {
        const files = await getAbsoluteFilePaths(filePath);
        const work = async () => await this.artifactClient.uploadArtifact(destination, files, filePath);
        await withRetry(work, DEFAULT_RETRY_CONFIG);
    }
    async uploadFile(absoluteFilePath, rootDir, destination) {
        const work = async () => await this.artifactClient.uploadArtifact(destination, [absoluteFilePath], rootDir);
        await withRetry(work, DEFAULT_RETRY_CONFIG);
    }
}
