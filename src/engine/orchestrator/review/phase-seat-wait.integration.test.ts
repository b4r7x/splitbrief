import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { passingReviewVerdict } from '#testing/helpers/typed-planner.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { ensureSessionDir, writeSpecFile } from '../../../core/sessions/spec-files.js';
import { SPEC_FILE } from '../../../core/paths.js';
import { loadState } from '../../../core/state/persistence.js';
import type { Task } from '../../../core/schemas/task.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import type { Planner } from '../../planners/types.js';
import { haltVerdictlessReview } from './loop/halts.js';
import { runFinalReviewPhase } from './phase.js';
import type { FinalReviewResult } from './types.js';
import { createCliPlanner } from '../../planners/cli.js';
import { createCommandPlanner } from '../../planners/command-invoke.js';
import { requireCompletedCall } from '../../planners/require-completed-call.js';
import { invokeCommandRunner } from '../../runners/command-based.js';
import { formatRecoveryPrompt } from '../../../features/workflow/recovery/prompt-text.js';
import { invokeProcessCli } from '../../runners/cli-tools/process-invoke/invoke.js';
import { claudeCodePlannerAdapter } from '../../runners/cli-tools/claude-code/adapter.js';
import { antigravityPlannerAdapter } from '../../runners/cli-tools/antigravity/adapter.js';
import { diagnosePlannerCallFailure } from '../recovery/planner-call-failure.js';
import { buildPlannerCallFailedRecoveryIssue } from '../recovery/builders/planner.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import { CURSOR_MODEL_REFUSAL, writeCursorRefusalShim } from '#testing/helpers/cursor-refusal.js';
import { admittedCliSeat } from '#testing/helpers/runner-gate.js';

const CODEX_REVIEWER = makeNoValidationConfig({ reviewer: { kind: 'cli', tool: 'codex' } });
const RESET_IN_BOUND = 'HTTP 429: rate limit reached (retry-after: 120)';
const RESET_PAST_BOUND = 'HTTP 429: rate limit reached (retry-after: 7200)';
const TERMINAL_RESET = '\u001b(B\u001b[m';
const CURSOR_RESTORE = '\u001b8';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

// The run's git helpers pause on short real timers, so the fake clock also moves with real time;
// the seat's own wait is long enough that only the explicit advance ends it.
function seatClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
}

