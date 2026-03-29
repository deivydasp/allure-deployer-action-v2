import { info, warning } from '@actions/core';
import * as fs from 'fs/promises';

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
        // Git push rejection — match loosely to handle different git versions/locales
        message.includes('tip of your current branch is behind') ||
        message.includes('failed to push some refs') ||
        message.includes('non-fast-forward') ||
        message.includes('[rejected]')
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
                    { cause: error },
                );
            }

            // Add jitter: randomize between 50%-100% of delay to prevent thundering herd
            const jitteredDelay = Math.floor(delay * (0.5 + Math.random() * 0.5));
            warning(`Attempt ${attempt} failed. Retrying in ${jitteredDelay}ms. Error: ${error.message}`);

            await new Promise((resolve) => setTimeout(resolve, jitteredDelay));

            // Calculate next delay with exponential backoff
            delay = Math.min(delay * config.backoffFactor, config.maxDelay);
        }
    }

    throw new Error('Unreachable: withRetry loop completed without return or throw');
}

export async function copyDirectory(sourceDir: string, destDir: string): Promise<void> {
    await fs.cp(sourceDir, destDir, { recursive: true });
    info(`Copied directory from ${sourceDir} to ${destDir}`);
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
