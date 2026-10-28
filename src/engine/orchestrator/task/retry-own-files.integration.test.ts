import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
  setupTaskProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import { loadState } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { ImplementerOptions, RetryOptions } from '../../implementers/types.js';
import type { Validator } from '../validation/types.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { inputHashesNow } from './stale-inputs.js';
import { runSingleTask } from './step.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTaskProjects();
});

const config = makeConfig({
  planner: { kind: 'cli', tool: 'claude-code' },
  reviewer: { kind: 'cli', tool: 'codex' },
  validation: { endChecks: false, testCommand: 'noop' },
  workflow: { review: 'task' },
});
const validator: Validator = { formatChangedFiles: vi.fn().mockResolvedValue(undefined) };
const NEW_FILE = 'src/new.ts';
const STALE_TEXT = 'inputs changed since the brief was compiled';

function runTask(wctx: WorkflowContext, state: WorkflowState): Promise<WorkflowState> {
  const task = state.tasks[state.currentTaskIndex];
  if (task === undefined) throw new Error('The recovery lost its task.');
  return runSingleTask({
    wctx,
    task,
    state,
    index: state.currentTaskIndex,
    totalTasks: state.tasks.length,
    taskBreakdowns: [],
    setTrackedState: () => {},
    setCurrentTask: () => {},
  });
}

function writeNewFile(projectDir: string, content: string): void {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, NEW_FILE), content);
}

/** A planner seat whose every typed call stops the way a killed planner process does. */
function stoppedPlanner() {
  return makePlanner({
    typedCall: vi.fn(() => {
      throw new Error('The planner process stopped unexpectedly.');
    }),
  });
}

/** The brief's required check fails while `failing` holds, and passes after. */
function scriptedCheck(failing: { value: boolean }): void {
  vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
    if (!failing.value) return { stdout: '', stderr: '', code: 0 };
    throw processError.exitCode({
      command: 'tsc',
      code: 2,
      stderr: 'src/new.ts(1,23): error TS1109: Expression expected.',
      output: '',
    });
  });
}

/**
 * The brief creates `src/new.ts`. Its first attempt writes the file, then its planner call stops:
 * the consult after the attempt and its local retry fail the brief's check. Try again runs the
 * brief once more; each build call
 * of that run records the lineage's consult count as saved when the call starts, and the action it
 * was dispatched with.
 */
async function retryAfterHalt() {
  const ref = setupTaskProject();
  const task = makeTask({
    id: 'T001',
    action: 'create',
    suggestedFiles: [NEW_FILE],
    criteria: [],
    checks: [{ id: 'T001-K1', kind: 'cmd', value: 'tsc --noEmit', required: true }],
    inputHashes: inputHashesNow(ref.projectDir, [NEW_FILE]),
  });
  const failing = { value: true };
  scriptedCheck(failing);
  const writeAndFail = async (opts: ImplementerOptions | RetryOptions) => {
    writeNewFile(opts.projectDir, 'export const broken = ;\n');
    return {
      success: true,
      output: 'implemented',
      report: {
        status: 'done' as const,
        filesChanged: [NEW_FILE],
        touchedNotSuggested: [],
        notes: null,
        decisions: [],
      },
    };
  };
  const { bus } = makeBusRecorder();
  const wctx = makeTaskWorkflowContext({
    ...ref,
    config,
    bus,
    validator,
    planner: stoppedPlanner(),
    implementer: makeImplementer({ implement: vi.fn(writeAndFail), retry: vi.fn(writeAndFail) }),
  });
  const halted = await runTask(wctx, makeImplStateWithMetadata([task]));
  expect(halted.pendingRecovery).toMatchObject({ reason: 'planner-call-failed', taskId: 'T001' });

  const retried = await applyRecoveryAction({
    ...ref,
    bus,
    config,
    state: halted,
    action: 'retry-same-worker',
  });
  if (!retried.ok) throw new Error(retried.message);
  failing.value = false;

  const builds: { consults: number | undefined; action: string; call: string }[] = [];
  const build = async (opts: ImplementerOptions | RetryOptions) => {
    builds.push({
      consults: loadState(ref)?.lineages?.T001?.consults,
      action: opts.task.action,
      call: JSON.stringify(opts),
    });
    writeNewFile(opts.projectDir, 'export const run = 1;\n');
    return { success: true, output: 'implemented' };
  };
  const planner = makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) });
  const recovered = await runTask(
    {
      ...wctx,
      planner,
      implementer: makeImplementer({ implement: vi.fn(build), retry: vi.fn(build) }),
    },
    retried.state,
  );
  return { halted, recovered, builds };
}

describe('Try again on a brief whose first attempt wrote its own files', () => {
  it('runs no stale consult after a failed-consult halt and keeps the brief creating its file', async () => {
    const { halted, recovered, builds } = await retryAfterHalt();

    expect(recovered.lineages?.T001?.consultRecords ?? []).not.toContainEqual(
      expect.objectContaining({ reason: 'stale' }),
    );
    expect(builds[0]?.consults).toBe(halted.lineages?.T001?.consults);
    expect(builds[0]?.call).not.toContain(STALE_TEXT);
    expect(builds[0]?.action).toBe('create');
    expect(recovered.tasks[0]?.action).toBe('create');
  });
});