function nextEvent(bus: EventBus, type: EngineEvent['type']): Promise<EngineEvent> {
  return new Promise((resolve) => {
    const stop = bus.subscribe((event) => {
      if (event.type !== type) return;
      stop();
      resolve(event);
    });
  });
}

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
    modelCache: undefined,
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
  it.each([true, false])(
    'publishes REVIEW advice only without an automatic intent: %s',
    async (auto) => {
      const ref = project();
      await rememberDetectedTools(
        ref.projectDir,
        cliDetectionsFor('ready', ['codex', 'claude-code']),
      );
      const config = makeNoValidationConfig({
        reviewer: {
          kind: 'cli',
          tool: 'codex',
          ...(auto && { fallback: { tool: 'claude-code', model: 'sonnet' } }),
        },
      });
      writeConfig(ref.projectDir, config);
      const { bus, events } = makeBusRecorder();
      const failed = await review(
        ref,
        doneState(makeTask({ id: 'T001' })),
        codexReviewer('Insufficient Balance'),
        bus,
        config,
      );
      const halted = await halt(ref, failed, bus, config);
      expect(halted.pendingRecovery?.switchSeat?.auto !== undefined).toBe(auto);
      expect(halted.pendingRecovery?.message).toContain('Add credit');
      const rows = events.filter((event) => event.type === 'error');
      expect(rows).toHaveLength(1);
      if (auto) expect(rows[0]?.message).toBe('Balance spent on OpenAI Codex CLI');
      else expect(rows[0]?.message).toContain('change the REVIEW tool');
    },
  );

  it.each([
    [RESET_IN_BOUND, CODEX_REVIEWER, 120_000],
    [RESET_PAST_BOUND, CODEX_REVIEWER, 7_200_000],
    [
      RESET_PAST_BOUND,
      makeNoValidationConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      7_200_000,
    ],
  ])(
    'waits inside the review call for a named reset with no fallback, then passes: %s [%#]',
    async (message, config, waitMs) => {
      seatClock();
      const ref = project();
      const { bus, events } = makeBusRecorder();
      const waiting = nextEvent(bus, 'seat_wait_started');

      const running = review(
        ref,
        doneState(makeTask({ id: 'T001' })),
        codexReviewer(message),
        bus,
        config,
      );
      const started = await Promise.race([waiting, running]);
      expect(started).toMatchObject({ type: 'seat_wait_started', seat: 'review' });
      if (!('type' in started) || started.type !== 'seat_wait_started') return;
      const resetAt = Date.parse(started.resetAt);
      expect(resetAt - started.ts).toBeGreaterThan(waitMs - 1_000);
      expect(resetAt - started.ts).toBeLessThanOrEqual(waitMs);
      expect(loadState(ref)?.seatWait?.resetAt).toBe(new Date(resetAt).toISOString());
      await vi.advanceTimersByTimeAsync(resetAt - Date.now());
      const passed = await running;

      expect(passed.reviewStatus).toBe('written');
      expect(passed.verdict?.outcome.kind).toBe('pass');
      expect(events.filter((event) => event.type === 'seat_wait_ended')).toHaveLength(1);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(loadState(ref)?.seatWait).toBeUndefined();
      expect(loadState(ref)?.pendingRecovery).toBeUndefined();
    },
  );

  it('drops the wait a /steer cut once the steered review call passes', async () => {
    seatClock();
    const ref = project();
    const { bus, events } = makeBusRecorder();
    const abortHandlers: (() => void)[] = [];
    const waiting = nextEvent(bus, 'seat_wait_started');

    const running = runFinalReviewPhase({
      modelCache: undefined,
      ...ref,
      workspaceDir: ref.projectDir,
      state: doneState(makeTask({ id: 'T001' })),
      config: CODEX_REVIEWER,
      bus,
      callbacks: makeCallbacks({
        onContinuationNeeded: async () => plainUserMessage('look at auth'),
      }).callbacks,
      sinks: {
        ...TEST_SINKS,
        setAbortHandler: (handler) => {
          if (handler === null) abortHandlers.pop();
          else abortHandlers.push(handler);
        },
      },
      signal: new AbortController().signal,
      reviewer: codexReviewer(RESET_PAST_BOUND),
      metadata: TEST_METADATA,
      summaryBase: {
        feature: 'feature',
        startTime: Date.now(),
        plannerTool: 'test',
        implementerTool: 'test',
      },
    });
    await Promise.race([waiting, running]);
    expect(loadState(ref)?.seatWait?.seat).toBe('review');
    // `/steer` aborts the call through the per-call abort handler.
    abortHandlers.at(-1)?.();
    const passed = await running;

    expect(passed.verdict?.outcome.kind).toBe('pass');
    expect(loadState(ref)?.seatWait).toBeUndefined();
    expect(events.filter((event) => event.type === 'seat_wait_ended').at(-1)).not.toHaveProperty(
      'kept',
    );
  });

  it('retries a dropped connection inside the review call, then passes', async () => {
    seatClock();
    const ref = project();
    const { bus, events } = makeBusRecorder();
    const retried = nextEvent(bus, 'seat_retry');

    const running = review(
      ref,
      doneState(makeTask({ id: 'T001' })),
      codexReviewer('stream error: connection reset by peer'),
      bus,
    );
    expect(await Promise.race([retried, running])).toMatchObject({
      type: 'seat_retry',
      seat: 'review',
      attempt: 1,
      delayMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const passed = await running;

    expect(passed.reviewStatus).toBe('written');
    expect(passed.verdict?.outcome.kind).toBe('pass');
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });
});

