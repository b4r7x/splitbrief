import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  createHeadlessGitProject,
  preparedHeadlessExecution,
  writeCurrentTranscriptHeadlessConfigYaml,
  writeMinimalHeadlessConfigYaml,
} from '#testing/helpers/headless-project.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { writeActive } from '../../../src/core/sessions/lifecycle.js';
import { listSessions } from '../../../src/core/sessions/io.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { Planner } from '../../../src/engine/planners/types.js';
import { runHeadless } from '../../../src/cli/headless.js';

let stderrSpy: ReturnType<typeof vi.spyOn>;
let dirs: string[] = [];

describe('runHeadless — SIGINT/SIGTERM stops the run', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let planner: Planner;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    planner = makePlanner();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  function makeTwoTaskState(): WorkflowState {
    return {
      ...createInitialState('stop me'),
      phase: 'implementing',
      tasks: [
        makeTask({ id: 'T001', file: 'src/one.ts' }),
        makeTask({ id: 'T002', file: 'src/two.ts' }),
      ],
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    };
  }

  function setupSignalProject(): { projectDir: string; sessionId: string } {
    const projectDir = createHeadlessGitProject('headless-signal');
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
    const sessionId = 'sess-headless-signal';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });
    saveState({ projectDir, sessionId }, makeTwoTaskState());
    return { projectDir, sessionId };
  }

  it('aborts the workflow on SIGINT and records the session as interrupted, not failed', async () => {
    const { projectDir, sessionId } = setupSignalProject();
    const implement = vi.fn().mockImplementation(async () => {
      process.emit('SIGINT');
      return { success: true, output: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const implementer = makeImplementer({ implement });
    const state = makeTwoTaskState();

    await runHeadless({
      prepared: preparedHeadlessExecution({
        projectDir,
        sessionId,
        feature: 'stop me',
        resumeState: state,
      }),
      _planner: planner,
      _implementer: implementer,
    });

    expect(implement).toHaveBeenCalledTimes(1);
    const session = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(session?.status).toBe('interrupted');
  });

  it('keeps opaque resumed sessions transcript-private when current config allows transcripts', async () => {
    const projectDir = createHeadlessGitProject('headless-private-resume');
    dirs.push(projectDir);
    writeCurrentTranscriptHeadlessConfigYaml(projectDir);
    const sessionId = '2025-04-01-session-abcdef123456';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });
    const state = makeTwoTaskState();
    saveState({ projectDir, sessionId }, state);
    let seenPersistTranscript: boolean | undefined;
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (opts) => {
        seenPersistTranscript = opts.config.workflow.persistTranscript;
        process.emit('SIGINT');
        return { success: true, output: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });

    await runHeadless({
      prepared: preparedHeadlessExecution({
        projectDir,
        sessionId,
        feature: 'secret oauth login',
        resumeState: state,
      }),
      _planner: planner,
      _implementer: implementer,
    });

    expect(seenPersistTranscript).toBe(false);
  });

  it('stops the run on SIGTERM the same way', async () => {
    const { projectDir, sessionId } = setupSignalProject();
    const implement = vi.fn().mockImplementation(async () => {
      process.emit('SIGTERM');
      return { success: true, output: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const implementer = makeImplementer({ implement });
    const state = makeTwoTaskState();

    await runHeadless({
      prepared: preparedHeadlessExecution({
        projectDir,
        sessionId,
        feature: 'stop me',
        resumeState: state,
      }),
      _planner: planner,
      _implementer: implementer,
    });

    expect(implement).toHaveBeenCalledTimes(1);
    const session = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(session?.status).toBe('interrupted');
  });

  it('does not emit retry or escalation events after a mid-run SIGINT (no paid churn)', async () => {
    const { projectDir, sessionId } = setupSignalProject();
    const stdoutChunks: string[] = [];
    stdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const implement = vi.fn().mockImplementation(async () => {
      process.emit('SIGINT');
      return { success: false, output: '', error: 'broken code', usage: null };
    });
    const implementer = makeImplementer({ implement });
    const state = makeTwoTaskState();

    await runHeadless({
      prepared: preparedHeadlessExecution({
        projectDir,
        sessionId,
        feature: 'stop me',
        resumeState: state,
      }),
      _planner: planner,
      _implementer: implementer,
    });

    expect(implement).toHaveBeenCalledTimes(1);

    const emittedTypes = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => {
        const parsed = JSON.parse(line) as { type?: string; data?: { type?: string } };
        return parsed.type === 'event' ? parsed.data?.type : parsed.type;
      });
    expect(emittedTypes).not.toContain('task_retry');
    expect(emittedTypes).not.toContain('task_escalating');
    expect(emittedTypes).not.toContain('escalate');

    const session = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(session?.status).toBe('interrupted');
  });

  it('leaves a broken-pipe guard on stdout and stderr so a closed consumer cannot crash the run', async () => {
    const { projectDir, sessionId } = setupSignalProject();
    const implement = vi.fn().mockImplementation(async () => {
      process.emit('SIGINT');
      return { success: true, output: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const implementer = makeImplementer({ implement });
    const state = makeTwoTaskState();

    await runHeadless({
      prepared: preparedHeadlessExecution({
        projectDir,
        sessionId,
        feature: 'stop me',
        resumeState: state,
      }),
      _planner: planner,
      _implementer: implementer,
    });

    const epipe: NodeJS.ErrnoException = new Error('write EPIPE');
    epipe.code = 'EPIPE';
    expect(() => process.stdout.emit('error', epipe)).not.toThrow();
    expect(() => process.stderr.emit('error', epipe)).not.toThrow();
  });
});
