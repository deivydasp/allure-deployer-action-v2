import { CommandRunner } from '../interfaces/command.interface.js';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
// allure's exports map only exposes ./dist/index.js, so resolve that and navigate up to cli.js
const allureEntry = require.resolve('allure');
const allureCli = path.join(allureEntry, '..', '..', 'cli.js');

export class AllureService implements CommandRunner {
    runCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const allureProcess = spawn(process.execPath, [allureCli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        return new Promise((resolve, reject) => {
            allureProcess.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });
            allureProcess.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });
            allureProcess.on('error', (error: Error) => {
                reject(error);
            });
            allureProcess.on('exit', (exitCode: number | null) => {
                resolve({ exitCode: exitCode ?? 1, stdout, stderr });
            });
        });
    }
}
