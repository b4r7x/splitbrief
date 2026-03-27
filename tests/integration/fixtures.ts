export const FIXTURE_PACKAGE_JSON = JSON.stringify({
  name: 'test-fixture',
  version: '0.0.0',
  type: 'module',
  scripts: { test: 'node --test tests/*.test.ts', build: 'tsc --noEmit' },
}, null, 2);

export const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2024',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    outDir: 'dist',
    rootDir: 'src',
  },
  include: ['src/**/*'],
}, null, 2);

export const FIXTURE_INDEX_TS = `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`;

export const FIXTURE_INDEX_TEST_TS = `import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/index.js';\n\ndescribe('greet', () => {\n  it('returns greeting', () => {\n    assert.equal(greet('World'), 'Hello, World!');\n  });\n});\n`;
