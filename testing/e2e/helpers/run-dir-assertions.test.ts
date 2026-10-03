import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTasksStrict } from '../../../src/engine/spec/tasks/parse.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { assertPlainStdout, assertSessionDir, assertWorkingTree } from './run-dir-assertions.js';

const TASKS_MD = `# Tasks

---
id: T001
title: Register the health route
action: modify
file: src/routes.ts
files:
  - src/routes.ts
  - src/server.ts
depends_on: []
---

### Description
Register a GET /api/health route.

### Implementation Steps
1. Add the route entry.

### Tests
- GET /api/health returns 200.

### Constraints
- No new dependencies.

---
id: T002
title: Cover the health route
action: create
file: test/server.test.mjs
depends_on:
  - T001
---

### Description
Add a node:test case for the route.

### Implementation Steps
1. Add the case.

### Tests
- npm test passes.

### Constraints
- Use node:test.
`;

function plainStdout(): string {
  return [
    'phase: planning',
    'phase: implementing',
    'task T001: done (typecheck test)',
    'task T002: done (typecheck test)',
    'phase: final-review',
    'review: passed',
    'done: 2 tasks',
    '',
  ].join('\n');
}

function logLine(type: string, phase: string, data: unknown, taskId?: string): string {
  return JSON.stringify({
    kind: 'event',
    ts: '2026-09-13T00:00:00.000Z',
    type,
    phase,
    ...(taskId === undefined ? {} : { taskId }),
    data,
  });
}

function sessionLog(extra: readonly string[] = []): string {
  return [
    logLine('runner_call_started', 'planning', { role: 'planner' }),
    // A planner-role call outside the planning phases is not part of the planning session.
    logLine('runner_call_started', 'implementing', { role: 'planner' }),
    logLine('runner_call_started', 'implementing', { role: 'implementer' }),
    logLine('runner_call_started', 'implementing', { role: 'implementer' }),
    logLine('runner_call_started', 'final-review', { role: 'review' }),
    logLine('task_completed', 'implementing', { duration: 4200 }, 'T001'),
    logLine('task_completed', 'implementing', { duration: 1300 }, 'T002'),
    ...extra,
    '',
  ].join('\n');
}

function writeSessionDir(dir: string, overrides: Readonly<Record<string, string>> = {}): void {
  const files: Record<string, string> = {
    'tasks.md': TASKS_MD,
    'spec.md': '# Spec\n\nAdd a health endpoint.\n',
    'plan.md': '# Plan\n\nOne route, one test.\n',
    'evidence.json': JSON.stringify({
      version: 1,
      sessionId: 'sess-1',
      feature: 'health endpoint',
      generatedAt: '2026-09-13T00:00:00.000Z',
      tasks: [
        {
          id: 'T001',
          title: 'Register the health route',
          file: 'src/routes.ts',
          status: 'done',
          retries: 0,
          changedFiles: ['src/routes.ts'],
          validation: [],
          expectedEvidence: [],
          observedEvidence: [],
          escalated: false,
        },
      ],
      validationSummary: { passed: 1, failed: 0, skipped: 0, escalated: 0 },
    }),
    'drift-report.json': JSON.stringify({
      version: 1,
      passed: true,
      score: 1,
      changedFiles: ['src/routes.ts'],
      expectedFiles: ['src/routes.ts'],
      findings: [],
      briefHash: null,
    }),
    'review.md': '# Final review\n\n### Verdict\n\npass\n',
    'summary.json': JSON.stringify({
      id: 'sess-1',
      feature: 'health endpoint',
      startedAt: 1,
      completedAt: 2,
      stateVersion: 4,
      status: 'complete',
      summary: {
        feature: 'health endpoint',
        totalTasks: 2,
        completedByLocal: 2,
        escalatedToPlanner: 0,
        skipped: 0,
        failed: 0,
        totalTime: 5500,
        tokenUsage: {
          plannerInput: 900,
          plannerOutput: 300,
          implementerInput: 600,
          implementerOutput: 200,
          escalationInput: 0,
          escalationOutput: 0,
          reviewerInput: 400,
          reviewerOutput: 120,
        },
        escalationRate: 0,
        taskBreakdown: [
          {
            taskId: 'T001',
            taskTitle: 'Register the health route',
            method: 'local',
            implementerTokens: 400,
            escalationTokens: 0,
            retryCount: 0,
          },
          {
            taskId: 'T002',
            taskTitle: 'Cover the health route',
            method: 'local',
            implementerTokens: 200,
            escalationTokens: 0,
            retryCount: 0,
          },
        ],
      },
    }),
    'session.jsonl': sessionLog(),
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf-8');
  }
}

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = createTempDir(prefix);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('assertPlainStdout', () => {
  it('accepts the --plain grammar and the required lines', () => {
    expect(() => assertPlainStdout(plainStdout())).not.toThrow();
  });

  it('rejects a line outside the grammar', () => {
    const stdout = `${plainStdout()}Implementation complete.\n`;
    expect(() => assertPlainStdout(stdout)).toThrow();
  });

  it('rejects a JSON record on stdout', () => {
    const stdout = `${plainStdout()}{"type":"task_completed"}\n`;
    expect(() => assertPlainStdout(stdout)).toThrow();
  });

  it('returns the done count however many briefs the run held', () => {
    const stdout = plainStdout().replace('done: 2 tasks', 'done: 30 tasks');
    expect(assertPlainStdout(stdout)).toBe(30);
  });
});

