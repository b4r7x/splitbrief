import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../core/paths-io.js';
import { createInitialState, transition } from '../core/state/machine.js';
import { saveState } from '../core/state/persistence.js';
import { writeActive } from '../core/sessions/lifecycle.js';
import { buildValidationFailedRecoveryIssue } from '../engine/orchestrator/recovery.js';

const runWorkflowMock = vi.hoisted(() => vi.fn());

vi.mock('../engine/orchestrator/run/run.js', () => ({
  runWorkflow: runWorkflowMock,
}));
vi.mock('../core/config/load/load.js');
vi.mock('../core/config/runtime/overrides.js');
vi.mock('../lib/warn.js', () => ({ warnStderr: vi.fn() }));

import { loadConfig } from '../core/config/load/load.js';
import { applyCLIOverrides } from '../core/config/runtime/overrides.js';
import { runHeadless } from './headless.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockApplyCLIOverrides = vi.mocked(applyCLIOverrides);

let dirs: string[] = [];
let stdoutChunks: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const config = makeConfig({
    validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    workflow: { autoApproveSpec: true, autoApprovePlan: true, commitStrategy: 'none', mode: 'quick', persistTranscript: false },
  });
  mockLoadConfig.mockReturnValue({ config, warnings: [] });
  mockApplyCLIOverrides.mockReturnValue(config);
  runWorkflowMock.mockResolvedValue(undefined);
  stdoutChunks = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  vi.clearAllMocks();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('runHeadless recovery stops', () => {
  it('emits machine-readable recovery actions and exits non-zero when a run leaves pending recovery', async () => {
    const projectDir = createTempDir('headless-recovery');
    dirs.push(projectDir);
    const sessionId = 'sess-headless-recovery';
    ensureSessionDir(projectDir, sessionId);
    writeActive(projectDir, sessionId);

    const task = makeTask({ id: 'T001' });
    const issue = buildValidationFailedRecoveryIssue({
      task,
      validationSummary: 'npm test failed',
      attempts: 2,
      maxAttempts: 2,
      createdAt: '2026-04-29T00:00:00.000Z',
    });
    const state = transition({
      ...createInitialState('recover me'),
      phase: 'implementing',
      tasks: [task],
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    }, { type: 'SET_PENDING_RECOVERY', issue });
    saveState(projectDir, sessionId, state);

    await expect(runHeadless('recover me', projectDir, {}, undefined, sessionId)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Recovery required'),
    });

    const jsonLines = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as { type?: string; reason?: string; availableActions?: string[]; sessionId?: string });
    expect(jsonLines).toContainEqual(expect.objectContaining({
      type: 'recovery_required',
      sessionId,
      reason: 'validation-failed',
      availableActions: ['planner-split-rebase', 'skip-current-task', 'pause-run', 'abort-workflow'],
    }));
  });
});
