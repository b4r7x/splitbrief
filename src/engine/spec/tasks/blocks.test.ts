import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { unwrapFencedTaskDocument } from './blocks.js';
import { parseTaskSourceBlocks, parseTasks, parseTasksStrict } from './parse.js';

const BRIEF_FIXTURES = join(import.meta.dirname, '../../../../testing/fixtures/briefs');

function dependencyTaskBlock(id: string): string {
  return `---
id: ${id}
title: "Dependency ${id}"
action: create
file: src/${id.toLowerCase()}.ts
depends_on: []
---

### Description
Dependency task.
`;
}

describe('parseTasks with file-level frontmatter', () => {
  it('strips file-level frontmatter before parsing task blocks', () => {
    const input = `---
generated_by: splitbrief v0.1.0
planner: claude-code
implementer: ollama
mode: standard
created_at: 2025-01-01T00:00:00.000Z
---
---
id: T001
title: "Create project structure"
action: create
file: src/index.ts
depends_on: []
---

### Description
Set up the initial project directory structure.

### Tests
- Should create src/ directory

### Constraints
- Must be idempotent
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.id).toBe('T001');
    expect(tasks[0]?.title).toBe('Create project structure');
  });

  it('strips file-level frontmatter with CRLF line endings before parsing task blocks', () => {
    const input =
      '---\r\n' +
      'generated_by: splitbrief v0.1.0\r\n' +
      'planner: claude-code\r\n' +
      '---\r\n' +
      '---\r\n' +
      'id: T001\r\n' +
      'title: "Create project structure"\r\n' +
      'action: create\r\n' +
      'file: src/index.ts\r\n' +
      'depends_on: []\r\n' +
      '---\r\n' +
      '\r\n' +
      '### Description\r\n' +
      'Set up the initial project directory structure.\r\n' +
      '\r\n' +
      '### Tests\r\n' +
      '- Should create src/ directory\r\n' +
      '\r\n' +
      '### Constraints\r\n' +
      '- Must be idempotent\r\n';

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.id).toBe('T001');
    expect(tasks[0]?.title).toBe('Create project structure');
    expect(tasks[0]?.file).toBe('src/index.ts');
  });
});

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
  it('throws on a task block whose frontmatter is never closed before end of input', () => {
    const input = `${dependencyTaskBlock('T001')}
---
id: T999
title: "Unterminated frontmatter"
action: create
file: src/unterminated.ts
depends_on: []
`;
    expect(() => parseTasksStrict(input)).toThrow('unterminated task block after separator');
  });

  it('throws on a trailing in-frontmatter block with content but no id at end of input', () => {
    const input = `${dependencyTaskBlock('T001')}
---
title: "Dangling frontmatter without id"
action: create
file: src/dangling.ts
`;
    expect(() => parseTasksStrict(input)).toThrow('unterminated task block after separator');
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

describe('parseTasksStrict — real planner captures', () => {
  const codexFixture = readFileSync(
    join(BRIEF_FIXTURES, 'codex-standard-phase-separators.md'),
    'utf-8',
  );
  const opencodeFixture = readFileSync(
    join(BRIEF_FIXTURES, 'opencode-trailing-separator-prose.md'),
    'utf-8',
  );

  it('parses the codex standard-phase-separators capture to T001 and T002 in strict mode', () => {
    const warnings: string[] = [];
    const tasks = parseTasksStrict(codexFixture, (message) => warnings.push(message));

    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(warnings).toEqual([]);
    expect(parseTaskSourceBlocks(codexFixture).map((b) => b.id)).toEqual(['T001', 'T002']);
  });

  it('parses the opencode trailing-separator-prose capture with trailing --- and prose ignored in strict mode', () => {
    const warnings: string[] = [];
    const tasks = parseTasksStrict(opencodeFixture, (message) => warnings.push(message));

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
    expect(opencodeFixture).toContain('Note: per the "Output" instruction');
  });
});

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
