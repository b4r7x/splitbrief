import { describe, it, expect } from 'vitest';
import { dependencyTaskBlock } from '#testing/helpers/factories/task.js';
import { parseTaskSourceBlocks, parseTasksStrict } from './parse.js';

describe('parseTasksStrict — block and fence recovery', () => {
  it('recovers later tasks when an earlier body has an unclosed code fence', () => {
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

### Tests
- pattern present

### Constraints
- none

---
id: T302
title: "Following task"
action: create
file: src/following.ts
depends_on: []
---

### Description
This task must not be swallowed by the unclosed fence above.

### Tests
- task is parsed

### Constraints
- none
`;
    const tasks = parseTasksStrict(input);
    expect(tasks.map((t) => t.id)).toEqual(['T301', 'T302']);
    const following = tasks.find((t) => t.id === 'T302');
    expect(following?.file).toBe('src/following.ts');
  });

  it('parses a single task truncated mid-fence at end of input', () => {
    const input = `---
id: T401
title: "Truncated mid-fence"
action: modify
file: src/truncated.ts
depends_on: []
---

### Description
Body cut off while a code fence is still open.

### Tests
- task survives truncation

### Constraints
- none

### Pattern
\`\`\`typescript
export function broken(): void {`;
    const tasks = parseTasksStrict(input);
    expect(tasks.map((t) => t.id)).toEqual(['T401']);
    expect(tasks[0]?.file).toBe('src/truncated.ts');
    expect(tasks[0]?.tests).toEqual(['task survives truncation']);
  });
  it('throws when the only content is an unterminated frontmatter block with no preceding task', () => {
    const input = `---
id: T999
title: "Unterminated frontmatter"
action: create
file: src/unterminated.ts
depends_on: []
`;
    expect(() => parseTasksStrict(input)).toThrow(
      expect.objectContaining({ kind: 'parse-tasks-unterminated-block' }),
    );
  });

  it('keeps earlier tasks when a bare trailing separator carries no frontmatter body at all', () => {
    const input = `${dependencyTaskBlock('T001')}
---
`;
    const tasks = parseTasksStrict(input);
    expect(tasks.map((t) => t.id)).toEqual(['T001']);
  });
  it('preserves fenced --- delimiters inside task bodies', () => {
    const input = `---
id: T201
title: "Fenced delimiter"
action: modify
file: src/fenced.ts
depends_on: []
---

### Description
Task body includes a fenced block.

### Pattern
\`\`\`yaml
---
key: value
---
\`\`\`

### Tests
- pattern preserved

### Constraints
- none
`;
    const tasks = parseTasksStrict(input);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.pattern).toContain('key: value');
  });

  it('does not inject a newline into a fenced line ending in --- followed by id:', () => {
    const input = `---
id: T202
title: "Verbatim --- before id inside fence"
action: modify
file: src/verbatim.ts
depends_on: []
---

### Description
Body documents YAML where a line ends in --- right before an id key.

### Current Code
\`\`\`yaml
name: example---
id: 42
\`\`\`

### Tests
- fenced content preserved verbatim

### Constraints
- none
`;
    const tasks = parseTasksStrict(input);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.currentCode).toBe('name: example---\nid: 42');
    expect(tasks[0]?.id).toBe('T202');
  });
});

describe('parseTasksStrict — `---` as a horizontal rule', () => {
  const phaseSeparatedPlan = `# Task Briefs: clamp

## Phase 1: Core Function
Add the function.

---
id: T001
title: "Add clamp to src/math.js"
action: modify
file: src/math.js
depends_on: []
---

### Description
Constrain a value to [min, max].

### Constraints
- none

---

## Phase 2: Test Coverage
Cover the new function.

---
id: T002
title: "Add clamp test"
action: modify
file: src/math.test.js
depends_on: [T001]
---

### Description
Assert the boundaries.

### Constraints
- none
`;

  it('in-body `---` followed by a `##` heading does not close the block', () => {
    const warnings: string[] = [];
    const tasks = parseTasksStrict(phaseSeparatedPlan, (message) => warnings.push(message));

    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(warnings).toEqual([]);

    const blocks = parseTaskSourceBlocks(phaseSeparatedPlan);
    expect(blocks.map((b) => b.id)).toEqual(['T001', 'T002']);
    expect(blocks[0]?.source).toContain('## Phase 2: Test Coverage');
  });

  it('trailing `---` followed by prose after the last brief yields all briefs and no rejection', () => {
    const warnings: string[] = [];
    const tasks = parseTasksStrict(
      `${dependencyTaskBlock('T001')}\n---\n\nThat is the whole plan; say the word and I will write it.\n`,
      (message) => warnings.push(message),
    );

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
  });

  it('trailing `---` followed by colon-bearing prose opens no block and strict does not throw', () => {
    const input = `${dependencyTaskBlock('T001')}\n---\n\nNote: per the "Output" instruction \`tasks.md\` is the transport; I emitted its content above.\n`;
    const warnings: string[] = [];
    const tasks = parseTasksStrict(input, (message) => warnings.push(message));

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
  });
});
