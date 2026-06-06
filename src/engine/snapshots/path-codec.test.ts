import { describe, expect, it } from 'vitest';
import { decodeSnapshotPath, encodeSnapshotPath, generateSnapshotId } from './path-codec.js';

describe('generateSnapshotId', () => {
  it('produces a valid ISO slug with hyphens not colons', () => {
    const id = generateSnapshotId(new Date('2026-04-26T14:30:00.000Z'));
    expect(id).toBe('2026-04-26T14-30-00-000Z');
    expect(id).not.toContain(':');
    expect(id).not.toContain('.');
  });
});

describe('encodeSnapshotPath', () => {
  it('encodes paths to a filesystem-safe form without slashes', () => {
    const encoded = encodeSnapshotPath('a/b/c.ts');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('\\');
    expect(encoded).toMatch(/^[a-f0-9]+$/);
  });

  it('produces distinct encodings for paths whose legacy double-underscore form would collide', () => {
    // The legacy encoding split on '/' and joined with '__', so 'a/b.ts'
    // and a single segment literally containing '__' could collide. Verify
    // the new encoding keeps them apart.
    const a = encodeSnapshotPath('a/b.ts');
    const b = encodeSnapshotPath('a__b.ts');
    expect(a).not.toBe(b);
  });

  it('decodes the filesystem-safe path form', () => {
    const path = 'src/nested/file name.ts';
    expect(decodeSnapshotPath(encodeSnapshotPath(path))).toBe(path);
  });
});
