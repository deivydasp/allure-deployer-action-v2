import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { info, warning } from '@actions/core';
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
        if (this.config.showHistory) {
            await this.postProcessHistory(executor?.reportUrl);
            if (executor?.reportUrl) {
                await this.createHistoryRedirect();
            }
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
    async postProcessHistory(reportUrl) {
        try {
            const content = await readFile(this.config.HISTORY_PATH, 'utf8');
            const trimmed = content.trimEnd();
            if (!trimmed)
                return;
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
        }
        catch (e) {
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
    async createHistoryRedirect() {
        try {
            const awesomeDir = join(this.config.REPORTS_DIR, 'awesome');
            try {
                const dirStat = await stat(awesomeDir);
                if (dirStat.isDirectory())
                    return; // multi-plugin mode — awesome/ is a real plugin output
            }
            catch {
                // doesn't exist — create the redirect
            }
            await mkdir(awesomeDir, { recursive: true });
            const html = `<!DOCTYPE html>
<html><head><script>window.location.replace("../" + window.location.hash);</script></head><body></body></html>`;
            await writeFile(join(awesomeDir, 'index.html'), html, 'utf8');
        }
        catch (e) {
            warning(`Failed to create history redirect: ${e}`);
        }
    }
}
