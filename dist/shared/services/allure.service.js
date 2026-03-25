import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const allureCommandline = require('allure-commandline');
export class AllureService {
    runCommand(args) {
        const allureProcess = allureCommandline(args);
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
                resolve({ exitCode, stdout, stderr });
            });
        });
    }
}
