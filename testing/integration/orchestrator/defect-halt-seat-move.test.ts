import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Task } from '../../../src/core/schemas/task.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions, RetryOptions } from '../../../src/engine/implementers/types.js';
import type { PreparationPolicy } from '../../../src/engine/runners/prepare-execution/types.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { applyOfferedSeatSwap } from '../../../src/engine/orchestrator/run/seat-swap.js';
import { runTrackedWorkflow, settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { cliDetectionFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { writeConfigYamlText } from '#testing/helpers/config-io.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { typedCallFromTasks } from '#testing/helpers/typed-planner.js';

const TARGET = 'src/seat.ts';
const FIRST_CALL = 'export const seat = 0;\n';
const NEXT_CALL = 'export const seat = 1;\n';
const EVIDENCE = 'searched ~ with run_command: find ~ -name seat.ts';
const RESUME_POLICY: Extract<PreparationPolicy, { purpose: 'resume' }> = {
  purpose: 'resume',
  interaction: 'headless',
  allowRepoRunners: false,
  allowHooks: false,
  unverifiedAuth: 'denied',
};
const USAGE = { inputTokens: 10, outputTokens: 5 };

const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(async () => {
  await settleTrackedWorkflows();
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

const task: Task = makeTask({
  id: 'T001',
  action: 'create',
  suggestedFiles: [TARGET],
  title: 'Add the seat module',
  description: 'Create src/seat.ts.',
  implementationSteps: ['Create src/seat.ts.'],
  tests: ['node -e "process.exit(0)"'],
  scope: { inBounds: [TARGET], outOfBounds: ['everything else'] },
  evidence: ['src/seat.ts exports seat'],
  typeDefs: 'export const seat: number',
});

describe('a BUILD call that left its isolation directory', { timeout: 90_000 }, () => {
  it('continues on the files the call left when the operator moves BUILD to another tool', async () => {
    const projectDir = createTempDir('defect-halt-seat-move');
    dirs.push(projectDir);
    createTestGitRepo(projectDir, { '.gitignore': '.splitbrief/\n' });
    const sessionId = 'sess-defect-halt-seat-move';
    // Each call records the file it starts on. The first call writes the file and stops on the
    // defect; the next call finishes the file.
    const seen: string[] = [];
    let calls = 0;
    const attempt = async (opts: ImplementerOptions | RetryOptions) => {
      const file = join(opts.projectDir, TARGET);
      seen.push(existsSync(file) ? readFileSync(file, 'utf-8') : 'no file');
      calls += 1;
      mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
      if (calls === 1) {
        writeFileSync(file, FIRST_CALL, 'utf-8');
        return {
          success: false,
          output: '',
          outcome: 'implementer-left-isolation' as const,
          error: EVIDENCE,
          usage: USAGE,
        };
      }
      writeFileSync(file, NEXT_CALL, 'utf-8');
      return { success: true, output: 'finished the module', usage: USAGE };
    };
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn(attempt),
      retry: vi.fn(attempt),
    });
    const config = makeConfig({
      implementer: {
        kind: 'agent',
        command: 'node',
        model: 'cheap-direct-agent',
        contextLength: 4096,
      },
      validation: { endChecks: false, testCommand: 'true' },
      workflow: { approve: 'none' },
    });
    writeConfigYamlText(projectDir, YAML.stringify(config));
    await rememberDetectedTools(projectDir, [cliDetectionFor('ready', 'claude-code')]);
    const prepared = makePreparedExecution({
      projectDir,
      sessionId,
      feature: 'move BUILD after a defect halt',
      config,
    });

    await runTrackedWorkflow({
      prepared,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: makePlanner({ typedCall: typedCallFromTasks([task]) }),
      _implementer: implementer,
    });

    const halted = loadState({ projectDir, sessionId });
    if (halted === null) throw new Error('the halt saved no state');
    expect(halted.pendingRecovery).toMatchObject({
      reason: 'implementer-left-isolation',
      taskId: 'T001',
    });
    const candidate = halted.pendingRecovery?.switchSeat?.candidates[0];
    expect(candidate).toEqual({ tool: 'claude-code' });
    if (candidate === undefined) throw new Error('the halt offered no other BUILD tool');

    const { bus } = makeBusRecorder();
    const moved = await applyOfferedSeatSwap({
      choice: { candidate, policy: RESUME_POLICY },
      projectDir,
      sessionId,
      bus,
      config,
      prepared,
      savedState: halted,
      prepare: async (request) => ({
        kind: 'prepared',
        execution: makePreparedExecution({
          projectDir,
          sessionId,
          feature: request.feature,
          config: request.effectiveConfig,
          ...(request.resumeState !== undefined && { resumeState: request.resumeState }),
        }),
      }),
    });
    if (moved === undefined) throw new Error('the seat move was not applied');

    const resumed: EngineEvent[] = [];
    const summary = await runTrackedWorkflow({
      prepared: moved.prepared,
      savedState: moved.state,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: makePlanner({ typedCall: typedCallFromTasks([task]) }),
      _implementer: implementer,
      _eventSink: (event) => resumed.push(event),
    });

    // The next tool starts on the file the halted call left, not on the brief's start.
    expect(seen).toEqual(['no file', FIRST_CALL]);
    expect(resumed).not.toContainEqual(
      expect.objectContaining({ type: 'warning', message: expect.stringMatching(/^Restored /) }),
    );
    expect(summary).toMatchObject({ totalTasks: 1, failed: 0 });
    const workspace = moved.state.workspace;
    if (workspace === undefined) throw new Error('the moved state recorded no workspace');
    expect(readFileSync(join(workspace.path, TARGET), 'utf-8')).toBe(NEXT_CALL);
  });
});
