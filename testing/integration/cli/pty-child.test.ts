import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { AppProps } from '../../../src/app/root.js';
import { createDefaultConfig } from '../../../src/core/config/load/defaults.js';
import { PLAN_FILE, PLAN_JSON_FILE, sessionDir } from '../../../src/core/paths.js';
import { PlanProposalSchema, PlanSchema } from '../../../src/core/schemas/plan.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import type {
  OrchestratorCallbacks,
  WorkflowSinks,
} from '../../../src/engine/orchestrator/types.js';
import {
  abortTurn,
  clearAllHandlers,
  consumeBoundaryInterrupt,
  consumeBoundaryPause,
  createAbortHandlerScope,
  requestQuit,
  setCancelHandler,
  setQueueHandler,
} from '../../../src/features/workflow/handlers.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { stopStore } from '../../../src/stores/workflow/stop.js';
import { PTY_REVIEW_SESSION_ID, parsePtyChildArgs, runPtyChild } from './pty/child.js';
import {
  PTY_ACTIVE_REVIEW_MARKER,
  PTY_APPROVED_MARKER,
  PTY_CHILD_PROJECT_ENV,
  PTY_EDITOR_FINISHED_MARKER,
  PTY_EDITOR_SENTINEL_ENV,
  PTY_EDITOR_STARTED_MARKER,
} from './pty/contract.js';
import { runEditorChild } from './pty/editor-child.js';

afterEach(() => {
  clearAllHandlers();
  stopStore.__testReset();
  vi.restoreAllMocks();
});

function renderedWorkflow(element: ReactElement<AppProps>) {
  const runWorkflow = element.props.workflowDeps?.runWorkflow;
  if (runWorkflow === undefined) throw new Error('PTY child rendered without a workflow runner');
  return runWorkflow;
}

function workflowOptions(
  projectDir: string,
  callbacks: OrchestratorCallbacks,
  sinks: WorkflowSinks,
  signal: AbortSignal,
  events: EngineEvent[],
): RunWorkflowOptions {
  return {
    prepared: makePreparedExecution({
      projectDir,
      sessionId: PTY_REVIEW_SESSION_ID,
      feature: 'PTY behavior contract',
      config: createDefaultConfig(),
    }),
    callbacks,
    sinks,
    signal,
    tuiSink: (event) => {
      events.push(event);
    },
  };
}

