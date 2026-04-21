import { describe, it, expect } from 'vitest';
import { parseTasks, stripFileFrontmatter } from './parser.js';

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

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.dependsOn).toEqual(['T001']);
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

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.dependsOn).toEqual(['T001']);
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

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.dependsOn).toEqual(['T001']);
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

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.dependsOn).toEqual(['T001', 'T002']);
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
id: A
title: "Task A"
action: create
file: a.ts
depends_on: [B]
---

### Description
Depends on B.

### Tests
- Test A

### Constraints
- None

---
id: B
title: "Task B"
action: create
file: b.ts
depends_on: [A]
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
    expect(tasks[0]?.implementationSteps).toEqual([
      'Read the file',
      'Transform the data',
    ]);
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

describe('stripFileFrontmatter', () => {
  it('strips frontmatter containing generated_by', () => {
    const input = `---
generated_by: diptych v0.1.0
planner: claude-code
mode: standard
created_at: 2025-01-01T00:00:00.000Z
---
# Remaining content`;

    const result = stripFileFrontmatter(input);
    expect(result).toBe('# Remaining content');
  });

  it('returns original string when no frontmatter', () => {
    const input = '# Just a heading\nSome content';
    expect(stripFileFrontmatter(input)).toBe(input);
  });

  it('returns original string when frontmatter has no generated_by (task frontmatter)', () => {
    const input = `---
id: T001
title: "Create something"
action: create
file: src/index.ts
---

### Description
Do stuff.`;

    expect(stripFileFrontmatter(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(stripFileFrontmatter('')).toBe('');
  });

  it('strips frontmatter with Windows line endings', () => {
    const content = '---\r\ngenerated_by: diptych v0.1.0\r\n---\r\nactual content';
    expect(stripFileFrontmatter(content)).toBe('actual content');
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
    expect(task.evidence).toEqual([
      'npm test passes',
      'diff limited to src/full.ts',
    ]);
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
