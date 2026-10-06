import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sessionDir } from '../../../src/core/paths.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { listSessions } from '../../../src/core/sessions/io.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { assertResumableState } from '../../../src/cli/sessions/resolve.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { runApply } from '../../../src/engine/orchestrator/apply/run.js';
import { closeRunIfOpen } from '../../../src/engine/orchestrator/run/close.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';

const TASKS = [
  makeTask({
    id: 'T001',
    action: 'modify',
    suggestedFiles: ['src/first.ts'],
    scope: { inBounds: ['src/first.ts'], outOfBounds: ['every other file'] },
    evidence: ['src/first.ts exports t001'],
  }),
  makeTask({
    id: 'T002',
    action: 'modify',
    suggestedFiles: ['src/second.ts'],
    dependsOn: ['T001'],
    scope: { inBounds: ['src/second.ts'], outOfBounds: ['every other file'] },
    evidence: ['src/second.ts exports t002'],
  }),
];
const ORIGINAL = {
  'src/first.ts': 'export const first = 0;\n',
  'src/second.ts': 'export const second = 0;\n',
};

type Ref = { projectDir: string; sessionId: string };
type Seen = { engine: unknown; cli: string; home: unknown };

const dirs: string[] = [];

beforeEach(() => resetAllStores());

