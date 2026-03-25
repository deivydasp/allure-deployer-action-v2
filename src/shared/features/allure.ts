import * as fs from 'fs/promises';
import * as path from "node:path";
import {AllureService} from "../services/allure.service.js";
import {CommandRunner} from "../interfaces/command.interface.js";
import {ExecutorInterface} from "../interfaces/executor.interface.js";
import {propertiesReader} from "properties-reader";

export interface AllureConfig {
    RESULTS_STAGING_PATH: string;
    REPORTS_DIR: string;
    reportLanguage?: string;
}

export class Allure {
    private readonly allureRunner: CommandRunner;
    private readonly config: AllureConfig;

    constructor({allureRunner, config}: { allureRunner?: CommandRunner; config: AllureConfig }) {
        this.allureRunner = allureRunner ?? new AllureService();
        this.config = config;
    }

    get environments(): Map<string, string> | undefined {
        const map = new Map<string, string>();
        try {
            const properties = propertiesReader({
                sourceFile: path.join(this.config.RESULTS_STAGING_PATH, 'environment.properties')
            });
            console.log('Environments');
            for (const [key, value] of properties.entries()) {
                console.log(`${key}: ${value}`);
                map.set(key, String(value));
            }
            return map;
        } catch (_e) {
            // environment.properties file does not exist
        }
        return undefined;
    }

    async generate(executor?: ExecutorInterface): Promise<string> {
        if (executor) {
            const executorPath = path.join(this.config.RESULTS_STAGING_PATH, 'executor.json');
            await fs.writeFile(executorPath, JSON.stringify(executor, null, 2), {mode: 0o755, encoding: 'utf8'});
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

        const {exitCode} = await this.allureRunner.runCommand(command);
        if (exitCode !== 0) {
            throw new Error("Failed to generate Allure report");
        }
        return this.config.REPORTS_DIR;
    }
}
