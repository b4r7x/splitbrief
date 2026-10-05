import { describe, expect, it } from 'vitest';
import { splitDiffByFile } from './diff-sections.js';

describe('splitDiffByFile', () => {
  it('splits a diff into one section per file with both paths', () => {
    const first =
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
    const second = 'diff --git a/docs/my notes.md b/docs/my notes.md\nnew file mode 100644\n';
    expect(splitDiffByFile(first + second)).toEqual([
      { before: 'src/a.ts', after: 'src/a.ts', diff: first },
      { before: 'docs/my notes.md', after: 'docs/my notes.md', diff: second },
    ]);
  });

  it('reads a header where git quoted only one of the two paths', () => {
    // Git C-quotes each path on its own: a rename from an ASCII name to a non-ASCII one quotes only
    // the new name.
    const rename =
      'diff --git a/plain.txt "b/caf\\303\\251.txt"\nsimilarity index 100%\nrename from plain.txt\nrename to "caf\\303\\251.txt"\n';
    expect(splitDiffByFile(rename)).toEqual([
      { before: 'plain.txt', after: 'café.txt', diff: rename },
    ]);
  });
});
