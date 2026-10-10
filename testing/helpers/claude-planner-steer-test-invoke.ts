import { invokeClaudePlanner } from '../../src/engine/planners/claude-invoke.js';
import { createRunnerSandboxEnv } from '../../src/engine/runners/sandbox-env.js';

type Invocation = Parameters<typeof invokeClaudePlanner>[0];

export async function invokeTestClaude(
  opts: Omit<
    Invocation,
    | 'callbacks'
    | 'callContext'
    | 'env'
    | 'authChannel'
    | 'configuredAuthChannel'
    | 'trustedCli'
    | 'sessionId'
    | 'mode'
  > &
    Invocation['callbacks'] & {
      env?: NodeJS.ProcessEnv;
      authChannel?: Invocation['authChannel'];
      executable?: NonNullable<Invocation['trustedCli']>['executable'];
      sessionId?: string | null;
      mode?: Invocation['mode'];
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
    mode: opts.mode ?? 'plan',
    sessionId: opts.sessionId ?? null,
    trustedCli: opts.executable === undefined ? undefined : { executable: opts.executable },
    callbacks: opts,
    callContext: {
      callId: 'claude-production-test',
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'claude',
    },
  });
}
