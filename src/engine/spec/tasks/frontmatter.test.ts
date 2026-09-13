import { describe, it, expect } from 'vitest';
import { readTaskFrontmatter } from './frontmatter.js';

function block(fields: string): string {
  return `---
id: T001
title: "Slice"
action: create
file: src/x.ts
${fields}
---

### Description
Body.
`;
}

describe('readTaskFrontmatter files', () => {
  it('accepts files[] with the same confinement refine as file', () => {
    const accepted = readTaskFrontmatter(block('files: [src/x.ts, src/x.test.ts]'));
    if (!accepted.ok) throw new Error(`expected frontmatter to parse: ${accepted.reason}`);
    expect(accepted.data.files).toEqual(['src/x.ts', 'src/x.test.ts']);

    const rejectedList = readTaskFrontmatter(block('files: [src/x.ts, ../x.ts]'));
    if (rejectedList.ok) throw new Error('expected an escaping path to be rejected');
    expect(rejectedList.reason).toContain('confined relative path');
  });

  it('reads a scalar files value as a one-entry list', () => {
    const result = readTaskFrontmatter(block('files: src/x.ts'));
    if (!result.ok) throw new Error(`expected frontmatter to parse: ${result.reason}`);
    expect(result.data.files).toEqual(['src/x.ts']);
  });

  it('leaves files undefined when the key is absent', () => {
    const result = readTaskFrontmatter(block('depends_on: []'));
    if (!result.ok) throw new Error(`expected frontmatter to parse: ${result.reason}`);
    expect(result.data.files).toBeUndefined();
  });
});
