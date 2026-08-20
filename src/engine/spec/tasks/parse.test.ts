import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Task } from '../../../core/schemas/task.js';
import { evaluateBriefQuality } from '../brief-quality.js';
import { parseTasks, parseTaskSourceBlocks, parseTasksStrict } from './parse.js';

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

  it("a malformed brief plus a fenced sample throws the frontmatter diagnostic, not the no-tasks warning, and never returns the sample's tasks", () => {
    const input = [
      '---',
      'id: T001',
      'title:',
      'action: create',
      'file: src/broken.ts',
      'depends_on: []',
      '---',
      '',
      '### Description',
      'The title is empty, so this brief is rejected.',
      '',
      'For reference, a well-formed brief looks like this:',
      '',
      '```markdown',
      '---',
      'id: T900',
      'title: "Fenced sample"',
      'action: create',
      'file: src/sample.ts',
      'depends_on: []',
      '---',
      '',
      '### Description',
      'Sample brief.',
      '```',
    ].join('\n');

    expect(() => parseTasksStrict(input)).toThrow(
      expect.objectContaining({
        kind: 'parse-tasks-invalid-block',
        data: { detail: expect.stringContaining('`title`') },
      }),
    );

    const warnings: string[] = [];
    const tasks = parseTasks(input, { onWarning: (message) => warnings.push(message) });

    expect(tasks).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('task T001');
    expect(warnings[0]).not.toContain('No Task Brief was parsed');
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

describe('parseTasks — real planner captures', () => {
  const briefFixtures = join(import.meta.dirname, '../../../../testing/fixtures/briefs');
  const codexFixture = readFileSync(
    join(briefFixtures, 'codex-standard-phase-separators.md'),
    'utf-8',
  );
  const opencodeFixture = readFileSync(
    join(briefFixtures, 'opencode-trailing-separator-prose.md'),
    'utf-8',
  );

  it('returns the same task count in lenient and strict mode for both real captures', () => {
    for (const fixture of [codexFixture, opencodeFixture]) {
      const lenientWarnings: string[] = [];
      const strictWarnings: string[] = [];
      const lenient = parseTasks(fixture, {
        onWarning: (message) => lenientWarnings.push(message),
      });
      const strict = parseTasksStrict(fixture, (message) => strictWarnings.push(message));

      expect(lenient.map((t) => t.id)).toEqual(strict.map((t) => t.id));
      expect(lenientWarnings).toEqual([]);
      expect(strictWarnings).toEqual([]);
    }
  });
});

describe('parseTasks — fenced planner replies', () => {
  const briefFixtures = join(import.meta.dirname, '../../../../testing/fixtures/briefs');

  // Captured verbatim from a 2026-08-06 quick run: the planner answered with prose
  // narration and the whole tasks.md inside a ````markdown fence (four backticks,
  // because the briefs carry ```typescript fences of their own). The shipped parser
  // returned zero tasks for it and the run died before the implementer started.
  const capturedReply = readFileSync(join(briefFixtures, 'run-a-fenced-planner-reply.md'), 'utf-8');

  it('parses the captured fenced reply to T001 and T002 with no warning', () => {
    const warnings: string[] = [];
    const tasks = parseTasks(capturedReply, { onWarning: (message) => warnings.push(message) });

    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(warnings).toEqual([]);
    const t1 = tasks[0];
    expect(t1?.file).toBe('src/text.ts');
    expect(t1?.signature).toBe('export function titleCase(input: string): string');
    expect(t1?.currentCode).toContain('export function slugify(input: string): string');
    expect(tasks[1]?.dependsOn).toEqual(['T001']);
  });

  it('parses the captured fenced reply in strict mode without throwing or warning', () => {
    const warnings: string[] = [];
    const tasks = parseTasksStrict(capturedReply, (message) => warnings.push(message));

    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(warnings).toEqual([]);
  });

  it('keeps every unwrapped brief a verbatim substring of the captured reply', () => {
    const blocks = parseTaskSourceBlocks(capturedReply);

    expect(blocks.map((b) => b.id)).toEqual(['T001', 'T002']);
    for (const block of blocks) {
      expect(capturedReply).toContain(block.source);
      expect(block.source).not.toContain('````');
    }
    expect(blocks[0]?.source).toContain(
      '```typescript\nexport function titleCase(input: string): string\n```',
    );
  });

  it('returns brief sources byte-identical to the input when nothing wraps the document', () => {
    const input = [
      '---',
      'id: T101',
      'title: "Inner fences are content"',
      'action: create',
      'file: src/a.ts',
      'depends_on: []',
      '---',
      '',
      '### Description',
      'A brief whose sections carry their own fences.',
      '',
      '### Current Code',
      '```yaml',
      '---',
      'key: value',
      '---',
      '```',
    ].join('\n');

    const blocks = parseTaskSourceBlocks(input);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.source).toBe(input);
  });

  it('selects the task-shaped region when narration carries other fenced snippets too', () => {
    const input = [
      'First I would run:',
      '```bash',
      'npm test',
      '```',
      'And here are the briefs:',
      '````markdown',
      dependencyTaskBlock('T001').trimEnd(),
      '````',
      'Let me know if you need adjustments.',
    ].join('\n');
    const warnings: string[] = [];
    const tasks = parseTasks(input, { onWarning: (message) => warnings.push(message) });

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
  });

  it('parses a wrapper fence the planner never closed', () => {
    const input = `Here is the complete tasks.md content:\n\n\`\`\`\`markdown\n${dependencyTaskBlock('T001')}`;
    const warnings: string[] = [];
    const tasks = parseTasks(input, { onWarning: (message) => warnings.push(message) });

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
  });

  // Captured verbatim from a 2026-08-07 instant run: the planner wrapped the whole
  // tasks.md in a ```markdown fence exactly as long as the ```javascript fences its
  // own briefs carry. The shipped parser returned T001 with every section after
  // `### Signature` missing, and the brief quality gate failed the run with five
  // errors before the implementer started.
  const sameLengthReply = readFileSync(
    join(briefFixtures, 'run-b-same-length-fenced-planner-reply.md'),
    'utf-8',
  );

  it('keeps every section of a wrapper fence as long as the brief its own fences', () => {
    const warnings: string[] = [];
    const tasks = parseTasks(sameLengthReply, { onWarning: (message) => warnings.push(message) });

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
    const task = tasks[0];
    expect(task?.file).toBe('hello.js');
    expect(task?.currentCode).toContain('export function hello()');
    expect(task?.implementationSteps.length).toBeGreaterThan(0);
    expect(task?.tests.length).toBeGreaterThan(0);
    expect(task?.evidence?.length).toBeGreaterThan(0);
    expect(task?.scope?.inBounds?.length).toBeGreaterThan(0);
    expect(task?.scope?.outOfBounds?.length).toBeGreaterThan(0);
  });

  it('carries the same-length fenced reply past the brief quality gate', () => {
    const report = evaluateBriefQuality(parseTasks(sameLengthReply));

    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('drops the trailing narration after a same-length wrapper fence', () => {
    const blocks = parseTaskSourceBlocks(sameLengthReply);

    expect(blocks.map((b) => b.id)).toEqual(['T001']);
    expect(blocks[0]?.source).not.toContain('I returned the content above');
    expect(blocks[0]?.source).toContain('```bash');
  });

  it('parses a fenced document even when the preamble carries a --- horizontal rule', () => {
    const input = `My plan:\n\n---\n\nHere is the tasks.md:\n\n\`\`\`\`markdown\n${dependencyTaskBlock('T001')}\`\`\`\``;
    const warnings: string[] = [];
    const tasks = parseTasks(input, { onWarning: (message) => warnings.push(message) });

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);

    const strictWarnings: string[] = [];
    const strictTasks = parseTasksStrict(input, (message) => strictWarnings.push(message));
    expect(strictTasks.map((t) => t.id)).toEqual(['T001']);
    expect(strictWarnings).toEqual([]);
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
  const briefFixtures = join(import.meta.dirname, '../../../../testing/fixtures/briefs');
  const codexFixture = readFileSync(
    join(briefFixtures, 'codex-standard-phase-separators.md'),
    'utf-8',
  );
  const opencodeFixture = readFileSync(
    join(briefFixtures, 'opencode-trailing-separator-prose.md'),
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
