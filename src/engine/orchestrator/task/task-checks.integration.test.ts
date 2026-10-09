import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Check } from '../../../core/schemas/task.js';
import type { EvidenceCheckEntry } from '../../../core/schemas/evidence.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { validateAndCommit } from '../escalation/validate-and-commit.js';
import type { EscalationContext } from '../escalation/types.js';
import type { ValidationCommandRunner, Validator } from '../validation/types.js';
import { makeConfig, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { saveState } from '../../../core/state/persistence.js';
import { processError } from '../../../lib/process/errors.js';
import type { EngineEventOf } from '../../events/types.js';
import { runTaskChecks } from './task-checks.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function setup(prefix: string): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix,
    sessionId: `sess-${prefix}`,
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function recordedChecks(projectDir: string, sessionId: string): EvidenceCheckEntry[] {
  return readEvidenceLedger({ projectDir, sessionId })?.tasks[0]?.checks ?? [];
}

function versionCheck(): Check[] {
  return [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }];
}

function acceptingValidator(): Validator {
  return {
    formatChangedFiles: vi.fn().mockResolvedValue(undefined),
  };
}

async function makeEscalationCtx(opts: {
  projectDir: string;
  sessionId: string;
  validator: Validator;
}): Promise<EscalationContext> {
  const { bus } = makeBusRecorder();
  return {
    taskStartTime: Date.now(),
    ...makeWctx({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      bus,
      validator: opts.validator,
      config: makeNoValidationConfig({ workflow: { review: 'task' } }),
    }),
    taskStartSnapshot: await getChangedFilesSnapshot(opts.projectDir),
    dependsOnFiles: [],
  };
}

describe('runTaskChecks', () => {
  it('runs and records a task checks once on the accepted first attempt', async () => {
    const { projectDir, sessionId } = setup('task-checks-first');
    const task = makeTask({ id: 'T001', checks: versionCheck() });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx({ projectDir, sessionId, bus });

    const result = await runTaskChecks({
      wctx,
      state,
      task,
      checkIds: (task.checks ?? []).map((check) => check.id),
    });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.status).toBe('pass');
    expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'K1', passed: true }]);
    expect(events.filter((event) => event.type === 'checks_run')).toHaveLength(1);
    expect(recordedChecks(projectDir, sessionId).map((entry) => entry.id)).toEqual(['K1']);
  });

  it('leaves a task without checks unchanged', async () => {
    const { projectDir, sessionId } = setup('task-checks-none');
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx({ projectDir, sessionId, bus });

    const result = await runTaskChecks({
      wctx,
      state,
      task,
      checkIds: (task.checks ?? []).map((check) => check.id),
    });

    expect(result.runs).toEqual([]);
    expect(result.state).toBe(state);
    expect(events).toHaveLength(0);
  });

  it('runs and records the checks once when a local retry is accepted', async () => {
    const { projectDir, sessionId } = setup('task-checks-retry');
    const task = makeTask({ id: 'T002', checks: versionCheck() });
    const ctx = await makeEscalationCtx({
      projectDir,
      sessionId,
      validator: acceptingValidator(),
    });

    const result = await validateAndCommit({
      ctx,
      task,
      state: makeImplState([task]),
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
      preApprovedChangedFiles: [task.suggestedFiles[0]],
    });

    expect(result.completed).toBe(true);
    expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'K1', passed: true }]);
    const retryChecks = recordedChecks(projectDir, sessionId).filter((entry) => entry.id === 'K1');
    expect(retryChecks).toHaveLength(1);
  });
});

