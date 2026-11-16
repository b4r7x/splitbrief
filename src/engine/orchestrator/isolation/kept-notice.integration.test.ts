import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { debugLogEntries, enableDebugLog } from '#testing/helpers/debug-log.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeAttemptBrief } from '#testing/helpers/factories/attempt-brief.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createRunIsolation } from './create.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { taskId } from '../../../core/schemas/task.js';
import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import { WORKSPACE_KEPT_CODE } from '../../../core/sessions/workspace-notice.js';
import { resetLoggerForTests } from '../../../lib/logger.js';
import { publishRetainedWorkspaceNotice } from './kept-notice.js';
import { readWorkspaceRecord } from './retention.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('retained workspace handoff', () => {
  it.each(['stop', 'failure', 'ready', 'closed', 'not-retained', 'no-workspace'] as const)(
    'publishes a successful retention notice only for a continuable %s',
    async (outcome) => {
      const projectDir = createTempDir('retention-handoff');
      dirs.push(projectDir);
      writeFileSync(join(projectDir, 'source.txt'), 'original\n');
      const ref = { projectDir, sessionId: 'retention-handoff' };
      const isolation = createRunIsolation({
        ...ref,
        strategy: 'staged-copy',
        onFallback: () => {},
      });
      const workspace = await isolation.acquire({
        role: 'implementer',
        config: makeConfig(),
        brief: makeAttemptBrief(),
      });
      if (outcome !== 'not-retained') await workspace.retain?.();
      await isolation.dispose();
      const record = await readWorkspaceRecord(ref);
      expect(record?.retained).toBe(outcome !== 'not-retained');
      const state = makeImplState([], {
        ...(outcome !== 'no-workspace' && {
          workspace: {
            kind: 'staged-copy',
            path: workspace.projectDir,
            base: { snapshotId: 'workspace-base', head: null },
          },
        }),
        ...(outcome === 'failure' && {
          lastFailure: {
            message: 'call failed',
            step: { kind: 'review', cycle: 0 },
            at: '2026-10-10T00:00:00.000Z',
          },
        }),
        ...(outcome === 'ready' && { phase: 'complete', reviewStatus: 'passed' }),
        ...(outcome === 'closed' && { closed: { as: 'ended', at: '2026-10-10T00:00:00.000Z' } }),
      });
      const { bus, events } = makeBusRecorder();
      await publishRetainedWorkspaceNotice({ ...ref, state, bus });
      const notices = events.flatMap((event) =>
        event.type === 'warning' ? [{ message: event.message, code: event.code }] : [],
      );
      expect(notices).toEqual(
        outcome === 'stop' || outcome === 'failure'
          ? [
              {
                message: `Workspace kept at ${workspace.projectDir} for Continue, with its private CLI state and caches.`,
                code: WORKSPACE_KEPT_CODE,
              },
            ]
          : [],
      );
    },
  );
});

describe('retained workspace notice after a stop', () => {
  afterEach(() => {
    resetLoggerForTests();
  });

  async function retainedState(sessionId: string, fields: Partial<WorkflowState>) {
    const projectDir = createTempDir('retention-notice');
    dirs.push(projectDir);
    writeFileSync(join(projectDir, 'source.txt'), 'original\n');
    const ref = { projectDir, sessionId };
    const isolation = createRunIsolation({ ...ref, strategy: 'staged-copy', onFallback: () => {} });
    const workspace = await isolation.acquire({
      role: 'implementer',
      config: makeConfig(),
      brief: makeAttemptBrief(),
    });
    await workspace.retain?.();
    await isolation.dispose();
    const state = makeImplState([], {
      workspace: {
        kind: 'staged-copy',
        path: workspace.projectDir,
        base: { snapshotId: 'workspace-base', head: null },
      },
      ...fields,
    });
    enableDebugLog(projectDir);
    return { ref, state, workspaceDir: workspace.projectDir };
  }

  it('writes the kept notice of a stop the user asked for to the debug log, not the bus', async () => {
    const { ref, state, workspaceDir } = await retainedState('retention-user-stop', {
      interruptedStep: {
        step: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
        source: 'user',
        cut: 'mid-step',
        at: '2026-10-10T00:00:00.000Z',
      },
    });
    expect(deriveRunStatus({ reviewNone: false, state, liveness: 'not-alive' })).toMatchObject({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'paused' } },
    });
    const { bus, events } = makeBusRecorder();

    await publishRetainedWorkspaceNotice({ ...ref, state, bus });

    expect(events.filter((event) => event.type === 'warning')).toEqual([]);
    expect(debugLogEntries(ref.projectDir, 'engine', WORKSPACE_KEPT_CODE)).toEqual([
      {
        message: `Workspace kept at ${workspaceDir} for Continue, with its private CLI state and caches.`,
      },
    ]);
  });

  it('keeps the kept notice of a halt on the bus as a warning', async () => {
    const { ref, state, workspaceDir } = await retainedState('retention-halt', {
      pendingRecovery: makeRecoveryIssue(),
    });
    expect(deriveRunStatus({ reviewNone: false, state, liveness: 'not-alive' })).toMatchObject({
      kind: 'open',
      stop: { kind: 'waiting-for-you', on: { kind: 'halt' } },
    });
    const { bus, events } = makeBusRecorder();

    await publishRetainedWorkspaceNotice({ ...ref, state, bus });

    expect(
      events.flatMap((event) =>
        event.type === 'warning' ? [{ message: event.message, code: event.code }] : [],
      ),
    ).toEqual([
      {
        message: `Workspace kept at ${workspaceDir} for Continue, with its private CLI state and caches.`,
        code: WORKSPACE_KEPT_CODE,
      },
    ]);
  });
});
