import { describe, expect, it } from 'vitest';
import { encodeSnapshotPath, generateSnapshotId } from './path-codec.js';

describe('generateSnapshotId', () => {
  it('produces a valid ISO slug with hyphens not colons', () => {
    const id = generateSnapshotId(new Date('2026-04-26T14:30:00.000Z'));
    expect(id).toBe('2026-04-26T14-30-00-000Z');
    expect(id).not.toContain(':');
    expect(id).not.toContain('.');
  });
});

describe('encodeSnapshotPath', () => {
  it('encodes paths to a fixed-length filesystem-safe form without slashes', () => {
    const encoded = encodeSnapshotPath('a/b/c.ts');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('\\');
    expect(encoded).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces distinct encodings for paths whose legacy double-underscore form would collide', () => {
    // The legacy encoding split on '/' and joined with '__', so 'a/b.ts'
    // and a single segment literally containing '__' could collide. Verify
    // the new encoding keeps them apart.
    const a = encodeSnapshotPath('a/b.ts');
    const b = encodeSnapshotPath('a__b.ts');
    expect(a).not.toBe(b);
  });

  it('is deterministic for the same path', () => {
    const path = 'src/nested/file name.ts';
    expect(encodeSnapshotPath(path)).toBe(encodeSnapshotPath(path));
  });

  it('keeps the blob filename short for very long unicode paths', () => {
    // hex(utf8(path)) doubled (or worse, for multi-byte chars) the byte count,
    // so deep CJK paths blew past the 255-byte filename limit. sha256 names are
    // always 64 chars regardless of input length.
    const longUnicodePath = `${'長い経路名'.repeat(50)}/файл.ts`;
    expect(encodeSnapshotPath(longUnicodePath)).toHaveLength(64);
  });
});
