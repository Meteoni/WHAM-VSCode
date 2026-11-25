import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'vendor/**', 'media/windhawk-renderer/**', 'examples/**', 'work/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    // Path and configuration validation deliberately rejects control characters.
    rules: { 'no-control-regex': 'off' }
  },
  {
    files: ['media/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, acquireVsCodeApi: 'readonly' } }
  },
  {
    files: ['test/**/*.cjs', 'scripts/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node }
  },
  {
    // These drive a browser page; functions they pass to it run with DOM globals.
    files: ['test/browser.cjs', 'test/windhawk-preview.cjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  }
);
