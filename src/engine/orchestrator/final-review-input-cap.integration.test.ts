import { plainUserMessage } from '../../core/types/user-input.js';

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import {
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import {
  REVIEW_FILE,
  REVIEW_JSON_FILE,
  REVIEW_PACKET_JSON_FILE,
  SPEC_FILE,
  sessionDir,
} from '../../core/paths.js';
import { formatRecoveryHeadline } from '../../core/recovery/headline.js';
import { recoveryFactNumber } from '../../core/schemas/recovery/facts.js';
import { ReviewPacketSchema } from '../../core/schemas/review-packet.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { awaitsApply } from '../../core/sessions/run-status.js';
import type { Planner } from '../planners/types.js';
import {
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
} from './approval/file-snapshots/capture.js';
import { captureTaskReviewChanges } from './evidence/review-capture.js';
import { getOrCreateLedger } from './evidence/persistence.js';
import { writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { runFinalReviewPhase, type FinalReviewResult } from './final-review.js';
import { applyRecoveryAction } from './recovery/actions.js';
import { haltVerdictlessReview } from './run/review.js';
import { buildSummary } from './summary/build.js';

const CODEX_CAP = 1_048_576;
// Captured live from `codex exec` (gpt-6.1-sol) on 2026-10-05.
const CODEX_INPUT_TOO_LARGE =
  'Error: turn/start: turn/start failed: Input exceeds the maximum length of 1048576 characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":1048576,"actual_chars":1106026}';
const CODEX_REVIEWER = makeNoValidationConfig({ reviewer: { kind: 'cli', tool: 'codex' } });

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function lines(prefix: string, count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `export const ${prefix}${i} = '${'x'.repeat(20)}';\n`,
  ).join('');
}

function project() {
  const projectDir = createTempDir('review-input-cap');
  dirs.push(projectDir);
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, 'src/big.ts'), 'export const start = 0;\n');
  const ref = { projectDir, sessionId: 'input-cap' };
  ensureSessionDir(projectDir, ref.sessionId);
  writeSpecFile(ref, SPEC_FILE, 'Grow the module.', null);
  return ref;
}

async function completeTask(
  ref: { projectDir: string; sessionId: string },
  task: Task,
  writes: Record<string, string>,
) {
  const taskStartSnapshot = await getChangedFilesSnapshot(ref.projectDir);
  for (const [path, text] of Object.entries(writes))
    writeFileSync(join(ref.projectDir, path), text);
  await captureTaskReviewChanges({
    ref,
    workspaceDir: ref.projectDir,
    task,
    since: taskStartSnapshot,
    files: await getChangedFilesSinceSnapshot(ref.projectDir, taskStartSnapshot),
  });
  writeEvidenceLedger(ref, getOrCreateLedger({ ref, state: makeImplState([task]) }));
}

function doneState(task: Task, overrides: Partial<WorkflowState> = {}): WorkflowState {
  return makeImplState([{ ...task, status: 'done' }], {
    changedFilesBaseline: { head: null, runStartChangedFiles: [], fingerprints: {} },
    ...overrides,
  });
}

function countingReviewer(): { reviewer: Planner; prompts: string[] } {
  const prompts: string[] = [];
  const reviewer = makePlanner({
    typedCall: typedCallPlanAndReview(
      () => planFromTasks([]),
      (prompt) => {
        prompts.push(prompt);
        return passingReviewVerdict(prompt);
      },
    ),
  });
  return { reviewer, prompts };
}

async function review(
  ref: { projectDir: string; sessionId: string },
  state: WorkflowState,
  reviewer: Planner,
  bus = makeBusRecorder().bus,
): Promise<FinalReviewResult> {
  return runFinalReviewPhase({
    ...ref,
    workspaceDir: ref.projectDir,
    state,
    config: CODEX_REVIEWER,
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
  });
}

async function halt(
  ref: { projectDir: string; sessionId: string },
  result: FinalReviewResult,
): Promise<WorkflowState> {
  const halted = await haltVerdictlessReview({
    wctx: makeWctx({ ...ref, config: CODEX_REVIEWER, bus: makeBusRecorder().bus }),
    state: result.state,
    setTrackedState: vi.fn(),
    review: result,
  });
  if (halted === undefined) throw new Error('the review did not halt');
  return halted;
}

