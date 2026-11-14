import { invokeClaudePlanner } from '../../src/engine/planners/claude-code/invoke.js';
import { createRunnerSandboxEnv } from '../../src/engine/runners/sandbox/env.js';
import type { CliStartGate } from '../../src/engine/runners/start-gate.js';
import { admittedCliSeat } from './runner-gate.js';

type Invocation = Parameters<typeof invokeClaudePlanner>[0];

export async function invokeTestClaude(
  opts: Omit<Invocation, 'callbacks' | 'callContext' | 'env' | 'cliSeat' | 'sessionId'> &
    Invocation['callbacks'] & {
      env?: NodeJS.ProcessEnv;
      executable?: CliStartGate['executable'];
      sessionId?: string | null;
    },
): ReturnType<typeof invokeClaudePlanner> {
  const env =
    opts.env ??
    (await createRunnerSandboxEnv(
      opts.projectDir,
      { kind: 'cli', tool: 'claude-code' },
      'planner',
    ));
  return invokeClaudePlanner({
    ...opts,
    env,
    sessionId: opts.sessionId ?? null,
    cliSeat:
      opts.executable === undefined
        ? undefined
        : admittedCliSeat({ tool: 'claude-code', executable: opts.executable }),
    callbacks: opts,
    callContext: {
      callId: 'claude-production-test',
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'claude',
    },
  });
}
