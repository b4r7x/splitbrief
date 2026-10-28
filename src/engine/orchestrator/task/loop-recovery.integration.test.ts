import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeConfig, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { runTaskLoop } from './loop.js';
import { buildContextOverflowRecoveryIssue } from '../recovery/builders/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { applyRecoveryAction } from '../recovery/actions.js';

let dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-loop-test',
    sessionId: 'sess-loop',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function setupSessionOnly(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('task-loop-test');
  dirs.push(projectDir);
  const sessionId = 'sess-loop';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

const IMPLEMENTER_WORDS = [
  {
    name: 'cli codex',
    runner: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' },
    word: 'OpenAI Codex CLI',
  },
  {
    name: 'cli claude-code',
    runner: { kind: 'cli', tool: 'claude-code' },
    word: 'Claude Code CLI',
  },
  {
    name: 'cli opencode route',
    runner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-chat' },
    word: 'OpenCode CLI',
  },
  {
    name: 'api ollama',
    runner: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'llama3',
    },
    word: 'Ollama',
  },
  {
    name: 'api custom endpoint',
    runner: {
      kind: 'api',
      provider: 'custom-endpoint',
      model: 'some-model',
      apiBase: 'https://api.example.com/v1',
      apiKey: 'k',
    },
    word: 'custom-endpoint',
  },
  {
    name: 'shell',
    runner: { kind: 'shell', command: './run.sh', model: 'auto' },
    word: 'Custom Shell',
  },
  { name: 'agent', runner: { kind: 'agent', command: './agent.sh', model: 'auto' }, word: 'Agent' },
] as const;

