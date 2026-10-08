import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import { collectRunnerCallResult } from '../../calls/collector.js';
import { RUNNER_CALL_TOOL_USE_MAX_ITEMS } from '../../calls/output-limit.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import {
  runnerCallFailureMessage,
  runnerCallOutcome,
} from '../../implementers/pipeline/call-result.js';
import { handleRetryAndEscalation } from './handle.js';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'tool-use-limit-test',
    sessionId: 'sess-tool-use-limit',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function makeValidatingState(): WorkflowState {
  const task = makeTask();
  return transition(makeImplState([task]), { type: 'TASK_SENT' });
}

const base = {
  ts: 1,
  callId: 'call-tool-use',
  role: 'implementer',
  backendKind: 'cli',
} as const;

function toolFlood(): RunnerCallEvent[] {
  const events: RunnerCallEvent[] = [{ type: 'call_started', ...base }];
  for (let index = 0; index < RUNNER_CALL_TOOL_USE_MAX_ITEMS + 2; index += 1) {
    events.push({
      type: 'call_tool_use_done',
      ...base,
      ts: index + 1,
      channel: 'tool',
      toolUse: { id: `tool-${index}`, name: 'read_file', input: { path: `file-${index}.ts` } },
    });
  }
  events.push({
    type: 'call_completed',
    ...base,
    status: 'completed',
    startedAt: 1,
    endedAt: 20,
    durationMs: 19,
    partial: false,
    error: null,
    usage: null,
    nativeSessionId: 'native-1',
  });
  return events;
}

describe('implementer tool-use limit', () => {
  it('ends the call as tool-use-limit and carries the last calls in its error', () => {
    const result = collectRunnerCallResult(toolFlood());

    expect(result.status).toBe('truncated');
    expect(result.error?.code).toBe('runner_call_tool_use_count_limit');
    expect(result.error?.message).toContain('Recent tool calls');
    expect(result.error?.message).toContain('file-');
    expect(runnerCallOutcome(result).state).toBe('tool-use-limit');
  });

  it('consults once with the last calls and no local retry', async () => {
    const { projectDir, sessionId } = setupProject();
    const result = collectRunnerCallResult(toolFlood());
    const outcome = runnerCallOutcome(result);
    if (outcome.state === 'success') throw new Error('expected a failed outcome');
    const summary = runnerCallFailureMessage(result, undefined);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const retry = vi.fn().mockResolvedValue({ success: true, output: 'fixed', usage: null });
    const implementer = makeImplementer({ retry });
    const prompts: string[] = [];
    const planner = makePlanner({
      typedCall: consultCallAnswering((prompt) => {
        prompts.push(prompt);
        return guidanceConsult();
      }),
    });

    const { result: runResult } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: summary,
      currentState: makeValidatingState(),
      initialFailure: { outcome: outcome.state, runner: makeNoValidationConfig().implementer },
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Recent tool calls');
    expect(prompts[0]).toContain('file-');
    expect(events.filter((e) => e.type === 'task_retry')).toEqual([]);
    expect(runResult).toMatchObject({ completed: true, method: 'consulted' });
  });
});