describe('a Cursor reviewer that refuses the account', () => {
  it.each([true, false])(
    'halts the review seat as Seat down in the whole refusal, automatic switch: %s',
    async (auto) => {
      const ref = project();
      const shimDir = createTempDir('final-review-cursor-shim');
      dirs.push(shimDir);
      writeCursorRefusalShim(shimDir);
      const restorePath = prependPath(shimDir);
      try {
        await rememberDetectedTools(
          ref.projectDir,
          cliDetectionsFor('ready', ['cursor', 'claude-code']),
        );
        const seat = {
          kind: 'cli',
          tool: 'cursor',
          model: 'claude-haiku-5-5-thinking-high',
          ...(auto && { fallback: { tool: 'claude-code', model: 'sonnet' } }),
        } as const;
        const config = makeNoValidationConfig({ reviewer: seat });
        writeConfig(ref.projectDir, config);
        const reviewer = createCliPlanner({
          config: { ...config, planner: seat },
          cliSeat: admittedCliSeat(trustedShimGate({ dir: shimDir, tool: 'cursor' })),
        });
        const { bus, events } = makeBusRecorder();

        const failed = await review(
          ref,
          doneState(makeTask({ id: 'T001' })),
          reviewer,
          bus,
          config,
        );
        const halted = await halt(ref, failed, bus, config);

        expect(halted.pendingRecovery).toMatchObject({
          seat: 'review',
          reason: 'runner-usage-limit',
        });
        expect(halted.pendingRecovery?.switchSeat?.auto !== undefined).toBe(auto);
        expect(halted.pendingRecovery?.details.join('\n')).toContain(CURSOR_MODEL_REFUSAL);
        const rows = events.filter((event) => event.type === 'error');
        expect(halted.pendingRecovery?.facts?.cause).toBe('access');
        if (auto) {
          expect(rows[0]?.message).toBe('Access refused by Cursor Agent CLI');
        } else {
          expect(rows[0]?.message).toContain(
            'Check what the Cursor Agent CLI account allows, or change the REVIEW tool',
          );
        }
      } finally {
        restorePath();
      }
    },
  );
});

it.each([
  { stderr: TERMINAL_RESET, label: 'terminal reset' },
  { stderr: CURSOR_RESTORE, label: 'cursor restore' },
])('omits the shell attribution on PLAN for $label', async ({ stderr }) => {
  const ref = project();
  const runner = {
    kind: 'shell' as const,
    command: '/bin/sh',
    args: ['-c', 'printf "%s" "$1" >&2; exit 0', 'plan', stderr],
  };
  const err = await invokeCommandRunner({
    source: { kind: 'config', runner, env: process.env, notFoundMessage: 'Missing shell' },
    cwd: ref.projectDir,
    prompt: 'p'.repeat(1024 * 1024),
    callContext: { role: 'planner', callId: 'plan', backendKind: 'shell' },
  }).then(
    () => {
      throw new Error('The PLAN call returned before consuming the prompt');
    },
    (err: unknown) => err,
  );
  const diagnosis = diagnosePlannerCallFailure({
    err,
    label: 'Planning failed',
    runner,
    seat: 'plan',
  });
  const issue = buildPlannerCallFailedRecoveryIssue({
    diagnosis,
    runner,
    seat: 'plan',
    phase: 'planning',
    createdAt: new Date(0).toISOString(),
  });
  const panel = formatRecoveryPrompt(issue);
  expect(panel).toContain('The prompt could not be fully delivered through stdin.');
  expect(panel).not.toContain('Custom Shell reported:');
});

it.each([
  { stderr: '', label: 'silent', reported: false },
  { stderr: TERMINAL_RESET, label: 'terminal reset only', reported: false },
  { stderr: CURSOR_RESTORE, label: 'cursor restore only', reported: false },
  { stderr: 'Check the workspace index', label: 'stderr', reported: true },
])('saves and displays the final REVIEW transport failure ($label)', async (row) => {
  const { stderr, reported } = row;
  const ref = project();
  writeSpecFile(ref, SPEC_FILE, '# Spec\n' + 'Review the context.\n'.repeat(60_000), null);
  const runner = {
    kind: 'shell' as const,
    command: '/bin/sh',
    args: ['-c', 'printf "%s" "$1" >&2; exit 0', 'review', stderr],
    contextLength: 1_000_000,
  };
  const config = makeNoValidationConfig({ planner: runner, reviewer: runner });
  writeConfig(ref.projectDir, config);
  const { bus } = makeBusRecorder();
  const result = await review(
    ref,
    doneState(makeTask({ id: 'T001' })),
    createCommandPlanner(config, 'shell'),
    bus,
    config,
  );
  await halt(ref, result, bus, config);

  const issue = loadState(ref)?.pendingRecovery;
  if (!issue) throw new Error('Review did not save a recovery issue');
  const panel = formatRecoveryPrompt(issue);
  expect(issue.reason).toBe('review-failed');
  expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
  expect(panel).toContain('SPLITBRIEF could not deliver the prompt');
  expect(panel).toContain('The prompt could not be fully delivered through stdin.');
  expect(panel).not.toMatch(/reported: .*prompt could not be fully delivered/);
  if (reported) expect(panel).toContain(`Custom Shell reported: ${stderr}`);
  else expect(panel).not.toContain('reported:');
});

