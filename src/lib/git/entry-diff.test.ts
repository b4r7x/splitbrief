import { describe, expect, it } from 'vitest';
import { diffFileEntries } from './entry-diff.js';

describe('diffFileEntries', () => {
  it('quotes non-ASCII and whitespace paths in Git format', async () => {
    const diff = await diffFileEntries({
      path: 'docs/café notes.md',
      before: null,
      after: { bytes: Buffer.from('hello\n'), mode: 0o644 },
    });
    expect(diff).toContain(
      'diff --git "a/docs/caf\\303\\251 notes.md" "b/docs/caf\\303\\251 notes.md"',
    );
    expect(diff).toContain('+hello');
    expect(diff).toContain('new file mode 100644');
  });

  it('reports binary contents rather than decoding them as text', async () => {
    const diff = await diffFileEntries({
      path: 'image.bin',
      before: null,
      after: { bytes: Buffer.from([0, 255, 1]), mode: 0o644 },
    });
    expect(diff).toContain('Binary files');
  });

  it('rejects paths outside its captured-entry directories', async () => {
    await expect(
      diffFileEntries({
        path: '../escape',
        before: null,
        after: { bytes: Buffer.from('hello'), mode: 0o644 },
      }),
    ).rejects.toMatchObject({ kind: 'path-confined-escape' });
  });
});
