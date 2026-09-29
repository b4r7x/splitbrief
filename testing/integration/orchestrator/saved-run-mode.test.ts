import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { ensureSessionDir, writeSpecFile } from '../../../src/core/paths-io.js';
import { sessionDir, SPEC_FILE, PLAN_FILE } from '../../../src/core/paths.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { reactivateExistingSession } from '../../../src/core/sessions/active-pointer.js';
import { readLockfile } from '../../../src/core/sessions/lockfile.js';
import { recordRunnerPid } from '../../../src/core/sessions/runner-pids.js';
import { LOCKFILE } from '../../../src/core/paths.js';
import { readProcessStartTimeMs } from '../../../src/lib/process/start-time.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { transitionAndSave } from '../../../src/engine/orchestrator/state-ops.js';
import { readQueueForPrompt } from '../../../src/engine/orchestrator/queue/drain.js';

const dirs: string[] = [];
let trust: ReturnType<typeof useTrustHome>;
beforeEach(() => {
  trust = useTrustHome('saved-run-mode');
});
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  trust.restore();
  vi.restoreAllMocks();
});

function session(state: Partial<WorkflowState>, mode: 'quick' | 'standard' | 'speckit') {
  const projectDir = createTempDir('saved-run-mode');
  dirs.push(projectDir);
  const ref = { projectDir, sessionId: 'saved-mode' };
  ensureSessionDir(projectDir, ref.sessionId);
  const saved = {
    ...createInitialState('Add a greeting'),
    phase: 'researching' as const,
    ...state,
  };
  saveState(ref, saved);
  const prepared = makePreparedExecution({
    ...ref,
    feature: saved.feature,
    config: makeConfig({
      workflow: { mode, approve: 'default' },
      codebase: { enabled: false, tokenBudget: 4000 },
    }),
    resumeState: saved,
    active: reactivateExistingSession(ref),
  });
  return { ref, prepared };
}

/**
 * A live orphan in its own process group, holding a handshake for the test: it announces
 * readiness so the reaper can never signal it before its handler is installed, survives the
 * reaper's SIGTERM, and records that signal so the concurrent progress write lands while the
 * reaper is inside its grace window instead of racing its start.
 */
