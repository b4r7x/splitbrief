import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import { sessionDir, REVIEW_FILE, SPEC_FILE } from '../../core/paths.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { runFinalReviewPhase, shutdownWorkflow } from './final-review.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { Summary } from '../../core/schemas/summary.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('final-review-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-final';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function allTasksDoneState(tasks: Task[]): WorkflowState {
  // Walk the state machine into a state where ALL_DONE is valid.
  let s = createInitialState('feat');
  s = transition(s, { type: 'START', feature: 'feat' });
  s = transition(s, { type: 'RESEARCH_DONE' });
  s = transition(s, { type: 'SPEC_DONE' });
  s = transition(s, { type: 'APPROVE_SPEC' });
  s = transition(s, { type: 'PLAN_DONE', tasks });
  s = transition(s, { type: 'APPROVE_PLAN' });
  s = { ...s, implementerTool: 'ollama', implementerModel: 'qwen2.5' };
  return s;
}

const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'standard',
};

const SUMMARY_BASE = {
  feature: 'test feature',
  startTime: Date.now() - 1000,
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
};

describe('runFinalReviewPhase', () => {
  it('runs the planner review, writes review.md, emits workflow_complete, transitions to complete', async () => {
    const { projectDir, sessionId } = setupProject();
    // A non-trivial spec so the review prompt is well-formed.
    writeSpecFile(projectDir, sessionId, SPEC_FILE, '# Spec\n\nAdd auth.\n', null);

    const reviewText = '### Verdict\npass\n\n### Findings\nNone.';
    const review = vi.fn().mockResolvedValue({ text: reviewText, usage: { inputTokens: 200, outputTokens: 40 } });
    const onComplete = vi.fn();
    const { callbacks, events } = makeCallbacks({ onComplete });
    const planner = makePlanner({ review });

    const state = allTasksDoneState([makeTask({ id: 'T001', status: 'done' })]);
    const phaseTimings: Record<string, number> = {};

    const summary = await runFinalReviewPhase(
      { projectDir, sessionId, callbacks, state, planner, metadata: TEST_METADATA },
      SUMMARY_BASE,
      [] satisfies TaskTokenUsage[],
      phaseTimings,
    );

    // Planner was given a review prompt (contract: the spec content is passed in).
    expect(review).toHaveBeenCalled();
    const [prompt] = review.mock.calls[0] ?? [];
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Add auth');

    // review.md was written with the planner's output.
    const reviewPath = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
    expect(existsSync(reviewPath)).toBe(true);
    expect(readFileSync(reviewPath, 'utf-8')).toContain(reviewText);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[0]).toBe(summary);

    const statusEvents = events.filter((e) => e.type === 'planner-status');
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(statusEvents[0]).toMatchObject({ status: 'running' });
    expect(statusEvents.at(-1)).toMatchObject({ status: 'done' });

    // Summary shape + phase timing were set.
    expect(summary.feature).toBe('test feature');
    expect(phaseTimings.review).toBeGreaterThanOrEqual(0);
  });

  it('still advances to complete, records phase timing, and calls onComplete even when the planner review throws', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile(projectDir, sessionId, SPEC_FILE, '# Spec\n', null);

    const review = vi.fn().mockRejectedValue(new Error('planner crashed'));
    const onComplete = vi.fn();
    const { callbacks, events } = makeCallbacks({ onComplete });
    const planner = makePlanner({ review });

    const state = allTasksDoneState([makeTask({ id: 'T001', status: 'done' })]);
    const phaseTimings: Record<string, number> = {};

    const summary = await runFinalReviewPhase(
      { projectDir, sessionId, callbacks, state, planner, metadata: TEST_METADATA },
      SUMMARY_BASE,
      [],
      phaseTimings,
    );

    // An error event was emitted — the phase did not fail hard.
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    const message = errorEvent && 'message' in errorEvent ? errorEvent.message : '';
    expect(message.length).toBeGreaterThan(0);

    // review.md was NOT written (the review failed before reaching persistence).
    const reviewPath = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
    expect(existsSync(reviewPath)).toBe(false);

    // Terminal transitions still happened.
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(phaseTimings.review).toBeGreaterThanOrEqual(0);
    // The state passed to onComplete is internal; the returned summary is the observable.
    expect(summary).toBeDefined();
  });

  it('works without a phaseTimings map (metadata argument remains optional)', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile(projectDir, sessionId, SPEC_FILE, '# Spec\n', null);

    const { callbacks } = makeCallbacks();
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({ text: 'ok', usage: null }),
    });
    const state = allTasksDoneState([]);

    const result: Summary = await runFinalReviewPhase(
      { projectDir, sessionId, callbacks, state, planner },
      SUMMARY_BASE,
      [],
    );

    expect(result).toBeDefined();
    expect(result.totalTasks).toBe(0);
  });
});

describe('shutdownWorkflow', () => {
  it('persists tracked state to disk when one is available', () => {
    const { projectDir, sessionId } = setupProject();

    const trackedState: WorkflowState = {
      ...createInitialState('feat'),
      feature: 'shutdown-test',
    };

    shutdownWorkflow(
      projectDir,
      sessionId,
      () => trackedState,
      () => undefined,
    );

    const statePath = join(sessionDir(projectDir, sessionId), 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(persisted.feature).toBe('shutdown-test');
  });

  it('is safe when there is no tracked state and no current task', () => {
    const { projectDir, sessionId } = setupProject();
    expect(() =>
      shutdownWorkflow(projectDir, sessionId, () => undefined, () => undefined),
    ).not.toThrow();
  });
});
