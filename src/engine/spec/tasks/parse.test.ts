import { describe, it, expect } from 'vitest';
import type { Task } from '../../../core/schemas/task.js';
import { parseTasks, parseTasksStrict } from './parse.js';

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
generated_by: splitbrief v0.1.0
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

    expect(() => parseTasks(input)).toThrow(
      expect.objectContaining({
        kind: 'topo-circular-dependency',
        data: { cycle: ['T001', 'T002', 'T001'] },
      }),
    );
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

    expect(() => parseTasks(input)).toThrow(
      expect.objectContaining({
        kind: 'topo-duplicate-task-id',
        data: { taskId: 'T001' },
      }),
    );
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
    expect(() => parseTasksStrict(input)).toThrow(
      expect.objectContaining({
        kind: 'parse-tasks-invalid-block',
        data: { detail: expect.any(String) },
      }),
    );
  });

  it('throws when frontmatter is never closed before end of input', () => {
    const input = `${dependencyTaskBlock('T001')}
---
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

  it('throws on trailing in-frontmatter block with content but no id at end of input', () => {
    const input = `${dependencyTaskBlock('T001')}
---
title: "Dangling frontmatter without id"
action: create
file: src/dangling.ts
`;
    expect(() => parseTasksStrict(input)).toThrow(
      expect.objectContaining({ kind: 'parse-tasks-unterminated-block' }),
    );
  });
});

describe('parseTasks — rejection diagnostics', () => {
  function metaSyntaxBlock(overrides: { action: string; dependsOn: string }): string {
    return `---
id: T001
title: Short descriptive title
action: ${overrides.action}
file: src/path/to/file.ts
depends_on: ${overrides.dependsOn}
---

### Description
What to implement and why.
`;
  }

  function collectWarnings(input: string): { tasks: Task[]; warnings: string[] } {
    const warnings: string[] = [];
    const tasks = parseTasks(input, { onWarning: (message) => warnings.push(message) });
    return { tasks, warnings };
  }

  it('names the task, the field and the rejected value for an enum alternation', () => {
    const { tasks, warnings } = collectWarnings(
      metaSyntaxBlock({ action: 'create | modify', dependsOn: '[]' }),
    );

    expect(tasks).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('task T001');
    expect(warnings[0]).toContain('`action`');
    expect(warnings[0]).toContain('"create | modify"');
  });

  it('names the field and the rejected value when the value is not valid YAML', () => {
    const { tasks, warnings } = collectWarnings(
      metaSyntaxBlock({ action: 'create', dependsOn: '[] | [T001, T002]' }),
    );

    expect(tasks).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('task T001');
    expect(warnings[0]).toContain('`depends_on`');
    expect(warnings[0]).toContain('"[] | [T001, T002]"');
  });

  it('names the field when a confinement-violating path is rejected', () => {
    const { warnings } = collectWarnings(
      metaSyntaxBlock({ action: 'create', dependsOn: '[]' }).replace(
        'file: src/path/to/file.ts',
        'file: ../escape.ts',
      ),
    );

    expect(warnings[0]).toContain('`file`');
    expect(warnings[0]).toContain('"../escape.ts"');
  });

  it('explains a zero-task parse caused by the whole document being fenced', () => {
    const { tasks, warnings } = collectWarnings(
      `\`\`\`markdown\n${metaSyntaxBlock({ action: 'create', dependsOn: '[]' })}\`\`\``,
    );

    expect(tasks).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('wrapped in a ``` code fence');
  });

  it('explains a zero-task parse of planner narration that has no task block', () => {
    const { tasks, warnings } = collectWarnings('I reviewed the repo and here is my plan.');

    expect(tasks).toHaveLength(0);
    expect(warnings).toEqual([
      'No Task Brief was parsed: the output has no --- delimited block with an id: field.',
    ]);
  });

  it('stays quiet for empty input', () => {
    expect(collectWarnings('   \n  ').warnings).toEqual([]);
  });

  it('does not report narration blocks alongside tasks that parsed', () => {
    const { tasks, warnings } = collectWarnings(
      `Here is the plan.\n\n${dependencyTaskBlock('T001')}`,
    );

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
  });

  it('strips terminal control sequences out of the value it quotes back', () => {
    const { warnings } = collectWarnings(
      metaSyntaxBlock({ action: 'create', dependsOn: '[]' }).replace(
        'action: create',
        'action: "\\u001b[2Jspoofed"',
      ),
    );

    expect(warnings[0]).toContain('"spoofed"');
    expect(warnings[0]).not.toContain('\u001b');
    expect(warnings[0]).not.toContain('[2J');
  });

  it('clips an oversized rejected value instead of pasting it whole', () => {
    const { warnings } = collectWarnings(
      metaSyntaxBlock({ action: 'create', dependsOn: '[]' }).replace(
        'action: create',
        `action: ${'x'.repeat(400)}`,
      ),
    );

    expect(warnings[0]).toContain('...');
    expect(warnings[0]?.length).toBeLessThan(200);
  });

  it('carries the same detail into the strict throw', () => {
    expect(() =>
      parseTasksStrict(metaSyntaxBlock({ action: 'create | modify', dependsOn: '[]' })),
    ).toThrow(/task T001: frontmatter field `action` rejected "create \| modify"/);
  });

  it('reports a zero-task fenced document without throwing in strict mode', () => {
    const warnings: string[] = [];
    const tasks = parseTasksStrict(
      `\`\`\`markdown\n${metaSyntaxBlock({ action: 'create', dependsOn: '[]' })}\`\`\``,
      (message) => warnings.push(message),
    );

    expect(tasks).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('wrapped in a ``` code fence');
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
