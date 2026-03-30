import { Order, StorageFile, StorageProvider } from '../interfaces/storage-provider.interface.js';
import { DefaultArtifactClient } from '@actions/artifact';
import pLimit from 'p-limit';
import { DEFAULT_RETRY_CONFIG, allFulfilledResults, withRetry } from '../utilities/util.js';
import { Octokit } from '@octokit/rest';
import https from 'https';
import { createWriteStream, unlink } from 'node:fs';
import path from 'node:path';
import * as github from '@actions/github';
import { RequestError } from '@octokit/request-error';

export interface ArtifactResponse extends StorageFile {
    node_id: string;
    size_in_bytes: number;
    url: string;
    archive_download_url: string;
    expired: boolean;
    expires_at: string | null;
    updated_at: string | null;
}

export interface ArtifactServiceConfig {
    token: string;
    owner: string;
    repo: string;
}

export class ArtifactService implements StorageProvider {
    private readonly artifactClient: DefaultArtifactClient;
    private readonly octokit: Octokit;
    private readonly owner: string;
    private readonly repo: string;

    constructor({ token, repo, owner }: ArtifactServiceConfig) {
        this.artifactClient = new DefaultArtifactClient();
        this.octokit = new Octokit({ auth: token, baseUrl: github.context.apiUrl });
        this.owner = owner;
        this.repo = repo;
    }

    async hasArtifactReadPermission(): Promise<boolean> {
        try {
            await this.getFiles({ maxResults: 1 });
            return true;
        } catch (_e) {
            return false;
        }
    }

    async deleteFile(id: number): Promise<void> {
        const operation = async () => {
            try {
                await this.octokit.request('DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}', {
                    owner: this.owner,
                    repo: this.repo,
                    artifact_id: id,
                    headers: {
                        'X-GitHub-Api-Version': '2022-11-28',
                    },
                });
            } catch (error: unknown) {
                // 404 means already deleted (e.g. by concurrent workflow) — treat as success
                if (error instanceof RequestError && error.status === 404) return;
                throw error;
            }
        };
        await withRetry(operation, DEFAULT_RETRY_CONFIG);
    }

    async download({
        destination,
        concurrency = 5,
        files,
    }: {
        destination: string;
        concurrency?: number;
        files: ArtifactResponse[];
    }): Promise<string[]> {
        const limit = pLimit(concurrency);
        const promises: Promise<string>[] = [];
        for (const file of files) {
            promises.push(
                limit(async (): Promise<string> => {
                    const filePath = path.join(destination, `${file.id}.zip`);
                    const operation = async () => {
                        return await this.octokit.request(
                            'GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}',
                            {
                                owner: this.owner,
                                repo: this.repo,
                                artifact_id: file.id,
                                archive_format: 'zip',
                                headers: {
                                    'X-GitHub-Api-Version': '2022-11-28',
                                },
                            },
                        );
                    };
                    const urlResponse = await withRetry(operation, DEFAULT_RETRY_CONFIG);
                    const artifactUrl = urlResponse.url;
                    return new Promise((resolve, reject) => {
                        const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
                        const req = https
                            .get(artifactUrl, { timeout: DOWNLOAD_TIMEOUT_MS }, (response) => {
                                if (response.statusCode !== 200) {
                                    response.resume();
                                    reject(
                                        new Error(
                                            `Failed to get '${artifactUrl}' (${response.statusCode}) ${response.statusMessage}`,
                                        ),
                                    );
                                    return;
                                }
                                const fileStream = createWriteStream(filePath);
                                response.on('error', (err) => {
                                    fileStream.destroy();
                                    unlink(filePath, () => reject(err));
                                });
                                fileStream.on('error', (err) => {
                                    response.destroy();
                                    unlink(filePath, () => reject(err));
                                });
                                fileStream.on('finish', () => {
                                    fileStream.close();
                                    resolve(filePath);
                                });
                                response.pipe(fileStream);
                            })
                            .on('timeout', () => {
                                req.destroy(new Error(`Artifact download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`));
                            })
                            .on('error', (err) => {
                                unlink(filePath, () => reject(err));
                            });
                    });
                }),
            );
        }
        return await allFulfilledResults(promises);
    }

    async getFiles({
        matchGlob,
        order = Order.byOldestToNewest,
        maxResults,
    }: {
        matchGlob?: string;
        order?: Order;
        maxResults?: number;
    }): Promise<ArtifactResponse[]> {
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

    private sortFiles(files: ArtifactResponse[], order: Order): ArtifactResponse[] {
        if (!files || files.length < 2) {
            return files;
        }
        return [...files].sort((a, b) => {
            const aTime = new Date(a.created_at!).getTime();
            const bTime = new Date(b.created_at!).getTime();
            return order === Order.byOldestToNewest ? aTime - bTime : bTime - aTime;
        });
    }

    async uploadFile(absoluteFilePath: string, rootDir: string, destination: string): Promise<void> {
        const work = async () => await this.artifactClient.uploadArtifact(destination, [absoluteFilePath], rootDir);
        await withRetry(work, DEFAULT_RETRY_CONFIG);
    }
}
