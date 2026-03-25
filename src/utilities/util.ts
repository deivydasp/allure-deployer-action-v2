import { warning } from '@actions/core';
import * as fs from 'fs/promises';
import path from 'node:path';
import { SlackConfig } from '../shared/interfaces/slack.interface.js';

export const ERROR_MESSAGES = {
    EMPTY_RESULTS: 'Error: The specified results directory is empty.',
    NO_RESULTS_DIR: 'Error: No Allure result files in the specified directory.',
    INVALID_SLACK_CRED: `Invalid Slack credential. 'slack_channel' and 'slack_token' must be provided together`,
    NO_JAVA: 'Error: JAVA_HOME not found. Allure 2.32 requires JAVA runtime installed',
};

export function validateSlackConfig(channel: string, token: string): SlackConfig | undefined {
    // Check if only one of the variables is provided
    if ((channel && !token) || (!channel && token)) {
        warning(ERROR_MESSAGES.INVALID_SLACK_CRED);
    }
    if (channel && token) {
        return { channel, token };
    }
    return undefined;
}

/**
 * Configuration for retry logic
 */
export interface RetryConfig {
    maxRetries: number;
    initialDelay: number;
    maxDelay: number;
    backoffFactor: number;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    initialDelay: 1000, // 1 second
    maxDelay: 10000, // 10 seconds
    backoffFactor: 2,
};

/**
 * Determines if an error is retryable based on its status code
 */
export function isRetryableError(error: { status?: number; message?: string }): boolean {
    const retryableStatusCodes = [
        408, // Request Timeout
        429, // Too Many Requests
        500, // Internal Server Error
        502, // Bad Gateway
        503, // Service Unavailable
        504, // Gateway Timeout
    ];

    const message = error.message?.toLowerCase() ?? '';
    return (
        (error.status !== undefined && retryableStatusCodes.includes(error.status)) ||
        message.includes('rate limit') ||
        message.includes('timeout') ||
        message.includes('network error') ||
        message.includes('tip of your current branch is behind')
    );
}

/**
 * Utility function to implement retry logic with exponential backoff
 * @param operation - Function to retry
 * @param config - Retry configuration
 * @returns Result of the operation
 */
export async function withRetry<T>(
    operation: () => Promise<T>,
    config: RetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<T> {
    let delay = config.initialDelay;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            // Don't retry if it's not a retryable error
            if (!isRetryableError(error)) {
                throw error;
            }

            // If this was our last attempt, throw the error
            if (attempt === config.maxRetries) {
                throw new Error(
                    `Failed after ${config.maxRetries} attempts. Last error: ${error?.message || 'Unknown error'}`,
                );
            }

            console.warn(`Attempt ${attempt} failed. Retrying in ${delay}ms. Error: ${error.message}`);

            // Wait before retrying
            await new Promise((resolve) => setTimeout(resolve, delay));

            // Calculate next delay with exponential backoff
            delay = Math.min(delay * config.backoffFactor, config.maxDelay);
        }
    }

    throw new Error('Unreachable: withRetry loop completed without return or throw');
}

export async function getAbsoluteFilePaths(dir: string): Promise<string[]> {
    const filesAndDirs = await fs.readdir(dir);
    const filePaths: string[] = [];

    for (const entry of filesAndDirs) {
        const fullPath = path.resolve(dir, entry);
        const stats = await fs.stat(fullPath);

        if (stats.isDirectory()) {
            filePaths.push(...(await getAbsoluteFilePaths(fullPath)));
        } else if (stats.isFile()) {
            filePaths.push(fullPath);
        }
    }

    return filePaths;
}

export async function copyDirectory(sourceDir: string, destDir: string): Promise<void> {
    await fs.cp(sourceDir, destDir, { recursive: true });
    console.log(`Copied directory from ${sourceDir} to ${destDir}`);
}

export async function allFulfilledResults<T>(promises: Promise<T>[]): Promise<T[]> {
    const results = await Promise.allSettled(promises);
    return results
        .filter((result): result is PromiseFulfilledResult<Awaited<T>> => {
            if (result.status === 'rejected') {
                warning(String(result.reason));
                return false;
            }
            return true;
        })
        .map((result) => result.value);
}

export function removeTrailingSlash(p: string) {
    return p.length > 1 && (p.endsWith('/') || p.endsWith('\\')) ? p.slice(0, -1) : p;
}
