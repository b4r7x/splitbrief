import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { REVIEW_FILE, sessionDir } from '../../core/paths.js';
import { buildSummary } from '../../engine/orchestrator/summary/build.js';
import { readRunRecord } from '../../core/sessions/run-record-io.js';
import { deriveRunStatus } from '../../core/sessions/run-status.js';
import { WorkflowStateSchema } from '../../core/schemas/workflow.js';
import { resetWorkflow } from '../../stores/workflow/actions/reset.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { hydrateRun } from './run-history.js';

// A trimmed copy of a run the old step chain made (standard mode, approve: all): state.json plus a
// short session.jsonl that carries the chain's research, spec, plan and tasks artifacts.
const FIXTURE = 'testing/fixtures/old-runs/p01-standard';
const SESSION_ID = '2026-09-29-use-one-list-grammar-across-the-tui-base-the-brief';

let projectDir = '';

function savedRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE, 'state.json'), 'utf-8'));
}

beforeEach(() => {
  projectDir = createTempDir('old-run-at-rest');
  const dir = sessionDir(projectDir, SESSION_ID);
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
  resetWorkflow();
});

afterEach(() => {
  resetWorkflow();
  cleanupTempDir(projectDir);
  projectDir = '';
});

describe('a run the old step chain made', () => {
  it('reads and reports the end it was given', () => {
    const record = readRunRecord({ projectDir, sessionId: SESSION_ID });

    expect(record.hydration.kind).toBe('loaded');
    expect(record.status).toEqual({ kind: 'closed', as: 'ended' });
  });

  it('opens at rest: the replay and the saved state reach the stores', async () => {
    const record = readRunRecord({ projectDir, sessionId: SESSION_ID });

    await hydrateRun(record);

    const types = eventsStore.get().events.map((event) => event.type);
    expect(types[0]).toBe('replay_started');
    expect(types.at(-1)).toBe('replay_complete');
    expect(types.filter((type) => type === 'artifact_written')).toHaveLength(4);
    expect(lifecycleStore.get().phase).toBe('implementing');
    expect(tasksStore.get().tasks.map((task) => task.id)).toEqual(['T001', 'T008', 'T009']);
  });

  it('stays continuable at the brief it stopped on when it was never ended', () => {
    const { closed: _closed, ...open } = savedRaw();
    const state = WorkflowStateSchema.parse(open);

    expect(deriveRunStatus({ state, liveness: 'not-alive' })).toEqual({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'interrupted' } },
      resumeAt: { kind: 'brief', taskId: 'T008', attempt: 1 },
    });
  });

  it('summarizes a session saved before review.json through its review.md', () => {
    writeFileSync(
      join(sessionDir(projectDir, SESSION_ID), REVIEW_FILE),
      '### Verdict\npass_with_notes\n\n### Findings\n- **Warning**: the retry path is untested\n',
    );

    const summary = buildSummary({
      feature: 'legacy review',
      startTime: Date.now() - 1000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      state: makeImplState([makeTask({ id: 'T001', status: 'done' })]),
      projectDir,
      sessionId: SESSION_ID,
    });

    expect(summary.review).toEqual({
      verdict: 'pass_with_notes',
      critical: 0,
      warnings: 1,
      notes: 0,
    });
  });

  it.each([
    [
      'specifying',
      {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'interrupted' } },
        resumeAt: { kind: 'planner', call: 'plan' },
      },
    ],
    [
      'reviewing-spec',
      {
        kind: 'open',
        stop: { kind: 'waiting-for-you', on: { kind: 'gate', gate: 'spec', reopens: false } },
        resumeAt: { kind: 'gate', gate: 'spec' },
      },
    ],
  ] as const)('still places a stop inside the old chain (%s)', (phase, status) => {
    const { closed: _closed, ...open } = savedRaw();
    const state = WorkflowStateSchema.parse({ ...open, phase, tasks: [], currentTaskIndex: 0 });

    expect(deriveRunStatus({ state, liveness: 'not-alive' })).toEqual(status);
  });
});
