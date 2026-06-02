import { writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractMentionedFilenames } from './extract-mentioned-filenames.js';
import { buildGraph } from './graph.js';
import { pagerank } from './pagerank.js';
import type { FileNode } from './types.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

describe('extractMentionedFilenames', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir('diptych-emf');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  it('returns empty array for empty string', () => {
    expect(extractMentionedFilenames('', projectDir, [])).toEqual([]);
  });

  it('returns empty array for text with no file paths', () => {
    expect(
      extractMentionedFilenames('add a login feature with OAuth support', projectDir, []),
    ).toEqual([]);
  });

  it('returns the absolute path when file exists', () => {
    writeFileSync(join(projectDir, 'foo.ts'), 'export {}');
    const result = extractMentionedFilenames('update foo.ts to add a bar function', projectDir, []);
    expect(result).toContain(join(projectDir, 'foo.ts'));
    expect(result.every((p) => isAbsolute(p))).toBe(true);
  });

  it('filters out non-existent paths', () => {
    const result = extractMentionedFilenames(
      'modify ghost.ts which does not exist',
      projectDir,
      [],
    );
    expect(result).toEqual([]);
  });

  it('returns multiple existing files when both are present', () => {
    writeFileSync(join(projectDir, 'alpha.ts'), 'export {}');
    writeFileSync(join(projectDir, 'beta.tsx'), 'export {}');
    const result = extractMentionedFilenames('change alpha.ts and beta.tsx', projectDir, []);
    expect(result).toContain(join(projectDir, 'alpha.ts'));
    expect(result).toContain(join(projectDir, 'beta.tsx'));
  });

  it('matches basename against discoveredFiles when literal path does not exist', () => {
    const deepFile = join(projectDir, 'src', 'utils', 'validation.ts');
    const result = extractMentionedFilenames('see validation.ts for details', projectDir, [
      deepFile,
    ]);
    expect(result).toEqual([deepFile]);
  });

  it('returns empty when basename is not in discoveredFiles', () => {
    const result = extractMentionedFilenames('see validation.ts for details', projectDir, [
      join(projectDir, 'src', 'foo.ts'),
    ]);
    expect(result).toEqual([]);
  });

  it('mentioned on-disk file survives pagerank focus filter and gets boosted', () => {
    const focusPath = join(projectDir, 'target.ts');
    const otherPath = join(projectDir, 'other.ts');
    writeFileSync(focusPath, 'export {}');

    const node = (path: string, imports: string[]): FileNode => ({
      path,
      symbols: [],
      imports,
      sizeBytes: 10,
      mtimeMs: 0,
    });
    const graph = buildGraph([node(focusPath, []), node(otherPath, ['./target'])]);
    const discovered = [focusPath, otherPath];

    const mentioned = extractMentionedFilenames('please change target.ts', projectDir, discovered);
    const ranks = pagerank(graph, mentioned);

    // With a live focus file the mentioned node must outrank the unfocused one.
    expect(mentioned).toContain(focusPath);
    expect(ranks.get(focusPath) ?? 0).toBeGreaterThan(ranks.get(otherPath) ?? 0);
  });
});
