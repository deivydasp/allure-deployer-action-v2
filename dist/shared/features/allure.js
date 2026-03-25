import * as fs from 'fs/promises';
import * as path from 'node:path';
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
            console.log('Environments');
            for (const [key, value] of properties.entries()) {
                console.log(`${key}: ${value}`);
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
            '--report-dir',
            this.config.REPORTS_DIR,
            '--clean',
        ];
        if (this.config.reportLanguage) {
            command.push('--report-language', this.config.reportLanguage);
        }
        const { exitCode } = await this.allureRunner.runCommand(command);
        if (exitCode !== 0) {
            throw new Error('Failed to generate Allure report');
        }
        return this.config.REPORTS_DIR;
    }
}
