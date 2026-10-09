import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../types.js';
import { createStdoutTextSink } from './stdout-text.js';

function collect(events: EngineEvent[]): string[] {
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const sink = createStdoutTextSink({ output });
  for (const event of events) sink(event);
  return chunks.join('').trimEnd().split('\n').filter(Boolean);
}

const ts = 1;

describe('createStdoutTextSink', () => {
  it('prints plan checks and render scenarios, with no new line for stopped commands', () => {
    const render: EngineEventOf<'full_suite'> = {
      type: 'full_suite',
      ts,
      phase: 'final-review',
      id: 'R1',
      moment: 'plan',
      scenario: 'workflow-x',
      command: 'npm run tui-shots -- --scenario workflow-x --output /tmp/render',
      status: 'done',
      passed: true,
      duration: 14_200,
    };
    expect(
      collect([
        { ...render, status: 'running' },
        render,
        { ...render, passed: false },
        { ...render, status: 'not-run', detail: 'validation.render is not set' },
        { ...render, status: 'refused', detail: 'invalid scenario' },
        { ...render, status: 'stopped' },
        { ...render, scenario: undefined, id: 'K1', command: 'npm test' },
      ]),
    ).toEqual([
      'phase: final-review',
      'Render workflow-x: rendered · 14.2s',
      'Render workflow-x: failed · 14.2s',
      'Render workflow-x: not run (validation.render is not set)',
      'Render workflow-x: refused (invalid scenario)',
      'plan check K1: passed · 14.2s (npm test)',
    ]);
  });
  it('writes one line per phase change, task, review and completion', () => {
    const lines = collect([
      { type: 'workflow_started', ts, phase: 'researching', feature: 'add a widget' },
      { type: 'planner_heartbeat', ts, phase: 'researching', elapsedMs: 5 },
      {
        type: 'checks_run',
        ts,
        phase: 'implementing',
        taskId: taskId('T001'),
        results: [
          { id: 'K1', passed: true },
          { id: 'K2', passed: false },
        ],
      },
      {
        type: 'task_completed',
        ts,
        phase: 'implementing',
        taskId: taskId('T001'),
        title: 'Add the widget',
        method: 'local',
        retries: 0,
        duration: 12,
      },
      {
        type: 'cost_update',
        ts,
        phase: 'implementing',
        tokenUsage: {
          plannerInput: 1000,
          plannerOutput: 500,
          implementerInput: 400,
          implementerOutput: 100,
          escalationInput: 0,
          escalationOutput: 0,
          reviewerInput: 0,
          reviewerOutput: 0,
        },
      },
      { type: 'workflow_complete', ts, phase: 'complete', completedTasks: 1 },
    ]);

    expect(lines).toEqual([
      'phase: researching',
      'phase: implementing',
      'task T001: done (1 of 2 checks passed)',
      'phase: complete',
      'review: passed',
      'done: 1 tasks',
    ]);
  });

  it('prints one stalled line at the warn and nothing when the stall clears', () => {
    const call = {
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'opencode',
    } as const;
    const lines = collect([
      { type: 'runner_call_stalled', ts, ...call, sequence: 1, silentMs: 300_000 },
      { type: 'runner_call_stall_cleared', ts, ...call, sequence: 2 },
    ]);

    expect(lines).toEqual([
      'phase: implementing',
      'stalled: implementer (opencode) · no output for 5:00',
    ]);
    expect(lines.filter((line) => line.startsWith('stalled:'))).toHaveLength(1);
  });

  it('names a CLI call by its tool id and runs the clock on past an hour', () => {
    const lines = collect([
      {
        type: 'runner_call_stalled',
        ts,
        phase: 'final-review',
        callId: 'call-2',
        role: 'review',
        backendKind: 'cli',
        runnerName: 'claude',
        sequence: 1,
        silentMs: 4_500_000,
      },
    ]);

    expect(lines).toContain('stalled: review (claude-code) · no output for 1:15:00');
  });

  it('review: failed carries the blocking count the event already knows', () => {
    const lines = collect([
      { type: 'task_full_fail', ts, phase: 'implementing', taskId: taskId('T002') },
      {
        type: 'planner_status',
        ts,
        phase: 'final-review',
        status: 'done',
        summary: 'Final review failed',
      },
      { type: 'workflow_complete', ts, phase: 'complete', review: 'failed', blocking: 2 },
    ]);

    expect(lines).toEqual([
      'phase: implementing',
      'task T002: failed (no checks)',
      'phase: final-review',
      'phase: complete',
      'review: failed (2 blocking)',
      'done: 0 tasks',
    ]);
  });

  // A continue completes only the briefs left; the completion event carries the run's count.
  it('prints the completed count the completion event carries, not the briefs it saw complete', () => {
    const lines = collect([
      {
        type: 'task_completed',
        ts,
        phase: 'implementing',
        taskId: taskId('T002'),
        title: 'Add the second widget',
        method: 'local',
        retries: 0,
        duration: 12,
      },
      { type: 'workflow_complete', ts, phase: 'complete', completedTasks: 2 },
    ]);

    expect(lines.at(-1)).toBe('done: 2 tasks');
  });

  it('effect-invalid reason on task failed line', () => {
    const lines = collect([
      {
        type: 'task_full_fail',
        ts,
        phase: 'implementing',
        taskId: taskId('T002'),
        reason: 'effect-invalid: src/unrelated.ts',
      },
    ]);

    expect(lines).toEqual([
      'phase: implementing',
      'task T002: failed (effect-invalid: src/unrelated.ts)',
    ]);
  });

  it('a task that ran no check reads no checks', () => {
    const lines = collect([
      {
        type: 'checks_run',
        ts,
        phase: 'implementing',
        taskId: taskId('T001'),
        results: [],
      },
      {
        type: 'task_completed',
        ts,
        phase: 'implementing',
        taskId: taskId('T001'),
        title: 'Add the widget',
        method: 'local',
        retries: 0,
        duration: 12,
      },
    ]);

    expect(lines).toEqual(['phase: implementing', 'task T001: done (no checks)']);
  });

  it('names End-of-run checks off, and a plan with no command with its reason', () => {
    const lines = collect([
      { type: 'review_checks', ts, phase: 'final-review', scope: 'final', status: 'off' },
      {
        type: 'review_checks',
        ts,
        phase: 'final-review',
        scope: 'final',
        status: 'planned',
        commands: [],
        declined: [],
        reason: 'the change edits only the README',
      },
    ]);

    expect(lines).toEqual([
      'phase: final-review',
      'reviewer checks: off',
      'reviewer checks: none (the change edits only the README)',
    ]);
  });

  it('names every reviewer check a skipped plan did not run, and why, on one line', () => {
    const lines = collect([
      {
        type: 'review_checks',
        ts,
        phase: 'final-review',
        scope: 'final',
        status: 'skipped',
        commands: [
          { id: 'V1', command: 'npm run typecheck', reason: 'types changed' },
          { id: 'V2', command: 'npm test', reason: 'tests cover it' },
        ],
        reason: 'validation.approve_checks is ask and this run has no screen to ask on',
      },
    ]);

    expect(lines).toEqual([
      'phase: final-review',
      'reviewer checks: not run V1, V2 (validation.approve_checks is ask and this run has no screen to ask on)',
    ]);
  });

  it('writes one line per declined test and per finished, refused or not-run reviewer check', () => {
    const check = (fields: Partial<EngineEventOf<'full_suite'>>): EngineEventOf<'full_suite'> => ({
      type: 'full_suite',
      ts,
      phase: 'final-review',
      status: 'done',
      id: 'V1',
      command: 'npm test',
      moment: 'pre-review',
      ...fields,
    });
    const lines = collect([
      {
        type: 'review_checks',
        ts,
        phase: 'final-review',
        scope: 'task',
        status: 'planned',
        commands: [
          { id: 'V1', command: 'npm test', reason: 'runs the changed tests' },
          { id: 'V2', command: 'make test', reason: 'the project gate' },
          { id: 'V3', command: 'cargo test', reason: 'the crate tests' },
        ],
        declined: [{ target: 'e2e/app.spec.ts', reason: 'needs a browser' }],
        reason: null,
      },
      check({ status: 'running' }),
      check({ passed: false, duration: 3 }),
      check({ status: 'running', moment: 'base' }),
      check({ moment: 'base', passed: false, duration: 2 }),
      check({
        id: 'V2',
        command: 'make test',
        status: 'refused',
        detail: 'runs make on Makefile, which this run changed',
      }),
      check({ id: 'V3', command: 'cargo test', status: 'not-run', detail: 'V1 failed' }),
      check({ id: 'V4', command: 'go test ./...', passed: true, duration: 9 }),
      check({ id: 'V4', moment: 'base', status: 'not-run', detail: 'no check V4' }),
      check({ id: 'V5', command: 'pytest', passed: false, duration: 4 }),
      check({ id: 'V5', command: 'pytest', moment: 'base', passed: true, duration: 4 }),
      check({ id: 'V6', moment: 'base', status: 'refused', detail: 'names no program' }),
      check({ id: 'V7', command: 'npm run e2e', passed: false, duration: 5 }),
      check({
        id: 'V7',
        command: 'npm run e2e',
        moment: 'base',
        passed: false,
        newFailures: 0,
        preExisting: 0,
        notVerified: 1,
        detail: 'both runs timed out',
        duration: 5,
      }),
    ]);

    expect(lines).toEqual([
      'phase: final-review',
      'reviewer check declined: e2e/app.spec.ts (needs a browser)',
      'reviewer check V1: failed (npm test)',
      'base re-run V1: fails',
      'reviewer check V2: refused (runs make on Makefile, which this run changed)',
      'reviewer check V3: not run (V1 failed)',
      'reviewer check V4: passed (go test ./...)',
      'base re-run V4: not run (no check V4)',
      'reviewer check V5: failed (pytest)',
      'base re-run V5: passes',
      'base re-run V6: refused (names no program)',
      'reviewer check V7: failed (npm run e2e)',
      'base re-run V7: 1\u00a0not verified at the run base · both runs timed out',
    ]);
  });

  // Q2 review B3 and B2: the base line said `fails` for a red the run went on from, and a fix
  // brief's re-run had no line.
  it('writes how a red splits at the run base and each fix check a brief runs again', () => {
    const check = (fields: Partial<EngineEventOf<'full_suite'>>): EngineEventOf<'full_suite'> => ({
      type: 'full_suite',
      ts,
      phase: 'final-review',
      status: 'done',
      id: 'V1',
      command: 'npm test',
      moment: 'base',
      passed: false,
      ...fields,
    });
    const lines = collect([
      check({ newFailures: 0, preExisting: 2 }),
      check({ id: 'V2', newFailures: 1, preExisting: 1 }),
      check({ moment: 'brief', status: 'running' }),
      check({ moment: 'brief', duration: 3 }),
      check({ newFailures: 0, preExisting: 1 }),
      check({ moment: 'brief', status: 'refused', detail: 'names no program' }),
      check({ moment: 'brief', passed: true, own: 2, ownLeft: 0, others: 3 }),
      check({ moment: 'brief', own: 2, ownLeft: 1, others: 3 }),
      check({ moment: 'brief', own: 2, ownLeft: 0, others: 1, proven: false }),
      check({ moment: 'brief', passed: true, own: 2, ownLeft: 0, others: 0, proven: true }),
      check({
        id: 'V3',
        newFailures: 1,
        preExisting: 1,
        notVerified: 1,
        detail: 'the run base re-run timed out',
      }),
    ]);

    expect(lines).toEqual([
      'phase: final-review',
      "base re-run V1: pre-existing · all 2 failures also fail before this run's changes",
      'base re-run V2: 1\u00a0new, 1\u00a0pre-existing',
      'fix check V1: failed (npm test)',
      "base re-run V1: pre-existing · the failure also fails before this run's changes",
      'fix check V1: refused (names no program)',
      'fix check V1: your 2\u00a0failures gone · 3\u00a0others left (npm test)',
      'fix check V1: 1\u00a0of your 2\u00a0failures remains (npm test)',
      'fix check V1: your 2\u00a0failures not shown · not\u00a0proven\u00a0fixed (npm test)',
      'fix check V1: your 2\u00a0failures gone (npm test)',
      'base re-run V3: 1\u00a0new, 1\u00a0pre-existing, 1\u00a0not verified at the run base · the run base re-run timed out',
    ]);
  });

  it('writes nothing for a full-suite stage of a session from before the reviewer chose its checks', () => {
    const lines = collect([
      {
        type: 'full_suite',
        ts,
        phase: 'final-review',
        status: 'done',
        stage: 'test',
        command: 'npm test',
        moment: 'pre-review',
        passed: true,
      },
    ]);

    expect(lines).toEqual(['phase: final-review']);
  });

  it('writes nothing for pre-start events that carry the idle phase', () => {
    const lines = collect([
      { type: 'warning', ts, phase: 'idle', message: 'Session JSONL sink is degraded.' },
      { type: 'error', ts, phase: 'idle', message: 'Planner claude-code is not available.' },
      { type: 'workflow_started', ts, phase: 'researching', feature: 'add a widget' },
    ]);

    expect(lines).toEqual(['phase: researching']);
  });
});
