import {Order, StorageProvider} from "../shared/index.js";
import {DefaultArtifactClient} from '@actions/artifact'
import pLimit from "p-limit";
import {DEFAULT_RETRY_CONFIG, allFulfilledResults, getAbsoluteFilePaths, withRetry} from "../utilities/util.js";
import {Octokit} from "@octokit/rest";
import https from 'https';
import fs from "fs";
import path from "node:path";
import * as github from "@actions/github";

export interface WorkflowRun {
    id?: number;
    repository_id: number;
    head_repository_id: number;
    head_branch: string;
    head_sha: string;
}

export interface ArtifactResponse {
    id: number;
    node_id: string;
    name: string;
    size_in_bytes: number;
    url: string;
    archive_download_url: string;
    expired: boolean;
    created_at: string | null;
    expires_at: string | null;
    updated_at: string | null;
    workflow_run?: WorkflowRun | object | null;
}

export interface ArtifactServiceConfig {
    token: string;
    owner: string;
    repo: string;
}

export class ArtifactService implements StorageProvider {
    bucket: any;
    prefix: string | undefined;
    artifactClient: DefaultArtifactClient;
    octokit: Octokit;
    owner: string;
    repo: string;
    token: string;

    constructor({token, repo, owner}: ArtifactServiceConfig) {
        this.artifactClient = new DefaultArtifactClient();
        this.octokit = new Octokit({auth: token, baseUrl: github.context.apiUrl});
        this.owner = owner;
        this.repo = repo;
        this.token = token;
    }

    async hasArtifactReadPermission(): Promise<boolean> {
        try {
            await this.getFiles({maxResults: 1})
            return true
        } catch (_e) {
            return false;
        }
    }

    async deleteFile(id: number): Promise<void> {
        const operation = async () => {
            return await this.octokit.request('DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}', {
                owner: this.owner,
                repo: this.repo,
                artifact_id: id,
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            })
        }
        await withRetry(operation, DEFAULT_RETRY_CONFIG);
    }

    deleteFiles(_matchGlob?: string): Promise<void> {
        throw new Error('Not implemented');
    }

    async download({destination, concurrency = 5, files}: {
        destination: string;
        concurrency?: number;
        files: ArtifactResponse[]
    }): Promise<string[]> {

        const limit = pLimit(concurrency);
        const promises: Promise<string>[] = [];
        for (const file of files) {
            promises.push(limit(async (): Promise<string> => {
                const filePath = path.join(destination, `${file.id}.zip`);
                return new Promise(async (resolve, reject) => {
                    try {
                        const operation = async () => {
                            return await this.octokit.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', {
                                owner: this.owner,
                                repo: this.repo,
                                artifact_id: file.id,
                                archive_format: 'zip',
                                headers: {
                                    'X-GitHub-Api-Version': '2022-11-28'
                                }
                            })
                        }
                        const urlResponse = await withRetry(operation, DEFAULT_RETRY_CONFIG)
                        if (!urlResponse) {
                            reject(urlResponse)
                        } else {
                            const artifactUrl = urlResponse.url
                            https.get(artifactUrl, (response) => {
                                if (response.statusCode !== 200) {
                                    reject(`Failed to get '${artifactUrl}' (${response.statusCode}) ${response.statusMessage}`);
                                }
                                const fileStream = fs.createWriteStream(filePath);
                                response.pipe(fileStream);
                                fileStream.on('finish', () => {
                                    fileStream.close();
                                    resolve(filePath);
                                });
                            }).on('error', (err) => {
                                fs.unlink(filePath, () => reject(err)); // Delete the file if an error occurs
                            });
                        }
                    } catch (e) {
                        reject(e)
                    }
                });
            }))
        }
        return await allFulfilledResults(promises)
    }

    async getFiles({matchGlob, order = Order.byOldestToNewest, maxResults}: {
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
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            })
        }
        const response = await withRetry(operation, DEFAULT_RETRY_CONFIG)
        const files = response.data.artifacts.filter(file => file.created_at && !file.expired);
        return this.sortFiles(files, order)
    }

    sortFiles(files: ArtifactResponse[], order: Order): ArtifactResponse[] {
        if (!files || files.length < 2) {
            return files;
        }
        return files.sort((a, b) => {
            const aTime = new Date(a.created_at!).getTime();
            const bTime = new Date(b.created_at!).getTime();
            return order === Order.byOldestToNewest ? aTime - bTime : bTime - aTime;
        });
    }

    async upload(filePath: string, destination: string): Promise<void> {
        const files = getAbsoluteFilePaths(filePath)
        const work = async () => await this.artifactClient.uploadArtifact(destination, files, filePath)
        await withRetry(work, DEFAULT_RETRY_CONFIG)
    }

}