import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  preparedHeadlessExecution,
  setupBudgetHeadlessProject,
  writeHeadlessConfigYaml,
} from '#testing/helpers/headless-project.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { writeActive } from '../../../src/core/sessions/active-pointer.js';
import { generateSessionId } from '../../../src/core/sessions/session-id.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { Implementer } from '../../../src/engine/implementers/types.js';
import type { Planner } from '../../../src/engine/planners/types.js';
import { runHeadless } from '../../../src/cli/headless.js';

let stderrSpy: ReturnType<typeof vi.spyOn>;
let dirs: string[] = [];

function makeBudgetState(): WorkflowState {
  const task = makeTask({
    title: 'Do the task',
    action: 'modify',
    file: 'src/example.ts',
    description: 'Do the task',
    tests: ['verifies budget pause behavior with a passing validation command'],
    constraints: ['keep behavior focused on the budget threshold'],
    typeDefs: 'function runBudgetFixture(): void',
    implementationSteps: [
      '1. Run the implementation once',
      '2. Stop at the budget pause threshold',
    ],
    scope: { inBounds: ['budget behavior'], outOfBounds: ['unrelated workflow changes'] },
    evidence: ['headless JSON output includes budget_paused'],
  });
  return {
    ...createInitialState('fix budget behavior'),
    phase: 'implementing',
    tasks: [task],
    plannerTool: 'custom-planner-api',
    plannerModel: 'claude-sonnet-4-6',
    implementerTool: 'custom-planner-api',
    implementerModel: 'claude-sonnet-4-6',
  };
}

describe('runHeadless — budget pause behavior', () => {
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let planner: Planner;
  let implementer: Implementer;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code: number | string | null | undefined,
    ) => {
      const err = new Error(`process.exit(${String(code)})`) as Error & {
        code: number | string | null | undefined;
      };
      err.code = code;
      throw err;
    }) as never);

    planner = makePlanner({
      review: vi.fn().mockResolvedValue({ text: '', usage: null }),
    });
    implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'done',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    vi.clearAllMocks();
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  it('emits budget_paused JSON and fails fast through the public headless workflow path', {
    timeout: 60_000,
  }, async () => {
    const projectDir = setupBudgetHeadlessProject(0.75);
    dirs.push(projectDir);
    const sessionId = generateSessionId({ projectDir, feature: 'fix budget behavior' });
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });
    const state = makeBudgetState();

    await expect(
      runHeadless({
        prepared: preparedHeadlessExecution({
          projectDir,
          sessionId,
          feature: 'fix budget behavior',
          resumeState: state,
        }),
        _planner: planner,
        _implementer: implementer,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Workflow failed — see the error output above.'),
    });

    const output = stdoutChunks.join('');
    const jsonLines = output
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as { type?: string; message?: string });
    expect(jsonLines).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('status failed'),
      }),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects interactive task review modes before starting a headless run', {
    timeout: 60_000,
  }, async () => {
    const projectDir = setupBudgetHeadlessProject();
    dirs.push(projectDir);
    writeHeadlessConfigYaml(projectDir, [
      'version: 3',
      'planner:',
      '  kind: api',
      '  provider: custom-planner-api',
      '  service: custom-planner-api',
      '  offering: payg',
      '  model: claude-sonnet-4-6',
      '  api_base: https://api.planner.example/v1',
      '  api_key: test-key',
      'implementer:',
      '  kind: api',
      '  provider: custom-planner-api',
      '  service: custom-planner-api',
      '  offering: payg',
      '  model: claude-sonnet-4-6',
      '  api_base: https://api.planner.example/v1',
      '  api_key: test-key',
      'validation:',
      '  typecheck: false',
      '  lint: false',
      '  test: false',
      '  test_command: "noop"',
      'workflow:',
      '  mode: quick',
      '  approve: none',
      '  persist_transcript: false',
      '  max_budget: 20',
      '  budget_pause_threshold: 0.85',
      '  task_review: every',
    ]);
    const sessionId = generateSessionId({ projectDir, feature: 'fix budget behavior' });
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });
    const state = makeBudgetState();

    await expect(
      runHeadless({
        prepared: preparedHeadlessExecution({
          projectDir,
          sessionId,
          feature: 'fix budget behavior',
          resumeState: state,
        }),
        _planner: planner,
        _implementer: implementer,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('workflow.taskReview requires an interactive TUI run'),
    });
    expect(stdoutChunks.join('')).toBe('');
  });
});
