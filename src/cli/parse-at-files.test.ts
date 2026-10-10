import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join, relative } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { formatAtFileRefusal, parseAtFiles } from './parse-at-files.js';

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
}));

let tmp: string;
const itUnix = process.platform === 'win32' ? it.skip : it;
const itReadableByOwnerOnly =
  process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;

beforeEach(() => {
  tmp = createTempDir('parse-at-files-test');
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('accepts absolute image paths inside the project', () => {
    const imgPath = join(tmp, 'screenshot.png');
    writeFileSync(imgPath, Buffer.alloc(100));

    const result = parseAtFiles('fix layout', [`@${imgPath}`], tmp);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.mimeType).toBe('image/png');
    expect(result.errors).toEqual([]);
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

  it('reports path failures and binary content without throwing or sending their bodies', () => {
    symlinkSync('loop', join(tmp, 'loop'));
    writeFileSync(join(tmp, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x00]));
    const long = 'a'.repeat(300);
    const result = parseAtFiles('fix', [`@${long}`, '@loop', '@archive.zip'], tmp);
    expect(result.errors).toEqual([
      { path: long, reason: 'not-found' },
      { path: 'loop', reason: 'not-found' },
      { path: 'archive.zip', reason: 'not-text' },
    ]);
    expect(result.textContext).toBe('');
    expect(result.attachedInputs).toEqual([]);
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

  it('reads a ../ path outside the project and names its resolved path', () => {
    const outside = createTempDir('parse-at-files-relative-outside');
    try {
      const brief = join(outside, 'brief.md');
      writeFileSync(brief, 'The real brief.');
      const raw = relative(tmp, brief);

      const result = parseAtFiles('fix', [`@${raw}`], tmp);

      expect(raw.startsWith('..')).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.textContext).toContain('The real brief.');
      expect(result.attachedInputs).toEqual([{ path: realpathSync(brief), kind: 'text' }]);
    } finally {
      cleanupTempDir(outside);
    }
  });

  it('reads an absolute text path outside the project', () => {
    const outside = createTempDir('parse-at-files-absolute-outside');
    try {
      const brief = join(outside, 'brief.md');
      writeFileSync(brief, 'The real brief.');

      const result = parseAtFiles('fix', [`@${brief}`], tmp);

      expect(result.errors).toEqual([]);
      expect(result.textContext).toContain('The real brief.');
      expect(result.attachedInputs).toEqual([{ path: realpathSync(brief), kind: 'text' }]);
    } finally {
      cleanupTempDir(outside);
    }
  });

  it('accepts absolute text paths inside the project', () => {
    const textPath = join(tmp, 'context.md');
    writeFileSync(textPath, 'Design notes.');

    const result = parseAtFiles('fix', [`@${textPath}`], tmp);

    expect(result.textContext).toContain(`--- @${textPath} ---`);
    expect(result.textContext).toContain('Design notes.');
    expect(result.errors).toEqual([]);
  });

  it('expands a leading ~/ to the home folder', () => {
    const root = createTempDir('parse-at-files-home');
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    try {
      const brief = join(root, 'brief.md');
      writeFileSync(brief, 'Brief from home.');
      const raw = '~/brief.md';

      const result = parseAtFiles('fix', [`@${raw}`], tmp);

      expect(result.errors).toEqual([]);
      expect(result.textContext).toContain('Brief from home.');
      expect(result.attachedInputs).toEqual([{ path: realpathSync(brief), kind: 'text' }]);
    } finally {
      cleanupTempDir(root);
    }
  });

  it('keeps the typed ~/ spelling in a refusal', () => {
    const result = parseAtFiles('fix', ['@~/splitbrief-no-such-dir/brief.md'], tmp);

    expect(result.errors).toEqual([
      { path: '~/splitbrief-no-such-dir/brief.md', reason: 'not-found' },
    ]);
  });

  it('accepts a quoted outside text path and a literal backslash in an image path', () => {
    const outside = createTempDir('parse-at-files-typed-outside');
    try {
      const brief = join(outside, 'my notes.md');
      const image = join(outside, 'my\\ shot.png');
      writeFileSync(brief, 'Outside notes.');
      writeFileSync(image, 'image');
      writeFileSync(join(outside, 'my shot.png'), 'other image');
      const rawText = `"${brief}"`;

      const result = parseAtFiles('fix', [`@${rawText}`, `@${image}`], tmp);

      expect(result.errors).toEqual([]);
      expect(result.textContext).toBe(`--- @${rawText} ---\nOutside notes.`);
      expect(result.attachments).toMatchObject([{ path: realpathSync(image) }]);
      expect(result.attachedInputs).toEqual([
        { path: realpathSync(brief), kind: 'text' },
        { path: realpathSync(image), kind: 'image' },
      ]);
    } finally {
      cleanupTempDir(outside);
    }
  });

  it('refuses an escaped outside image path when only the unescaped filename exists', () => {
    const outside = createTempDir('parse-at-files-literal-outside');
    try {
      const image = join(outside, 'my shot.png');
      writeFileSync(image, 'image');
      const rawImage = image.replace('my shot', 'my\\ shot');

      const result = parseAtFiles('fix', [`@${rawImage}`], tmp);

      expect(result.errors).toEqual([{ path: rawImage, reason: 'not-found' }]);
      expect(result.textContext).toBe('');
      expect(result.attachments).toEqual([]);
      expect(result.attachedInputs).toEqual([]);
    } finally {
      cleanupTempDir(outside);
    }
  });

  itReadableByOwnerOnly('refuses a file in an unreadable directory as unreadable', () => {
    const directory = join(tmp, 'locked');
    mkdirSync(directory);
    writeFileSync(join(directory, 'notes.md'), 'Notes.');
    chmodSync(directory, 0o000);
    try {
      expect(parseAtFiles('fix', ['@locked/notes.md'], tmp).errors).toEqual([
        { path: 'locked/notes.md', reason: 'unreadable' },
      ]);
    } finally {
      chmodSync(directory, 0o700);
    }
  });

  itUnix('follows a text symlink that points outside the project', () => {
    const outside = createTempDir('parse-at-files-outside');
    try {
      writeFileSync(join(outside, 'notes.md'), 'Linked notes.');
      symlinkSync(join(outside, 'notes.md'), join(tmp, 'linked.md'));

      const result = parseAtFiles('fix', ['@linked.md'], tmp);

      expect(result.errors).toEqual([]);
      expect(result.textContext).toContain('Linked notes.');
      expect(result.attachedInputs).toEqual([
        { path: realpathSync(join(outside, 'notes.md')), kind: 'text' },
      ]);
    } finally {
      cleanupTempDir(outside);
    }
  });

  itUnix('follows an image symlink that points outside the project and home folder', () => {
    const outside = createTempDir('parse-at-files-image-outside');
    try {
      writeFileSync(join(outside, 'mock.png'), Buffer.alloc(100));
      symlinkSync(join(outside, 'mock.png'), join(tmp, 'linked.png'));

      const result = parseAtFiles('fix', ['@linked.png'], tmp);

      const target = realpathSync(join(outside, 'mock.png'));
      expect(result.errors).toEqual([]);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.path).toBe(target);
      expect(result.attachedInputs).toEqual([{ path: target, kind: 'image' }]);
    } finally {
      cleanupTempDir(outside);
    }
  });

  it('lists attached inputs in argument order with their kind', () => {
    writeFileSync(join(tmp, 'notes.md'), 'Design notes.');
    writeFileSync(join(tmp, 'mock.png'), Buffer.alloc(50));
    writeFileSync(join(tmp, 'spec.txt'), 'Spec content.');

    const result = parseAtFiles('build', ['@notes.md', '@ghost.md', '@mock.png', '@spec.txt'], tmp);

    expect(result.attachedInputs).toEqual([
      { path: realpathSync(join(tmp, 'notes.md')), kind: 'text' },
      { path: realpathSync(join(tmp, 'mock.png')), kind: 'image' },
      { path: realpathSync(join(tmp, 'spec.txt')), kind: 'text' },
    ]);
    expect(result.errors).toEqual([{ path: 'ghost.md', reason: 'not-found' }]);
  });

  it('refuses a directory named like an image as not a regular file', () => {
    mkdirSync(join(tmp, 'shots.png'));

    const result = parseAtFiles('fix', ['@shots.png'], tmp);

    expect(result.errors).toEqual([{ path: 'shots.png', reason: 'not-a-file' }]);
    expect(result.attachments).toEqual([]);
  });

  itReadableByOwnerOnly.each([['notes.md'], ['mock.png']])(
    'refuses an unreadable %s as unreadable',
    (name) => {
      const file = join(tmp, name);
      writeFileSync(file, Buffer.alloc(10));
      chmodSync(file, 0o000);
      try {
        const result = parseAtFiles('fix', [`@${name}`], tmp);

        expect(result.errors).toEqual([{ path: name, reason: 'unreadable' }]);
        expect(result.attachedInputs).toEqual([]);
      } finally {
        chmodSync(file, 0o600);
      }
    },
  );

  it('reports not-a-file error for directories', () => {
    mkdirSync(join(tmp, 'subdir'));

    const result = parseAtFiles('fix', ['@subdir'], tmp);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe('subdir');
    expect(result.errors[0]?.reason).toBe('not-a-file');
  });
});

describe('formatAtFileRefusal', () => {
  it('names every refused input with its reason and recovery, in argument order', () => {
    expect(
      formatAtFileRefusal([
        { path: 'ghost.md', reason: 'not-found' },
        { path: 'docs', reason: 'not-a-file' },
        { path: 'huge.md', reason: 'too-large' },
        { path: 'locked.md', reason: 'unreadable' },
      ]),
    ).toBe(
      [
        'Cannot start: SPLITBRIEF refused these @file inputs.',
        '  @ghost.md: file not found. Check the path and try again.',
        '  @docs: not a regular file. Name a file, not a directory.',
        '  @huge.md: file is larger than 10 MiB. Choose a smaller file.',
        '  @locked.md: cannot read the file. Check its permissions.',
      ].join('\n'),
    );
  });

  it('strips terminal control bytes from the paths it names', () => {
    const message = formatAtFileRefusal([
      { path: '\u001b]0;pwned\u0007ghost.md', reason: 'not-found' },
    ]);

    expect(message).toContain('  @ghost.md: file not found.');
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('pwned');
  });
});
