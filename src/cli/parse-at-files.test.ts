import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { parseAtFiles } from './parse-at-files.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('parse-at-files-test');
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('parseAtFiles', () => {
  it('returns feature unchanged when no @file args are present', () => {
    const result = parseAtFiles('add auth', [], tmp);

    expect(result.feature).toBe('add auth');
    expect(result.textContext).toBe('');
    expect(result.attachments).toHaveLength(0);
    expect(result.errors).toEqual([]);
  });

  it('inlines text file contents into textContext', () => {
    writeFileSync(join(tmp, 'context.md'), '# Auth notes\nUse OAuth2.');

    const result = parseAtFiles('refactor auth', ['@context.md'], tmp);

    expect(result.feature).toBe('refactor auth');
    expect(result.textContext).toContain('--- @context.md ---');
    expect(result.textContext).toContain('# Auth notes');
    expect(result.textContext).toContain('Use OAuth2.');
    expect(result.attachments).toHaveLength(0);
    expect(result.errors).toEqual([]);
  });

  it('routes image files into attachments array', () => {
    const imgPath = join(tmp, 'screenshot.png');
    writeFileSync(imgPath, Buffer.alloc(100));

    const result = parseAtFiles('fix layout', ['@screenshot.png'], tmp);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.mimeType).toBe('image/png');
    expect(result.textContext).toBe('');
  });

  it('handles multiple text and image files together', () => {
    writeFileSync(join(tmp, 'notes.md'), 'Design notes.');
    writeFileSync(join(tmp, 'spec.txt'), 'Spec content.');
    writeFileSync(join(tmp, 'mock.png'), Buffer.alloc(50));

    const result = parseAtFiles('build feature', ['@notes.md', '@mock.png', '@spec.txt'], tmp);

    expect(result.feature).toBe('build feature');
    expect(result.textContext).toContain('--- @notes.md ---');
    expect(result.textContext).toContain('--- @spec.txt ---');
    expect(result.attachments).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('reports error for missing files', () => {
    const result = parseAtFiles('fix bug', ['@missing.md'], tmp);

    expect(result.errors).toEqual([{ path: 'missing.md', reason: 'not-found' }]);
    expect(result.textContext).toBe('');
  });

  it('reports error for files exceeding size limit', () => {
    const bigFile = join(tmp, 'huge.md');
    writeFileSync(bigFile, Buffer.alloc(11 * 1024 * 1024));

    const result = parseAtFiles('summarize', ['@huge.md'], tmp);

    expect(result.errors).toEqual([{ path: 'huge.md', reason: 'too-large' }]);
  });

  it('concatenates non-@-prefixed extra args into feature string', () => {
    writeFileSync(join(tmp, 'ref.md'), 'Reference.');

    const result = parseAtFiles('add', ['auth', 'flow', '@ref.md'], tmp);

    expect(result.feature).toBe('add auth flow');
    expect(result.textContext).toContain('--- @ref.md ---');
  });

  it('treats double-@ as literal (not a file reference)', () => {
    const result = parseAtFiles('mention @@user', [], tmp);

    expect(result.feature).toBe('mention @@user');
    expect(result.errors).toEqual([]);
  });

  it('treats double-@ prefix as literal file lookup (not escape)', () => {
    const result = parseAtFiles('fix', ['@@user'], tmp);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe('@user');
    expect(result.errors[0]?.reason).toBe('not-found');
  });

  it('reports outside-project error for path traversal', () => {
    const result = parseAtFiles('fix', ['@../../etc/passwd'], tmp);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe('../../etc/passwd');
    expect(result.errors[0]?.reason).toBe('outside-project');
  });

  it('reports not-a-file error for directories', () => {
    mkdirSync(join(tmp, 'subdir'));

    const result = parseAtFiles('fix', ['@subdir'], tmp);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe('subdir');
    expect(result.errors[0]?.reason).toBe('not-a-file');
  });
});
