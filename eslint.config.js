import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'dist/', 'vendor/', 'samples/', 'test/fixtures/', 'test-results/', 'playwright-report/'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // logic must stay testable in Node: no DOM outside render/ and ui/ (AGENTS.md)
    files: ['src/parse/**', 'src/model/**', 'src/project/**'],
    languageOptions: { globals: { ...globals.node, TextDecoder: 'readonly', TextEncoder: 'readonly' } },
  },
];
