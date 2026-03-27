import { CommandRunner } from '../interfaces/command.interface.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const allurePkgDir = path.dirname(require.resolve('allure'));
// Navigate from dist/ up to the package root where cli.js lives
const allureCli = path.resolve(allurePkgDir, '..', 'cli.js');
if (!existsSync(allureCli)) {
    throw new Error(`Allure CLI not found at ${allureCli}. The allure package structure may have changed.`);
}

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
