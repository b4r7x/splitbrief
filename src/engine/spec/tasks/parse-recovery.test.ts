import { describe, it, expect } from 'vitest';
import { dependencyTaskBlock, makeTask } from '#testing/helpers/factories/task.js';
import { formatTasks } from '../formatter.js';
import { parseTasks, parseTaskSourceBlocks, parseTasksStrict } from './parse.js';

describe('parseTasksStrict — block and fence recovery', () => {
  const brief = (id: string, body: string[]) =>
    [
      '---',
      `id: ${id}`,
      `title: "Brief ${id}"`,
      'action: create',
      `file: src/${id.toLowerCase()}.ts`,
      'depends_on: []',
      '---',
      '',
      ...body,
      '',
    ].join('\n');

  const marker = String.fromCharCode(96).repeat(3);
  const completeBrief = (id: string, tail: string[] = []) =>
    brief(id, [
      '### Description',
      'Create the named module.',
      '### Tests',
      '- returns the expected value',
      '### Implementation Steps',
      '1. Create the module and verify the value',
      '### Scope',
      '**In bounds:**',
      '- the named module',
      '**Out of bounds:**',
      '- other modules',
      '### Evidence',
      '- the focused check passes',
      ...tail,
    ]);

  it('reads every brief after an unclosed fence when a later brief has a code sample of its own', () => {
    const input = formatTasks([
      makeTask({
        id: 'T001',
        title: 'Open a sample',
        file: 'src/a.ts',
        description: 'Before:\n```ts\nconst a = 1;',
      }),
      makeTask({ id: 'T002', title: 'Plain brief', file: 'src/b.ts' }),
      makeTask({
        id: 'T003',
        title: 'Fenced signature',
        file: 'src/c.ts',
        signature: 'export function c(): void',
      }),
    ]);
    const unclosed =
      'Task T001 never closes its ```ts code fence, so the rest of the brief is read as code; the fence ends at Task T002';
    const strictWarnings: string[] = [];
    const lenientWarnings: string[] = [];

    const strict = parseTasksStrict(input, (message) => strictWarnings.push(message));
    const lenient = parseTasks(input, { onWarning: (message) => lenientWarnings.push(message) });

    expect(strict.map((t) => t.id)).toEqual(['T001', 'T002', 'T003']);
    expect(lenient.map((t) => t.id)).toEqual(['T001', 'T002', 'T003']);
    expect(strict.find((t) => t.id === 'T003')?.signature).toBe('export function c(): void');
    expect(strictWarnings).toEqual([unclosed]);
    expect(lenientWarnings).toEqual([unclosed]);
    expect(parseTaskSourceBlocks(input).map((b) => b.id)).toEqual(['T001', 'T002', 'T003']);
  });

  it('ends an unclosed fence at the next brief when that brief opens a fence of its own', () => {
    const input = [
      brief('T001', ['### Pattern', '```typescript', 'export function one(): void {']),
      brief('T002', [
        '### Signature',
        '```typescript',
        'export function two(): string',
        '```',
        '',
        '### Tests',
        '- two() returns a string',
      ]),
    ].join('\n');
    const warnings: string[] = [];

    const tasks = parseTasksStrict(input, (message) => warnings.push(message));

    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
    const second = tasks.find((t) => t.id === 'T002');
    expect(second?.signature).toBe('export function two(): string');
    expect(second?.tests).toEqual(['two() returns a string']);
    expect(warnings).toEqual([
      'Task T001 never closes its ```typescript code fence, so the rest of the brief is read as code; the fence ends at Task T002',
    ]);
  });

  it('recovers the next brief when an unclosed ```ts fence starts with its bare header', () => {
    const input = [
      brief('T001', ['### Pattern', '```ts']),
      brief('T002', ['### Description', 'Follow-up work.', '### Tests', '- follow-up passes']),
    ].join('\n');
    const unclosed =
      'Task T001 never closes its ```ts code fence, so the rest of the brief is read as code; the fence ends at Task T002';
    const strictWarnings: string[] = [];
    const lenientWarnings: string[] = [];

    const strict = parseTasksStrict(input, (message) => strictWarnings.push(message));
    const lenient = parseTasks(input, { onWarning: (message) => lenientWarnings.push(message) });

    expect(strict.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(lenient.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(parseTaskSourceBlocks(input).map((b) => b.id)).toEqual(['T001', 'T002']);
    expect(strict.find((t) => t.id === 'T002')?.tests).toEqual(['follow-up passes']);
    expect(strictWarnings).toEqual([unclosed]);
    expect(lenientWarnings).toEqual([unclosed]);
  });

  // Two open fences pair with each other: T002's opener reads as the closer of T001's fence, so
  // the document is a valid code sample either way. The brief that reading costs is named.
  it('names the brief it reads as code when two briefs each leave a fence open', () => {
    const input = [
      brief('T001', ['### Description', '```ts', 'const one = 1;']),
      brief('T002', ['### Description', '```ts', 'const two = 2;']),
      brief('T003', ['### Description', 'Closes nothing, opens nothing.']),
    ].join('\n');
    const warnings: string[] = [];

    const tasks = parseTasksStrict(input, (message) => warnings.push(message));

    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T003']);
    expect(warnings).toEqual([
      'Task T001 holds the header of Task T002 in its ```ts code fence, so Task T002 is read as code, not as a brief',
    ]);
  });

  // T002's closer reads as an opener once T002's opener has closed T001's fence, and T003's header
  // follows it directly, so it looks like a fence opened on a sample of the format. A bare marker
  // is never certainly an opener, so T003 is still named.
  it('names every brief it reads as code when an unclosed fence meets a truncated last brief', () => {
    const input = [
      brief('T001', ['### Current Code', '```ts', 'const one = 1;']),
      brief('T002', ['### Signature', '```ts', 'export function two(): void', '```']),
      brief('T003', ['### Current Code', '```ts', 'const three = 3;']),
    ].join('\n');
    const warnings: string[] = [];

    const tasks = parseTasksStrict(input, (message) => warnings.push(message));

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([
      'Task T001 holds the header of Task T002 in its ```ts code fence, so Task T002 is read as code, not as a brief',
      'Task T001 holds the header of Task T003 in its ``` code fence, so Task T003 is read as code, not as a brief',
    ]);
  });

  it('reads a brief header quoted in a closed code sample as code, and names it', () => {
    const input = [
      brief('T001', [
        '### Current Code',
        '```ts',
        'const input = `---',
        'id: T301',
        '---',
        '',
        '---',
        'id: T302',
        '---',
        '`;',
        '```',
        '',
        '### Tests',
        '- the new case passes',
      ]),
      brief('T002', ['### Signature', '```ts', 'export function helper(): void', '```']),
    ].join('\n');
    const warnings: string[] = [];

    const tasks = parseTasksStrict(input, (message) => warnings.push(message));

    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(tasks[0]?.currentCode).toContain('id: T302');
    expect(tasks[0]?.tests).toEqual(['the new case passes']);
    expect(warnings).toEqual([
      'Task T001 holds the header of Task T302 in its ```ts code fence, so Task T302 is read as code, not as a brief',
    ]);
  });

  it('keeps a brief header inside a fenced sample of the format as sample text', () => {
    const input = [
      brief('T001', [
        '### Pattern',
        '```markdown',
        '---',
        'id: T900',
        'title: "Sample brief"',
        'action: create',
        'file: src/sample.ts',
        'depends_on: []',
        '---',
        '',
        '### Description',
        'Sample body.',
        '```',
        '',
        '### Tests',
        '- the sample renders',
      ]),
      brief('T002', ['### Signature', '```ts', 'export function helper(): void', '```']),
    ].join('\n');
    const warnings: string[] = [];

    const tasks = parseTasksStrict(input, (message) => warnings.push(message));

    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(tasks[0]?.pattern).toContain('id: T900');
    expect(tasks[0]?.tests).toEqual(['the sample renders']);
    expect(warnings).toEqual([]);
  });

  it('keeps two complete brief headers inside a closed md/markdown sample as sample text', () => {
    for (const language of ['md', 'markdown']) {
      const sample = completeBrief('T001', [
        '### Current Code',
        marker + language,
        completeBrief('T900'),
        completeBrief('T901'),
        marker,
      ]);
      const real = completeBrief('T002', [
        '### Signature',
        marker + 'ts',
        'export function next(): void',
        marker,
      ]);
      const input = [sample, real].join('\n');
      const strictWarnings: string[] = [];
      const lenientWarnings: string[] = [];

      const strict = parseTasksStrict(input, (message) => strictWarnings.push(message));
      const lenient = parseTasks(input, { onWarning: (message) => lenientWarnings.push(message) });

      expect(strict.map((t) => t.id)).toEqual(['T001', 'T002']);
      expect(lenient.map((t) => t.id)).toEqual(['T001', 'T002']);
      expect(parseTaskSourceBlocks(input).map((b) => b.id)).toEqual(['T001', 'T002']);
      expect(strictWarnings).toEqual([]);
      expect(lenientWarnings).toEqual([]);

      const outer = strict.find((t) => t.id === 'T001');
      expect(outer?.currentCode).toContain('id: T901');
      expect(outer?.currentCode).toContain('title: "Brief T901"');
      expect(outer?.description).toBe('Create the named module.');
      expect(outer?.tests).toEqual(['returns the expected value']);
      expect(outer?.implementationSteps).toEqual(['Create the module and verify the value']);
      expect(outer?.scope).toEqual({
        inBounds: ['the named module'],
        outOfBounds: ['other modules'],
      });
      expect(outer?.evidence).toEqual(['the focused check passes']);
    }
  });

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
    const warnings: string[] = [];
    const tasks = parseTasksStrict(input, (message) => warnings.push(message));
    expect(tasks.map((t) => t.id)).toEqual(['T301', 'T302']);
    const following = tasks.find((t) => t.id === 'T302');
    expect(following?.file).toBe('src/following.ts');
    expect(warnings).toEqual([
      'Task T301 never closes its ```typescript code fence, so the rest of the brief is read as code; the fence ends at Task T302',
    ]);
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
