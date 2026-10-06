import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ValidationStage } from '../../../core/schemas/enums.js';
import type { Check } from '../../../core/schemas/task.js';
import type { EvidenceCheckEntry } from '../../../core/schemas/evidence.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { validateAndCommit } from '../escalation/validate-and-commit.js';
import type { EscalationContext } from '../escalation/types.js';
import { decideValidationAcceptance } from '../validation/acceptance.js';
import type { Validator } from '../validation/types.js';
import { runTaskChecksAfterAcceptance } from './task-checks.js';

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
    primeBaseline: vi.fn().mockResolvedValue(undefined),
    runFullSuite: vi
      .fn()
      .mockResolvedValue({ results: [], failures: {}, newFailures: {}, stages: {} }),
    runValidation: vi.fn().mockResolvedValue([{ stage: 'test' as const, passed: true }]),
    decideAcceptance: ({ results, changedFiles }) =>
      decideValidationAcceptance({
        results,
        changedFiles,
        baselineFailingStages: new Set<ValidationStage>(),
      }),
  };
}

async function makeEscalationCtx(opts: {
  projectDir: string;
  sessionId: string;
  validator: Validator;
}): Promise<EscalationContext> {
  const { bus } = makeBusRecorder();
  return {
    ...makeWctx({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      bus,
      validator: opts.validator,
    }),
    taskStartSnapshot: await getChangedFilesSnapshot(opts.projectDir),
    dependsOnFiles: [],
  };
}

describe('runTaskChecksAfterAcceptance', () => {
  it('runs and records a task checks once on the accepted first attempt', async () => {
    const { projectDir, sessionId } = setup('task-checks-first');
    const task = makeTask({ id: 'T001', checks: versionCheck() });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx({ projectDir, sessionId, bus });

    const result = await runTaskChecksAfterAcceptance({ wctx, state, task });

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

    const result = await runTaskChecksAfterAcceptance({ wctx, state, task });

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
