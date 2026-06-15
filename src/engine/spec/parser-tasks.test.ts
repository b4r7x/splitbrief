import { describe, it, expect } from 'vitest';
import { parseTasks, parseTasksStrict } from './parser.js';
import { formatTasks } from './formatter.js';

const validTasksMd = `---
id: T001
title: "Create project structure"
action: create
file: src/index.ts
depends_on: []
---

### Description
Set up the initial project directory structure.

### Signature
\`\`\`typescript
export function init(): void
\`\`\`

### Tests
- Should create src/ directory
- Should create package.json

### Constraints
- Must be idempotent

### Pattern
Use mkdir -p equivalent.

---
id: T002
title: "Add configuration loader"
action: create
file: src/config.ts
depends_on: [T001]
---

### Description
Load configuration from YAML file.

### Tests
- Should load default config
- Should merge user overrides

### Constraints
- Validate all fields on load

---
id: T003
title: "Implement CLI entry"
action: modify
file: src/cli.ts
depends_on: [T001, T002]
---

### Description
Wire up commander for CLI argument parsing.

### Signature
\`\`\`typescript
export function main(argv: string[]): Promise<void>
\`\`\`

### Tests
- Should parse start command
- Should parse init command

### Constraints
- Exit code 1 on unknown command

### Pattern
Use commander's .command() API.
`;

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

