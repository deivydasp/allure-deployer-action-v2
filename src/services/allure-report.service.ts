import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { info } from '@actions/core';
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
                        groupBy: ['parentSuite', 'suite'],
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
}