describe('assertSessionDir', () => {
  it('reports the runner-call counts and per-brief durations of a clean run', () => {
    const dir = tempDir('run-dir-assertions-ok');
    writeSessionDir(dir);

    const facts = assertSessionDir(dir, {
      expectedBriefs: { min: 1, max: 3 },
      completed: 2,
    });

    expect(facts.calls).toEqual({ planner: 1, implementer: 2, review: 1 });
    expect(facts.perBrief).toEqual([
      { id: 'T001', durationMs: 4200 },
      { id: 'T002', durationMs: 1300 },
    ]);
    expect(facts.tasks.map((task) => task.id)).toEqual(['T001', 'T002']);
  });

  it('rejects a done count that disagrees with the run records', () => {
    const dir = tempDir('run-dir-assertions-completed');
    writeSessionDir(dir);

    expect(() =>
      assertSessionDir(dir, { expectedBriefs: { min: 1, max: 3 }, completed: 3 }),
    ).toThrow('stdout `done:` count');
  });

  it('rejects a second planner call in the planning phases', () => {
    const dir = tempDir('run-dir-assertions-calls');
    writeSessionDir(dir, {
      'session.jsonl': sessionLog([
        logLine('runner_call_started', 'planning', { role: 'planner' }),
      ]),
    });

    expect(() =>
      assertSessionDir(dir, { expectedBriefs: { min: 1, max: 3 }, completed: 2 }),
    ).toThrow();
  });

  it('rejects a run that logged an implementer_wrote_nothing warning', () => {
    const dir = tempDir('run-dir-assertions-warning');
    writeSessionDir(dir, {
      'session.jsonl': sessionLog([
        JSON.stringify({
          kind: 'event',
          ts: '2026-09-13T00:00:00.000Z',
          type: 'warning',
          phase: 'implementing',
          data: {
            message: 'Implementer wrote nothing for task T002',
            category: 'implementer',
            code: 'implementer_wrote_nothing',
          },
        }),
      ]),
    });

    expect(() =>
      assertSessionDir(dir, { expectedBriefs: { min: 1, max: 3 }, completed: 2 }),
    ).toThrow();
  });

  it('rejects a drift report that did not pass', () => {
    const dir = tempDir('run-dir-assertions-drift');
    writeSessionDir(dir, {
      'drift-report.json': JSON.stringify({
        version: 1,
        passed: false,
        score: 0.5,
        changedFiles: ['src/unrelated.ts'],
        expectedFiles: ['src/routes.ts'],
        findings: [
          {
            severity: 'error',
            code: 'out_of_scope_file',
            message: 'src/unrelated.ts is not declared',
          },
        ],
        briefHash: null,
      }),
    });

    expect(() =>
      assertSessionDir(dir, { expectedBriefs: { min: 1, max: 3 }, completed: 2 }),
    ).toThrow();
  });
});

describe('assertWorkingTree', () => {
  const tasks = parseTasksStrict(TASKS_MD);

  it('accepts changes confined to the declared set and .splitbrief/', () => {
    const dir = tempDir('run-dir-assertions-tree-ok');
    createTestGitRepo(dir, { 'src/routes.ts': 'export const routes = [];\n' });
    writeFileSync(join(dir, 'src/routes.ts'), 'export const routes = ["/api/health"];\n', 'utf-8');
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test/server.test.mjs'), '// test\n', 'utf-8');
    mkdirSync(join(dir, '.splitbrief/sessions/sess-1'), { recursive: true });
    writeFileSync(join(dir, '.splitbrief/sessions/sess-1/tasks.md'), TASKS_MD, 'utf-8');

    expect(() => assertWorkingTree(dir, tasks)).not.toThrow();
  });

  it('rejects a file no brief declared', () => {
    const dir = tempDir('run-dir-assertions-tree-drift');
    createTestGitRepo(dir, { 'src/routes.ts': 'export const routes = [];\n' });
    writeFileSync(join(dir, 'src/unrelated.ts'), 'export const stray = true;\n', 'utf-8');

    expect(() => assertWorkingTree(dir, tasks)).toThrow();
  });
});
