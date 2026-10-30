import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { makeConfig, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { recordGitLaunches } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { readEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { runBaseTreesRoot } from '../../core/paths.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { saveState } from '../../core/state/persistence.js';
import { processError } from '../../lib/process/errors.js';
import * as commandRunner from '../../lib/process/spawn/run-command.js';
import type { EngineEvent, EngineEventOf } from '../events/types.js';
import { startBaseGate } from './base-gate.js';
import { runReviewChecks } from './review-checks.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const FILES = {
  'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
  'src/a.ts': 'export const a = 1;\n',
};
const OLD_RED = 'src/legacy.ts(3,7): error TS2322: Type number is not assignable to type string.';
const NEW_RED = 'src/a.ts(1,14): error TS2322: Type number is not assignable to type string.';

function gateState(run: ApplyRun, gate: string[]): WorkflowState {
  const state = makeImplState(
    [makeTask({ id: 'T001', status: 'done', suggestedFiles: ['src/a.ts'] })],
    {
      phase: 'implementing',
      workspace: run.workspace,
      plan: {
        summary: 'Run the project gate.',
        criteria: [],
        decisions: [],
        checks: [],
        gate,
        validation: null,
      },
    },
  );
  saveState({ projectDir: run.dir, sessionId: run.sessionId }, state);
  return state;
}

function baseRows(events: EngineEvent[]): EngineEventOf<'full_suite'>[] {
  return events.filter(
    (event): event is EngineEventOf<'full_suite'> =>
      event.type === 'full_suite' && event.moment === 'base',
  );
}

/** A command that ends only when its signal aborts, the way a killed process group ends. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

describe('startBaseGate', { timeout: 60_000 }, () => {
  it('runs each gate command at the run base, one at a time, and stores each result', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-gate-order' }, async (run) => {
      const state = gateState(run, ['npm test', 'npm run lint']);
      let running = 0;
      let most = 0;
      const ran: string[] = [];
      vi.spyOn(commandRunner, 'runCommand').mockImplementation(async (cmd, args, options) => {
        running += 1;
        most = Math.max(most, running);
        ran.push(`${[cmd, ...args].join(' ')} @ ${options?.cwd === run.ws ? 'workspace' : 'base'}`);
        await Promise.resolve();
        running -= 1;
        return { stdout: 'ok', stderr: '', code: 0 };
      });
      const { bus, events } = makeBusRecorder();
      const gate = startBaseGate({
        ref: { projectDir: run.dir, sessionId: run.sessionId },
        workspaceDir: run.ws,
        config: makeConfig(),
        bus,
        state,
        phase: () => 'implementing',
      });

      const outcomes = await Promise.all([gate?.outcome('V1'), gate?.outcome('V2')]);
      await gate?.stop();

      expect(ran).toEqual(['npm test @ base', 'npm run lint @ base']);
      expect(most).toBe(1);
      expect(outcomes.map((outcome) => outcome?.kind === 'ran' && outcome.run.status)).toEqual([
        'pass',
        'pass',
      ]);
      expect(baseRows(events).map((row) => [row.id, row.status, row.passed])).toEqual([
        ['V1', 'running', undefined],
        ['V1', 'done', true],
        ['V2', 'running', undefined],
        ['V2', 'done', true],
      ]);
      expect(
        readEvidenceLedger({ projectDir: run.dir, sessionId: run.sessionId })?.commandRuns?.map(
          (entry) => [entry.tree, entry.command],
        ),
      ).toEqual([
        ['run-base', 'npm test'],
        ['run-base', 'npm run lint'],
      ]);
      expect(
        readdirSync(runBaseTreesRoot()).filter((name) => name.startsWith(`base-${process.pid}-`)),
      ).toEqual([]);
    });
  });

  it('makes no base tree when every gate command has a stored run base result', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-gate-stored' }, async (run) => {
      const state = gateState(run, ['npm test']);
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      const runCommand = vi
        .spyOn(commandRunner, 'runCommand')
        .mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });
      const first = startBaseGate({
        ref,
        workspaceDir: run.ws,
        config: makeConfig(),
        bus: makeBusRecorder().bus,
        state,
        phase: () => 'implementing',
      });
      await first?.outcome('V1');
      await first?.stop();
      runCommand.mockClear();

      const { bus, events } = makeBusRecorder();
      const launches = recordGitLaunches();
      let outcome: Awaited<ReturnType<NonNullable<typeof first>['outcome']>> | undefined;
      try {
        const second = startBaseGate({
          ref,
          workspaceDir: run.ws,
          config: makeConfig(),
          bus,
          state,
          phase: () => 'implementing',
        });
        outcome = await second?.outcome('V1');
        await second?.stop();
        expect(launches.launches()).toEqual([]);
      } finally {
        launches.restore();
      }

      expect(runCommand).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        kind: 'ran',
        run: { status: 'pass', reusedAt: expect.any(String) },
      });
      expect(baseRows(events)).toEqual([]);
    });
  });

  it('starts no base run with End-of-run checks off, with no gate, or with no run base', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-gate-none' }, async (run) => {
      const { workspace: _workspace, ...noBase } = gateState(run, ['npm test']);
      const start = (state: WorkflowState, config = makeConfig()) =>
        startBaseGate({
          ref: { projectDir: run.dir, sessionId: run.sessionId },
          workspaceDir: run.ws,
          config,
          bus: makeBusRecorder().bus,
          state,
          phase: () => 'implementing',
        });

      expect(start(gateState(run, ['npm test']), makeNoValidationConfig())).toBeUndefined();
      expect(start(gateState(run, []))).toBeUndefined();
      expect(start(noBase)).toBeUndefined();
    });
  });

  it('cuts the running base command on stop, settles only its row stopped, and stores nothing', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-gate-stop' }, async (run) => {
      const state = gateState(run, ['npm test', 'npm run lint']);
      const started = Promise.withResolvers<void>();
      vi.spyOn(commandRunner, 'runCommand').mockImplementation(async (_cmd, _args, options) => {
        started.resolve();
        return untilAborted(options?.signal);
      });
      const { bus, events } = makeBusRecorder();
      const gate = startBaseGate({
        ref: { projectDir: run.dir, sessionId: run.sessionId },
        workspaceDir: run.ws,
        config: makeConfig(),
        bus,
        state,
        phase: () => 'implementing',
      });
      await started.promise;

      await gate?.stop();

      expect(baseRows(events).map((row) => [row.id, row.status])).toEqual([
        ['V1', 'running'],
        ['V1', 'stopped'],
      ]);
      expect(await gate?.outcome('V2')).toEqual({
        kind: 'unavailable',
        reason: 'the run stopped before it finished',
      });
      expect(
        readEvidenceLedger({ projectDir: run.dir, sessionId: run.sessionId })?.commandRuns ?? [],
      ).toEqual([]);
      expect(
        readdirSync(runBaseTreesRoot()).filter((name) => name.startsWith(`base-${process.pid}-`)),
      ).toEqual([]);
    });
  });

  it('lets the review wait for a base command that has not finished, and never run it again', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-gate-wait' }, async (run) => {
      const state = { ...gateState(run, ['npm run typecheck']), phase: 'final-review' as const };
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      const baseStarted = Promise.withResolvers<void>();
      const baseRelease = Promise.withResolvers<void>();
      const workspaceRan = Promise.withResolvers<void>();
      const ran: string[] = [];
      vi.spyOn(commandRunner, 'runCommand').mockImplementation(async (cmd, args, options) => {
        const at = options?.cwd === run.ws ? 'workspace' : 'base';
        ran.push(at);
        if (at === 'base') {
          baseStarted.resolve();
          await baseRelease.promise;
        } else workspaceRan.resolve();
        throw processError.exitCode({
          command: [cmd, ...args].join(' '),
          code: 1,
          stderr: '',
          output: at === 'base' ? OLD_RED : `${OLD_RED}\n${NEW_RED}`,
        });
      });
      const { bus, events } = makeBusRecorder();
      const gate = startBaseGate({
        ref,
        workspaceDir: run.ws,
        config: makeConfig(),
        bus,
        state,
        phase: () => state.phase,
      });

      const review = runReviewChecks({
        projectDir: run.dir,
        workspaceDir: run.ws,
        sessionId: run.sessionId,
        config: makeConfig(),
        bus,
        state,
        signal: undefined,
        baseGate: gate,
      });
      // The base command is still running when the workspace run turns red.
      await Promise.all([baseStarted.promise, workspaceRan.promise]);
      baseRelease.resolve();
      const outcome = await review;
      await gate?.stop();

      expect(ran.toSorted()).toEqual(['base', 'workspace']);
      const done = events.filter(
        (event): event is EngineEventOf<'full_suite'> =>
          event.type === 'full_suite' && event.status === 'done',
      );
      expect(done.map((row) => [row.moment, row.passed])).toEqual([
        ['base', false],
        ['pre-review', false],
      ]);
      expect(done[1]).toMatchObject({ newFailures: 1, preExisting: 1 });
      expect(outcome).toMatchObject({
        preExistingChecks: [{ id: 'V1', command: 'npm run typecheck', keys: [OLD_RED] }],
      });
    });
  });
});
