import { access } from 'node:fs/promises';
export async function validateResultsPaths(commaSeparatedResultPaths) {
    if (!commaSeparatedResultPaths.includes(',')) {
        const trimmed = commaSeparatedResultPaths.trim();
        const exists = await access(trimmed)
            .then(() => true)
            .catch(() => false);
        return exists ? [trimmed] : [];
    }
    const paths = commaSeparatedResultPaths.split(',');
    const validPaths = [];
    for (const p of paths) {
        const trimmedPath = p.trim();
        const exists = await access(trimmedPath)
            .then(() => true)
            .catch(() => false);
        if (exists) {
            validPaths.push(trimmedPath);
        }
    }
    return validPaths;
}
