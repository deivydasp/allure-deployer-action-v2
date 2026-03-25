import { main } from './main.js';
import { setFailed } from '@actions/core';
main().catch((err) => {
    setFailed(err instanceof Error ? err.message : String(err));
});
