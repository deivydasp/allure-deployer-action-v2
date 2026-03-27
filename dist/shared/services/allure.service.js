import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
const require = createRequire(import.meta.url);
const allureCli = path.join(path.dirname(require.resolve('allure/package.json')), 'cli.js');
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
