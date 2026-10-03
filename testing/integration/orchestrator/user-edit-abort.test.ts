import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makeImplementer,
  makePlanner,
  makeWctx,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { saveState, loadState } from '../../../src/core/state/persistence.js';
import { reactivateExistingSession } from '../../../src/core/sessions/active-pointer.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import {
  captureChangedFilesBaseline,
  serializeChangedFilesBaseline,
} from '../../../src/engine/orchestrator/changed-files-baseline.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { runTaskLoop } from '../../../src/engine/orchestrator/task/loop.js';
import { closeRunIfOpen } from '../../../src/engine/orchestrator/run/close.js';
import { commitWorkflowState } from '../../../src/engine/orchestrator/state-ops.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function runUserEditAnswer(
  answer: 'abort-workflow' | 'pause' | 'continue-unrelated',
  opts: { race?: 'end' | 'complete' } = {},
) {
  const projectDir = createTempDir('user-edit-abort');
  dirs.push(projectDir);
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, 'src/future.ts'), 'before\n');
  const sessionId = 'user-edit-answer';
  const ref = { projectDir, sessionId };
  ensureSessionDir(projectDir, sessionId);
  const baseline = await captureChangedFilesBaseline(projectDir);
  const state = makeImplState(
    [
      makeTask({ id: 'T001', file: 'src/current.ts' }),
      makeTask({ id: 'T002', file: 'src/future.ts' }),
    ],
    {
      mode: 'quick',
      approve: 'none',
      changedFilesBaseline: serializeChangedFilesBaseline(baseline),
    },
  );
  saveState(ref, state);
  writeFileSync(join(projectDir, 'src/future.ts'), 'operator edit\n');
  const config = makeNoValidationConfig({
    approval: { enabled: false, feedRejectionsToPlanner: true },
    workflow: {
      isolation: 'staged-copy',
    },
  });
  const prepared = makePreparedExecution({
    ...ref,
    feature: state.feature,
    resumeState: state,
    active: reactivateExistingSession(ref),
    config,
  });
  const implementer = makeImplementer();
  let revisionAtAnswer = 0;
  const onUserEditConflict = async () => {
    const current = loadState(ref);
    if (!current) throw new Error('missing state at user-edit question');
    revisionAtAnswer = current.stateRevision ?? 0;
    if (opts.race === 'end') closeRunIfOpen(ref, current);
    if (opts.race === 'complete') {
      const committed = commitWorkflowState({
        ref,
        expected: current,
        next: {
          ...current,
          phase: 'complete',
          reviewStatus: 'passed',
          completedAt: new Date().toISOString(),
        },
      });
      if (committed.kind !== 'committed') throw new Error('completion race did not commit');
    }
    return answer;
  };
  const events: EngineEvent[] = [];
  const summary = await runWorkflow({
    prepared,
    callbacks: makeCallbacks({ onUserEditConflict }).callbacks,
    sinks: TEST_SINKS,
    _planner: makePlanner(),
    _implementer: implementer,
    _eventSink: (event) => events.push(event),
  });
  return {
    ref,
    summary,
    events,
    persisted: loadState(ref),
    revisionAtAnswer,
    replay: (await readRunEvents(ref)).events,
  };
}

describe('user-edit question answer', () => {
  it('ends the run on abort without offering a second recovery decision', async () => {
    const result = await runUserEditAnswer('abort-workflow');

    expect(result.events.filter((event) => event.type === 'task_started')).toHaveLength(0);
    expect(result.persisted?.closed?.as).toBe('ended');
    expect(result.persisted?.pendingRecovery).toBeUndefined();
    expect(result.summary.phase).toBe('implementing');
    expect(readRunRecord(result.ref)?.status).toEqual({ kind: 'closed', as: 'ended' });
    expect(result.events.filter((event) => event.type === 'paused_external_changes')).toMatchObject(
      [{ selectedAction: 'abort-workflow' }],
    );
    expect(result.events.filter((event) => event.type === 'recovery_prompted')).toHaveLength(0);
    expect(result.events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(1);
    expect(result.replay.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(1);
    expect(result.persisted?.stateRevision).toBe(result.revisionAtAnswer + 1);
  });

  it('ends after a brief without writing task metadata after the close', async () => {
    const projectDir = createTempDir('user-edit-post-task-abort');
    dirs.push(projectDir);
    execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
    mkdirSync(join(projectDir, 'src'));
    writeFileSync(join(projectDir, 'src/future.ts'), 'before\n');
    const sessionId = 'post-task-answer';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const baseline = await captureChangedFilesBaseline(projectDir);
    const state = makeImplState(
      [
        makeTask({ id: 'T001', file: 'src/current.ts' }),
        makeTask({ id: 'T002', file: 'src/future.ts' }),
      ],
      { changedFilesBaseline: serializeChangedFilesBaseline(baseline) },
    );
    saveState(ref, state);
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn(async ({ task, projectDir: runDir }) => {
        if (task.id === 'T001') {
          writeFileSync(join(runDir, 'src/current.ts'), 'worker output\n');
          writeFileSync(join(projectDir, 'src/future.ts'), 'operator edit\n');
        }
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { bus, events } = makeBusRecorder();
    let revisionAtAnswer = 0;
    const onUserEditConflict = async () => {
      revisionAtAnswer = loadState(ref)?.stateRevision ?? 0;
      return 'abort-workflow' as const;
    };
    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          approval: { enabled: false, feedRejectionsToPlanner: true },
          workflow: { isolation: 'staged-copy' },
        }),
        callbacks: makeCallbacks({ onUserEditConflict }).callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(events.filter((event) => event.type === 'paused_external_changes')).toMatchObject([
      { selectedAction: 'abort-workflow' },
    ]);
    expect(events.filter((event) => event.type === 'task_started')).toHaveLength(1);
    expect(result.status).toBe('cancelled');
    expect(result.state.closed?.as).toBe('ended');
    expect(loadState(ref)?.stateRevision).toBe(revisionAtAnswer + 1);
    expect(events.filter((event) => event.type === 'recovery_prompted')).toHaveLength(0);
  });

  it.each(['end', 'complete'] as const)(
    'does not replace a terminal %s that wins while the question is open',
    async (race) => {
      const result = await runUserEditAnswer('abort-workflow', { race });

      expect(result.persisted?.stateRevision).toBe(result.revisionAtAnswer + 1);
      expect(readRunRecord(result.ref)?.status).toEqual({
        kind: 'closed',
        as: race === 'end' ? 'ended' : 'complete',
      });
      expect(result.events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(0);
      expect(result.replay.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(0);
    },
  );

  it('keeps the existing pause and continue answers distinct', async () => {
    const paused = await runUserEditAnswer('pause');
    expect(paused.persisted?.closed).toBeUndefined();
    expect(paused.persisted?.pendingRecovery?.reason).toBe('user-edit-conflict');
    expect(paused.events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(0);

    const continued = await runUserEditAnswer('continue-unrelated');
    expect(
      continued.events.filter((event) => event.type === 'paused_external_changes'),
    ).toMatchObject([{ selectedAction: 'continue-unrelated' }]);
    expect(continued.events.filter((event) => event.type === 'recovery_prompted')).toHaveLength(0);
  });
});