describe('parseTasks', () => {
  it('parses a valid tasks.md with 3 tasks in topologically sorted order', () => {
    const tasks = parseTasks(validTasksMd);

    expect(tasks.length).toBe(3);

    const t1 = tasks.find((t) => t.id === 'T001');
    if (!t1) throw new Error('T001 not found');
    expect(t1.title).toBe('Create project structure');
    expect(t1.action).toBe('create');
    expect(t1.file).toBe('src/index.ts');
    expect(t1.dependsOn).toEqual([]);
    expect(t1.description).toBe('Set up the initial project directory structure.');
    expect(t1.signature).toBe('export function init(): void');
    expect(t1.tests).toEqual(['Should create src/ directory', 'Should create package.json']);
    expect(t1.constraints).toEqual(['Must be idempotent']);
    expect(t1.pattern).toBe('Use mkdir -p equivalent.');
    expect(t1.status).toBe('pending');

    const t3 = tasks.find((t) => t.id === 'T003');
    if (!t3) throw new Error('T003 not found');
    expect(t3.action).toBe('modify');
    expect(t3.dependsOn).toEqual(['T001', 'T002']);

    const ids: string[] = tasks.map((t) => t.id);
    expect(ids.indexOf('T001')).toBeLessThan(ids.indexOf('T002'));
    expect(ids.indexOf('T001')).toBeLessThan(ids.indexOf('T003'));
    expect(ids.indexOf('T002')).toBeLessThan(ids.indexOf('T003'));
  });

  it('preserves a valid non-ID-ascending order instead of re-sorting by ID', () => {
    const input = `---
id: T002
title: "Higher id, listed first"
action: create
file: src/two.ts
depends_on: []
---

### Description
Independent task authored first in the file.

---
id: T001
title: "Lower id, listed second"
action: create
file: src/one.ts
depends_on: []
---

### Description
Independent task authored second in the file.
`;

    const tasks = parseTasks(input);
    expect(tasks.map((t) => t.id)).toEqual(['T002', 'T001']);
  });

  it('handles missing optional sections (no Signature, no Pattern)', () => {
    const input = `---
id: T010
title: "Minimal task"
action: create
file: src/minimal.ts
depends_on: []
---

### Description
A task with no signature or pattern sections.

### Tests
- Should work

### Constraints
- None
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);

    const task = tasks[0];
    if (!task) throw new Error('expected task');
    expect(task.signature).toBe(undefined);
    expect(task.pattern).toBe(undefined);
    expect(task.description).toBe('A task with no signature or pattern sections.');
    expect(task.tests).toEqual(['Should work']);
    expect(task.constraints).toEqual(['None']);
  });

  it('skips tasks with malformed YAML and returns valid ones', () => {
    const input = `---
id: T020
title: "Good task"
action: create
file: src/good.ts
depends_on: []
---

### Description
This task is valid.

### Tests
- Should pass

### Constraints
- Be good

---
id:
title:
action: invalid_action
file:
depends_on: []
---

### Description
This task has missing required fields and invalid action.
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.id).toBe('T020');
  });

  it('parses task frontmatter when planner narration is attached to the delimiter', () => {
    const input = `---
generated_by: diptych v0.1.0
planner: codex
implementer: codex
mode: quick
created_at: 2026-04-22T17:31:07.683Z
---
I inspected the repo and will emit tasks now.---
id: T030
title: "Task after narration"
action: create
file: src/after-narration.ts
depends_on: []
---

### Description
Create a file after planner narration.

### Tests
- Should parse the task

### Constraints
- None
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.id).toBe('T030');
    expect(tasks[0]?.file).toBe('src/after-narration.ts');
  });

  it('parses bare depends_on without brackets as single-element array', () => {
    const input = `---
id: T050
title: "Task with bare dep"
action: create
file: src/bare.ts
depends_on: T001
---

### Description
Task with bare depends_on value.

### Tests
- Should work

### Constraints
- None
`;

    const tasks = parseTasks(`${dependencyTaskBlock('T001')}\n${input}`);
    const task = tasks.find((t) => t.id === 'T050');
    expect(task?.dependsOn).toEqual(['T001']);
  });

  it('strips double quotes from bare depends_on value', () => {
    const input = `---
id: T060
title: "Task with quoted dep"
action: create
file: src/quoted.ts
depends_on: "T001"
---

### Description
Task with double-quoted depends_on value.

### Tests
- Should work

### Constraints
- None
`;

    const tasks = parseTasks(`${dependencyTaskBlock('T001')}\n${input}`);
    const task = tasks.find((t) => t.id === 'T060');
    expect(task?.dependsOn).toEqual(['T001']);
  });

  it('strips single quotes from bare depends_on value', () => {
    const input = `---
id: T061
title: "Task with single-quoted dep"
action: create
file: src/quoted2.ts
depends_on: 'T001'
---

### Description
Task with single-quoted depends_on value.

### Tests
- Should work

### Constraints
- None
`;

    const tasks = parseTasks(`${dependencyTaskBlock('T001')}\n${input}`);
    const task = tasks.find((t) => t.id === 'T061');
    expect(task?.dependsOn).toEqual(['T001']);
  });

  it('strips quotes from array depends_on values', () => {
    const input = `---
id: T062
title: "Task with quoted array deps"
action: create
file: src/quoted3.ts
depends_on: ['T001', "T002"]
---

### Description
Task with quoted array depends_on values.

### Tests
- Should work

### Constraints
- None
`;

    const tasks = parseTasks(
      `${dependencyTaskBlock('T001')}\n${dependencyTaskBlock('T002')}\n${input}`,
    );
    const task = tasks.find((t) => t.id === 'T062');
    expect(task?.dependsOn).toEqual(['T001', 'T002']);
  });

  it('returns empty array for empty input', () => {
    expect(parseTasks('')).toEqual([]);
  });

  it('returns a task from a frontmatter-only block with no body sections', () => {
    const input = `---
id: T090
title: "Frontmatter only"
action: create
file: src/fm.ts
depends_on: []
---
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.id).toBe('T090');
    expect(tasks[0]?.description).toBe('');
    expect(tasks[0]?.tests).toEqual([]);
    expect(tasks[0]?.constraints).toEqual([]);
    expect(tasks[0]?.signature).toBeUndefined();
    expect(tasks[0]?.pattern).toBeUndefined();
    expect(tasks[0]?.typeDefs).toBe('');
    expect(tasks[0]?.implementationSteps).toEqual([]);
  });

  it('throws on circular dependencies', () => {
    const input = `---
id: T001
title: "Task A"
action: create
file: a.ts
depends_on: [T002]
---

### Description
Depends on T002.

### Tests
- Test A

### Constraints
- None

---
id: T002
title: "Task B"
action: create
file: b.ts
depends_on: [T001]
---

### Description
Depends on A.

### Tests
- Test B

### Constraints
- None
`;

    expect(() => parseTasks(input)).toThrow('Circular dependency');
  });

  it('throws on duplicate task IDs instead of silently collapsing', () => {
    const input = `${dependencyTaskBlock('T001')}
---
id: T001
title: "Duplicate task"
action: create
file: src/duplicate.ts
depends_on: []
---

### Description
Second block with the same ID.

### Tests
- Should fail parse

### Constraints
- None
`;

    expect(() => parseTasks(input)).toThrow('Duplicate task ID: T001');
  });
});

