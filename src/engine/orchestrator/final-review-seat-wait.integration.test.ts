import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  makeWctx,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { passingReviewVerdict } from '#testing/helpers/typed-planner.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import { SPEC_FILE } from '../../core/paths.js';
import { recoveryActionLabel } from '../../core/recovery/action-label.js';
import { loadState } from '../../core/state/persistence.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EventBus } from '../events/types.js';
import type { Planner } from '../planners/types.js';
import { applyRecoveryAction } from './recovery/actions.js';
import { resumeSeatWait } from './escalation/seat-wait.js';
import { haltVerdictlessReview } from './run/review.js';
import { runFinalReviewPhase, type FinalReviewResult } from './final-review.js';

const CODEX_REVIEWER = makeNoValidationConfig({ reviewer: { kind: 'cli', tool: 'codex' } });
const RESET_IN_BOUND = 'HTTP 429: rate limit reached (retry-after: 120)';
const RESET_PAST_BOUND = 'HTTP 429: rate limit reached (retry-after: 7200)';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function project(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('final-review-seat-wait');
  dirs.push(projectDir);
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, 'src/alpha.ts'), 'export const alpha = true;\n');
  const ref = { projectDir, sessionId: 'seat-wait' };
  ensureSessionDir(projectDir, ref.sessionId);
  writeSpecFile(ref, SPEC_FILE, '# Spec\n\nAdd auth.\n', null);
  return ref;
}

function doneState(task: Task): WorkflowState {
  return makeImplState([{ ...task, status: 'done' }], {
    changedFilesBaseline: { head: null, runStartChangedFiles: [], fingerprints: {} },
  });
}

function codexReviewer(message: string): Planner {
  let calls = 0;
  const invoke = vi.fn(async ({ prompt }: { prompt: string }) => {
    calls += 1;
    if (calls === 1) {
      return makeRunnerCallResult({
        status: 'failed',
        text: '',
        error: { code: 'codex-turn-failed', message },
      });
    }
    return makeRunnerCallResult({
      status: 'completed',
      text: JSON.stringify(passingReviewVerdict(prompt)),
    });
  });
  return makePlanner({
    typedCall: (ctx) => ({
      seat: ctx.seat,
      typedOutput: 'strict-native',
      canResume: false,
      invoke,
    }),
  });
}

async function review(
  ref: { projectDir: string; sessionId: string },
  state: WorkflowState,
  reviewer: Planner,
  bus: EventBus,
  config = CODEX_REVIEWER,
): Promise<FinalReviewResult> {
  return runFinalReviewPhase({
    ...ref,
    workspaceDir: ref.projectDir,
    state,
    config,
    bus,
    callbacks: makeCallbacks().callbacks,
    reviewer,
    metadata: TEST_METADATA,
    summaryBase: {
      feature: 'feature',
      startTime: Date.now(),
      plannerTool: 'test',
      implementerTool: 'test',
    },
    taskBreakdowns: [],
  });
}

async function halt(
  ref: { projectDir: string; sessionId: string },
  result: FinalReviewResult,
  bus: EventBus,
  config = CODEX_REVIEWER,
): Promise<WorkflowState> {
  const halted = await haltVerdictlessReview({
    wctx: makeWctx({ ...ref, config, bus }),
    state: result.state,
    setTrackedState: vi.fn(),
    review: result,
  });
  if (halted === undefined) throw new Error('the review did not halt');
  return halted;
}

describe('a rate-limited codex reviewer', () => {
  it('waits out a reset inside the bound, then reviews again and passes', async () => {
    const ref = project();
    const { bus, events } = makeBusRecorder();
    const reviewer = codexReviewer(RESET_IN_BOUND);

    const failed = await review(ref, doneState(makeTask({ id: 'T001' })), reviewer, bus);
    expect(failed.reviewStatus).toBe('failed');
    expect(failed.failure?.kind).toBe('seat-blocked');

    const halted = await halt(ref, failed, bus);
    const issue = halted.pendingRecovery;
    expect(issue).toMatchObject({ seat: 'review', reason: 'runner-usage-limit' });
    expect(issue?.availableActions).toContain('retry-later');
    expect(issue?.recommendedAction).toBe('retry-later');
    if (issue?.resetAt === undefined) throw new Error('the halt names no reset');

    const applied = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'retry-later',
      bus,
    });
    expect(applied).toMatchObject({ ok: true, status: 'continued' });
    if (!applied.ok) return;
    expect(applied.state.pendingRecovery).toBeUndefined();
    expect(applied.state.seatWait?.resetAt).toBe(issue.resetAt);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(issue.resetAt) - 120_000));
    const pending = resumeSeatWait({ ref: { ...ref, bus }, state: applied.state });
    await vi.advanceTimersByTimeAsync(1);
    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    const resumed = await pending;
    vi.useRealTimers();
    expect(resumed.seatWait).toBeUndefined();
    expect(loadState(ref)?.seatWait).toBeUndefined();

    const passed = await review(ref, resumed, reviewer, bus);
    expect(passed.reviewStatus).toBe('written');
    expect(passed.verdict?.outcome.kind).toBe('pass');
  });

  it.each([CODEX_REVIEWER, makeNoValidationConfig({ planner: { kind: 'cli', tool: 'codex' } })])(
    'halts the review seat on a reset past the bound, offering Retry at the clock [%#]',
    async (config) => {
      const ref = project();
      const { bus, events } = makeBusRecorder();
      const reviewer = codexReviewer(RESET_PAST_BOUND);

      const failed = await review(ref, doneState(makeTask({ id: 'T001' })), reviewer, bus, config);
      expect(failed.reviewStatus).toBe('failed');
      expect(failed.failure?.kind).toBe('seat-blocked');

      expect(events.find((event) => event.type === 'error')?.message).toContain(
        'change the REVIEW tool',
      );
      const halted = await halt(ref, failed, bus, config);
      const issue = halted.pendingRecovery;
      expect(issue).toMatchObject({ seat: 'review', reason: 'runner-usage-limit' });
      expect(issue?.availableActions).toContain('retry-later');
      if (issue?.resetAt === undefined) throw new Error('the halt names no reset');
      expect(recoveryActionLabel('retry-later', { resetAt: issue.resetAt })).toMatch(/^Retry at /);
    },
  );
});
