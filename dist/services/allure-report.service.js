import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { info } from '@actions/core';
import { propertiesReader } from 'properties-reader';
import { AllureService } from './allure.service.js';
export class Allure {
    allureRunner;
    config;
    constructor({ allureRunner, config }) {
        this.allureRunner = allureRunner ?? new AllureService();
        this.config = config;
    }
    readEnvironments() {
        try {
            const properties = propertiesReader({
                sourceFile: join(this.config.RESULTS_STAGING_PATH, 'environment.properties'),
            });
            const map = new Map();
            info('Environments');
            for (const [key, value] of properties.entries()) {
                info(`${key}: ${value}`);
                map.set(key, String(value));
            }
            return map;
        }
        catch (e) {
            if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
                return undefined;
            }
            throw e;
        }
    }
    async generate(executor) {
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
        if (stdout)
            info(stdout);
        if (exitCode !== 0) {
            throw new Error(`Failed to generate Allure report (exit code ${exitCode}): ${stderr}`);
        }
        return this.config.REPORTS_DIR;
    }
    async writeAllureConfig() {
        const allurerc = {
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
