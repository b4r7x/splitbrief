import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('ships without the repository map parser and grammars', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const installed = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];

  expect(
    installed.filter((name) => name === 'web-tree-sitter' || name.startsWith('tree-sitter-')),
  ).toEqual([]);
  expect(Object.keys(manifest.dependencies)).toContain('better-sqlite3');
});
