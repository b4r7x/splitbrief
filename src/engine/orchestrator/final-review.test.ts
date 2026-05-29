import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import {
  sessionDir,
  REVIEW_FILE,
  SPEC_FILE,
  DRIFT_REPORT_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
} from '../../core/paths.js';
import { hashTaskBrief } from '../brief-hash.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { runFinalReviewPhase, shutdownWorkflow } from './final-review.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { Summary } from '../../core/schemas/summary.js';
import { ReviewPacketSchema } from '../../core/schemas/review-packet.js';
import { readRunSnapshotLedger } from '../snapshots/run.js';

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
  s = transition(s, { type: 'BRIEFS_READY', tasks });
  s = transition(s, { type: 'APPROVE_BRIEFS' });
  s = { ...s, implementerTool: 'ollama', implementerModel: 'qwen2.5' };
  return s;
}

const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'standard',
} as const;

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
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nAdd auth.\n', null);

    const reviewText = '### Verdict\npass\n\n### Findings\nNone.';
    const reviewPrompts: string[] = [];
    const review = async (prompt: string) => {
      reviewPrompts.push(prompt);
      return { text: reviewText, usage: { inputTokens: 200, outputTokens: 40 } };
    };
    const completions: Summary[] = [];
    const onComplete = (s: Summary) => {
      completions.push(s);
    };
    const { callbacks } = makeCallbacks({ onComplete });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({ review });

    const state = allTasksDoneState([makeTask({ id: 'T001', status: 'done' })]);
    const phaseTimings: Record<string, number> = {};

    const summary = await runFinalReviewPhase(
      {
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks,
        bus,
        state,
        planner,
        metadata: TEST_METADATA,
      },
      SUMMARY_BASE,
      [] satisfies TaskTokenUsage[],
      phaseTimings,
    );

    expect(reviewPrompts).toHaveLength(1);
    expect(reviewPrompts[0]).toContain('Add auth');

    const reviewPath = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
    expect(existsSync(reviewPath)).toBe(true);
    expect(readFileSync(reviewPath, 'utf-8')).toContain(reviewText);

    expect(completions).toHaveLength(1);
    expect(completions[0]).toBe(summary);

    const statusEvents = events.filter((e) => e.type === 'planner_status');
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(statusEvents[0]).toMatchObject({ status: 'running' });
    expect(statusEvents.at(-1)).toMatchObject({ status: 'done' });

    expect(summary.feature).toBe('test feature');
    expect(phaseTimings.review).toBeGreaterThanOrEqual(0);
    expect(summary.reviewPacket).toMatchObject({
      jsonPath: REVIEW_PACKET_JSON_FILE,
      markdownPath: REVIEW_PACKET_MARKDOWN_FILE,
      finalReviewStatus: 'written',
    });
    const packetPath = join(sessionDir(projectDir, sessionId), REVIEW_PACKET_JSON_FILE);
    expect(existsSync(packetPath)).toBe(true);
    const packet = ReviewPacketSchema.parse(JSON.parse(readFileSync(packetPath, 'utf-8')));
    expect(packet.finalReview.status).toBe('written');
    expect(existsSync(join(sessionDir(projectDir, sessionId), REVIEW_PACKET_MARKDOWN_FILE))).toBe(
      true,
    );
  });

  it('still advances to complete, records phase timing, and calls onComplete even when the planner review throws', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    const review = async () => {
      throw new Error('planner crashed');
    };
    const completions: Summary[] = [];
    const onComplete = (s: Summary) => {
      completions.push(s);
    };
    const { callbacks } = makeCallbacks({ onComplete });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({ review });

    const state = allTasksDoneState([makeTask({ id: 'T001', status: 'done' })]);
    const phaseTimings: Record<string, number> = {};

    const summary = await runFinalReviewPhase(
      {
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks,
        bus,
        state,
        planner,
        metadata: TEST_METADATA,
      },
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
    expect(completions).toHaveLength(1);
    expect(phaseTimings.review).toBeGreaterThanOrEqual(0);
    // The state passed to onComplete is internal; the returned summary is the observable.
    expect(summary).toBeDefined();
    expect(summary.reviewPacket?.finalReviewStatus).toBe('failed');
    const packetPath = join(sessionDir(projectDir, sessionId), REVIEW_PACKET_JSON_FILE);
    expect(existsSync(packetPath)).toBe(true);
    const packet = ReviewPacketSchema.parse(JSON.parse(readFileSync(packetPath, 'utf-8')));
    expect(packet.finalReview.status).toBe('failed');
  });

  it('does not emit workflow completion when final review is aborted', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    const controller = new AbortController();
    const completions: Summary[] = [];
    const { callbacks } = makeCallbacks({
      onComplete: (summary) => {
        completions.push(summary);
      },
    });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      review: async () => {
        controller.abort(new DOMException('The user aborted a request.', 'AbortError'));
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
    });
    const phaseTimings: Record<string, number> = {};

    const summary = await runFinalReviewPhase(
      {
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks,
        bus,
        state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })]),
        planner,
        metadata: TEST_METADATA,
        signal: controller.signal,
      },
      SUMMARY_BASE,
      [],
      phaseTimings,
    );

    expect(summary).toBeDefined();
    expect(completions).toEqual([]);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
    expect(phaseTimings.review).toBeGreaterThanOrEqual(0);
    expect(existsSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE))).toBe(false);
  });

  it('works without a phaseTimings map (metadata argument remains optional)', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);

    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({ text: 'ok', usage: null }),
    });
    const state = allTasksDoneState([]);

    const result: Summary = await runFinalReviewPhase(
      { projectDir, sessionId, config: makeNoValidationConfig(), callbacks, bus, state, planner },
      SUMMARY_BASE,
      [],
    );

    expect(result).toBeDefined();
    expect(result.totalTasks).toBe(0);
  });

  it('writes active briefHash into the drift report artifact', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const planner = makePlanner({ review: vi.fn().mockResolvedValue({ text: 'ok', usage: null }) });
    const tasks = [makeTask({ id: 'T001', status: 'done' })];

    await runFinalReviewPhase(
      {
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks,
        bus,
        state: allTasksDoneState(tasks),
        planner,
      },
      SUMMARY_BASE,
      [],
    );

    const drift = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE), 'utf8'),
    );
    expect(drift.briefHash).toBe(hashTaskBrief(tasks));
  });

  it('records the real pre-final-review auto snapshot in the run ledger', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', null);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({ review: vi.fn().mockResolvedValue({ text: 'ok', usage: null }) });

    await runFinalReviewPhase(
      {
        projectDir,
        sessionId,
        config: { ...makeNoValidationConfig(), snapshots: { auto: { preFinalReview: true } } },
        callbacks,
        bus,
        state: allTasksDoneState([makeTask({ id: 'T001', status: 'done' })]),
        planner,
      },
      SUMMARY_BASE,
      [],
    );

    const snapshotEvent = events.find((e) => e.type === 'snapshot_created');
    expect(snapshotEvent).toMatchObject({ type: 'snapshot_created', name: 'pre-final-review' });
    const ledger = await readRunSnapshotLedger(projectDir, sessionId);
    expect(ledger?.accepted).toBe(false);
    expect(ledger?.rejected).toBe(false);
    if (snapshotEvent?.type === 'snapshot_created') {
      expect(ledger?.runSnapshotIds).toContain(snapshotEvent.snapshotId);
    }
  });
});

describe('shutdownWorkflow', () => {
  it('persists tracked state to disk when one is available', async () => {
    const { projectDir, sessionId } = setupProject();

    const trackedState: WorkflowState = {
      ...createInitialState('feat'),
      feature: 'shutdown-test',
    };

    await shutdownWorkflow(
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

  it('is safe when there is no tracked state and no current task', async () => {
    const { projectDir, sessionId } = setupProject();
    await expect(
      shutdownWorkflow(
        projectDir,
        sessionId,
        () => undefined,
        () => undefined,
      ),
    ).resolves.toBeUndefined();
  });

  it('waits for current task rollback during shutdown', async () => {
    const { projectDir, sessionId } = setupProject();
    const file = 'src/generated.ts';
    const filePath = join(projectDir, file);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const generated = true;\n');

    await shutdownWorkflow(
      projectDir,
      sessionId,
      () => undefined,
      () => ({ file, action: 'create' }),
    );

    expect(existsSync(filePath)).toBe(false);
  });
});
