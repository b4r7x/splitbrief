import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { attachmentShortName, resolveAttachment } from './resolve.js';

let projectDir: string;
let externalDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'diptych-project-'));
  externalDir = mkdtempSync(join(tmpdir(), 'diptych-external-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(externalDir, { recursive: true, force: true });
});

describe('resolveAttachment', () => {
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

  it('rejects missing files', () => {
    const result = resolveAttachment({ input: join(projectDir, 'missing.png'), projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');
  });

  it('rejects relative path that escapes safe roots', () => {
    const evilPath = join(externalDir, 'evil.png');
    writeFileSync(evilPath, '');
    const relativeEvil = relative(projectDir, evilPath);
    const result = resolveAttachment({ input: relativeEvil, projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('outside-safe-roots');
  });

  it('rejects symlinks pointing outside safe roots', () => {
    const target = join(externalDir, 'target.png');
    writeFileSync(target, '');
    const link = join(projectDir, 'link.png');
    symlinkSync(target, link);
    const result = resolveAttachment({ input: link, projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('outside-safe-roots');
  });

  it('rejects path-traversal attempts', () => {
    const result = resolveAttachment({ input: '../../etc/passwd.png', projectDir });
    expect(result.ok).toBe(false);
    // Either not-found or outside-safe-roots — either is a refusal.
    if (!result.ok) {
      expect(['not-found', 'outside-safe-roots', 'not-image']).toContain(result.reason);
    }
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

describe('attachmentShortName', () => {
  it('returns the basename unchanged when within budget', () => {
    expect(attachmentShortName('/some/dir/photo.png')).toBe('photo.png');
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
