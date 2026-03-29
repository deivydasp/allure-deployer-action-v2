import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB
let allureCliPath;
function resolveAllureCli() {
    if (allureCliPath)
        return allureCliPath;
    const require = createRequire(import.meta.url);
    const allurePkgDir = path.dirname(require.resolve('allure'));
    const resolved = path.resolve(allurePkgDir, '..', 'cli.js');
    if (!existsSync(resolved)) {
        throw new Error(`Allure CLI not found at ${resolved}. The allure package structure may have changed.`);
    }
    allureCliPath = resolved;
    return allureCliPath;
}
export class AllureService {
    runCommand(args) {
        const allureCli = resolveAllureCli();
        const allureProcess = spawn(process.execPath, [allureCli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        const timers = [];
        timers.push(setTimeout(() => {
            allureProcess.kill('SIGTERM');
            timers.push(setTimeout(() => {
                if (!allureProcess.killed)
                    allureProcess.kill('SIGKILL');
            }, 5000));
        }, TIMEOUT_MS));
        const clearTimers = () => timers.forEach((t) => clearTimeout(t));
        return new Promise((resolve, reject) => {
            allureProcess.stdout?.on('data', (data) => {
                if (!stdoutTruncated) {
                    stdout += data.toString();
                    if (stdout.length >= MAX_BUFFER_SIZE) {
                        stdout = stdout.slice(0, MAX_BUFFER_SIZE) + '\n... [stdout truncated]';
                        stdoutTruncated = true;
                    }
                }
            });
            allureProcess.stderr?.on('data', (data) => {
                if (!stderrTruncated) {
                    stderr += data.toString();
                    if (stderr.length >= MAX_BUFFER_SIZE) {
                        stderr = stderr.slice(0, MAX_BUFFER_SIZE) + '\n... [stderr truncated]';
                        stderrTruncated = true;
                    }
                }
            });
            allureProcess.on('error', (error) => {
                clearTimers();
                reject(error);
            });
            allureProcess.on('close', (exitCode, signal) => {
                clearTimers();
                if (signal === 'SIGTERM' || signal === 'SIGKILL') {
                    reject(new Error(`Allure CLI timed out after ${TIMEOUT_MS / 1000}s and was killed`));
                    return;
                }
                resolve({ exitCode: exitCode ?? 1, stdout, stderr });
            });
        });
    }
}
