import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Allure, AllureConfig } from '../../src/services/allure-report.service.js';
import { CommandRunner } from '../../src/interfaces/command.interface.js';

vi.mock('@actions/core', () => ({
    info: vi.fn(),
    warning: vi.fn(),
}));

vi.mock('properties-reader', () => ({
    propertiesReader: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from 'node:fs/promises';
import { warning } from '@actions/core';
import { propertiesReader } from 'properties-reader';

const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedStat = vi.mocked(fs.stat);
const mockedMkdir = vi.mocked(fs.mkdir);
const mockedWarning = vi.mocked(warning);
const mockedPropertiesReader = vi.mocked(propertiesReader);

function createMockRunner(exitCode = 0, stdout = '', stderr = ''): CommandRunner {
    return {
        runCommand: vi.fn().mockResolvedValue({ exitCode, stdout, stderr }),
    };
}

function createConfig(overrides: Partial<AllureConfig> = {}): AllureConfig {
    return {
        RESULTS_STAGING_PATH: '/staging',
        REPORTS_DIR: '/reports',
        HISTORY_PATH: '/history/history.jsonl',
        historyLimit: 20,
        showHistory: true,
        ...overrides,
    };
}

describe('Allure', () => {
    describe('generate', () => {
        it('runs allure generate with correct arguments', async () => {
            const runner = createMockRunner();
            mockedReadFile.mockResolvedValue('');
            const allure = new Allure({ allureRunner: runner, config: createConfig() });

            await allure.generate();

            expect(runner.runCommand).toHaveBeenCalledWith([
                'generate',
                '/staging',
                '--config',
                expect.stringContaining('allurerc.json'),
                '--output',
                '/reports',
            ]);
        });

        it('writes executor.json when executor is provided', async () => {
            const runner = createMockRunner();
            mockedReadFile.mockResolvedValue('');
            const allure = new Allure({ allureRunner: runner, config: createConfig() });
            const executor = { name: 'GitHub', reportUrl: 'https://example.com', buildName: 'Build #1' };

            await allure.generate(executor);

            const executorCall = mockedWriteFile.mock.calls.find(
                (call) => typeof call[0] === 'string' && call[0].includes('executor.json'),
            );
            expect(executorCall).toBeDefined();
            const written = JSON.parse(executorCall![1] as string);
            expect(written.name).toBe('GitHub');
            expect(written.reportUrl).toBe('https://example.com');
            expect(written.buildName).toBe('Build #1');
        });

        it('throws when allure exits with non-zero code', async () => {
            const runner = createMockRunner(1, '', 'generation failed');
            const allure = new Allure({ allureRunner: runner, config: createConfig() });

            await expect(allure.generate()).rejects.toThrow('Failed to generate Allure report (exit code 1)');
        });

        it('writes allurerc.json with history config when showHistory is true', async () => {
            const runner = createMockRunner();
            mockedReadFile.mockResolvedValue('');
            const allure = new Allure({ allureRunner: runner, config: createConfig({ showHistory: true }) });

            await allure.generate();

            // Find the writeFile call for allurerc.json
            const allurercCall = mockedWriteFile.mock.calls.find(
                (call) => typeof call[0] === 'string' && call[0].includes('allurerc.json'),
            );
            expect(allurercCall).toBeDefined();
            const config = JSON.parse(allurercCall![1] as string);
            expect(config.historyPath).toBe('/history/history.jsonl');
            expect(config.historyLimit).toBe(20);
            expect(config.appendHistory).toBe(true);
        });

        it('writes allurerc.json without history config when showHistory is false', async () => {
            const runner = createMockRunner();
            const allure = new Allure({
                allureRunner: runner,
                config: createConfig({ showHistory: false }),
            });

            await allure.generate();

            const allurercCall = mockedWriteFile.mock.calls.find(
                (call) => typeof call[0] === 'string' && call[0].includes('allurerc.json'),
            );
            const config = JSON.parse(allurercCall![1] as string);
            expect(config.historyPath).toBeUndefined();
        });

        it('includes report name and language in allurerc', async () => {
            const runner = createMockRunner();
            mockedReadFile.mockResolvedValue('');
            const allure = new Allure({
                allureRunner: runner,
                config: createConfig({ reportName: 'My Report', reportLanguage: 'de' }),
            });

            await allure.generate();

            const allurercCall = mockedWriteFile.mock.calls.find(
                (call) => typeof call[0] === 'string' && call[0].includes('allurerc.json'),
            );
            const config = JSON.parse(allurercCall![1] as string);
            expect(config.name).toBe('My Report');
            expect(config.plugins.awesome.options.reportLanguage).toBe('de');
        });

        it('post-processes history: patches URL and truncates', async () => {
            const runner = createMockRunner();
            const historyLines = [
                '{"id":"1","name":"test1"}',
                '{"id":"2","name":"test2"}',
                '{"id":"3","name":"test3"}',
            ].join('\n');
            mockedReadFile.mockResolvedValueOnce(historyLines);
            // stat for awesome dir — throw to indicate it doesn't exist
            mockedStat.mockRejectedValue(new Error('ENOENT'));

            const allure = new Allure({
                allureRunner: runner,
                config: createConfig({ historyLimit: 2 }),
            });

            await allure.generate({ reportUrl: 'https://example.com/report' });

            // Find the writeFile call for history
            const historyCall = mockedWriteFile.mock.calls.find(
                (call) => typeof call[0] === 'string' && call[0].includes('history.jsonl'),
            );
            expect(historyCall).toBeDefined();
            const lines = (historyCall![1] as string).trimEnd().split('\n');
            expect(lines).toHaveLength(2); // truncated to limit
            const lastEntry = JSON.parse(lines[1]);
            expect(lastEntry.url).toBe('https://example.com/report');
        });

        it('creates history redirect when awesome dir does not exist', async () => {
            const runner = createMockRunner();
            mockedReadFile.mockResolvedValueOnce('{"id":"1"}\n');
            mockedStat.mockRejectedValue(new Error('ENOENT'));

            const allure = new Allure({
                allureRunner: runner,
                config: createConfig(),
            });

            await allure.generate({ reportUrl: 'https://example.com' });

            const redirectCall = mockedWriteFile.mock.calls.find(
                (call) => typeof call[0] === 'string' && call[0].includes('awesome') && call[0].includes('index.html'),
            );
            expect(redirectCall).toBeDefined();
            expect(redirectCall![1]).toContain('window.location.replace');
        });

        it('skips history redirect when awesome dir already exists (multi-plugin)', async () => {
            const runner = createMockRunner();
            mockedReadFile.mockResolvedValueOnce('{"id":"1"}\n');
            mockedStat.mockResolvedValue({ isDirectory: () => true } as any);

            const allure = new Allure({
                allureRunner: runner,
                config: createConfig(),
            });

            await allure.generate({ reportUrl: 'https://example.com' });

            const redirectCall = mockedWriteFile.mock.calls.find(
                (call) => typeof call[0] === 'string' && call[0].includes('awesome') && call[0].includes('index.html'),
            );
            expect(redirectCall).toBeUndefined();
        });
    });

    describe('readEnvironments', () => {
        it('returns map of environment properties', () => {
            const entries = new Map([['Browser', 'Chrome'], ['OS', 'Linux']]);
            mockedPropertiesReader.mockReturnValue(entries as any);

            const allure = new Allure({ config: createConfig() });
            const result = allure.readEnvironments();

            expect(result).toBeInstanceOf(Map);
            expect(result!.get('Browser')).toBe('Chrome');
            expect(result!.get('OS')).toBe('Linux');
        });

        it('returns undefined when environment.properties file not found', () => {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            mockedPropertiesReader.mockImplementation(() => { throw err; });

            const allure = new Allure({ config: createConfig() });
            expect(allure.readEnvironments()).toBeUndefined();
        });

        it('throws non-ENOENT errors', () => {
            mockedPropertiesReader.mockImplementation(() => { throw new Error('parse error'); });

            const allure = new Allure({ config: createConfig() });
            expect(() => allure.readEnvironments()).toThrow('parse error');
        });
    });
});
