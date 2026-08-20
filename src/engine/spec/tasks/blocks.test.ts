import { describe, it, expect } from 'vitest';
import {
  parseTaskBlock,
  readTaskFrontmatter,
  splitTaskBlocks,
  unwrapFencedTaskDocument,
} from './blocks.js';

function taskBlock(id: string): string {
  return `---
id: ${id}
title: "Task ${id}"
action: create
file: src/${id.toLowerCase()}.ts
depends_on: []
---

### Description
Task ${id}.
`;
}

describe('unwrapFencedTaskDocument', () => {
  const taskBody = ['---', 'id: T001', 'title: "Wrapped"', '---', '', '### Description', 'Body.'];

  it('returns null when the document has no fences', () => {
    expect(unwrapFencedTaskDocument(taskBody.join('\n'))).toBeNull();
  });

  it('returns null when no fenced region contains task structure', () => {
    const doc = ['Prose.', '```bash', 'npm test', '```', 'More prose.'].join('\n');
    expect(unwrapFencedTaskDocument(doc)).toBeNull();
  });

  it('returns the fenced document without the narration around it', () => {
    const doc = ['Intro prose.', '```markdown', ...taskBody, '```', 'Outro prose.'].join('\n');
    expect(unwrapFencedTaskDocument(doc)).toBe(taskBody.join('\n'));
  });

  it('keeps shorter inner fences intact inside a four-backtick wrapper', () => {
    const inner = [...taskBody, '', '### Current Code', '```ts', 'const x = 1;', '```'].join('\n');
    const doc = `Intro.\n\n\`\`\`\`markdown\n${inner}\n\`\`\`\`\nOutro.`;
    expect(unwrapFencedTaskDocument(doc)).toBe(inner);
  });

  it('keeps a wrapper fence as long as the inner fences from closing on the first one', () => {
    const inner = [
      ...taskBody,
      '',
      '### Current Code',
      '```js',
      'const x = 1;',
      '```',
      '',
      '### Tests',
      '- x is 1',
    ].join('\n');
    const doc = ['```markdown', inner, '```', 'Say the word and I will write it.'].join('\n');
    expect(unwrapFencedTaskDocument(doc)).toBe(inner);
  });

  it('captures an unclosed wrapper through end of input', () => {
    const doc = ['Intro.', '````markdown', ...taskBody].join('\n');
    expect(unwrapFencedTaskDocument(doc)).toBe(taskBody.join('\n'));
  });

  it('joins task-shaped regions and drops the others', () => {
    const second = ['---', 'id: T002', 'title: "Second"', '---', '', '### Description', 'B.'];
    const doc = [
      '```bash',
      'npm test',
      '```',
      'First:',
      '```markdown',
      ...taskBody,
      '```',
      'Second:',
      '```markdown',
      ...second,
      '```',
    ].join('\n');
    expect(unwrapFencedTaskDocument(doc)).toBe(`${taskBody.join('\n')}\n${second.join('\n')}`);
  });
});

describe('splitTaskBlocks', () => {
  it('recovers later blocks when an earlier body has an unclosed code fence', () => {
    const input = `---
id: T301
title: "Unclosed fence"
action: modify
file: src/unclosed.ts
depends_on: []
---

### Description
Body with a code fence that is never closed.

### Pattern
\`\`\`typescript
export function broken(): void {

---
id: T302
title: "Following task"
action: create
file: src/following.ts
depends_on: []
---

### Description
This task must not be swallowed by the unclosed fence above.
`;
    const blocks = splitTaskBlocks(input);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('id: T301');
    expect(blocks[1]).toContain('id: T302');
  });

  it('preserves fenced --- delimiters inside a block body', () => {
    const input = `---
id: T201
title: "Fenced delimiter"
action: modify
file: src/fenced.ts
depends_on: []
---

### Description
Body includes a fenced block.

### Pattern
\`\`\`yaml
---
key: value
---
\`\`\`
`;
    const blocks = splitTaskBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('key: value');
  });

  it('keeps a truncated single block through end of input', () => {
    const input = `---
id: T401
title: "Truncated mid-fence"
action: modify
file: src/truncated.ts
depends_on: []
---

### Description
Body cut off while a code fence is still open.

### Pattern
\`\`\`typescript
export function broken(): void {`;
    const blocks = splitTaskBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('id: T401');
  });

  it('does not open a block on a bare separator followed by prose', () => {
    const input = `${taskBlock('T001')}
---

That is the whole plan; say the word and I will write it.
`;
    const blocks = splitTaskBlocks(input);
    expect(blocks).toHaveLength(1);
  });
});

describe('readTaskFrontmatter', () => {
  it('reads valid frontmatter with depends_on defaulting to an empty list', () => {
    const result = readTaskFrontmatter(taskBlock('T001'));
    if (!result.ok) throw new Error('expected frontmatter to parse');
    expect(result.data).toMatchObject({
      id: 'T001',
      action: 'create',
      file: 'src/t001.ts',
      depends_on: [],
    });
  });

  it('rejects an alternation action naming the field and the value', () => {
    const block = taskBlock('T001').replace('action: create', 'action: create | modify');
    const result = readTaskFrontmatter(block);
    if (result.ok) throw new Error('expected frontmatter to be rejected');
    expect(result.reason).toContain('task T001');
    expect(result.reason).toContain('`action`');
    expect(result.reason).toContain('"create | modify"');
  });

  it('rejects frontmatter that never closes', () => {
    const block = `---
id: T999
title: "Unterminated"
action: create
file: src/unterminated.ts
depends_on: []
`;
    const result = readTaskFrontmatter(block);
    if (result.ok) throw new Error('expected frontmatter to be rejected');
    expect(result.reason).toContain('no closing --- delimiter');
  });
});

describe('parseTaskBlock', () => {
  it('parses a valid block into a schema-shaped Task', () => {
    const result = parseTaskBlock(taskBlock('T001'));
    if (!result.ok) throw new Error('expected the block to parse');
    expect(result.task).toMatchObject({
      id: 'T001',
      title: 'Task T001',
      action: 'create',
      file: 'src/t001.ts',
      dependsOn: [],
      description: 'Task T001.',
      status: 'pending',
    });
    expect(result.task.typeDefs).toBe('');
  });

  it('parses a frontmatter-only block with empty section defaults', () => {
    const block = `---
id: T090
title: "Frontmatter only"
action: create
file: src/fm.ts
depends_on: []
---
`;
    const result = parseTaskBlock(block);
    if (!result.ok) throw new Error('expected the block to parse');
    expect(result.task.description).toBe('');
    expect(result.task.tests).toEqual([]);
    expect(result.task.constraints).toEqual([]);
    expect(result.task.implementationSteps).toEqual([]);
  });

  it('rejects a malformed block with a frontmatter diagnostic', () => {
    const block = `---
id: T002
title:
action: create
file: src/broken.ts
depends_on: []
---

### Description
Malformed title.
`;
    const result = parseTaskBlock(block);
    if (result.ok) throw new Error('expected the block to be rejected');
    expect(result.reason).toContain('`title`');
  });

  it('rejects a prose block that carries no frontmatter', () => {
    const result = parseTaskBlock('I reviewed the repo and here is my plan.');
    if (result.ok) throw new Error('expected the block to be rejected');
    expect(result.reason).toContain('no closing --- delimiter');
  });
});
