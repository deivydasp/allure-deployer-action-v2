import * as fs from 'fs/promises';
import * as path from 'node:path';
import { info } from '@actions/core';
import { propertiesReader } from 'properties-reader';
import { AllureService } from '../services/allure.service.js';
export class Allure {
    constructor({ allureRunner, config }) {
        this.allureRunner = allureRunner ?? new AllureService();
        this.config = config;
    }
    get environments() {
        const map = new Map();
        try {
            const properties = propertiesReader({
                sourceFile: path.join(this.config.RESULTS_STAGING_PATH, 'environment.properties'),
            });
            info('Environments');
            for (const [key, value] of properties.entries()) {
                info(`${key}: ${value}`);
                map.set(key, String(value));
            }
            return map;
        }
        catch (e) {
            if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
                // environment.properties file does not exist
            }
            else {
                throw e;
            }
        }
        return undefined;
    }
    async generate(executor) {
        if (executor) {
            const executorPath = path.join(this.config.RESULTS_STAGING_PATH, 'executor.json');
            await fs.writeFile(executorPath, JSON.stringify(executor, null, 2), { encoding: 'utf8' });
        }
        const command = [
            'generate',
            this.config.RESULTS_STAGING_PATH,
            '--output',
            this.config.REPORTS_DIR,
        ];
        if (this.config.reportName) {
            command.push('--report-name', this.config.reportName);
        }
        const { exitCode, stdout, stderr } = await this.allureRunner.runCommand(command);
        if (stdout)
            info(stdout);
        if (exitCode !== 0) {
            throw new Error(`Failed to generate Allure report (exit code ${exitCode}): ${stderr}`);
        }
        return this.config.REPORTS_DIR;
    }
}
