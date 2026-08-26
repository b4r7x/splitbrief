import { describe, it, expect } from 'vitest';
import { dependencyTaskBlock } from '#testing/helpers/factories/task.js';
import type { Task } from '../../../core/schemas/task.js';
import { parseTasks, parseTasksStrict } from './parse.js';

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

  it('parses a document whose only content is a fenced valid block instead of warning', () => {
    const { tasks, warnings } = collectWarnings(
      `\`\`\`markdown\n${metaSyntaxBlock({ action: 'create', dependsOn: '[]' })}\`\`\``,
    );

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
  });

  it('names the fence when fenced output has no task structure anywhere, even behind prose', () => {
    const { tasks, warnings } = collectWarnings(
      'Here is what I would run first:\n\n```bash\nnpm test\n```\n\nMore narration after.',
    );

    expect(tasks).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('``` code fence');
    expect(warnings[0]).not.toContain('no --- delimited block');
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

  it('parses a fenced document in strict mode without throwing or warning', () => {
    const warnings: string[] = [];
    const tasks = parseTasksStrict(
      `\`\`\`markdown\n${metaSyntaxBlock({ action: 'create', dependsOn: '[]' })}\`\`\``,
      (message) => warnings.push(message),
    );

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
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