describe('typeDefs and implementationSteps parsing', () => {
  it('parses Current Code and Pattern as code context for modify tasks', () => {
    const input = `---
id: T001
title: Test task
action: modify
file: src/test.ts
depends_on: []
---

### Description
Implement something.

### Current Code
\`\`\`typescript
export function existing(): string {
  return 'old';
}
\`\`\`

### Pattern
Follow the existing parser helper shape.

### Tests
- test() should return new value

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.currentCode).toBe("export function existing(): string {\n  return 'old';\n}");
    expect(tasks[0]?.pattern).toBe('Follow the existing parser helper shape.');
  });

  it('keeps ### lines inside a fenced Current Code block out of section headers', () => {
    const input = `---
id: T001
title: Test task
action: modify
file: src/test.ts
depends_on: []
---

### Description
Implement something.

### Current Code
\`\`\`markdown
### Existing heading inside fence
- bullet that must not become a section
\`\`\`

### Tests
- test() should return new value

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.currentCode).toBe(
      '### Existing heading inside fence\n- bullet that must not become a section',
    );
    expect(tasks[0]?.tests).toEqual(['test() should return new value']);
    expect(tasks[0]?.constraints).toEqual(['Use ESM imports']);
  });

  it('preserves nested fenced content inside Current Code instead of truncating at the first inner fence', () => {
    const input = `---
id: T001
title: Test task
action: modify
file: src/test.ts
depends_on: []
---

### Description
Document the fenced example.

### Current Code
\`\`\`\`markdown
Render a snippet:

\`\`\`ts
const greeting = 'hello';
\`\`\`

Then explain it below.
\`\`\`\`

### Tests
- snippet preserved

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.currentCode).toBe(
      "Render a snippet:\n\n```ts\nconst greeting = 'hello';\n```\n\nThen explain it below.",
    );
  });

  it('parses Type Definitions section', () => {
    const input = `---
id: T001
title: Test task
action: create
file: src/test.ts
depends_on: []
---

### Description
Implement something.

### Type Definitions
\`\`\`typescript
export interface Config {
  name: string;
}
\`\`\`

### Tests
- test() should not throw

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.typeDefs).toBe('export interface Config {\n  name: string;\n}');
  });

  it('parses Implementation Steps section', () => {
    const input = `---
id: T001
title: Test task
action: create
file: src/test.ts
depends_on: []
---

### Description
Implement something.

### Implementation Steps
1. Import Config from types
2. Create function that returns void
3. Add validation logic

### Tests
- test() should not throw

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.implementationSteps).toEqual([
      'Import Config from types',
      'Create function that returns void',
      'Add validation logic',
    ]);
  });

  it('mixed — only implementationSteps present', () => {
    const input = `---
id: T001
title: Test task
action: create
file: src/test.ts
depends_on: []
---

### Description
Has implementation steps but no type definitions.

### Implementation Steps
1. Read the file
2. Transform the data

### Tests
- Should work

### Constraints
- None
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.typeDefs).toBe('');
    expect(tasks[0]?.implementationSteps).toEqual(['Read the file', 'Transform the data']);
  });

  it('accepts legacy implementer heading aliases without losing contract fields', () => {
    const input = `---
id: T001
title: Test task
action: create
file: src/test.ts
depends_on: []
---

### What To Do
Implement something.

### Function Signature
export function test(): void

### Tests (must pass after implementation)
- test() should not throw

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.description).toBe('Implement something.');
    expect(tasks[0]?.signature).toBe('export function test(): void');
    expect(tasks[0]?.tests).toEqual(['test() should not throw']);
  });
});