describe('PTY behavior child', () => {
  it('rejects arguments before starting the production app', () => {
    expect(() => parsePtyChildArgs([])).not.toThrow();
    expect(() => parsePtyChildArgs(['--scenario', 'home'])).toThrow(
      'PTY child does not accept arguments',
    );
  });

  it('runs the deterministic editor child exactly once', () => {
    const root = createTempDir('pty-editor-child-test');
    const sentinel = join(root, 'editor-ran');
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      runEditorChild(['/tmp/plan.json'], {
        [PTY_EDITOR_SENTINEL_ENV]: sentinel,
      });

      expect(existsSync(sentinel)).toBe(true);
      expect(output).toBe(
        `${PTY_EDITOR_STARTED_MARKER}:${process.pid}\n${PTY_EDITOR_FINISHED_MARKER}:${process.pid}\n`,
      );
      expect(() =>
        runEditorChild(['/tmp/plan.json'], {
          [PTY_EDITOR_SENTINEL_ENV]: sentinel,
        }),
      ).toThrow('PTY editor must run exactly once');
    } finally {
      cleanupTempDir(root);
    }
  });

  it('leaves its parent-owned project for parent cleanup when production rendering fails', async () => {
    const environmentRoot = createTempDir('pty-child-parent-cleanup');
    const expectedProjectDir = join(environmentRoot, 'project');
    let renderedProjectDir: string | undefined;
    const exitListeners = process.listenerCount('exit');

    try {
      await expect(
        runPtyChild(
          [],
          {
            renderApp: async (_element, options) => {
              renderedProjectDir = options.projectDir;
              expect(renderedProjectDir).toBe(expectedProjectDir);
              expect(existsSync(renderedProjectDir ?? '')).toBe(true);
              throw new Error('deterministic render setup failure');
            },
          },
          { [PTY_CHILD_PROJECT_ENV]: expectedProjectDir },
        ),
      ).rejects.toThrow('deterministic render setup failure');

      expect(renderedProjectDir).toBe(expectedProjectDir);
      expect(existsSync(expectedProjectDir)).toBe(true);
      expect(process.listenerCount('exit')).toBe(exitListeners);
    } finally {
      cleanupTempDir(environmentRoot);
    }
    expect(existsSync(expectedProjectDir)).toBe(false);
  });

  it('requires an explicit safe parent-owned project path', async () => {
    await expect(
      runPtyChild(
        [],
        {
          renderApp: async () => {
            throw new Error('render must not start');
          },
        },
        {},
      ),
    ).rejects.toThrow('PTY child project path is unavailable or unsafe');
  });

  it('parks the approved run as a durable interruption that requestQuit exits from', async () => {
    const environmentRoot = createTempDir('pty-child-lifecycle');
    const projectDir = join(environmentRoot, 'project');
    const output: string[] = [];
    const events: EngineEvent[] = [];
    const exitListeners = process.listenerCount('exit');
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    try {
      let quitExited = false;
      const pending = runPtyChild(
        [],
        {
          renderApp: async (element) => {
            const runWorkflow = renderedWorkflow(element);
            const saved = loadState({ projectDir, sessionId: PTY_REVIEW_SESSION_ID });
            expect(saved?.phase).toBe('reviewing-plan');
            const running = runWorkflow(
              workflowOptions(
                projectDir,
                {
                  onApprovalNeeded: async (phase, reviewInput) => {
                    expect(phase).toBe('plan');
                    const reviewPath = join(
                      sessionDir(projectDir, PTY_REVIEW_SESSION_ID),
                      PLAN_FILE,
                    );
                    expect(reviewInput).toBe(reviewPath);
                    expect(readFileSync(reviewPath, 'utf8')).toContain(
                      `# ${PTY_ACTIVE_REVIEW_MARKER}`,
                    );
                    const plan = PlanProposalSchema.parse(
                      JSON.parse(readFileSync(join(dirname(reviewPath), PLAN_JSON_FILE), 'utf8')),
                    );
                    expect(PlanSchema.parse(plan)).toEqual(saved?.plan);
                    return { approved: true };
                  },
                  onContinuationNeeded: async (_partial, at) => {
                    // The approval gate runs inside the step's continuation loop now, so a user
                    // interrupt there cuts mid-step while the pickup point stays the plan gate.
                    expect(at).toBe('mid-step');
                    const interrupted = loadState({
                      projectDir,
                      sessionId: PTY_REVIEW_SESSION_ID,
                    });
                    expect(interrupted?.interruptedStep?.step).toEqual({
                      kind: 'gate',
                      gate: 'plan',
                    });
                    expect(interrupted?.interruptedStep?.cut).toBe('mid-step');
                    expect(interrupted?.interruptedStep?.source).toBe('user');
                    expect(interrupted?.awaitingContinue).toBe(true);
                    expect(interrupted?.closed).toBeUndefined();
                    return new Promise<string>((resolve) => {
                      stopStore.park('boundary', null, resolve);
                    });
                  },
                  onComplete: () => {},
                },
                {
                  setAbortHandler: createAbortHandlerScope(),
                  setQueueHandler,
                  consumeBoundaryInterrupt,
                  consumeBoundaryPause,
                },
                new AbortController().signal,
                events,
              ),
            );
            await expect(running).resolves.toMatchObject({ feature: 'PTY behavior contract' });
          },
        },
        { [PTY_CHILD_PROJECT_ENV]: projectDir },
      );

      await vi.waitFor(() => expect(output.join('')).toContain(PTY_APPROVED_MARKER));
      setCancelHandler(() => {});
      requestQuit(() => {
        quitExited = true;
      });
      await vi.waitFor(() => expect(quitExited).toBe(true));
      expect(consumeBoundaryInterrupt()).toBe(false);
      stopStore.resume('');
      await expect(pending).resolves.toEqual({ approved: true });

      expect(events[1]).toMatchObject({ type: 'turn_interrupted', source: 'user', at: 'mid-step' });
      expect(output.filter((chunk) => chunk.includes(PTY_APPROVED_MARKER))).toHaveLength(1);
      expect(abortTurn()).toBe(false);
      expect(process.listenerCount('exit')).toBe(exitListeners);
      const parked = loadState({ projectDir, sessionId: PTY_REVIEW_SESSION_ID });
      expect(parked?.interruptedStep).toBeDefined();
      expect(parked?.closed).toBeUndefined();
    } finally {
      cleanupTempDir(environmentRoot);
    }
  });

  it('never emits the approval marker when the review callback does not approve', async () => {
    const environmentRoot = createTempDir('pty-child-unapproved');
    const projectDir = join(environmentRoot, 'project');
    const output: string[] = [];
    const events: EngineEvent[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    try {
      const pending = runPtyChild(
        [],
        {
          renderApp: async (element) => {
            const runWorkflow = renderedWorkflow(element);
            await expect(
              runWorkflow(
                workflowOptions(
                  projectDir,
                  {
                    onApprovalNeeded: async () => ({ approved: false }),
                    onContinuationNeeded: async () => {
                      throw new Error('continuation must not be asked without approval');
                    },
                    onComplete: () => {},
                  },
                  { setAbortHandler: () => {}, setQueueHandler: () => {} },
                  new AbortController().signal,
                  events,
                ),
              ),
            ).rejects.toThrow('PTY review did not return exactly approved true');
          },
        },
        { [PTY_CHILD_PROJECT_ENV]: projectDir },
      );

      await expect(pending).rejects.toThrow('PTY review exited before approval');
      expect(output.join('')).not.toContain(PTY_APPROVED_MARKER);
      expect(events.map((event) => event.type)).toEqual(['workflow_started']);
    } finally {
      cleanupTempDir(environmentRoot);
    }
  });

  it.each(['approved wait', 'continuation park'] as const)(
    'returns a summary and preserves the cut step when the app aborts at the %s',
    async (at) => {
      const environmentRoot = createTempDir('pty-child-abort-approved');
      const projectDir = join(environmentRoot, 'project');
      const controller = new AbortController();
      const events: EngineEvent[] = [];
      const output: string[] = [];
      const onContinuationNeeded = vi.fn(() => new Promise<string>(() => {}));
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });

      try {
        const pending = runPtyChild(
          [],
          {
            renderApp: async (element) => {
              const running = renderedWorkflow(element)(
                workflowOptions(
                  projectDir,
                  {
                    onApprovalNeeded: async () => ({ approved: true }),
                    onContinuationNeeded,
                    onComplete: () => {},
                  },
                  {
                    setAbortHandler: createAbortHandlerScope(),
                    setQueueHandler,
                    consumeBoundaryInterrupt,
                  },
                  controller.signal,
                  events,
                ),
              );
              await vi.waitFor(() => expect(output.join('')).toContain(PTY_APPROVED_MARKER));
              if (at === 'continuation park') {
                expect(abortTurn()).toBe(true);
                await vi.waitFor(() => expect(onContinuationNeeded).toHaveBeenCalledOnce());
              }
              controller.abort();
              await expect(running).resolves.toMatchObject({ feature: 'PTY behavior contract' });
            },
          },
          { [PTY_CHILD_PROJECT_ENV]: projectDir },
        );

        await expect(pending).resolves.toEqual({ approved: true });
        expect(onContinuationNeeded).toHaveBeenCalledTimes(at === 'continuation park' ? 1 : 0);
        expect(events[1]).toMatchObject({
          type: 'turn_interrupted',
          source: 'user',
          at: 'mid-step',
        });
        const parked = loadState({ projectDir, sessionId: PTY_REVIEW_SESSION_ID });
        expect(parked?.interruptedStep).toMatchObject({
          step: { kind: 'gate', gate: 'plan' },
          cut: 'mid-step',
          source: 'user',
        });
        expect(parked?.awaitingContinue).toBe(true);
        expect(parked?.closed).toBeUndefined();
        expect(abortTurn()).toBe(false);
      } finally {
        cleanupTempDir(environmentRoot);
      }
    },
  );

  it('ends the pending fixture when the app aborts before approval', async () => {
    const environmentRoot = createTempDir('pty-child-abort');
    const projectDir = join(environmentRoot, 'project');

    try {
      const controller = new AbortController();
      const pending = runPtyChild(
        [],
        {
          renderApp: async (element) => {
            const runWorkflow = renderedWorkflow(element);
            const running = runWorkflow(
              workflowOptions(
                projectDir,
                {
                  onApprovalNeeded: () => new Promise(() => {}),
                  onComplete: () => {},
                },
                { setAbortHandler: () => {}, setQueueHandler: () => {} },
                controller.signal,
                [],
              ),
            );
            controller.abort();
            await expect(running).resolves.toMatchObject({ feature: 'PTY behavior contract' });
          },
        },
        { [PTY_CHILD_PROJECT_ENV]: projectDir },
      );

      await expect(pending).rejects.toThrow('PTY review exited before approval');
    } finally {
      cleanupTempDir(environmentRoot);
    }
  });
});
