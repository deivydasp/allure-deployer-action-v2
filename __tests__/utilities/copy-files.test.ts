import { describe, it, expect, vi, beforeEach } from 'vitest';
import { copyFiles } from '../../src/utilities/copy-files.js';

vi.mock('@actions/core', () => ({
    warning: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn(),
    cp: vi.fn(),
}));

import { mkdir, readdir, cp } from 'node:fs/promises';
import { warning } from '@actions/core';

const mockedMkdir = vi.mocked(mkdir);
const mockedReaddir = vi.mocked(readdir);
const mockedCp = vi.mocked(cp);
const mockedWarning = vi.mocked(warning);

beforeEach(() => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedCp.mockResolvedValue(undefined);
});

describe('copyFiles', () => {
    it('creates destination directory', async () => {
        mockedReaddir.mockResolvedValue([]);
        await copyFiles({ from: ['/src'], to: '/dest' });
        expect(mockedMkdir).toHaveBeenCalledWith('/dest', { recursive: true });
    });

    it('copies files from source to destination', async () => {
        mockedReaddir.mockResolvedValue([
            { name: 'file1.json', isFile: () => true, isDirectory: () => false },
            { name: 'file2.xml', isFile: () => true, isDirectory: () => false },
        ] as any);

        const count = await copyFiles({ from: ['/src'], to: '/dest' });
        expect(count).toBe(2);
        expect(mockedCp).toHaveBeenCalledTimes(2);
    });

    it('skips directories in source', async () => {
        mockedReaddir.mockResolvedValue([
            { name: 'file.json', isFile: () => true, isDirectory: () => false },
            { name: 'subdir', isFile: () => false, isDirectory: () => true },
        ] as any);

        const count = await copyFiles({ from: ['/src'], to: '/dest' });
        expect(count).toBe(1);
    });

    it('copies from multiple source directories', async () => {
        mockedReaddir
            .mockResolvedValueOnce([
                { name: 'a.json', isFile: () => true, isDirectory: () => false },
            ] as any)
            .mockResolvedValueOnce([
                { name: 'b.json', isFile: () => true, isDirectory: () => false },
            ] as any);

        const count = await copyFiles({ from: ['/src1', '/src2'], to: '/dest' });
        expect(count).toBe(2);
    });

    it('warns on unreadable source directory', async () => {
        mockedReaddir.mockRejectedValueOnce(new Error('ENOENT'));
        const count = await copyFiles({ from: ['/nonexistent'], to: '/dest' });
        expect(count).toBe(0);
        expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Error reading directory'));
    });

    it('warns on individual file copy failure and continues', async () => {
        mockedReaddir.mockResolvedValue([
            { name: 'good.json', isFile: () => true, isDirectory: () => false },
            { name: 'bad.json', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockedCp
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('copy failed'));

        const count = await copyFiles({ from: ['/src'], to: '/dest' });
        expect(count).toBe(1);
        expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('Error copying file bad.json'));
    });

    it('passes overwrite option to cp', async () => {
        mockedReaddir.mockResolvedValue([
            { name: 'file.json', isFile: () => true, isDirectory: () => false },
        ] as any);

        await copyFiles({ from: ['/src'], to: '/dest', overwrite: true });
        expect(mockedCp).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            { force: true, errorOnExist: false },
        );
    });

    it('defaults overwrite to false', async () => {
        mockedReaddir.mockResolvedValue([
            { name: 'file.json', isFile: () => true, isDirectory: () => false },
        ] as any);

        await copyFiles({ from: ['/src'], to: '/dest' });
        expect(mockedCp).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            { force: false, errorOnExist: true },
        );
    });
});