it.each([
  {
    tool: 'claude-code',
    adapter: claudeCodePlannerAdapter,
    words: 'Claude Code image attachments could not be read',
    attribution: 'Claude Code CLI reported:',
  },
  {
    tool: 'antigravity',
    adapter: antigravityPlannerAdapter,
    words: 'failed to decode stream input',
    attribution: 'Antigravity CLI reported:',
  },
] as const)('shows the actual $tool diagnostic on PLAN and once on final REVIEW', async (row) => {
  const ref = project();
  const marker = join(ref.projectDir, 'started');
  const shim = join(ref.projectDir, 'runner');
  const fixture = resolve('testing/fixtures/antigravity/stream-input-bad-json');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      `touch "${marker}"`,
      'cat >/dev/null',
      `cat "${fixture}.ndjson"`,
      `cat "${fixture}.stderr.txt" >&2`,
      'exit 1',
    ].join('\n'),
    { mode: 0o755 },
  );
  const path = realpathSync(shim);
  const { dev, ino, size, mtimeMs } = statSync(path);
  const images =
    row.tool === 'claude-code'
      ? [
          {
            id: 'attached',
            kind: 'image' as const,
            path: join(ref.projectDir, 'missing.png'),
            mimeType: 'image/png',
            sizeBytes: 12,
          },
        ]
      : [];
  const args = row.adapter.baseArgs({
    model: undefined,
    effort: undefined,
    projectDir: ref.projectDir,
    configuredArgs: [],
    sessionId: null,
    imagePaths: images.map((image) => image.path),
  });
  const invoke = (role: 'planner' | 'review') =>
    invokeProcessCli(row.adapter, {
      invocation: {
        executable: { path, fingerprint: { dev, ino, size, mtimeMs } },
        args,
        baseArgs: args,
        promptTransport: row.adapter.promptTransport,
        environment: { PATH: process.env.PATH ?? '' },
        cwd: ref.projectDir,
        images,
        signal: undefined,
      },
      prompt: 'Inspect screenshot',
      callContext: { callId: role, role, backendKind: 'cli' },
    });

  const runner = { kind: 'cli', tool: row.tool } as const;
  const config = makeNoValidationConfig({ planner: runner, reviewer: runner });
  writeConfig(ref.projectDir, config);
  const planError = await invoke('planner').then((call) => {
    try {
      requireCompletedCall(call);
    } catch (error) {
      return error;
    }
    throw new Error('The PLAN call completed');
  });
  const diagnosis = diagnosePlannerCallFailure({
    err: planError,
    label: 'Planning failed',
    runner,
    seat: 'plan',
  });
  const planIssue = buildPlannerCallFailedRecoveryIssue({
    diagnosis,
    runner,
    phase: 'planning',
    createdAt: new Date(0).toISOString(),
  });

  const reviewer = makePlanner({
    typedCall: ({ seat }) => ({
      seat,
      typedOutput: 'strict-native',
      canResume: false,
      invoke: () => invoke('review'),
    }),
  });
  const { bus } = makeBusRecorder();
  const result = await review(ref, doneState(makeTask({ id: 'T001' })), reviewer, bus, config);
  await halt(ref, result, bus, config);
  const reviewIssue = loadState(ref)?.pendingRecovery;
  if (!reviewIssue) throw new Error('Review did not save a recovery issue');
  expect(reviewIssue.reason).toBe('review-failed');
  expect(existsSync(marker)).toBe(row.tool === 'antigravity');
  const planPanel = formatRecoveryPrompt(planIssue);
  const reviewPanel = formatRecoveryPrompt(reviewIssue);
  expect(planPanel).toContain(row.words);
  if (row.tool === 'claude-code') expect(planPanel).not.toContain(row.attribution);
  else expect(planPanel).toContain(row.attribution);
  expect(reviewPanel.split(row.words).length - 1).toBe(1);
  expect(reviewPanel).not.toContain(row.attribution);
});
