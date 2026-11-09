import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  disposeWctxIsolations,
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
  makeWorktreeIsolation,
} from '#testing/helpers/orchestrator-factories.js';
import {
  cannotConsult,
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Check } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { createSnapshot } from '../../snapshots/create.js';
import { parkStoppedRun } from '../state-ops.js';
import { resumeContinuation } from './init.js';
import { runTasksAndReview } from './task-execution.js';

let dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeWctxIsolations();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const SEAT = (): Config => makeNoValidationConfig({ workflow: {} });
const NONE = (): Config => makeNoValidationConfig({ reviewer: 'none', workflow: {} });
const CHECK: Check = { id: 'K1', kind: 'cmd', value: 'node --version' };
const WORDS = 'also fix the typo';
const MERGED = [
  {
    path: 'src/alpha.ts',
    checkoutHunks: '@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n',
  },
];

/**
 * One pass of a run that Apply sent back: the run finished under one REVIEW, Apply started the
 * pass named by `type`, and the pass runs on `config`, as after a move in Crew at rest.
 */
async function sentBack(opts: {
  type: 'APPLY_REVIEW_START' | 'APPLY_RECHECK_START';
  config: Config;
  words?: boolean;
  stop?: boolean;
}) {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'review-next-pass',
    sessionId: 'sess-next-pass',
  });
  dirs.push(projectDir);
  const ref = { projectDir, sessionId };
  const head = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf8' }).trim();
  const isolation = makeWorktreeIsolation(ref);
  const base = await createSnapshot({ ...ref, phase: 'manual', name: 'workspace-base' });
  const opened = await isolation.open({ config: opts.config });
  const tasks = [
    makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done', checks: [CHECK] }),
  ];
  const finished: WorkflowState = {
    ...makeImplState(tasks),
    currentTaskIndex: tasks.length,
    changedFilesBaseline: { head, fingerprints: {}, runStartChangedFiles: [] },
    phase: 'complete',
    reviewStatus: opts.type === 'APPLY_RECHECK_START' ? 'none' : 'passed',
    plan: { summary: 'Plan', decisions: [], criteria: [], validation: null, checks: [] },
    workspace: {
      kind: opened.kind,
      path: opened.projectDir,
      base: { snapshotId: base.manifest.id, head: opened.head },
    },
  };
  const state = transition(finished, { type: opts.type, merged: MERGED });
  saveState(ref, state);
  const reviewNone = resolveReviewCadence(opts.config) === 'none';
  const controller = new AbortController();
  vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
    if (!opts.stop) return { stdout: 'ok', stderr: '', code: 0 };
    controller.abort();
    throw new DOMException('The operation was aborted.', 'AbortError');
  });
  const prompts: string[] = [];
  const reviewer = makePlanner({
    typedCall: typedCallPlanAndReview(
      () => planFromTasks(tasks),
      (prompt) => {
        prompts.push(prompt);
        return passingReviewVerdict(prompt);
      },
      undefined,
      () => cannotConsult(),
    ),
  });
  const wctx = makeWctx({
    ...ref,
    isolation,
    config: opts.config,
    callbacks: makeCallbacks({ onComplete: vi.fn() }).callbacks,
    bus: makeBusRecorder().bus,
    planner: reviewer,
    reviewer,
    implementer: makeImplementer(),
    signal: controller.signal,
    continuation: await resumeContinuation({
      ref,
      state,
      reviewNone,
      steer: opts.words ? plainUserMessage(WORDS) : undefined,
    }),
  });
  await runTasksAndReview({
    wctx,
    state,
    planning: { disposition: 'ready-for-tasks', state, tasks },
    summaryBase: {
      feature: 'f',
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      ...ref,
    },
    setTrackedState: vi.fn(),
    setCurrentTask: vi.fn(),
  }).catch((err: unknown) => {
    if (!controller.signal.aborted) throw err;
  });
  const latest = loadState(ref);
  const parked =
    opts.stop && latest !== null ? await parkStoppedRun(ref, latest, reviewNone) : undefined;
  return {
    parkedAt: parked?.interruptedStep?.step,
    reviewCalls: prompts.length,
    wordsInReview: prompts.some((prompt) => prompt.includes(WORDS)),
  };
}

describe('a pass Apply sent back runs on the REVIEW of its config', () => {
  it.each([
    ['a seat review, then a move to None', 'APPLY_REVIEW_START', NONE, { kind: 'apply' }],
    [
      'a None recheck, then a move to a seat',
      'APPLY_RECHECK_START',
      SEAT,
      { kind: 'review', cycle: 0 },
    ],
    ['a seat review, no move', 'APPLY_REVIEW_START', SEAT, { kind: 'review', cycle: 1 }],
    ['a None recheck, no move', 'APPLY_RECHECK_START', NONE, { kind: 'apply' }],
  ] as const)('a stop in the checks of %s parks at that pass', async (_, type, config, step) => {
    expect((await sentBack({ type, config: config(), stop: true })).parkedAt).toEqual(step);
  });

  it('hands words typed at rest to the seat review after a move from None to a seat', async () => {
    expect(
      await sentBack({ type: 'APPLY_RECHECK_START', config: SEAT(), words: true }),
    ).toMatchObject({ reviewCalls: 1, wordsInReview: true });
  });
});
