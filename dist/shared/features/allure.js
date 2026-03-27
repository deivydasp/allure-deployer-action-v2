import * as fs from 'fs/promises';
import * as path from 'node:path';
import { info, warning } from '@actions/core';
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
            'awesome',
            this.config.RESULTS_STAGING_PATH,
            '--output',
            this.config.REPORTS_DIR,
        ];
        if (this.config.showHistory) {
            command.push('--history-path', this.config.HISTORY_PATH);
            command.push('--history-limit', this.config.historyLimit.toString());
        }
        if (this.config.reportName) {
            command.push('--report-name', this.config.reportName);
        }
        if (this.config.reportLanguage) {
            command.push('--report-language', this.config.reportLanguage);
        }
        const { exitCode, stdout, stderr } = await this.allureRunner.runCommand(command);
        if (stdout)
            info(stdout);
        if (exitCode !== 0) {
            throw new Error(`Failed to generate Allure report (exit code ${exitCode}): ${stderr}`);
        }
        if (this.config.showHistory && executor?.reportUrl) {
            await this.patchHistoryUrl(executor.reportUrl);
            await this.createHistoryRedirect();
        }
        return this.config.REPORTS_DIR;
    }
    /**
     * Patches the last history entry with the report URL so history dots link to previous reports.
     */
    async patchHistoryUrl(reportUrl) {
        try {
            const content = await fs.readFile(this.config.HISTORY_PATH, 'utf8');
            const lines = content.trimEnd().split('\n');
            const lastEntry = JSON.parse(lines[lines.length - 1]);
            lastEntry.url = reportUrl;
            lines[lines.length - 1] = JSON.stringify(lastEntry);
            await fs.writeFile(this.config.HISTORY_PATH, lines.join('\n') + '\n', 'utf8');
        }
        catch (e) {
            warning(`Failed to patch history URL: ${e}`);
        }
    }
    /**
     * Creates an awesome/index.html redirect in the report directory.
     * Allure 3's awesome theme appends /awesome to history URLs, but self-hosted
     * reports don't have that subdirectory. This redirect preserves the hash fragment
     * so the SPA can route to the correct test result.
     */
    async createHistoryRedirect() {
        const redirectDir = path.join(this.config.REPORTS_DIR, 'awesome');
        await fs.mkdir(redirectDir, { recursive: true });
        const html = `<!DOCTYPE html>
<html><head><script>window.location.replace("../" + window.location.hash);</script></head><body></body></html>`;
        await fs.writeFile(path.join(redirectDir, 'index.html'), html, 'utf8');
    }
}
