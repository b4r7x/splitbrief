import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makeWctx,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent } from '../../events/types.js';
import { loadState } from '../../../core/state/persistence.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { workflowStatePath } from '../state-ops.js';
import { runTaskLoop } from './loop.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

describe('runTaskLoop', { timeout: 120_000 }, () => {
  it('boundary pause stops before next brief', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'task-loop-pause-test',
      sessionId: 'sess-pause',
    });
    dirs.push(projectDir);

    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'] }),
    ];
    const implemented: string[] = [];
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (opts) => {
        implemented.push(opts.task.id);
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, opts.task.file), 'implementation\n');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { bus } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks: makeCallbacks().callbacks,
        implementer,
        bus,
        sinks: { ...TEST_SINKS, consumeBoundaryPause: () => true },
      }),
      initialState: makeImplState(tasks),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('paused');
    expect(implemented).toEqual(['T001']);
    expect(result.state.tasks[0]?.status).toBe('done');
    expect(result.state.tasks[1]?.status).toBe('pending');
  });

  it('skips briefs that already passed when a review fix re-enters the loop', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'task-loop-skip-test',
      sessionId: 'sess-skip',
    });
    dirs.push(projectDir);

    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], status: 'done' }),
    ];
    const implemented: string[] = [];
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (opts) => {
        implemented.push(opts.task.id);
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, opts.task.file), 'implementation\n');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { bus } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks: makeCallbacks().callbacks,
        implementer,
        bus,
      }),
      initialState: makeImplState(tasks),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(implemented).toEqual(['T001']);
  });

  it('runs no check command before the first brief', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'task-loop-no-run-start-suite',
      sessionId: 'sess-no-run-start-suite',
    });
    dirs.push(projectDir);
    const runCommand = vi.spyOn(commandRunner, 'runCommand');
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (opts) => {
        expect(runCommand).not.toHaveBeenCalled();
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, opts.task.file), 'implementation\n');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: {} }),
        implementer,
      }),
      initialState: makeImplState([makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'] })]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(runCommand).not.toHaveBeenCalled();
    runCommand.mockRestore();
  });

  it('has the task-start snapshot on disk before the brief runs', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'task-loop-snapshot-test',
      sessionId: 'sess-snapshot',
    });
    dirs.push(projectDir);

    let persisted: ChangedFilesSnapshot | undefined;
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (opts) => {
        persisted = loadState({ projectDir, sessionId })?.changedFilesBaseline?.activeTaskSnapshot;
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, opts.task.file), 'implementation\n');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });

    await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks: makeCallbacks().callbacks,
        implementer,
        bus: makeBusRecorder().bus,
      }),
      initialState: makeImplState([makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'] })]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(persisted).toBeDefined();
    expect(persisted?.head).toEqual(expect.any(String));
  });

  describe('a message queued while a brief is saved', () => {
    function runWithWriteOn(
      eventType: EngineEvent['type'],
      write: (ref: { projectDir: string; sessionId: string }) => void,
    ) {
      const { projectDir, sessionId } = setupGitSessionProject({
        prefix: 'task-loop-queue-race-test',
        sessionId: 'sess-queue-race',
      });
      dirs.push(projectDir);
      let atCall: WorkflowState | null = null;
      const implementer = makeImplementer({
        implement: vi.fn().mockImplementation(async () => {
          atCall = loadState({ projectDir, sessionId });
          mkdirSync(join(projectDir, 'src'), { recursive: true });
          writeFileSync(join(projectDir, 'src/alpha.ts'), 'implementation\n');
          return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
        }),
      });
      const { bus } = makeBusRecorder();
      let written = false;
      bus.subscribe((event) => {
        if (event.type !== eventType || written) return;
        written = true;
        write({ projectDir, sessionId });
      });
      const run = runTaskLoop({
        wctx: makeWctx({
          projectDir,
          sessionId,
          config: makeNoValidationConfig({ workflow: {} }),
          callbacks: makeCallbacks().callbacks,
          implementer,
          bus,
        }),
        initialState: makeImplState([makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'] })]),
        setTrackedState: vi.fn(),
        setCurrentTask: vi.fn(),
      });
      return { projectDir, sessionId, run, atCall: () => atCall };
    }

    function queueBuildMessage(ref: { projectDir: string; sessionId: string }) {
      const state = loadState(ref);
      if (state === null) throw new Error('no saved state to queue on');
      enqueueUserMessage({
        ...ref,
        state,
        message: plainUserMessage('also export the helper'),
        phase: 'implementing',
        bus: makeBusRecorder().bus,
      });
    }

    it('keeps the message and saves the brief usage when it lands after the pass is saved', async () => {
      const { projectDir, sessionId, run } = runWithWriteOn('task_completed', (ref) =>
        queueBuildMessage(ref),
      );

      const result = await run;

      expect(result.status).toBe('complete');
      const saved = loadState({ projectDir, sessionId });
      expect(saved?.taskBreakdowns?.map((breakdown) => breakdown.taskId)).toEqual(['T001']);
      expect(saved?.tasks[0]?.status).toBe('done');
      expect(saved?.messageQueue.map((message) => message.text)).toEqual([
        'also export the helper',
      ]);
      expect(result.state.messageQueue.map((message) => message.text)).toEqual([
        'also export the helper',
      ]);
    });

    it('keeps the message and saves the task-start snapshot when it lands as the brief starts', async () => {
      const { projectDir, sessionId, run, atCall } = runWithWriteOn('task_started', (ref) =>
        queueBuildMessage(ref),
      );

      const result = await run;

      expect(result.status).toBe('complete');
      expect(atCall()?.changedFilesBaseline?.activeTaskSnapshot).toBeDefined();
      expect(atCall()?.implementerTool).toEqual(expect.any(String));
      expect(atCall()?.messageQueue.map((message) => message.text)).toEqual([
        'also export the helper',
      ]);
      const saved = loadState({ projectDir, sessionId });
      expect(saved?.taskBreakdowns?.map((breakdown) => breakdown.taskId)).toEqual(['T001']);
      expect(saved?.messageQueue.map((message) => message.text)).toEqual([
        'also export the helper',
      ]);
    });

    it('still fails when the saved state is gone, which no rebase can settle', async () => {
      const { run } = runWithWriteOn('task_completed', (ref) => rmSync(workflowStatePath(ref)));

      await expect(run).rejects.toThrow(
        'Workflow state changed before task metadata could be persisted.',
      );
    });
  });
});
