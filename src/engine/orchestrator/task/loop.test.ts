import { createValidator } from '../validation/run.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import { loadState } from '../../../core/state/persistence.js';
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

  it('runs no full suite before the first brief', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'task-loop-no-run-start-suite',
      sessionId: 'sess-no-run-start-suite',
    });
    dirs.push(projectDir);
    const runFullSuite = vi.fn();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (opts) => {
        expect(runFullSuite).not.toHaveBeenCalled();
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, opts.task.file), 'implementation\n');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          validation: { typecheck: true, lint: true, test: true },
          workflow: {},
        }),
        implementer,
        validator: { ...createValidator(), runFullSuite },
      }),
      initialState: makeImplState([makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'] })]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(runFullSuite).not.toHaveBeenCalled();
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
});
