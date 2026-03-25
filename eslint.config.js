import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/', 'node_modules/'],
    },
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
        },
    },
);
