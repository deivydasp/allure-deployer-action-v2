import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['__tests__/**/*.test.ts'],
        globals: false,
        pool: 'forks',
        // Serialize test-file execution. The default parallel mode races on ESM
        // module transform during cold runs and produces sporadic "0 test" failures
        // on Windows ("Cannot find package", "Cannot read properties of undefined
        // (reading 'config')", "Vitest failed to find the runner"). Disabling file
        // parallelism is rock-stable and only ~100ms slower for a suite this size.
        fileParallelism: false,
        restoreMocks: true,
        clearMocks: true,
        unstubEnvs: true,
        unstubGlobals: true,
    },
});
