import path from 'node:path';
import fs from 'node:fs/promises';
import { warning } from '@actions/core';
import pLimit from 'p-limit';
export async function copyFiles({ from, to, concurrency = 10, overwrite = false, }) {
    const limit = pLimit(concurrency);
    const copyPromises = [];
    let successCount = 0;
    await fs.mkdir(to, { recursive: true });
    for (const dir of from) {
        try {
            const files = await fs.readdir(dir, { withFileTypes: true });
            for (const file of files) {
                if (!file.isFile())
                    continue;
                copyPromises.push(limit(async () => {
                    try {
                        const fileToCopy = path.join(dir, file.name);
                        const destination = path.join(to, file.name);
                        await fs.cp(fileToCopy, destination, { force: overwrite, errorOnExist: !overwrite });
                        successCount++;
                    }
                    catch (error) {
                        warning(`Error copying file ${file.name} from ${dir}: ${error}`);
                    }
                }));
            }
        }
        catch (error) {
            warning(`Error reading directory ${dir}: ${error}`);
        }
    }
    await Promise.all(copyPromises);
    return successCount;
}
