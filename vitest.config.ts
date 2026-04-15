import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['__tests__/**/*.test.ts'],
        globals: false,
        pool: 'forks',
        restoreMocks: true,
        clearMocks: true,
        unstubEnvs: true,
        unstubGlobals: true
    },
});
