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
export class AllureService {
    runCommand(args) {
        const allureProcess = spawn(process.execPath, [allureCli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        return new Promise((resolve, reject) => {
            allureProcess.stdout?.on('data', (data) => {
                stdout += data.toString();
            });
            allureProcess.stderr?.on('data', (data) => {
                stderr += data.toString();
            });
            allureProcess.on('error', (error) => {
                reject(error);
            });
            allureProcess.on('exit', (exitCode) => {
                resolve({ exitCode: exitCode ?? 1, stdout, stderr });
            });
        });
    }
}
