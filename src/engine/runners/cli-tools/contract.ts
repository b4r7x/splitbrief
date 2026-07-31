import type { CLI_TOOL_CATALOG, CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import type { RunnerCallTextChannel } from '../../../core/runner-call-contract.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { RunnerCallFailureStatus, RunnerCallUsageSemantics } from '../../calls/types.js';

export type CliPromptTransport =
  | Readonly<{ kind: 'stdin' }>
  | Readonly<{ kind: 'argv'; maxBytes: number }>
  | Readonly<{ kind: 'file'; mode: 0o600 }>;

type CliProtocolTerminalEvent =
  | Readonly<{
      type: 'result';
      status: 'completed';
      text: string;
      usage: TokenDelta | null;
      nativeSessionId: string | null;
      error: null;
      partial: false;
    }>
  | Readonly<{
      type: 'result';
      status: RunnerCallFailureStatus;
      text: string;
      usage: TokenDelta | null;
      nativeSessionId: string | null;
      error: Readonly<{ code: string; message: string }>;
      partial: boolean;
    }>;

export type CliProtocolEvent =
  | Readonly<{ type: 'text'; channel: RunnerCallTextChannel | 'stderr'; text: string }>
  | Readonly<{ type: 'usage'; usage: TokenDelta; semantics: RunnerCallUsageSemantics }>
  | Readonly<{ type: 'session'; nativeSessionId: string }>
  | Readonly<{
      type: 'tool-use';
      id: string | null;
      name: string;
      input: Readonly<Record<string, unknown>>;
      output?: unknown;
    }>
  | Readonly<{ type: 'warning'; code: string; message: string }>
  | CliProtocolTerminalEvent;

export type CliOutputContract =
  | Readonly<{ kind: 'structured-terminal'; terminalEvent: 'required' }>
  | Readonly<{
      kind: 'text-exit';
      successfulExitCodes: readonly [number, ...number[]];
    }>;

export type CliInvocation = Readonly<{
  executable: CliExecutableIdentity;
  args: readonly string[];
  promptTransport: CliPromptTransport;
  environment: Readonly<Record<string, string>>;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}>;

export type CliProbeCommand = Readonly<{
  command: readonly [string, ...string[]];
  cwd: 'neutral';
  timeoutMs: number;
  maxOutputBytes: number;
}>;

export type CliProbeContract = Readonly<{
  version: CliProbeCommand;
  auth: CliProbeCommand;
}>;

type CliArgumentValidation =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; conflicts: readonly string[] }>;

type CliTerminalInput = Readonly<{
  outputContract: CliOutputContract;
  events: readonly CliProtocolEvent[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}>;

type CliAdapterContract<
  Tool extends CliToolId,
  Role extends 'planner' | 'implementer',
  BuildArgsInput,
> = Readonly<{
  descriptor: (typeof CLI_TOOL_CATALOG)[Tool];
  role: Role;
  promptTransport: CliPromptTransport;
  buildArgs: (input: BuildArgsInput) => readonly string[];
  validateArgs: (invocationArgs: readonly string[]) => CliArgumentValidation;
  environment: Readonly<Record<string, string>>;
  outputContract: CliOutputContract;
  parse: (line: string) => readonly CliProtocolEvent[];
  terminal: (input: CliTerminalInput) => CliProtocolTerminalEvent;
  probe: CliProbeContract;
}>;

type CliPlannerBuildArgsInput = Readonly<{
  prompt: string;
  model: string | undefined;
  projectDir: string;
  configuredArgs: readonly string[];
  mode: 'plan' | 'escalate';
  sessionId: string | null;
  effort: EffortLevel | undefined;
}>;

type CliImplementerBuildArgsInput = Readonly<{
  prompt: string;
  model: string | undefined;
  projectDir: string;
  configuredArgs: readonly string[];
}>;

export type CliPlannerAdapter<Tool extends CliToolId = CliToolId> = CliAdapterContract<
  Tool,
  'planner',
  CliPlannerBuildArgsInput
>;

export type CliImplementerAdapter<Tool extends CliToolId = CliToolId> = CliAdapterContract<
  Tool,
  'implementer',
  CliImplementerBuildArgsInput
>;