describe('parseTasks with file-level frontmatter', () => {
  it('strips file-level frontmatter before parsing task blocks', () => {
    const input = `---
generated_by: diptych v0.1.0
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
});

describe('Task Brief v1 optional sections (Scope, Escalation, Evidence)', () => {
  it('omits scope, escalation, and evidence when sections are absent', () => {
    const input = `---
id: T100
title: "No brief sections"
action: create
file: src/none.ts
depends_on: []
---

### Description
Older brief without Scope/Escalation/Evidence.

### Tests
- Should still parse

### Constraints
- None
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    const task = tasks[0];
    if (!task) throw new Error('expected task');
    expect(task.scope).toBeUndefined();
    expect(task.escalation).toBeUndefined();
    expect(task.evidence).toBeUndefined();
  });

  it('parses Scope in/out bounds, Escalation, and Evidence when present', () => {
    const input = `---
id: T101
title: "Full brief"
action: modify
file: src/full.ts
depends_on: []
---

### Description
A brief with all Task Brief v1 optional sections.

### Scope
**In bounds:**
- update src/full.ts only
- keep public API stable

**Out of bounds:**
- changing unrelated modules
- adding new dependencies

### Tests
- Should compile

### Constraints
- ESM only

### Escalation
- if the public type signature would change
- if a new dependency is required

### Evidence
- npm test passes
- diff limited to src/full.ts
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    const task = tasks[0];
    if (!task) throw new Error('expected task');
    expect(task.scope).toEqual({
      inBounds: ['update src/full.ts only', 'keep public API stable'],
      outOfBounds: ['changing unrelated modules', 'adding new dependencies'],
    });
    expect(task.escalation).toEqual([
      'if the public type signature would change',
      'if a new dependency is required',
    ]);
    expect(task.evidence).toEqual(['npm test passes', 'diff limited to src/full.ts']);
  });

  it('parses approved out of bounds scope bucket when present', () => {
    const input = `---
id: T103
title: "Approved scope"
action: modify
file: src/approved.ts
depends_on: []
---

### Description
Task with approved exceptions.

### Scope
**In bounds:**
- src/approved.ts

**Out of bounds:**
- unrelated modules

**Approved out of bounds:**
- src/shared/config.ts

### Tests
- Should compile

### Constraints
- None
`;

    const tasks = parseTasks(input);
    const task = tasks[0];
    if (!task) throw new Error('expected task');
    expect(task.scope).toEqual({
      inBounds: ['src/approved.ts'],
      outOfBounds: ['unrelated modules'],
      approvedOutOfBounds: ['src/shared/config.ts'],
    });
  });

  it('round-trips approvedOutOfBounds through formatTasks', () => {
    const input = `---
id: T104
title: "Round trip"
action: modify
file: src/rt.ts
depends_on: []
---

### Description
Round trip approved scope.

### Scope
**Approved out of bounds:**
- src/shared.ts

### Tests
- ok

### Constraints
- none
`;
    const parsed = parseTasks(formatTasks(parseTasks(input)));
    expect(parsed[0]?.scope?.approvedOutOfBounds).toEqual(['src/shared.ts']);
  });

  it('parses Scope when the heading carries a parenthetical suffix', () => {
    const input = `---
id: T105
title: "Suffixed scope heading"
action: modify
file: src/suffix.ts
depends_on: []
---

### Description
Scope heading uses a parenthetical suffix like the sibling sections.

### Scope (Boundaries)
**In bounds:**
- src/suffix.ts

**Out of bounds:**
- everything else

### Tests
- Should compile

### Constraints
- None
`;

    const tasks = parseTasks(input);
    const task = tasks[0];
    if (!task) throw new Error('expected task');
    expect(task.scope).toEqual({
      inBounds: ['src/suffix.ts'],
      outOfBounds: ['everything else'],
    });
  });

  it('sets scope with only one bucket when only one is present', () => {
    const input = `---
id: T102
title: "Partial scope"
action: create
file: src/partial.ts
depends_on: []
---

### Description
Only in bounds listed.

### Scope
**In bounds:**
- new file src/partial.ts

### Tests
- Should compile

### Constraints
- None
`;

    const tasks = parseTasks(input);
    const task = tasks[0];
    if (!task) throw new Error('expected task');
    expect(task.scope).toEqual({ inBounds: ['new file src/partial.ts'] });
  });
});

describe('parseTasksStrict', () => {
  it('throws when a task-like block has invalid frontmatter', () => {
    const input = `${dependencyTaskBlock('T001')}
---
id: T002
title:
action: create
file: src/broken.ts
depends_on: []
---

### Description
Malformed title should fail strict parse.

### Tests
- fail

### Constraints
- none
`;
    expect(() => parseTasksStrict(input)).toThrow(/Invalid task block/);
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

  it('warns once per unknown ### section that the grammar will drop', () => {
    const input = `---
id: T501
title: "Has extra sections"
action: create
file: src/extra.ts
depends_on: []
---

### Description
A brief with sections outside the canonical grammar.

### Edge Cases
- empty input
- huge input

### Tests
- Should parse

### Constraints
- none

### Notes
Remember to handle retries.
`;
    const warnings: string[] = [];
    const tasks = parseTasksStrict(input, (m) => warnings.push(m));

    expect(tasks).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('T501');
    expect(warnings[0]).toContain('Edge Cases');
    expect(warnings[0]).toContain('Notes');
  });

  it('does not warn when every ### section is in the canonical grammar', () => {
    const input = `---
id: T502
title: "Only canonical sections"
action: create
file: src/canonical.ts
depends_on: []
---

### Description
All sections are recognized.

### Tests
- Should parse

### Constraints
- none
`;
    const warnings: string[] = [];
    parseTasksStrict(input, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
  });

  it('does not treat a ### heading inside a fenced block as an unknown section', () => {
    const input = `---
id: T503
title: "Fenced heading"
action: modify
file: src/fenced.ts
depends_on: []
---

### Description
Body documents a fenced markdown heading.

### Current Code
\`\`\`markdown
### Not A Real Section
\`\`\`

### Tests
- Should parse

### Constraints
- none
`;
    const warnings: string[] = [];
    parseTasksStrict(input, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
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

describe('parseTasks — path confinement', () => {
  it('rejects tasks with ../traversal file paths', () => {
    const input = `---
id: T001
title: "Escape"
action: create
file: ../sensitive-file.ts
depends_on: []
---

### Description
Should be rejected.
`;

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(0);
  });

  it('rejects tasks with absolute file paths', () => {
    const input = `---
id: T001
title: "Escape"
action: create
file: /etc/passwd
depends_on: []
---

### Description
Should be rejected.
`;

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(0);
  });

  it('accepts valid relative file paths', () => {
    const input = `---
id: T001
title: "Valid"
action: create
file: src/nested/file.ts
depends_on: []
---

### Description
Should work.
`;

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.file).toBe('src/nested/file.ts');
  });
});
