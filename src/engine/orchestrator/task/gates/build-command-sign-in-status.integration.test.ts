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
import { cannotConsult, consultCallAnswering } from '#testing/helpers/typed-planner.js';
import { createCommandImplementer } from '../../../implementers/command-invoke.js';
import { createImplementerPublisher } from '../../publish/runner.js';
import { runSingleTask } from '../step.js';

afterEach(cleanupTaskProjects);

it.each([
  {
    name: 'a successful sign-in status followed by an ordinary error',
    output: 'Sign in was successful.\nError: workspace index is corrupt.\n',
    code: 23,
    reason: 'retry-exhausted',
    consults: 1,
    diagnostic: 'Error: workspace index is corrupt.',
  },
  {
    name: 'a sign-in refusal',
    output: 'Error: not logged in\n',
    code: 1,
    reason: 'runner-unauthenticated',
    consults: 0,
    diagnostic: 'Error: not logged in',
  },
])('handles $name from a configured BUILD command', async (row) => {
  const { projectDir, sessionId } = setupTaskProject();
  const { bus, events } = makeBusRecorder();
  const config = makeConfig({
    implementer: {
      kind: 'agent',
      model: 'test',
      command: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `for await (const chunk of process.stdin) void chunk;
         process.stderr.write(${JSON.stringify(row.output)});
         process.exitCode = ${row.code};`,
      ],
    },
    validation: { endChecks: false },
  });
  const task = makeTask();
  const state = await runSingleTask({
    wctx: makeTaskWorkflowContext({
      projectDir,
      sessionId,
      bus,
      config,
      signal: new AbortController().signal,
      planner: makePlanner({
        typedCall: consultCallAnswering(() => cannotConsult('The workspace needs attention.')),
      }),
      implementer: createCommandImplementer(config, 'agent', {
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

  expect(state.pendingRecovery?.reason).toBe(row.reason);
  expect(events.filter((event) => event.type === 'consult_answered')).toHaveLength(row.consults);
  const buildErrors = events.flatMap((event) =>
    event.type === 'implementer_generate_failed' ? [event.error] : [],
  );
  expect(buildErrors).toEqual([expect.stringContaining(row.diagnostic)]);
  expect(buildErrors[0]).toContain(`exited with code ${row.code}`);
});
