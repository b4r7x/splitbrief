import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks, topoSort } from '../src/engine/spec/parser.js';

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
  it('parses a valid tasks.md with 3 tasks', () => {
    const tasks = parseTasks(validTasksMd);

    assert.equal(tasks.length, 3);

    const t1 = tasks.find((t) => t.id === 'T001')!;
    assert.ok(t1);
    assert.equal(t1.title, 'Create project structure');
    assert.equal(t1.action, 'create');
    assert.equal(t1.file, 'src/index.ts');
    assert.deepEqual(t1.dependsOn, []);
    assert.equal(t1.description, 'Set up the initial project directory structure.');
    assert.equal(t1.signature, 'export function init(): void');
    assert.deepEqual(t1.tests, ['Should create src/ directory', 'Should create package.json']);
    assert.deepEqual(t1.constraints, ['Must be idempotent']);
    assert.equal(t1.pattern, 'Use mkdir -p equivalent.');
    assert.equal(t1.status, 'pending');

    const t3 = tasks.find((t) => t.id === 'T003')!;
    assert.ok(t3);
    assert.equal(t3.action, 'modify');
    assert.deepEqual(t3.dependsOn, ['T001', 'T002']);
  });

  it('returns tasks in topologically sorted order', () => {
    const tasks = parseTasks(validTasksMd);

    const ids = tasks.map((t) => t.id);
    const indexT001 = ids.indexOf('T001');
    const indexT002 = ids.indexOf('T002');
    const indexT003 = ids.indexOf('T003');

    assert.ok(indexT001 < indexT002, 'T001 should come before T002');
    assert.ok(indexT001 < indexT003, 'T001 should come before T003');
    assert.ok(indexT002 < indexT003, 'T002 should come before T003');
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
    assert.equal(tasks.length, 1);

    const task = tasks[0];
    assert.equal(task.signature, undefined);
    assert.equal(task.pattern, undefined);
    assert.equal(task.description, 'A task with no signature or pattern sections.');
    assert.deepEqual(task.tests, ['Should work']);
    assert.deepEqual(task.constraints, ['None']);
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
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'T020');
  });

  it('returns empty array for empty input', () => {
    const tasks = parseTasks('');
    assert.deepEqual(tasks, []);
  });

  it('returns empty array for input with no frontmatter blocks', () => {
    const tasks = parseTasks('Just some random markdown text.\n\nNo tasks here.');
    assert.deepEqual(tasks, []);
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
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].dependsOn, ['T001']);
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

    assert.throws(
      () => parseTasks(input),
      (err: Error) => {
        assert.ok(err.message.includes('Circular dependency'));
        return true;
      },
    );
  });
});

describe('typeDefs and implSteps parsing', () => {
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
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].typeDefs, 'export interface Config {\n  name: string;\n}');
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
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].implSteps, [
      'Import Config from types',
      'Create function that returns void',
      'Add validation logic',
    ]);
  });

  it('backward compat — missing sections default to empty', () => {
    const input = `---
id: T001
title: Test task
action: create
file: src/test.ts
depends_on: []
---

### Description
A v0.1 task without Type Definitions or Implementation Steps.

### Tests
- Should work

### Constraints
- None
`;

    const tasks = parseTasks(input);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].typeDefs, '');
    assert.deepEqual(tasks[0].implSteps, []);
  });

  it('mixed — only typeDefs present', () => {
    const input = `---
id: T001
title: Test task
action: create
file: src/test.ts
depends_on: []
---

### Description
Has type definitions but no implementation steps.

### Type Definitions
\`\`\`typescript
export type Mode = 'fast' | 'slow';
\`\`\`

### Tests
- Should work

### Constraints
- None
`;

    const tasks = parseTasks(input);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].typeDefs, "export type Mode = 'fast' | 'slow';");
    assert.deepEqual(tasks[0].implSteps, []);
  });

  it('mixed — only implSteps present', () => {
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
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].typeDefs, '');
    assert.deepEqual(tasks[0].implSteps, [
      'Read the file',
      'Transform the data',
    ]);
  });
});
