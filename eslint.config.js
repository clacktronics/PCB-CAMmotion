import js from '@eslint/js';
import globals from 'globals';

// Logic folders must run in Node with no DOM (AGENTS.md → Testing).
const NO_DOM = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'location',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
];

export default [
  { ignores: ['node_modules/', 'vendor/', 'dist/', 'test/fixtures/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Spec-defined control characters (e.g. stripping NUL from names) are deliberate.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/**/*.js'],
    languageOptions: { globals: { ...globals.es2024, TextEncoder: 'readonly', TextDecoder: 'readonly' } },
    rules: {
      'no-restricted-globals': [
        'error',
        ...NO_DOM.map((name) => ({
          name,
          message: 'No DOM or network in logic code: keep it in src/ui or src/render.',
        })),
      ],
    },
  },
  {
    files: ['src/ui/**/*.js', 'src/render/**/*.js', 'src/render3d/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Local only: no network calls.' },
        { name: 'XMLHttpRequest', message: 'Local only: no network calls.' },
        { name: 'WebSocket', message: 'Local only: no network calls.' },
      ],
    },
  },
  {
    files: ['tools/**/*.mjs', 'test/**/*.js', '*.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['test/e2e/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
