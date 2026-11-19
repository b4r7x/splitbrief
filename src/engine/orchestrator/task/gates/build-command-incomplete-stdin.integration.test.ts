import { afterEach, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
  setupTaskProject,
} from '#testing/helpers/orchestrator-task-context.js';
import {
  cannotConsult,
  consultCallAnswering,
  guidanceConsult,
} from '#testing/helpers/typed-planner.js';
import { createCommandImplementer } from '../../../implementers/command-invoke.js';
import { createImplementerPublisher } from '../../publish/runner.js';
import { runSingleTask } from '../step.js';

afterEach(cleanupTaskProjects);

const startupError = JSON.stringify({ type: 'result', is_error: true, result: 'Startup failed' });

const rows = [
  { name: 'clean exit', kind: 'agent', script: 'exit 0' },
  {
    name: 'structured startup failure followed by clean exit',
    kind: 'shell',
    outputFormat: 'stream-json',
    script: `printf '%s\\n' '${startupError}'; printf '%s' 'Check the workspace index' >&2; exit 0`,
    stderr: 'Check the workspace index',
  },
  { name: 'signal exit', kind: 'shell', script: 'kill -TERM "$$"' },
  { name: 'silent exit 23', kind: 'agent', script: 'exit 23', exitCode: 23 },
  {
    name: 'silent missing helper',
    kind: 'shell',
    script: 'exec splitbrief-missing-workspace-helper 2>/dev/null',
    exitCode: 127,
  },
] as const;

it.each(rows)('records the BUILD failure after $name before reading stdin', async (row) => {
  const { projectDir, sessionId } = setupTaskProject();
  const { bus, events } = makeBusRecorder();
  const config = makeConfig({
    implementer: {
      kind: row.kind,
      model: 'test',
      command: '/bin/sh',
      args: ['-c', row.script],
      ...('outputFormat' in row && { outputFormat: row.outputFormat }),
    },
    validation: { endChecks: false },
  });
  // A prompt larger than the pipe cannot be written to a command that reads none of it.
  const task = makeTask({ description: 'Context for the task.\n'.repeat(20_000) });
  let consults = 0;
  const planner = makePlanner({
    typedCall: consultCallAnswering(() => {
      consults += 1;
      return consults === 1 ? guidanceConsult() : cannotConsult('The command does not read stdin.');
    }),
  });
  const state = await runSingleTask({
    wctx: makeTaskWorkflowContext({
      projectDir,
      sessionId,
      bus,
      config,
      planner,
      implementer: createCommandImplementer(config, row.kind, {
        publisher: createImplementerPublisher(bus),
      }),
    }),
    task,
    index: 0,
    totalTasks: 1,
    state: makeImplStateWithMetadata([task]),
    taskBreakdowns: [],
    setTrackedState: vi.fn(),
    setCurrentTask: vi.fn(),
  });

  const builds = events.filter((event) => event.type === 'implementer_generate_failed');
  const callErrors = events.flatMap((event) =>
    event.type === 'runner_call_error' && event.role === 'implementer' ? [event.error] : [],
  );
  if ('exitCode' in row) {
    expect(callErrors[0]).toMatchObject({
      code: 'process-output',
      message: `/bin/sh exited with code ${row.exitCode}`,
    });
    expect(builds[0]?.error).toContain(`/bin/sh exited with code ${row.exitCode}`);
    return;
  }

  const message = 'prompt could not be fully delivered through stdin';
  expect({
    reason: state.pendingRecovery?.reason,
    consults,
    buildErrors: builds.map((event) => event.error),
    callErrors: callErrors.map(({ code, message }) => ({ code, message })),
  }).toEqual({
    reason: 'implementer-recipe-invalid',
    consults: 0,
    buildErrors: [expect.stringContaining(message)],
    callErrors: [
      ...('stderr' in row ? [{ code: 'runner_result_error', message: 'Startup failed' }] : []),
      {
        code: 'prompt-transport-error',
        message: expect.stringContaining('stderr' in row ? `${message}: ${row.stderr}` : message),
      },
    ],
  });
});
