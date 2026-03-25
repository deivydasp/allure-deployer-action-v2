import {CommandRunner} from "../interfaces/command.interface.js";
// @ts-expect-error allure-commandline has no type definitions
import allureCommandline from "allure-commandline";

export class AllureService implements CommandRunner {
    runCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const allureProcess = allureCommandline(args);
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
            allureProcess.on('exit', (exitCode: number) => {
                resolve({exitCode, stdout, stderr});
            });
        });
    }
}
