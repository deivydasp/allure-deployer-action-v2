import { CommandRunner } from '../interfaces/command.interface.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
let allureCliPath: string | undefined;

function resolveAllureCli(): string {
    if (allureCliPath) return allureCliPath;
    const require = createRequire(import.meta.url);
    const allurePkgDir = path.dirname(require.resolve('allure'));
    const resolved = path.resolve(allurePkgDir, '..', 'cli.js');
    if (!existsSync(resolved)) {
        throw new Error(`Allure CLI not found at ${resolved}. The allure package structure may have changed.`);
    }
    allureCliPath = resolved;
    return allureCliPath;
}

export class AllureService implements CommandRunner {
    runCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const allureCli = resolveAllureCli();
        const ac = new AbortController();
        const timeout = setTimeout(() => ac.abort(), TIMEOUT_MS);
        const allureProcess = spawn(process.execPath, [allureCli, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: ac.signal,
        });

        let stdout = '';
        let stderr = '';

        return new Promise((resolve, reject) => {
            allureProcess.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
            allureProcess.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
            allureProcess.on('error', (error: Error) => {
                clearTimeout(timeout);
                if (ac.signal.aborted) {
                    reject(new Error(`Allure CLI timed out after ${TIMEOUT_MS / 1000}s and was killed`));
                } else {
                    reject(error);
                }
            });
            allureProcess.on('close', (exitCode: number | null) => {
                clearTimeout(timeout);
                resolve({ exitCode: exitCode ?? 1, stdout, stderr });
            });
        });
    }
}
