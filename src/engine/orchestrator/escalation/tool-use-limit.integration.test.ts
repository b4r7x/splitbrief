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
import { createRunnerCallRecorder } from '../../calls/recorder.js';
import type { RunnerCallResult } from '../../calls/types.js';
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

const MAX_TOOL_CALLS = 10;

/** The call a seat with `maxToolCalls: 10` ends: its 11th tool use stops it. */
function stoppedCall(): RunnerCallResult {
  const recorder = createRunnerCallRecorder({
    context: { callId: 'call-tool-use', role: 'implementer', backendKind: 'cli' },
    startedAt: 1,
    stopAfterToolUses: MAX_TOOL_CALLS,
  });
  for (let index = 0; index <= MAX_TOOL_CALLS; index += 1) {
    recorder.toolUseDone({
      toolUse: { id: `tool-${index}`, name: 'read_file', input: { path: `file-${index}.ts` } },
    });
  }
  return recorder.finishIncomplete({ endedAt: 20 });
}

describe('implementer tool-use stop', () => {
  it('ends the call as tool-use-limit, names the configured number and the last calls', () => {
    const result = stoppedCall();

    expect(result.status).toBe('truncated');
    expect(result.error?.code).toBe('runner_call_tool_use_stop');
    expect(result.error?.message).toContain(
      `The call reached the maxToolCalls limit of ${MAX_TOOL_CALLS} tool calls and was stopped.`,
    );
    expect(result.error?.message).toContain('Recent tool calls');
    expect(result.error?.message).toContain('file-');
    expect(runnerCallOutcome(result).state).toBe('tool-use-limit');
  });

  it('keeps a call without maxToolCalls a success past 256 tool uses', () => {
    const recorder = createRunnerCallRecorder({
      context: { callId: 'call-tool-use', role: 'implementer', backendKind: 'cli' },
      startedAt: 1,
    });
    for (let index = 0; index < 300; index += 1) {
      recorder.toolUseDone({
        toolUse: { id: `tool-${index}`, name: 'read_file', input: { path: `file-${index}.ts` } },
      });
    }

    expect(runnerCallOutcome(recorder.finishCompleted({ endedAt: 20 })).state).toBe('success');
  });

  it('consults once with the last calls and no local retry', async () => {
    const { projectDir, sessionId } = setupProject();
    const result = stoppedCall();
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