async function spawnSignalledOrphan(opts: {
  signalPath: string;
  readyPath: string;
}): Promise<number> {
  const { signalPath, readyPath } = opts;
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const { writeFileSync } = require('node:fs');
const signalPath = ${JSON.stringify(signalPath)};
process.on('SIGTERM', () => {
  try {
    writeFileSync(signalPath, '');
  } catch {}
});
writeFileSync(${JSON.stringify(readyPath)}, '');
setInterval(() => {}, 1000);`,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  if (child.pid === undefined) throw new Error('orphan reported no pid');
  await waitForPath(readyPath, 10_000);
  return child.pid;
}

/** A prior process that exited cleanly and left an exited lockfile and a runner pid behind. */
function writePriorRunnerRecord(
  ref: { projectDir: string; sessionId: string },
  orphanPid: number,
): void {
  const now = Date.now();
  writeFileSync(
    join(sessionDir(ref.projectDir, ref.sessionId), LOCKFILE),
    JSON.stringify({
      version: 1,
      pid: orphanPid,
      startTimeMs: now,
      lastAliveMs: now,
      sessionId: ref.sessionId,
      mode: 'standard',
      feature: 'Add a greeting',
      exitedAt: now,
    }),
  );
  recordRunnerPid(ref, orphanPid, readProcessStartTimeMs(orphanPid));
}

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(10);
  }
}

describe('saved run settings through resume', () => {
  it('reads progress again when the prior runner finishes during startup cleanup', async () => {
    const { ref, prepared } = session({ mode: 'standard', approve: 'all' }, 'quick');
    writeSpecFile(ref, PLAN_FILE, '# Saved plan');
    const signalPath = join(ref.projectDir, 'orphan-signalled');
    const orphanPid = await spawnSignalledOrphan({
      signalPath,
      readyPath: join(ref.projectDir, 'orphan-ready'),
    });
    try {
      writePriorRunnerRecord(ref, orphanPid);
      const { callbacks } = makeCallbacks({
        onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false, action: 'end-run' }),
      });
      const planner = makePlanner();

      const running = runWorkflow({
        prepared,
        callbacks,
        sinks: TEST_SINKS,
        _planner: planner,
        _implementer: makeImplementer(),
      });
      // The reaper is mid-grace on the orphan when the prior runner's completion lands;
      // the run has to read progress again after cleanup and see the new phase.
      await waitForPath(signalPath, 10_000);
      const midCleanup = loadState(ref);
      if (midCleanup === null) throw new Error('missing state');
      transitionAndSave(ref, midCleanup, { type: 'PLAN_DONE', tasks: [] });

      await running;
      expect(callbacks.onApprovalNeeded).toHaveBeenCalledWith('plan', expect.any(String));
      expect(planner.runPhase).not.toHaveBeenCalled();
    } finally {
      try {
        process.kill(orphanPid, 'SIGKILL');
      } catch {
        // The reaper already killed it; nothing to clean up.
      }
    }
  });

  it('uses the disk mode in resumed configuration, resolution, liveness, and summary', async () => {
    const { ref, prepared } = session(
      { phase: 'reviewing-spec', mode: 'speckit', approve: 'all' },
      'quick',
    );
    const events: EngineEvent[] = [];
    const planner = makePlanner({ isAvailable: vi.fn().mockResolvedValue(true) });
    writeSpecFile(ref, SPEC_FILE, '# Saved spec');
    const lockModes: unknown[] = [];
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false, action: 'end-run' }),
    });
    // A parked gate reopens without a planner call.
    const summary = await runWorkflow({
      prepared,
      callbacks,
      sinks: TEST_SINKS,
      _planner: planner,
      _implementer: makeImplementer(),
      _eventSink: (event) => {
        events.push(event);
        if (event.type === 'workflow_config') {
          lockModes.push(readLockfile(sessionDir(ref.projectDir, ref.sessionId))?.mode);
        }
      },
    });
    expect(lockModes).toEqual(['speckit']);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'workflow_config', mode: 'speckit' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'mode_resolved', mode: 'speckit', approve: 'all' }),
    );
    expect(summary.mode).toBe('speckit');
    expect(planner.runPhase).not.toHaveBeenCalled();
  });

  it('pins a legacy fallback on its first continue before queue reads, and keeps it on the next continue', async () => {
    const { ref, prepared } = session({}, 'standard');
    const events: EngineEvent[] = [];
    const planner = makePlanner({ isAvailable: vi.fn().mockResolvedValue(false) });
    const { callbacks } = makeCallbacks();
    await runWorkflow({
      prepared,
      callbacks,
      sinks: TEST_SINKS,
      _planner: planner,
      _implementer: makeImplementer(),
      _eventSink: (event) => events.push(event),
    });
    const pinned = loadState(ref);
    if (pinned === null) throw new Error('missing state');
    expect(pinned).toMatchObject({ mode: 'standard', approve: 'spec' });
    transitionAndSave(ref, pinned, {
      type: 'ENQUEUE_USER_MSG',
      message: {
        id: 'mode-check',
        text: 'Keep the saved plan',
        phase: pinned.phase,
        queuedAt: new Date().toISOString(),
        deliveredViaNative: false,
        nativeDeliveryState: 'pending',
      },
    });
    expect(readQueueForPrompt({ ...ref, state: pinned }).state).toMatchObject({
      mode: 'standard',
      approve: 'spec',
    });
    const next = makePreparedExecution({
      ...ref,
      feature: pinned.feature,
      config: makeConfig({ workflow: { mode: 'quick' } }),
      resumeState: pinned,
      active: prepared.session.active,
    });
    const summary = await runWorkflow({
      prepared: next,
      callbacks,
      sinks: TEST_SINKS,
      _planner: planner,
      _implementer: makeImplementer(),
    });
    expect(summary.mode).toBe('standard');
    expect(planner.runPhase).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'mode_resolved', mode: 'standard', approve: 'spec' }),
    );
  });

  it('writes regenerated artifact frontmatter in the saved mode and reuses the other artifacts', async () => {
    const { ref, prepared } = session(
      { phase: 'reviewing-spec', mode: 'standard', approve: 'spec' },
      'quick',
    );
    writeSpecFile(ref, SPEC_FILE, '# Saved spec');
    const planner = makePlanner();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockResolvedValueOnce({
          approved: false,
          action: 'revise',
          comment: 'Clarify the greeting',
        })
        .mockResolvedValueOnce({ approved: false, action: 'end-run' }),
    });
    const summary = await runWorkflow({
      prepared,
      callbacks,
      sinks: TEST_SINKS,
      _planner: planner,
      _implementer: makeImplementer(),
    });
    expect(
      readFileSync(join(sessionDir(ref.projectDir, ref.sessionId), SPEC_FILE), 'utf8'),
    ).toContain('mode: standard');
    expect(planner.regenerate).toHaveBeenCalledTimes(1);
    expect(planner.runPhase).not.toHaveBeenCalled();
    expect(summary.mode).toBe('standard');
  });
});
