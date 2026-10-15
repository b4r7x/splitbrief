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

  it('diffs a symlink by its target: create, retarget, delete and a file it replaced', async () => {
    const file = { bytes: Buffer.from('readme\n'), mode: 0o644 };
    const created = await diffFileEntries({
      path: 'docs/readme.md',
      before: null,
      after: { target: '../README.md' },
    });
    expect(created).toContain('new file mode 120000');
    expect(created).toContain('+../README.md');
    const retargeted = await diffFileEntries({
      path: 'docs/readme.md',
      before: { target: '../README.md' },
      after: { target: '../CHANGELOG.md' },
    });
    expect(retargeted).toMatch(/^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/m);
    expect(retargeted).toContain('-../README.md');
    expect(retargeted).toContain('+../CHANGELOG.md');
    const deleted = await diffFileEntries({
      path: 'docs/readme.md',
      before: { target: '../README.md' },
      after: null,
    });
    expect(deleted).toContain('deleted file mode 120000');
    const replaced = await diffFileEntries({
      path: 'docs/readme.md',
      before: file,
      after: { target: '../README.md' },
    });
    expect(replaced).toContain('deleted file mode 100644');
    expect(replaced).toContain('new file mode 120000');
    expect(replaced.match(/^diff --git .*$/gm)).toEqual([
      'diff --git "a/docs/readme.md" "b/docs/readme.md"',
      'diff --git "a/docs/readme.md" "b/docs/readme.md"',
    ]);
  });
});
