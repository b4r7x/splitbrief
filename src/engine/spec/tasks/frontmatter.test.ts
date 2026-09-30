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

describe('readTaskFrontmatter planner spellings', () => {
  function header(fields: string): string {
    return `---\ntitle: "Slice"\nfile: src/x.ts\n${fields}\n---\n\n### Description\nBody.\n`;
  }

  it('reads a capitalised action', () => {
    const result = readTaskFrontmatter(header('id: T001\naction: Modify'));
    if (!result.ok) throw new Error(`expected frontmatter to parse: ${result.reason}`);
    expect(result.data.action).toBe('modify');
  });

  it('pads a short id and short dependency ids to three digits', () => {
    const result = readTaskFrontmatter(header('id: T2\naction: create\ndepends_on: [T1, T02]'));
    if (!result.ok) throw new Error(`expected frontmatter to parse: ${result.reason}`);
    expect(result.data.id).toBe('T002');
    expect(result.data.depends_on).toEqual(['T001', 'T002']);
  });

  it.each(['T001, T002', 'T001 T002', 'T1,T2'])('splits depends_on written as %s', (value) => {
    const result = readTaskFrontmatter(header(`id: T003\naction: create\ndepends_on: ${value}`));
    if (!result.ok) throw new Error(`expected frontmatter to parse: ${result.reason}`);
    expect(result.data.depends_on).toEqual(['T001', 'T002']);
  });

  it.each(['id: T1000', 'id: task-1', 'id: T', 'depends_on: T001, B2'])(
    'still rejects %s',
    (field) => {
      const fields = field.startsWith('id:') ? field : `id: T001\n${field}`;
      expect(readTaskFrontmatter(header(`${fields}\naction: create`)).ok).toBe(false);
    },
  );
});