describe('final review input cap', () => {
  it('halts with review-input-too-large before calling a codex reviewer when the diff alone is over its cap', {
    timeout: 60_000,
  }, async () => {
    const ref = project();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/big.ts'], action: 'modify' });
    await completeTask(ref, task, { 'src/big.ts': lines('v', 40_000) });
    const { reviewer, prompts } = countingReviewer();

    const result = await review(ref, doneState(task), reviewer);

    expect(prompts).toEqual([]);
    expect(result.reviewStatus).toBe('failed');
    expect(result.failure).toMatchObject({ kind: 'input-too-large', maxChars: CODEX_CAP });
    if (result.failure?.kind !== 'input-too-large') throw new Error('no input-too-large failure');
    expect(result.failure.chars).toBeGreaterThan(CODEX_CAP);
    expect(result.failure.largestFiles[0]?.path).toBe('src/big.ts');

    const issue = (await halt(ref, result)).pendingRecovery;
    expect(issue).toMatchObject({ reason: 'review-input-too-large', seat: 'review' });
    expect(issue?.availableActions).not.toContain('retry-same-worker');
    expect(issue?.availableActions).toContain('end-run');
    expect(recoveryFactNumber(issue?.facts, 'maxChars')).toBe(CODEX_CAP);
    expect(recoveryFactNumber(issue?.facts, 'chars')).toBe(result.failure.chars);
    expect(issue?.details.join('\n')).toContain('src/big.ts');
    if (issue === undefined) throw new Error('no pending recovery');
    expect(formatRecoveryHeadline(issue)).toContain('Review input');
  });

  it('trims full-file context to fit, and records what it dropped in the packet and the transcript', {
    timeout: 60_000,
  }, async () => {
    const ref = project();
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/big.ts', 'src/new-big.ts'],
    });
    await completeTask(ref, task, {
      'src/big.ts': lines('v', 15_000),
      'src/new-big.ts': lines('n', 15_000),
    });
    const { reviewer, prompts } = countingReviewer();
    const { bus, events } = makeBusRecorder();

    const result = await review(ref, doneState(task), reviewer, bus);

    expect(result.reviewStatus).toBe('written');
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? '';
    expect(prompt.length).toBeLessThanOrEqual(CODEX_CAP);
    expect(prompt).toContain('export const v14999');
    expect(prompt).not.toContain('export const n14999');
    expect(prompt.split('## Trimmed for Size')[1]).toContain('src/new-big.ts');
    const packet = ReviewPacketSchema.parse(
      JSON.parse(
        readFileSync(
          join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_PACKET_JSON_FILE),
          'utf8',
        ),
      ),
    );
    expect(packet.reviewInput).toMatchObject({
      maxChars: CODEX_CAP,
      dropped: [{ trim: 'full-file-context', items: ['src/new-big.ts'] }],
    });
    expect(packet.reviewInput?.chars).toBeLessThanOrEqual(CODEX_CAP);
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.message.includes('Review input trimmed') &&
          event.message.includes('src/new-big.ts'),
      ),
    ).toBe(true);
  });

  it("classifies the tool's own input_too_large refusal as review-input-too-large with its numbers", async () => {
    const ref = project();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/big.ts'], action: 'modify' });
    await completeTask(ref, task, { 'src/big.ts': 'export const start = 1;\n' });
    const invoke = vi.fn(async () =>
      makeRunnerCallResult({
        status: 'failed',
        text: '',
        error: { code: 'input-too-large', message: CODEX_INPUT_TOO_LARGE },
      }),
    );
    const reviewer = makePlanner({
      typedCall: (ctx) => ({
        seat: ctx.seat,
        typedOutput: 'strict-native',
        canResume: false,
        invoke,
      }),
    });

    const result = await review(ref, doneState(task), reviewer);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.failure).toMatchObject({
      kind: 'input-too-large',
      chars: 1_106_026,
      maxChars: CODEX_CAP,
    });
    const issue = (await halt(ref, result)).pendingRecovery;
    expect(issue?.reason).toBe('review-input-too-large');
    expect(issue?.availableActions).not.toContain('retry-same-worker');
    expect(recoveryFactNumber(issue?.facts, 'chars')).toBe(1_106_026);
  });

  it('halts the same way when a repair answer grows the prompt over the cap', async () => {
    const ref = project();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/big.ts'], action: 'modify' });
    await completeTask(ref, task, { 'src/big.ts': 'export const start = 1;\n' });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(makeRunnerCallResult({ status: 'completed', text: 'not a verdict' }))
      .mockResolvedValueOnce(
        makeRunnerCallResult({
          status: 'failed',
          text: '',
          error: { code: 'input-too-large', message: CODEX_INPUT_TOO_LARGE },
        }),
      );
    const reviewer = makePlanner({
      typedCall: (ctx) => ({
        seat: ctx.seat,
        typedOutput: 'strict-native',
        canResume: false,
        invoke,
      }),
    });

    const result = await review(ref, doneState(task), reviewer);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.failure).toMatchObject({ kind: 'input-too-large', chars: 1_106_026 });
    expect((await halt(ref, result)).pendingRecovery?.reason).toBe('review-input-too-large');
  });

  it('records the trims it tried in the packet and the transcript when the prompt still does not fit', {
    timeout: 60_000,
  }, async () => {
    const ref = project();
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/big.ts', 'src/new-big.ts'],
    });
    await completeTask(ref, task, {
      'src/big.ts': lines('v', 40_000),
      'src/new-big.ts': lines('n', 1_000),
    });
    const { reviewer, prompts } = countingReviewer();
    const { bus, events } = makeBusRecorder();

    const result = await review(ref, doneState(task), reviewer, bus);

    expect(prompts).toEqual([]);
    expect(result.failure?.kind).toBe('input-too-large');
    const packet = ReviewPacketSchema.parse(
      JSON.parse(
        readFileSync(
          join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_PACKET_JSON_FILE),
          'utf8',
        ),
      ),
    );
    expect(packet.reviewInput).toMatchObject({
      maxChars: CODEX_CAP,
      dropped: [{ trim: 'full-file-context', items: ['src/new-big.ts'] }],
    });
    expect(packet.reviewInput?.chars).toBeGreaterThan(CODEX_CAP);
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.message.includes('Review input trimmed') &&
          event.message.includes('src/new-big.ts'),
      ),
    ).toBe(true);
  });

  it('never reports an earlier task-cadence pass as the final verdict of a run whose final review did not run', {
    timeout: 60_000,
  }, async () => {
    const ref = project();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/big.ts'], action: 'modify' });
    await completeTask(ref, task, { 'src/big.ts': lines('v', 40_000) });
    const taskReview = {
      scope: 'task',
      cycle: 0,
      verdict: { tasks: [{ id: 'T001', plan: 'met', note: '' }], criteria: [], findings: [] },
      outcome: 'pass',
      verification: [],
      at: '2026-10-05T00:00:00.000Z',
    };
    writeSpecFile(ref, REVIEW_JSON_FILE, `${JSON.stringify(taskReview)}\n`, null);
    writeSpecFile(ref, REVIEW_FILE, '### Verdict\npass\n', null);
    const { reviewer } = countingReviewer();

    const result = await review(ref, doneState(task), reviewer);

    expect(result.failure?.kind).toBe('input-too-large');
    const packet = ReviewPacketSchema.parse(
      JSON.parse(
        readFileSync(
          join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_PACKET_JSON_FILE),
          'utf8',
        ),
      ),
    );
    expect(packet.finalReview.verdict).toBeNull();
    const summary = buildSummary({
      feature: 'feature',
      startTime: Date.now(),
      plannerTool: 'test',
      implementerTool: 'test',
      projectDir: ref.projectDir,
      sessionId: ref.sessionId,
      state: result.state,
    });
    expect(summary.review).toBeUndefined();
  });

  it('skips the review with a note on a workspace run: ready to apply, never reviewed', {
    timeout: 60_000,
  }, async () => {
    const ref = project();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/big.ts'], action: 'modify' });
    await completeTask(ref, task, { 'src/big.ts': lines('v', 40_000) });
    const workspace = {
      kind: 'worktree' as const,
      path: ref.projectDir,
      base: { snapshotId: 'base', head: null },
    };
    const { reviewer } = countingReviewer();
    const result = await review(ref, doneState(task, { workspace }), reviewer);
    const halted = await halt(ref, result);
    const issue = halted.pendingRecovery;
    expect(issue?.availableActions).toEqual(expect.arrayContaining(['accept-as-is', 'end-run']));

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'accept-as-is',
      comment: plainUserMessage('Reviewed the diff by hand.'),
      bus: makeBusRecorder().bus,
    });

    expect(skipped).toMatchObject({ ok: true, status: 'continued' });
    expect(skipped.state.pendingRecovery).toBeUndefined();
    expect(skipped.state.phase).toBe('complete');
    expect(skipped.state.reviewStatus).not.toBe('passed');
    expect(skipped.state.review).toBeUndefined();
    expect(skipped.state.acceptedAsIs?.findings).toEqual([issue?.message]);
    expect(skipped.state.acceptedAsIs?.note).toBe('Reviewed the diff by hand.');
    expect(awaitsApply(skipped.state)).toBe(true);
  });
});
