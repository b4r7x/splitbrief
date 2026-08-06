import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  createHeadlessGitProject,
  preparedHeadlessExecution,
  writeMinimalHeadlessConfigYaml,
} from '#testing/helpers/headless-project.js';
import { createInitialState, transition } from '../core/state/machine.js';
import { ensureSessionDir } from '../core/paths-io.js';
import { saveState } from '../core/state/persistence.js';
import { writeActive } from '../core/sessions/lifecycle.js';
import { buildContextOverflowRecoveryIssue } from '../engine/orchestrator/recovery/builders/task.js';
import { runHeadless } from './headless.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { Planner } from '../engine/planners/types.js';

let stderrSpy: ReturnType<typeof vi.spyOn>;
let dirs: string[] = [];

describe('runHeadless — every pending recovery status fails the run', () => {
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let planner: Planner;
  let implementer: Implementer;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    planner = makePlanner();
    implementer = makeImplementer();
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  it.each([
    'paused',
    'applying',
  ] as const)('a run ending with a %s recovery exits 1, emits the record and names the resolution route', async (status) => {
    const projectDir = createHeadlessGitProject(`headless-recovery-${status}`);
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
    const sessionId = `sess-headless-${status}`;
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    const task = makeTask({ id: 'T001' });
    const issue = {
      ...buildContextOverflowRecoveryIssue({
        task,
        phase: 'implementing',
        createdAt: '2026-04-28T12:00:00.000Z',
      }),
      status,
    };
    const state = transition(
      {
        ...createInitialState('recover me'),
        phase: 'implementing',
        tasks: [task],
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      { type: 'SET_PENDING_RECOVERY', issue },
    );
    saveState({ projectDir, sessionId }, state);

    const error = await runHeadless({
      prepared: preparedHeadlessExecution({
        projectDir,
        sessionId,
        feature: 'recover me',
        resumeState: state,
      }),
      _planner: planner,
      _implementer: implementer,
    }).then(
      () => {
        throw new Error('runHeadless unexpectedly resolved');
      },
      (err: { exitCode?: number; message?: string }) => err,
    );

    expect(error).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining(`Recovery required (status: ${status})`),
    });
    expect(error.message).toContain('abort-workflow');

    const jsonLines = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as { type?: string; status?: string });
    expect(jsonLines).toContainEqual(
      expect.objectContaining({
        type: 'recovery_required',
        status,
      }),
    );
  });
});
