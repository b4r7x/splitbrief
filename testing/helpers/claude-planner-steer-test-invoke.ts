import { invokeClaudePlanner } from '../../src/engine/planners/claude-invoke.js';
import { createRunnerSandboxEnv } from '../../src/engine/runners/sandbox-env.js';
import type { CliStartGate } from '../../src/engine/runners/start-gate.js';
import { admittedCliSeat } from './runner-gate.js';

type Invocation = Parameters<typeof invokeClaudePlanner>[0];

export async function invokeTestClaude(
  opts: Omit<
    Invocation,
    | 'callbacks'
    | 'callContext'
    | 'env'
    | 'authChannel'
    | 'configuredAuthChannel'
    | 'cliSeat'
    | 'sessionId'
  > &
    Invocation['callbacks'] & {
      env?: NodeJS.ProcessEnv;
      authChannel?: Invocation['authChannel'];
      executable?: CliStartGate['executable'];
      sessionId?: string | null;
    },
): ReturnType<typeof invokeClaudePlanner> {
  const authChannel = opts.authChannel ?? 'session';
  const env =
    opts.env ??
    (await createRunnerSandboxEnv(
      opts.projectDir,
      { kind: 'cli', tool: 'claude-code', authChannel },
      'planner',
    ));
  return invokeClaudePlanner({
    ...opts,
    env,
    authChannel,
    configuredAuthChannel: undefined,
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