describe('runTaskChecks for a fix task that answers a reviewer check', { timeout: 60_000 }, () => {
  const FILES = {
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    'src/a.ts': 'export const a = 1;\n',
  };
  const NEW_RED = 'src/a.ts(1,14): error TS2322: Type number is not assignable to type string.';
  const OLD_RED = 'src/legacy.ts(3,7): error TS2322: Type number is not assignable to type string.';

  /** Runs the fix task's K1 and the V1 it answers; `red` answers `npm test` in each place. */
  async function fixChecks(run: ApplyRun, red: (at: 'workspace' | 'base') => string | null) {
    const task = makeTask({
      id: 'T002',
      checks: versionCheck(),
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'V1.1',
            text: 'Reviewer check V1 (npm test) failed with new failures.',
            acceptance: null,
            file: 'src/a.ts',
            checkIds: ['V1'],
            commands: { V1: 'npm test' },
            output: NEW_RED,
          },
        ],
      },
    });
    const state = makeImplState([task], { workspace: run.workspace });
    const ref = { projectDir: run.dir, sessionId: run.sessionId };
    saveState(ref, state);
    const runCommand: ValidationCommandRunner = async (cmd, args, options) => {
      const command = [cmd, ...args].join(' ');
      const output =
        command === 'npm test' ? red(options?.cwd === run.ws ? 'workspace' : 'base') : null;
      if (output === null) return { stdout: 'ok', stderr: '', code: 0 };
      throw processError.exitCode({ command, code: 1, stderr: '', output });
    };
    const { bus, events } = makeBusRecorder();
    const result = await runTaskChecks({
      wctx: makeWctx({ ...ref, workspaceDir: run.ws, bus, config: makeConfig() }),
      state,
      task,
      checkIds: ['K1', 'V1'],
      runCommand,
    });
    const rows = events.filter(
      (event): event is EngineEventOf<'full_suite'> => event.type === 'full_suite',
    );
    return { result, rows, events };
  }

  // Q2 review B2: the re-run had no row and no clock, and only an orphan base row showed.
  it('gives the fix check its own row and clock, then splits its red at the run base', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-rows' }, async (run) => {
      const { result, rows } = await fixChecks(run, (at) =>
        at === 'workspace' ? `${NEW_RED}\n${OLD_RED}` : OLD_RED,
      );

      expect(
        rows.map((row) => [
          row.id,
          row.moment,
          row.status,
          row.passed,
          row.newFailures,
          row.preExisting,
        ]),
      ).toEqual([
        ['V1', 'brief', 'running', undefined, undefined, undefined],
        ['V1', 'brief', 'done', false, undefined, undefined],
        ['V1', 'base', 'running', undefined, undefined, undefined],
        ['V1', 'base', 'done', false, 1, 1],
      ]);
      expect(rows.every((row) => row.phase === 'implementing' && row.command === 'npm test')).toBe(
        true,
      );
      expect(rows[1]?.duration).toEqual(expect.any(Number));
      expect(result.runs.map((entry) => [entry.checkId, entry.status])).toEqual([
        ['K1', 'pass'],
        ['V1', 'fail'],
      ]);
      expect(result.settled.has('V1')).toBe(false);
    });
  });

  it('settles a fix check whose every failure is also red at the run base', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-settled' }, async (run) => {
      const { result, rows } = await fixChecks(run, () => OLD_RED);

      expect(rows.at(-1)).toMatchObject({
        moment: 'base',
        status: 'done',
        passed: false,
        newFailures: 0,
        preExisting: 1,
      });
      expect(result.settled.has('V1')).toBe(true);
    });
  });

  it('records a settled fix check as passed while preserving its red command evidence', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-recorded' }, async (run) => {
      const { result, events } = await fixChecks(run, () => OLD_RED);

      expect(result.state.tasks[0]?.checkResults).toEqual([
        { id: 'K1', passed: true },
        { id: 'V1', passed: true },
      ]);
      expect(events.filter((event) => event.type === 'checks_run')).toEqual([
        expect.objectContaining({
          results: [
            { id: 'K1', passed: true },
            { id: 'V1', passed: true },
          ],
        }),
      ]);
      expect(
        recordedChecks(run.dir, run.sessionId).find((check) => check.id === 'V1'),
      ).toMatchObject({ exitCode: 1, output: OLD_RED });
    });
  });

  it('publishes a refused fix check with its reason and runs nothing at the run base', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-refused' }, async (run) => {
      writeFileSync(
        join(run.ws, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run --passWithNoTests' } }),
      );
      const { rows } = await fixChecks(run, () => null);

      expect(rows.map((row) => [row.id, row.moment, row.status])).toEqual([
        ['V1', 'brief', 'running'],
        ['V1', 'brief', 'refused'],
      ]);
      expect(rows[1]?.detail).toEqual(expect.stringContaining('which this run changed'));
    });
  });
});
