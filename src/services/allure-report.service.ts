import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { info, warning } from '@actions/core';
import { propertiesReader } from 'properties-reader';
import { CommandRunner } from '../interfaces/command.interface.js';
import { ExecutorInterface } from '../interfaces/executor.interface.js';
import { AllureService } from './allure.service.js';

export interface AllureConfig {
    RESULTS_STAGING_PATH: string;
    REPORTS_DIR: string;
    HISTORY_PATH: string;
    historyLimit: number;
    showHistory: boolean;
    reportName?: string;
    reportLanguage?: string;
}

export class Allure {
    private readonly allureRunner: CommandRunner;
    private readonly config: AllureConfig;

    constructor({ allureRunner, config }: { allureRunner?: CommandRunner; config: AllureConfig }) {
        this.allureRunner = allureRunner ?? new AllureService();
        this.config = config;
    }

    readEnvironments(): Map<string, string> | undefined {
        try {
            const properties = propertiesReader({
                sourceFile: join(this.config.RESULTS_STAGING_PATH, 'environment.properties'),
            });
            const map = new Map<string, string>();
            info('Environments');
            for (const [key, value] of properties.entries()) {
                info(`${key}: ${value}`);
                map.set(key, String(value));
            }
            return map;
        } catch (e) {
            if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw e;
        }
    }

    async generate(executor?: ExecutorInterface): Promise<string> {
        if (executor) {
            const executorPath = join(this.config.RESULTS_STAGING_PATH, 'executor.json');
            await writeFile(executorPath, JSON.stringify(executor, null, 2), { encoding: 'utf8' });
        }

        const configPath = await this.writeAllureConfig();
        const command = [
            'generate',
            this.config.RESULTS_STAGING_PATH,
            '--config',
            configPath,
            '--output',
            this.config.REPORTS_DIR,
        ];

        const { exitCode, stdout, stderr } = await this.allureRunner.runCommand(command);
        if (stdout) info(stdout);
        if (exitCode !== 0) {
            throw new Error(`Failed to generate Allure report (exit code ${exitCode}): ${stderr}`);
        }

        await this.ensureEnvironmentWidget();

        if (this.config.showHistory) {
            await this.postProcessHistory(executor?.reportUrl);
            if (executor?.reportUrl) {
                await this.createHistoryRedirect();
            }
        }

        return this.config.REPORTS_DIR;
    }

    private async writeAllureConfig(): Promise<string> {
        const allurerc: Record<string, unknown> = {
            name: this.config.reportName ?? 'Allure Report',
            appendHistory: true,
            plugins: {
                awesome: {
                    enabled: true,
                    options: {
                        ...(this.config.reportLanguage && { reportLanguage: this.config.reportLanguage }),
                    },
                },
            },
        };

        if (this.config.showHistory) {
            allurerc.historyPath = this.config.HISTORY_PATH;
            allurerc.historyLimit = this.config.historyLimit;
        }

        const configPath = join(this.config.RESULTS_STAGING_PATH, 'allurerc.json');
        await writeFile(configPath, JSON.stringify(allurerc, null, 2), 'utf8');
        return configPath;
    }

    /**
     * Patches the latest history entry with the report URL and truncates to the history limit.
     */
    private async postProcessHistory(reportUrl?: string): Promise<void> {
        try {
            const content = await readFile(this.config.HISTORY_PATH, 'utf8');
            const trimmed = content.trimEnd();
            if (!trimmed) return;
            let lines = trimmed.split('\n');

            if (reportUrl) {
                const lastEntry = JSON.parse(lines[lines.length - 1]);
                lastEntry.url = reportUrl;
                lines[lines.length - 1] = JSON.stringify(lastEntry);
            }

            if (lines.length > this.config.historyLimit) {
                lines = lines.slice(-this.config.historyLimit);
            }

            await writeFile(this.config.HISTORY_PATH, lines.join('\n') + '\n', 'utf8');
        } catch (e) {
            warning(`Failed to post-process history: ${e}`);
        }
    }

    /**
     * Creates an awesome/index.html redirect in the report directory.
     * Allure 3's awesome theme appends /awesome to history URLs, but single-plugin
     * reports don't have that subdirectory. This redirect preserves the hash fragment
     * so the SPA can route to the correct test result.
     * Skipped when awesome/ already exists (multi-plugin mode).
     */
    private async createHistoryRedirect(): Promise<void> {
        try {
            const awesomeDir = join(this.config.REPORTS_DIR, 'awesome');
            try {
                const dirStat = await stat(awesomeDir);
                if (dirStat.isDirectory()) return; // multi-plugin mode — awesome/ is a real plugin output
            } catch {
                // doesn't exist — create the redirect
            }
            await mkdir(awesomeDir, { recursive: true });
            const html = `<!DOCTYPE html>
<html><head><script>window.location.replace("../" + window.location.hash);</script></head><body></body></html>`;
            await writeFile(join(awesomeDir, 'index.html'), html, 'utf8');
        } catch (e) {
            warning(`Failed to create history redirect: ${e}`);
        }
    }

    /**
     * Ensures widgets/allure_environment.json exists in both the report root and
     * the awesome/ subdirectory. The Allure 3 awesome theme fetches this file when
     * opening individual test results — a 404 crashes the SPA with an undefined
     * read on `.message`. Writing an empty array makes missing environment data
     * non-fatal.
     */
    private async ensureEnvironmentWidget(): Promise<void> {
        const candidates = [
            join(this.config.REPORTS_DIR, 'widgets', 'allure_environment.json'),
            join(this.config.REPORTS_DIR, 'awesome', 'widgets', 'allure_environment.json'),
        ];
        for (const filePath of candidates) {
            try {
                await stat(filePath);
            } catch {
                try {
                    await mkdir(dirname(filePath), { recursive: true });
                    await writeFile(filePath, '[]', 'utf8');
                } catch (e) {
                    warning(`Failed to write environment widget at ${filePath}: ${e}`);
                }
            }
        }
    }
}
