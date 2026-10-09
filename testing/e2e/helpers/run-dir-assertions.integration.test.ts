import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { assertPlainStdout, assertSessionDir, assertWorkingTree } from './run-dir-assertions.js';

const TASKS = [
  makeTask({
    id: 'T001',
    title: 'Register the health route',
    action: 'modify',
    suggestedFiles: ['src/routes.ts', 'src/server.ts'],
  }),
  makeTask({
    id: 'T002',
    title: 'Cover the health route',
    action: 'create',
    suggestedFiles: ['test/server.test.mjs'],
    dependsOn: ['T001'],
  }),
];

function plainStdout(): string {
  return [
    'phase: planning',
    'phase: implementing',
    'task T001: done (no checks)',
    'task T002: done (no checks)',
    'phase: final-review',
    'reviewer check declined: test/server.test.mjs (covered by V1)',
    'reviewer check V1: refused (runs the package script lint, which this run changed)',
    'reviewer check V2: failed (npm test)',
    'base re-run V2: not run (this run recorded no run base)',
    'reviewer check V3: not run (V2 failed)',
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
    logLine('runner_call_started', 'final-review', { role: 'review' }),
    logLine('task_completed', 'implementing', { duration: 4200 }, 'T001'),
    logLine('task_completed', 'implementing', { duration: 1300 }, 'T002'),
    ...extra,
    '',
  ].join('\n');
}

function writeSessionDir(dir: string, overrides: Readonly<Record<string, string>> = {}): void {
  const files: Record<string, string> = {
    'state.json': JSON.stringify(makeWorkflowState({ tasks: TASKS })),
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
      changedFiles: ['src/routes.ts'],
      expectedFiles: ['src/routes.ts'],
      findings: [],
      briefHash: null,
    }),
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
        review: { verdict: 'pass', critical: 0, warnings: 0, notes: 0 },
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

  it('accepts fix checks and base re-runs with each failure split', () => {
    const stdout = [
      plainStdout(),
      'fix check V1: failed (npm test)',
      'base re-run V1: passes',
      'base re-run V1: fails',
      'base re-run V1: 1 new, 2 pre-existing',
      "base re-run V1: pre-existing · all 2 failures also fail before this run's changes",
      "base re-run V1: pre-existing · the failure also fails before this run's changes",
      'base re-run V1: refused (names no program)',
    ].join('\n');

    expect(() => assertPlainStdout(stdout)).not.toThrow();
  });

  it('rejects a line outside the grammar', () => {
    const stdout = `${plainStdout()}Implementation complete.\n`;
    expect(() => assertPlainStdout(stdout)).toThrow();
  });

  it('accepts the reviewer-check lines of a run whose End-of-run checks are off or chose none', () => {
    const stdout = plainStdout().replace(
      'phase: final-review\n',
      'phase: final-review\nreviewer checks: off\nreviewer checks: none (the change edits only docs)\n',
    );
    expect(() => assertPlainStdout(stdout)).not.toThrow();
  });

  it('rejects the retired checks lines without the reviewer prefix', () => {
    expect(() => assertPlainStdout(`${plainStdout()}check V1: passed (npm test)\n`)).toThrow();
    expect(() => assertPlainStdout(`${plainStdout()}checks: off\n`)).toThrow();
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

    expect(facts.calls).toEqual({ planner: 1, implementer: 2, review: 2 });
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
  it('accepts changes confined to the declared set and .splitbrief/', () => {
    const dir = tempDir('run-dir-assertions-tree-ok');
    createTestGitRepo(dir, { 'src/routes.ts': 'export const routes = [];\n' });
    writeFileSync(join(dir, 'src/routes.ts'), 'export const routes = ["/api/health"];\n', 'utf-8');
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test/server.test.mjs'), '// test\n', 'utf-8');
    mkdirSync(join(dir, '.splitbrief/sessions/sess-1'), { recursive: true });
    writeFileSync(join(dir, '.splitbrief/sessions/sess-1/tasks.md'), '# Tasks\n', 'utf-8');

    expect(() => assertWorkingTree(dir, TASKS)).not.toThrow();
  });

  it('rejects a file no brief declared', () => {
    const dir = tempDir('run-dir-assertions-tree-drift');
    createTestGitRepo(dir, { 'src/routes.ts': 'export const routes = [];\n' });
    writeFileSync(join(dir, 'src/unrelated.ts'), 'export const stray = true;\n', 'utf-8');

    expect(() => assertWorkingTree(dir, TASKS)).toThrow();
  });
});