describe('runTaskLoop', { timeout: 90_000 }, () => {
  it('task with failed dependency creates dependency-blocked recovery instead of auto-skipping', async () => {
    const { projectDir, sessionId } = setupProject();
    const dependency = makeTask({ id: 'T001', status: 'failed' });
    const blocked = makeTask({ id: 'T002', dependsOn: ['T001'] });
    let state = makeImplState([dependency, blocked]);
    state = {
      ...state,
      currentTaskIndex: 1,
      tasks: state.tasks.map((t) => (t.id === 'T001' ? { ...t, status: 'failed' } : t)),
    };

    const implementer = makeImplementer({ implement: vi.fn() });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'task_skipped')).toBeUndefined();
    expect(result.state.tasks.find((t) => t.id === 'T002')?.status).toBe('pending');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'dependency-blocked',
      taskId: 'T002',
      affectedTaskIds: ['T001', 'T002'],
      availableActions: ['skip-current-task', 'end-run'],
      recommendedAction: 'skip-current-task',
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'dependency-blocked',
      taskId: 'T002',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'recovery_prompted',
        reason: 'dependency-blocked',
        taskId: 'T002',
        availableActions: ['skip-current-task', 'end-run'],
        recommendedAction: 'skip-current-task',
      }),
    );
  });

  it('keeps a priced pre-resume taskBreakdown row when re-entering at currentTaskIndex 1', async () => {
    const { projectDir, sessionId } = setupProject();
    const completed = makeTask({ id: 'T001', status: 'failed' });
    const blocked = makeTask({ id: 'T002', dependsOn: ['T001'] });
    const preResumeRow = {
      taskId: taskId('T001'),
      taskTitle: 'pre-resume task',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      retryCount: 0,
      tool: 'ollama',
      model: 'deepseek-chat',
    };
    let state = makeImplState([completed, blocked], {
      currentTaskIndex: 1,
      taskBreakdowns: [preResumeRow],
    });
    state = {
      ...state,
      tasks: state.tasks.map((t) => (t.id === 'T001' ? { ...t, status: 'failed' } : t)),
    };

    const implementer = makeImplementer({ implement: vi.fn() });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.state.taskBreakdowns).toContainEqual(preResumeRow);
    expect(
      (result.state.taskBreakdowns ?? []).filter((row) => row.taskId === taskId('T001')),
    ).toHaveLength(1);
  });

  it('blocks before implementer dispatch when every profile overflows the task prompt', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const config: Config = {
      ...makeNoValidationConfig(),
      implementerProfiles: {
        default: 'tiny-local',
        profiles: {
          'tiny-cloud': {
            kind: 'api',
            provider: 'ollama',
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'tiny-cloud',
            contextLength: 10,
          },
          'tiny-local': {
            kind: 'api',
            provider: 'ollama',
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'tiny-local',
            contextLength: 10,
          },
        },
      },
    };
    const implementer = makeImplementer({ implement: vi.fn() });
    const createProfileImplementer = vi.fn();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config,
        callbacks,
        implementer,
        createImplementer: createProfileImplementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).not.toHaveBeenCalled();
    expect(createProfileImplementer).not.toHaveBeenCalled();
    expect(result.state.phase).toBe('implementing');
    expect(result.state.currentTaskIndex).toBe(0);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'context-overflow',
      taskId: 'T001',
      availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
      recommendedAction: 'retry-same-worker',
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'context-overflow',
      taskId: 'T001',
    });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: expect.stringContaining('T001 cannot be routed to an implementer profile'),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'recovery_prompted',
        reason: 'context-overflow',
        taskId: 'T001',
        availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
        recommendedAction: 'retry-same-worker',
      }),
    );
  });

  it('carries the runner own unavailability reason into the recovery issue', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const implementer = makeImplementer({
      implement: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(false),
      unavailabilityReason: () => 'the endpoint is unreachable',
    });
    const { bus } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'implementation-error',
      taskId: 'T001',
      details: expect.arrayContaining(['Availability: the endpoint is unreachable']),
    });
  });

  it.each(IMPLEMENTER_WORDS)(
    'names an unavailable $name implementer by its catalog name',
    async ({ runner, word }) => {
      const { projectDir, sessionId } = setupProject();
      const task = makeTask({ id: 'T001' });
      const implementer = makeImplementer({
        implement: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(false),
      });

      const result = await runTaskLoop({
        wctx: makeWctx({
          projectDir,
          sessionId,
          config: makeNoValidationConfig({ implementer: runner }),
          implementer,
          bus: makeBusRecorder().bus,
        }),
        initialState: makeImplState([task]),
        setTrackedState: vi.fn(),
        setCurrentTask: vi.fn(),
      });

      expect(result.state.pendingRecovery?.details).toEqual(
        expect.arrayContaining([
          `Tool: ${word}`,
          `Availability: Selected implementer profile default (${word}) is unavailable. Check runner installation, API credentials, or endpoint reachability.`,
        ]),
      );
    },
  );

  it('falls back to the generic guidance when the implementer cannot explain', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const implementer = makeImplementer({
      implement: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(false),
    });
    const { bus } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'implementation-error',
      taskId: 'T001',
      details: expect.arrayContaining([
        expect.stringContaining(
          'is unavailable. Check runner installation, API credentials, or endpoint reachability.',
        ),
      ]),
    });
  });

  it.each([{ status: 'awaiting-user' }, { status: 'applying' }] as const)(
    'stops on resume of a $status recovery, warning about it and leaving the issue unchanged',
    async ({ status }) => {
      const { projectDir, sessionId } = setupSessionOnly();
      const task = makeTask({ id: 'T001' });
      const issue = {
        ...buildContextOverflowRecoveryIssue({
          task,
          phase: 'implementing',
          createdAt: '2026-04-28T12:00:00.000Z',
        }),
        status,
      };
      const state = { ...makeImplState([task]), pendingRecovery: issue };
      const implementer = makeImplementer({ implement: vi.fn() });
      const { bus, events } = makeBusRecorder();

      const result = await runTaskLoop({
        wctx: makeWctx({
          projectDir,
          sessionId,
          config: makeNoValidationConfig(),
          implementer,
          bus,
        }),
        initialState: state,
        setTrackedState: vi.fn(),
        setCurrentTask: vi.fn(),
      });

      expect(result.status).toBe('stopped');
      expect(implementer.implement).not.toHaveBeenCalled();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'warning',
          code: 'recovery_pending_unresolved',
          category: 'recovery',
          message: expect.stringContaining('context-overflow'),
        }),
      );
      const warning = events.find((event) => event.type === 'warning');
      expect(warning).toMatchObject({
        message: expect.stringContaining(`status: ${status}`),
      });
      expect(warning).toMatchObject({
        message: expect.stringContaining(
          'Available actions: retry-same-worker, skip-current-task, end-run.',
        ),
      });
      expect(result.state.pendingRecovery).toEqual(issue);
      expect(result.state.pendingRecovery?.status).toBe(status);
    },
  );

  it('restores a file the brief created when its ladder runs out after a Continue', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/new.ts'],
      criteria: [],
      checks: [{ id: 'T001-K1', kind: 'cmd', value: 'tsc --noEmit', required: true }],
    });
    vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      processError.exitCode({ command: 'tsc', code: 2, stderr: 'test failed', output: '' }),
    );
    let attempts = 0;
    const write = async ({ projectDir: runDir }: ImplementerOptions) => {
      attempts += 1;
      mkdirSync(join(runDir, 'src'), { recursive: true });
      writeFileSync(join(runDir, 'src/new.ts'), `export const attempt = ${attempts};\n`);
      return {
        success: true,
        output: 'implemented',
        report: {
          status: 'done' as const,
          filesChanged: ['src/new.ts'],
          touchedNotSuggested: [],
          notes: null,
          decisions: [],
        },
      };
    };
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      reviewer: { kind: 'cli', tool: 'codex' },
      validation: { endChecks: false, testCommand: 'noop' },
      workflow: { review: 'task' },
    });
    const { bus } = makeBusRecorder();
    const wctx = makeWctx({
      projectDir,
      sessionId,
      config,
      bus,
      validator: { formatChangedFiles: vi.fn().mockResolvedValue(undefined) },
      planner: makePlanner({
        typedCall: vi.fn(() => {
          throw new Error('The planner process stopped unexpectedly.');
        }),
      }),
      implementer: makeImplementer({ implement: vi.fn(write), retry: vi.fn(write) }),
    });
    const loop = (initialState: ReturnType<typeof makeImplState>) =>
      runTaskLoop({ wctx, initialState, setTrackedState: vi.fn(), setCurrentTask: vi.fn() });

    // The lineage has spent its consults, so the first ladder halts with the file kept.
    const spent = {
      consults: 2,
      attempts: 0,
      consultAllowance: 2,
      attemptAllowance: 8,
      dispatchedRevision: {},
      consultRecords: [],
      replacedParents: [],
      notes: [],
    };
    const halted = await loop(makeImplState([task], { lineages: { T001: spent } }));
    expect(halted.state.pendingRecovery).toMatchObject({ reason: 'consult-bound-spent' });
    expect(existsSync(join(projectDir, 'src/new.ts'))).toBe(true);
    const continued = await applyRecoveryAction({
      projectDir,
      sessionId,
      bus,
      config,
      state: halted.state,
      action: 'continue',
    });
    if (!continued.ok) throw new Error(continued.message);

    const exhausted = await loop(continued.state);

    expect(exhausted.state.pendingRecovery).toMatchObject({ reason: 'planner-call-failed' });
    expect(attempts).toBeGreaterThan(1);
    expect(existsSync(join(projectDir, 'src/new.ts'))).toBe(false);
  });
});
