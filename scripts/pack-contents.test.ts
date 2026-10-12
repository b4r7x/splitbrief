import { describe, expect, it } from 'vitest';
import { tarballProblems } from './pack-contents.mjs';

const files = ['dist/', 'docs/GETTING-STARTED.md', './README.md', 'CHANGELOG.md', 'LICENSE'];

const clean = [
  'package/LICENSE',
  'package/README.md',
  'package/CHANGELOG.md',
  'package/package.json',
  'package/dist/cli.js',
  'package/dist/core/paths-io.js',
  'package/docs/GETTING-STARTED.md',
];

describe('tarballProblems', () => {
  it('accepts a listing with every required asset and listed file', () => {
    expect(tarballProblems(clean, files)).toEqual([]);
  });

  it('reports a tarball without the built CLI', () => {
    const entries = clean.filter((entry) => !entry.startsWith('package/dist/'));

    expect(tarballProblems(entries, files)).toEqual([
      'missing package/dist/cli.js',
      "missing 'dist/' from package.json files",
    ]);
  });

  it('does not count a directory entry as a packed file', () => {
    const entries = [
      ...clean.filter((entry) => !entry.startsWith('package/dist/')),
      'package/dist/',
    ];

    expect(tarballProblems(entries, files)).toEqual([
      'missing package/dist/cli.js',
      "missing 'dist/' from package.json files",
    ]);
  });

  it('reports a doc that package.json files lists but the tarball lacks', () => {
    const entries = clean.filter((entry) => entry !== 'package/docs/GETTING-STARTED.md');

    expect(tarballProblems(entries, files)).toEqual([
      "missing 'docs/GETTING-STARTED.md' from package.json files",
    ]);
  });

  it('reports leaked source, test and tooling files', () => {
    const entries = [
      ...clean,
      'package/src/cli.ts',
      'package/dist/cli.test.js',
      'package/dist/ui/home.integration.test.js',
      'package/testing/helpers/state-home.js',
      'package/.claude/settings.json',
    ];

    expect(tarballProblems(entries, files)).toEqual([
      'leaked package/src/cli.ts',
      'leaked package/dist/cli.test.js',
      'leaked package/dist/ui/home.integration.test.js',
      'leaked package/testing/helpers/state-home.js',
      'leaked package/.claude/settings.json',
    ]);
  });

  it('reports an entry outside the package/ root', () => {
    expect(tarballProblems([...clean, 'other/cli.js'], files)).toEqual([
      'entry outside package/: other/cli.js',
    ]);
  });
});
