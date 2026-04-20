import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractMentionedFilenames } from './extract-mentioned-filenames.js';

describe('extractMentionedFilenames', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'diptych-emf-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns empty array for empty string', () => {
    expect(extractMentionedFilenames('', projectDir)).toEqual([]);
  });

  it('returns empty array for text with no file paths', () => {
    expect(extractMentionedFilenames('add a login feature with OAuth support', projectDir)).toEqual([]);
  });

  it('returns matching path when file exists', () => {
    writeFileSync(join(projectDir, 'foo.ts'), 'export {}');
    const result = extractMentionedFilenames('update foo.ts to add a bar function', projectDir);
    expect(result).toContain('foo.ts');
  });

  it('filters out non-existent paths', () => {
    const result = extractMentionedFilenames('modify ghost.ts which does not exist', projectDir);
    expect(result).toEqual([]);
  });

  it('returns multiple existing files when both are present', () => {
    writeFileSync(join(projectDir, 'alpha.ts'), 'export {}');
    writeFileSync(join(projectDir, 'beta.tsx'), 'export {}');
    const result = extractMentionedFilenames('change alpha.ts and beta.tsx', projectDir);
    expect(result).toContain('alpha.ts');
    expect(result).toContain('beta.tsx');
  });

  it('matches basename against discoveredFiles when literal path does not exist', () => {
    const deepFile = join(projectDir, 'src', 'utils', 'validation.ts');
    const result = extractMentionedFilenames(
      'see validation.ts for details',
      projectDir,
      [deepFile],
    );
    expect(result).toEqual([deepFile]);
  });

  it('returns empty when basename is not in discoveredFiles', () => {
    const result = extractMentionedFilenames(
      'see validation.ts for details',
      projectDir,
      [join(projectDir, 'src', 'foo.ts')],
    );
    expect(result).toEqual([]);
  });
});
