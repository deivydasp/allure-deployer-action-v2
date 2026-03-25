import * as fs from 'fs/promises';

export async function validateResultsPaths(commaSeparatedResultPaths: string): Promise<string[]> {
    if (!commaSeparatedResultPaths.includes(',')) {
        const exists = await fs.access(commaSeparatedResultPaths).then(() => true).catch(() => false);
        return exists ? [commaSeparatedResultPaths] : [];
    }

    const paths = commaSeparatedResultPaths.split(',');
    const validPaths: string[] = [];

    for (const p of paths) {
        const trimmedPath = p.trim();
        const exists = await fs.access(trimmedPath).then(() => true).catch(() => false);
        if (exists) {
            validPaths.push(trimmedPath);
        }
    }

    return validPaths;
}
