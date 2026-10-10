import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  attachmentShortName,
  formatAttachedText,
  resolveAttachment,
  resolveInputFile,
  resolveRenderAttachment,
} from './resolve.js';
import { MAX_ATTACHMENT_BYTES } from '../schemas/attachment.js';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
}));

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
}));

let projectDir: string;
let externalDir: string;
const itReadableByOwnerOnly = process.getuid?.() === 0 ? it.skip : it;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-project-'));
  externalDir = mkdtempSync(join(tmpdir(), 'splitbrief-external-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(externalDir, { recursive: true, force: true });
});

describe('resolveInputFile', () => {
  it('reads an absolute text path outside the project', () => {
    const path = join(externalDir, 'notes.md');
    writeFileSync(path, 'Notes from outside.');

    expect(resolveInputFile({ input: path, projectDir })).toEqual({
      ok: true,
      kind: 'text',
      path: realpathSync(path),
      sizeBytes: 19,
      content: 'Notes from outside.',
    });
  });

  it('reads a project-relative text path', () => {
    const path = join(projectDir, 'notes.md');
    writeFileSync(path, 'Project notes.');

    expect(resolveInputFile({ input: 'notes.md', projectDir })).toEqual({
      ok: true,
      kind: 'text',
      path: realpathSync(path),
      sizeBytes: 14,
      content: 'Project notes.',
    });
  });

  it('expands ~/ before resolving the path', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(externalDir);
    const path = join(externalDir, 'notes.md');
    writeFileSync(path, 'Home notes.');

    expect(resolveInputFile({ input: '~/notes.md', projectDir })).toMatchObject({
      ok: true,
      kind: 'text',
      path: realpathSync(path),
      content: 'Home notes.',
    });
  });

  it('follows a text symlink to its real path', () => {
    const target = join(externalDir, 'notes.md');
    writeFileSync(target, 'Linked notes.');
    symlinkSync(target, join(projectDir, 'link.md'));

    expect(resolveInputFile({ input: 'link.md', projectDir })).toMatchObject({
      ok: true,
      kind: 'text',
      path: realpathSync(target),
      content: 'Linked notes.',
    });
  });

  it.each(['"', "'"])('removes one matched pair of %s quotes and trims input', (quote) => {
    const path = join(projectDir, 'my shot.png');
    writeFileSync(path, 'image');

    expect(resolveInputFile({ input: `  ${quote}${path}${quote}  `, projectDir })).toMatchObject({
      ok: true,
      kind: 'image',
      path: realpathSync(path),
    });
  });

  it('keeps unmatched quotes as part of the path', () => {
    writeFileSync(join(projectDir, 'shot.png'), 'image');

    expect(resolveInputFile({ input: "'shot.png", projectDir })).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('removes only one enclosing quote pair', () => {
    const path = join(projectDir, "'notes.md'");
    writeFileSync(path, 'Quoted filename.');

    expect(resolveInputFile({ input: '"\'notes.md\'"', projectDir })).toMatchObject({
      ok: true,
      kind: 'text',
      path: realpathSync(path),
      content: 'Quoted filename.',
    });
  });

  it('preserves a literal backslash when the path without it also exists', () => {
    const path = join(externalDir, 'my\\ shot.png');
    writeFileSync(path, 'image');
    writeFileSync(join(externalDir, 'my shot.png'), 'other image');

    expect(resolveInputFile({ input: path, projectDir })).toMatchObject({
      ok: true,
      kind: 'image',
      path: realpathSync(path),
      attachment: { path: realpathSync(path) },
    });
  });

  it('preserves backslashes inside matched quotes', () => {
    const path = join(projectDir, 'my\\ shot.png');
    writeFileSync(path, 'image');

    expect(resolveInputFile({ input: `"${path}"`, projectDir })).toMatchObject({
      ok: true,
      kind: 'image',
      path: realpathSync(path),
    });
  });

  it.each(['folder', 'folder.png'])('refuses the directory %s as not-a-file', (name) => {
    mkdirSync(join(projectDir, name));

    expect(resolveInputFile({ input: name, projectDir })).toEqual({
      ok: false,
      reason: 'not-a-file',
    });
  });

  it.each(['missing.md', '', '  '])('refuses missing or empty input %j', (input) => {
    expect(resolveInputFile({ input, projectDir })).toEqual({ ok: false, reason: 'not-found' });
  });

  it('classifies an overlong path as not-found', () => {
    expect(resolveInputFile({ input: 'a'.repeat(300), projectDir })).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('classifies a symlink loop as not-found for every attachment entry point', () => {
    symlinkSync('loop', join(projectDir, 'loop'));
    for (const resolve of [resolveInputFile, resolveAttachment, resolveRenderAttachment]) {
      expect(resolve({ input: './loop', projectDir })).toEqual({ ok: false, reason: 'not-found' });
    }
  });

  it.each([
    ['archive.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])],
    ['document.pdf', Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')],
    ['invalid.txt', Buffer.from([0xff, 0xfe])],
  ])('refuses non-text bytes in %s', (name, content) => {
    writeFileSync(join(projectDir, name), content);
    expect(resolveInputFile({ input: name, projectDir })).toEqual({
      ok: false,
      reason: 'not-text',
    });
  });

  it.each(['', 'Notes\twith\r\nwhitespace\fand\vbreaks.', 'Zażółć gęślą jaźń. 日本語 🐦'])(
    'accepts UTF-8 text %j',
    (content) => {
      writeFileSync(join(projectDir, 'notes'), content);
      expect(resolveInputFile({ input: 'notes', projectDir })).toMatchObject({
        ok: true,
        kind: 'text',
        content,
      });
    },
  );

  itReadableByOwnerOnly.each(['locked.md', 'locked.png'])(
    'refuses an unreadable %s with its permission reason',
    (name) => {
      const path = join(projectDir, name);
      writeFileSync(path, 'locked');
      chmodSync(path, 0o000);
      try {
        expect(resolveInputFile({ input: path, projectDir })).toEqual({
          ok: false,
          reason: 'unreadable',
        });
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  it('accepts exactly 10 MiB and refuses one byte more', () => {
    const path = join(projectDir, 'boundary.png');
    writeFileSync(path, Buffer.alloc(MAX_ATTACHMENT_BYTES));
    expect(resolveInputFile({ input: path, projectDir })).toMatchObject({
      ok: true,
      kind: 'image',
      sizeBytes: MAX_ATTACHMENT_BYTES,
    });

    writeFileSync(path, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    expect(resolveInputFile({ input: path, projectDir })).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('classifies an image by the typed extension and returns its attachment', () => {
    const target = join(externalDir, 'image.data');
    writeFileSync(target, 'image');
    symlinkSync(target, join(projectDir, 'shot.PNG'));

    expect(resolveInputFile({ input: 'shot.PNG', projectDir })).toEqual({
      ok: true,
      kind: 'image',
      path: realpathSync(target),
      sizeBytes: 5,
      attachment: {
        id: expect.stringMatching(/^att-[0-9a-f-]{36}$/),
        kind: 'image',
        path: realpathSync(target),
        mimeType: 'image/png',
        sizeBytes: 5,
      },
    });
  });

  describe.each(['statSync', 'realpathSync', 'accessSync', 'readFileSync'] as const)(
    '%s errors',
    (operation) => {
      it.each([
        ['ENOENT', 'not-found'],
        ['ENOTDIR', 'not-found'],
        ['ENAMETOOLONG', 'not-found'],
        ['ELOOP', 'not-found'],
        ['EACCES', 'unreadable'],
        ['EPERM', 'unreadable'],
      ])('maps %s to %s', (code, reason) => {
        writeFileSync(join(projectDir, 'notes.md'), 'Notes.');
        vi.spyOn(fs, operation).mockImplementationOnce(() => {
          throw Object.assign(new Error(code), { code });
        });

        expect(resolveInputFile({ input: 'notes.md', projectDir })).toEqual({ ok: false, reason });
      });

      it('propagates an operational error', () => {
        writeFileSync(join(projectDir, 'notes.md'), 'Notes.');
        const error = Object.assign(new Error('I/O failure'), { code: 'EIO' });
        vi.spyOn(fs, operation).mockImplementationOnce(() => {
          throw error;
        });

        expect(() => resolveInputFile({ input: 'notes.md', projectDir })).toThrow(error);
      });
    },
  );
});

describe('resolveAttachment', () => {
  it('preserves a literal backslash when the path without it also exists', () => {
    const path = join(externalDir, 'my\\ shot.png');
    writeFileSync(path, 'image');
    writeFileSync(join(externalDir, 'my shot.png'), 'other image');

    expect(resolveAttachment({ input: path, projectDir })).toMatchObject({
      ok: true,
      attachment: { path: realpathSync(path) },
    });
  });

  it('accepts a real PNG inside projectDir', () => {
    const p = join(projectDir, 'pic.png');
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const result = resolveAttachment({ input: p, projectDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachment.mimeType).toBe('image/png');
      expect(result.attachment.kind).toBe('image');
      expect(result.attachment.path).toBe(realpathSync(p));
    }
  });

  it('rejects non-image extensions', () => {
    const p = join(projectDir, 'file.txt');
    writeFileSync(p, 'hello');
    const result = resolveAttachment({ input: p, projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-image');
  });

  it('refuses a text file without reading its contents', () => {
    const path = join(projectDir, 'notes.md');
    writeFileSync(path, 'Notes.');
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw new Error('The image wrapper must not read text.');
    });

    expect(resolveAttachment({ input: path, projectDir })).toEqual({
      ok: false,
      reason: 'not-image',
    });
  });

  it.each(['folder', 'folder.png'])('refuses the directory %s as not-a-file', (name) => {
    mkdirSync(join(projectDir, name));

    expect(resolveAttachment({ input: name, projectDir })).toEqual({
      ok: false,
      reason: 'not-a-file',
    });
  });

  itReadableByOwnerOnly('refuses an unreadable PNG as unreadable', () => {
    const path = join(projectDir, 'locked.png');
    writeFileSync(path, 'image');
    chmodSync(path, 0o000);
    try {
      expect(resolveAttachment({ input: path, projectDir })).toEqual({
        ok: false,
        reason: 'unreadable',
      });
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it('rejects missing files', () => {
    const result = resolveAttachment({ input: join(projectDir, 'missing.png'), projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');
  });

  it('accepts a relative path the user named outside the project', () => {
    const outsidePath = join(externalDir, 'mock.png');
    writeFileSync(outsidePath, Buffer.alloc(10));
    const result = resolveAttachment({ input: relative(projectDir, outsidePath), projectDir });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attachment.path).toBe(realpathSync(outsidePath));
  });

  it('follows a symlink the user named to an image outside the project and home folder', () => {
    const target = join(externalDir, 'target.png');
    writeFileSync(target, Buffer.alloc(10));
    const link = join(projectDir, 'link.png');
    symlinkSync(target, link);
    const result = resolveAttachment({ input: link, projectDir });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attachment.path).toBe(realpathSync(target));
  });

  it('rejects a path-traversal attempt that resolves outside to nothing', () => {
    const result = resolveAttachment({ input: '../../etc/passwd.png', projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');
  });

  it('strips wrapping quotes from input', () => {
    const p = join(projectDir, 'q.png');
    writeFileSync(p, '');
    const result = resolveAttachment({ input: `"${p}"`, projectDir });
    expect(result.ok).toBe(true);
  });

  it('rejects oversized files', () => {
    const p = join(projectDir, 'big.png');
    writeFileSync(p, Buffer.alloc(11 * 1024 * 1024));
    const result = resolveAttachment({ input: p, projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too-large');
  });

  it('assigns a crypto-random UUID id, unique per resolution', () => {
    const p = join(projectDir, 'pic.png');
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const first = resolveAttachment({ input: p, projectDir });
    const second = resolveAttachment({ input: p, projectDir });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.attachment.id).toMatch(
      /^att-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(second.attachment.id).not.toBe(first.attachment.id);
  });
});

describe('resolveRenderAttachment', () => {
  it('preserves a literal backslash when the path without it also exists in the project', () => {
    const path = join(projectDir, 'my\\ shot.png');
    writeFileSync(path, 'image');
    writeFileSync(join(projectDir, 'my shot.png'), 'other image');

    expect(resolveRenderAttachment({ input: path, projectDir })).toMatchObject({
      ok: true,
      attachment: { path: realpathSync(path) },
    });
  });

  it('accepts a render inside the project', () => {
    const p = join(projectDir, 'frame.png');
    writeFileSync(p, Buffer.alloc(10));
    const result = resolveRenderAttachment({ input: p, projectDir });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attachment.path).toBe(realpathSync(p));
  });

  it('accepts a render inside the home folder', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(externalDir);
    const path = join(externalDir, 'frame.png');
    writeFileSync(path, 'image');

    expect(resolveRenderAttachment({ input: path, projectDir })).toMatchObject({
      ok: true,
      attachment: { path: realpathSync(path) },
    });
  });

  it('requires the lexical path to be inside a safe root as well as its target', () => {
    const target = join(projectDir, 'target.png');
    writeFileSync(target, 'image');
    const link = join(externalDir, 'frame.png');
    symlinkSync(target, link);

    expect(resolveRenderAttachment({ input: link, projectDir })).toEqual({
      ok: false,
      reason: 'outside-safe-roots',
    });
  });

  it('refuses a render outside the project and home folder', () => {
    const outsidePath = join(externalDir, 'frame.png');
    writeFileSync(outsidePath, Buffer.alloc(10));
    const result = resolveRenderAttachment({ input: outsidePath, projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('outside-safe-roots');
  });

  it('refuses a render symlink in the project that points outside the safe roots', () => {
    const target = join(externalDir, 'target.png');
    writeFileSync(target, Buffer.alloc(10));
    const link = join(projectDir, 'frame.png');
    symlinkSync(target, link);
    const result = resolveRenderAttachment({ input: link, projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('outside-safe-roots');
  });
});

describe('attachmentShortName', () => {
  it('returns the basename unchanged when within budget', () => {
    expect(attachmentShortName('/some/dir/photo.png')).toBe('photo.png');
  });

  it.each(['/Users/me/notes/', '/Users/me/notes///', 'C:\\Users\\me\\notes\\'])(
    'ignores trailing separators in %j',
    (path) => {
      expect(attachmentShortName(path)).toBe('notes');
    },
  );

  it.each(['/', '\\'])('preserves the root separator %j', (path) => {
    expect(attachmentShortName(path)).toBe(path);
  });

  it('truncates long basenames with the single ellipsis glyph within the 24-char budget', () => {
    const long = 'a-really-long-attachment-filename.png';
    const result = attachmentShortName(long);
    expect(result.length).toBe(24);
    expect(result.endsWith('…')).toBe(true);
    expect(result).toBe(`${long.slice(0, 23)}…`);
  });

  it('handles backslash-separated paths', () => {
    expect(attachmentShortName('C:\\dir\\image.jpg')).toBe('image.jpg');
  });
});

describe('formatAttachedText', () => {
  it('frames the content with the typed path', () => {
    expect(formatAttachedText('~/notes.md', 'Notes.\n')).toBe('--- @~/notes.md ---\nNotes.\n');
  });
});
