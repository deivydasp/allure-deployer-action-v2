import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AllureService } from '../../src/services/allure.service.js';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Mock child_process.spawn
vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}));

// Mock node:fs to control existsSync
vi.mock('node:fs', () => ({
    existsSync: vi.fn().mockReturnValue(true),
}));

// Mock node:module to control createRequire
vi.mock('node:module', () => ({
    createRequire: vi.fn().mockReturnValue({
        resolve: vi.fn().mockReturnValue('/mock/node_modules/allure/dist/index.js'),
    }),
}));

import { spawn } from 'node:child_process';
const mockedSpawn = vi.mocked(spawn);

function createMockProcess(exitCode: number = 0, stdout = '', stderr = '') {
    const proc = new EventEmitter() as any;
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });

    // Schedule data emission and close
    setTimeout(() => {
        if (stdout) proc.stdout.push(Buffer.from(stdout));
        proc.stdout.push(null);
        if (stderr) proc.stderr.push(Buffer.from(stderr));
        proc.stderr.push(null);
        proc.emit('close', exitCode);
    }, 0);

    return proc;
}

beforeEach(() => {
    // Reset the cached allureCliPath between tests
    vi.resetModules();
});

describe('AllureService', () => {
    it('spawns allure CLI with provided arguments', async () => {
        mockedSpawn.mockReturnValue(createMockProcess(0, 'ok') as any);
        const service = new AllureService();
        const result = await service.runCommand(['generate', '/results', '--output', '/report']);

        expect(mockedSpawn).toHaveBeenCalledWith(
            process.execPath,
            expect.arrayContaining(['generate', '/results', '--output', '/report']),
            expect.objectContaining({
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('ok');
    });

    it('captures stderr output', async () => {
        mockedSpawn.mockReturnValue(createMockProcess(1, '', 'error occurred') as any);
        const service = new AllureService();
        const result = await service.runCommand(['generate']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('error occurred');
    });

    it('strips CodeBuild environment variables', async () => {
        process.env.CODEBUILD_BUILD_ID = 'test-id';
        process.env.CODEBUILD_BUILD_URL = 'test-url';
        process.env.CODEBUILD_BUILD_ARN = 'test-arn';

        mockedSpawn.mockReturnValue(createMockProcess(0) as any);
        const service = new AllureService();
        await service.runCommand(['generate']);

        const spawnEnv = mockedSpawn.mock.calls[0][2]?.env as Record<string, string>;
        expect(spawnEnv.CODEBUILD_BUILD_ID).toBeUndefined();
        expect(spawnEnv.CODEBUILD_BUILD_URL).toBeUndefined();
        expect(spawnEnv.CODEBUILD_BUILD_ARN).toBeUndefined();

        // Clean up
        delete process.env.CODEBUILD_BUILD_ID;
        delete process.env.CODEBUILD_BUILD_URL;
        delete process.env.CODEBUILD_BUILD_ARN;
    });

    it('rejects on spawn error', async () => {
        const proc = new EventEmitter() as any;
        proc.stdout = new Readable({ read() {} });
        proc.stderr = new Readable({ read() {} });
        setTimeout(() => proc.emit('error', new Error('spawn failed')), 0);

        mockedSpawn.mockReturnValue(proc as any);
        const service = new AllureService();
        await expect(service.runCommand(['generate'])).rejects.toThrow('spawn failed');
    });

    it('defaults exit code to 1 when null', async () => {
        const proc = new EventEmitter() as any;
        proc.stdout = new Readable({ read() {} });
        proc.stderr = new Readable({ read() {} });
        setTimeout(() => {
            proc.stdout.push(null);
            proc.stderr.push(null);
            proc.emit('close', null);
        }, 0);

        mockedSpawn.mockReturnValue(proc as any);
        const service = new AllureService();
        const result = await service.runCommand(['generate']);
        expect(result.exitCode).toBe(1);
    });
});