afterEach(() => {
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

/** A process restart: nothing survives but what the run wrote to disk. */
function restart(ref: Ref): WorkflowState {
  resetAllStores();
  const state = loadState(ref);
  if (state === null) throw new Error('the run saved no state');
  return state;
}

/** How the run stands through each reader: the engine, the CLI resolve guard and the home rows. */
function seen(ref: Ref): Seen {
  const state = restart(ref);
  let cli = 'resumable';
  try {
    assertResumableState(state, ref.sessionId);
  } catch (err) {
    cli = err instanceof Error ? err.message : String(err);
  }
  const row = listSessions(ref.projectDir).find((session) => session.id === ref.sessionId);
  return {
    engine: readRunRecord(ref).status,
    cli,
    home: row === undefined ? undefined : { status: row.status, apply: row.apply, stop: row.stop },
  };
}

function expectSameStatus(ref: Ref): void {
  const state = restart(ref);
  expect(readRunRecord(ref).status).toEqual(deriveRunStatus({ state, liveness: 'not-alive' }));
}

async function runUntil(stopBeforeReview: boolean): Promise<Ref> {
  const projectDir = createTempDir('run-lifecycle-matrix');
  dirs.push(projectDir);
  createTestGitRepo(projectDir, ORIGINAL);
  const ref = { projectDir, sessionId: 'sess-lifecycle' };
  const controller = new AbortController();
  const implementer = makeImplementer({
    capabilities: { writesFiles: 'direct' },
    implement: vi.fn(async (opts: ImplementerOptions) => {
      const path = join(opts.projectDir, opts.task.suggestedFiles[0]);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `export const ${opts.task.id.toLowerCase()} = true;\n`);
      if (stopBeforeReview && opts.task.id === 'T002') controller.abort();
      return { success: true, output: 'written', usage: { inputTokens: 10, outputTokens: 5 } };
    }),
  });
  let reviewCalls = 0;
  const review = typedCallPlanAndReview(
    () => planFromTasks(TASKS),
    (prompt) => {
      reviewCalls += 1;
      return passingReviewVerdict(prompt);
    },
  );
  await runWorkflow({
    prepared: makePreparedExecution({
      ...ref,
      feature: 'two briefs, then the result',
      config: makeNoValidationConfig({
        workflow: { approve: 'none', maxRetries: 1, isolation: 'worktree' },
        approval: { feedRejectionsToPlanner: false },
      }),
    }),
    callbacks: makeCallbacks().callbacks,
    sinks: TEST_SINKS,
    eventBus: createEventBus(),
    signal: controller.signal,
    _planner: makePlanner({ typedCall: review }),
    _implementer: implementer,
  });
  expect(reviewCalls).toBe(stopBeforeReview ? 0 : 1);
  return ref;
}

const READY = {
  engine: { kind: 'ready-to-apply', override: false },
  cli: 'Run sess-lifecycle is ready to apply.\nApply with: splitbrief continue sess-lifecycle --action apply\nDiscard with: splitbrief continue sess-lifecycle --action discard',
  home: { status: 'open', apply: 'ready', stop: undefined },
};

function closed(as: 'applied' | 'discarded' | 'ended', home: Seen['home']): Seen {
  return {
    engine: { kind: 'closed', as },
    cli: `Run sess-lifecycle is closed (${as}); nothing to resume.`,
    home,
  };
}

function checkout(ref: Ref): Record<string, string> {
  return Object.fromEntries(
    Object.keys(ORIGINAL).map((file) => [file, readFileSync(join(ref.projectDir, file), 'utf8')]),
  );
}

function runPatch(ref: Ref): string {
  return readFileSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'), 'utf8');
}

describe('run lifecycle matrix', { timeout: 120_000 }, () => {
  it('pass review → ready to apply; Apply → closed applied, the checkout gets the run', async () => {
    const ref = await runUntil(false);
    expect(seen(ref)).toEqual(READY);
    expectSameStatus(ref);

    const result = await runApply({
      wctx: { ...ref, bus: createEventBus() },
      state: restart(ref),
    });

    expect(result.outcome).toBe('applied');
    expect(seen(ref)).toEqual(
      closed('applied', { status: 'complete', apply: 'applied', stop: undefined }),
    );
    expectSameStatus(ref);
    expect(checkout(ref)).toEqual({
      'src/first.ts': 'export const t001 = true;\n',
      'src/second.ts': 'export const t002 = true;\n',
    });
  });

  it('ready → Discard: closed discarded, run.patch holds the run, the checkout is untouched', async () => {
    const ref = await runUntil(false);
    const workspace = restart(ref).workspace;
    if (workspace === undefined) throw new Error('the run recorded no workspace');
    expect(workspace.kind).toBe('worktree');
    expect(seen(ref)).toEqual(READY);

    await closeRunIfOpen(ref, restart(ref), 'discarded');

    expect(seen(ref)).toEqual(
      closed('discarded', { status: 'ended', apply: 'discarded', stop: undefined }),
    );
    expectSameStatus(ref);
    expect(checkout(ref)).toEqual(ORIGINAL);
    expect(runPatch(ref)).toContain('+export const t002 = true;');
    expect(existsSync(workspace.path)).toBe(false);
  });

  it('ready → End run: a ready run closes discarded with run.patch', async () => {
    const ref = await runUntil(false);
    expect(seen(ref)).toEqual(READY);

    await closeRunIfOpen(ref, restart(ref));

    expect(seen(ref)).toEqual(
      closed('discarded', { status: 'ended', apply: 'discarded', stop: undefined }),
    );
    expectSameStatus(ref);
    expect(checkout(ref)).toEqual(ORIGINAL);
    expect(runPatch(ref)).toContain('+export const t001 = true;');
  });

  it('stopped before the review → End run: closed ended with run.patch, the checkout is untouched', async () => {
    const ref = await runUntil(true);
    const open = seen(ref);
    expect(open.engine).toMatchObject({ kind: 'open' });
    expect(open.cli).toBe('resumable');
    expect(open.home).toMatchObject({ status: 'open', apply: undefined });
    expectSameStatus(ref);

    await closeRunIfOpen(ref, restart(ref));

    expect(seen(ref)).toEqual(
      closed('ended', { status: 'ended', apply: undefined, stop: undefined }),
    );
    expectSameStatus(ref);
    expect(checkout(ref)).toEqual(ORIGINAL);
    expect(runPatch(ref)).toContain('+export const t001 = true;');
  });
});
