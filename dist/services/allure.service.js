import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
let allureCliPath;
function resolveAllureCli() {
    if (allureCliPath)
        return allureCliPath;
    const require = createRequire(import.meta.url);
    const allurePkgDir = dirname(require.resolve('allure'));
    const resolved = resolve(allurePkgDir, '..', 'cli.js');
    if (!existsSync(resolved)) {
        throw new Error(`Allure CLI not found at ${resolved}. The allure package structure may have changed.`);
    }
    allureCliPath = resolved;
    return allureCliPath;
}
export class AllureService {
    runCommand(args) {
        const allureCli = resolveAllureCli();
        const ac = new AbortController();
        const timeout = setTimeout(() => ac.abort(), TIMEOUT_MS);
        // Strip CodeBuild env vars so Allure's CI auto-detection falls through to GitHub Actions.
        // On CodeBuild-backed self-hosted runners, these vars cause Allure to generate AWS Console
        // links instead of GitHub Actions links in summary.json jobHref.
        const env = { ...process.env };
        delete env.CODEBUILD_BUILD_ID;
        delete env.CODEBUILD_BUILD_URL;
        delete env.CODEBUILD_BUILD_ARN;
        const allureProcess = spawn(process.execPath, [allureCli, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: ac.signal,
            env
        });
        let stdout = '';
        let stderr = '';
        return new Promise((resolve, reject) => {
            allureProcess.stdout.on('data', (data) => { stdout += data.toString(); });
            allureProcess.stderr.on('data', (data) => { stderr += data.toString(); });
            allureProcess.on('error', (error) => {
                clearTimeout(timeout);
                if (ac.signal.aborted) {
                    reject(new Error(`Allure CLI timed out after ${TIMEOUT_MS / 1000}s and was killed`));
                }
                else {
                    reject(error);
                }
            });
            allureProcess.on('close', (exitCode) => {
                clearTimeout(timeout);
                resolve({ exitCode: exitCode ?? 1, stdout, stderr });
            });
        });
    }
}
