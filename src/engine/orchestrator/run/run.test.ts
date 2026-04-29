import { describe, it, expect, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { Config } from '../../../core/schemas/config.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { readActive, writeActive } from '../../../core/sessions/lifecycle.js';
import { simpleGit } from 'simple-git';
import { runWorkflow, WORKFLOW_REWIND_ABORT_REASON } from './run.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): string {
  const projectDir = createTempDir('run-workflow-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  return projectDir;
}

// An "agent" planner whose command does not exist — planner.isAvailable() returns false,
// letting us observe the "planner unavailable" boundary of runWorkflow without spawning
// a real planning subprocess.
function unavailablePlannerConfig(): Config {
  return makeConfig({
    planner: {
      kind: 'agent',
      command: '/definitely/does/not/exist/plannerbin',
    },
    validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    workflow: { autoApproveSpec: true, autoApprovePlan: true, commitStrategy: 'none', mode: 'quick', persistTranscript: false },
  });
}

describe('runWorkflow — smoke', () => {
  it('returns a summary without throwing when the configured planner is unavailable', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];
    const config = unavailablePlannerConfig();

    const summary = await runWorkflow({
      feature: 'add auth',
      projectDir,
      config,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
    });

    // The entry point produces a Summary even when planner is not available.
    expect(summary).toBeDefined();
    expect(summary.feature).toBe('add auth');
    expect(summary.totalTasks).toBe(0);

    // An error event was emitted explaining the missing planner to the user.
    const errorEvent = events.find((e): e is Extract<EngineEvent, { type: 'error' }> => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toMatch(/not available/i);

    // onComplete is NOT called on the unavailable-planner path (unlike the happy path
    // where runFinalReviewPhase invokes it). This is the observable early-return contract.
    const onComplete = callbacks.onComplete as ReturnType<typeof import('vitest').vi.fn>;
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('short-circuits before emitting workflow-config when the planner is unavailable', async () => {
    // The workflow-config / user-message events are part of the initialisation happy
    // path. The observable contract on the unavailable-planner boundary is that NONE
    // of those initialisation events fire — only the error event does.
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];
    const config = unavailablePlannerConfig();

    await runWorkflow({
      feature: 'observable-config',
      projectDir,
      config,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
    });

    expect(events.find((e) => e.type === 'workflow_config')).toBeUndefined();
    expect(events.find((e) => e.type === 'user_message')).toBeUndefined();
    expect(events.find((e) => e.type === 'error')).toBeDefined();
  });

  it('uses the explicit sessionId when provided and creates the session directory', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const config = unavailablePlannerConfig();

    await runWorkflow({
      feature: 'session-initialised',
      projectDir,
      config,
      callbacks,
      sessionId: 'explicit-sid',
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    });

    // ensureSessionDir is called during init before the isAvailable check — verify it
    // created the explicit session directory on disk.
    const { existsSync } = await import('node:fs');
    const { sessionDir } = await import('../../../core/paths.js');
    expect(existsSync(sessionDir(projectDir, 'explicit-sid'))).toBe(true);
  });

  it('publishes workflow events to an externally owned event bus', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const config = unavailablePlannerConfig();
    const bus = createEventBus();
    const events: EngineEvent[] = [];
    bus.subscribe((event) => events.push(event));

    await runWorkflow({
      feature: 'detached-stream',
      projectDir,
      config,
      callbacks,
      eventBus: bus,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    });

    expect(events.find((event) => event.type === 'error')).toBeDefined();
  });

  it('skips most of the flow when the AbortSignal is aborted before planning completes and still returns a Summary', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();

    // This planner IS available (echo exists on macOS/linux) — but we pre-abort.
    // When `isAvailable()` passes but `signal.aborted` is true by the time planning
    // returns, the phases short-circuit and runWorkflow still produces a summary.
    const config = makeConfig({
      planner: { kind: 'agent', command: 'echo', args: ['done'] },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        autoApproveSpec: true,
        autoApprovePlan: true,
        commitStrategy: 'none',
        mode: 'quick',
        persistTranscript: false,
      },
    });

    const controller = new AbortController();
    controller.abort();

    const summary = await runWorkflow({
      feature: 'aborted-before-start',
      projectDir,
      config,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
    });

    expect(summary).toBeDefined();
    expect(summary.feature).toBe('aborted-before-start');
  });

  it('preserves the active session when a rewind-triggered abort finishes the old run', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const sessionId = 'explicit-rewind-sid';
    const config = makeConfig({
      planner: { kind: 'agent', command: 'echo', args: ['done'] },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        autoApproveSpec: true,
        autoApprovePlan: true,
        commitStrategy: 'none',
        mode: 'quick',
        persistTranscript: false,
      },
    });
    const controller = new AbortController();
    controller.abort(WORKFLOW_REWIND_ABORT_REASON);
    writeActive(projectDir, sessionId);

    await runWorkflow({
      feature: 'rewind-active',
      projectDir,
      config,
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
    });

    expect(readActive(projectDir)).toBe(sessionId);
  });

  it('clears the active session for a normal aborted run', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const sessionId = 'explicit-normal-abort-sid';
    const config = makeConfig({
      planner: { kind: 'agent', command: 'echo', args: ['done'] },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        autoApproveSpec: true,
        autoApprovePlan: true,
        commitStrategy: 'none',
        mode: 'quick',
        persistTranscript: false,
      },
    });
    const controller = new AbortController();
    controller.abort();
    writeActive(projectDir, sessionId);

    await runWorkflow({
      feature: 'normal-abort-active',
      projectDir,
      config,
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
    });

    expect(readActive(projectDir)).toBeNull();
  });
});

describe('runWorkflow — createBranch', () => {
  it('creates diptych/<slug> branch when git.createBranch is enabled', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];
    const controller = new AbortController();
    controller.abort();

    const config = makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { git: { createBranch: true, commitStrategy: 'none' }, mode: 'quick', persistTranscript: false },
    });

    await runWorkflow({
      feature: 'add auth',
      projectDir,
      config,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner(),
      signal: controller.signal,
    });

    const branchEvent = events.find((e): e is Extract<EngineEvent, { type: 'git_branch_created' }> => e.type === 'git_branch_created');
    expect(branchEvent).toBeDefined();
    expect(branchEvent?.name).toBe('diptych/add-auth');

    const g = simpleGit(projectDir);
    const status = await g.status();
    expect(status.current).toBe('diptych/add-auth');
  });

  it('does not create a branch when git.createBranch is false', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];
    const controller = new AbortController();
    controller.abort();

    const config = makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { git: { createBranch: false, commitStrategy: 'none' }, mode: 'quick', persistTranscript: false },
    });

    const g = simpleGit(projectDir);
    const statusBefore = await g.status();
    const defaultBranch = statusBefore.current ?? 'main';

    await runWorkflow({
      feature: 'add auth',
      projectDir,
      config,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner(),
      signal: controller.signal,
    });

    expect(events.find((e) => e.type === 'git_branch_created')).toBeUndefined();
    const statusAfter = await g.status();
    expect(statusAfter.current).toBe(defaultBranch);
  });
});
