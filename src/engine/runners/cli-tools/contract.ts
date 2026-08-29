import type { CLI_TOOL_CATALOG, CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type { CliExecutableIdentity, DetectedModel } from '../../../core/discovery/detection.js';
import type { AuthFact, ProbeOutcome } from '../../../core/discovery/runner-evidence.js';
import type { RunnerCallTextChannel } from '../../../core/runner-call-contract.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type {
  CliArgumentValidation,
  CliAuthorityCategory,
  CliParsedSemanticArg,
} from './validate-args.js';
import type {
  RunnerCallFailureStatus,
  RunnerCallTextSemantics,
  RunnerCallUsageSemantics,
} from '../../calls/types.js';

export type CliPromptTransport =
  | Readonly<{ kind: 'stdin' }>
  /**
   * `placement` records how the tool's own argv parser reads the prompt: a
   * `positional` prompt is parsed as an option when it starts with `-`, a
   * `flag-value` prompt occupies the value slot of its preceding flag and is
   * therefore inert.
   */
  | Readonly<{ kind: 'argv'; maxBytes: number; placement: 'positional' | 'flag-value' }>
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
  | Readonly<{
      type: 'text';
      channel: RunnerCallTextChannel | 'stderr';
      text: string;
      /** `final` restates a block already emitted as deltas; absent means append. */
      semantics?: RunnerCallTextSemantics | undefined;
    }>
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
  /** Adapter-owned prefix of `args`; anything past it is caller-configured. Absent means all of `args`. */
  baseArgs?: readonly string[] | undefined;
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

export type CliProbeOutput = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputExceeded: boolean;
}>;

export type CliProbeParser<Value> = (input: CliProbeOutput) => ProbeOutcome<Value>;

export type CliVersionProbe = CliProbeCommand &
  Readonly<{
    kind: 'version';
    parse: CliProbeParser<string>;
  }>;

export type CliAuthProbe =
  | Readonly<{ kind: 'not-run' }>
  | (CliProbeCommand &
      Readonly<{
        kind: 'auth-status';
        parse: (input: CliProbeOutput) => AuthFact;
      }>);

export type CliCatalogProbe =
  | Readonly<{ kind: 'not-run' }>
  | (CliProbeCommand &
      Readonly<{
        kind: 'catalog';
        /** A separately declared fixed manual command; never caller-mutated argv. */
        manualCommand?: readonly [string, ...string[]] | undefined;
        parse: CliProbeParser<readonly DetectedModel[]>;
      }>);

export type CliDeclaredProbeContract = Readonly<{
  kind: 'declared';
  version: CliVersionProbe;
  auth: CliAuthProbe;
  catalog: CliCatalogProbe;
}>;

/**
 * The legacy commands remain while detection migrates to adapter-declared
 * parser contracts. They carry no parser, so they cannot establish
 * authentication.
 */
export type CliProbeContract = Readonly<{
  version: CliProbeCommand;
  auth: CliProbeCommand;
  declared?: CliDeclaredProbeContract | undefined;
}>;

export function isDeclaredCliProbeContract(
  probe: CliProbeContract,
): probe is CliProbeContract & Readonly<{ declared: CliDeclaredProbeContract }> {
  return probe.declared !== undefined && probe.declared.kind === 'declared';
}

/**
 * The REQ-018 authority categories one role's adapter is allowed to own.
 * `role` binds the allowlist to the role it governs, so a planner allowlist
 * can never be attached to an implementer adapter and vice versa.
 */
export type CliRoleAllowlist<Role extends 'planner' | 'implementer'> = Readonly<{
  role: Role;
  owned: readonly CliAuthorityCategory[];
}>;

/**
 * Positive role allowlist admission (REQ-017, REQ-018): a parsed semantic
 * vector whose authority-bearing flags all fall inside the role's allowlist is
 * admitted; any flag outside the allowlist is a pre-dispatch rejection, and
 * the caller spawns nothing for a rejected vector.
 */
export function admitCliRoleVector(input: {
  role: 'planner' | 'implementer';
  vector: readonly CliParsedSemanticArg[];
  allowlist: CliRoleAllowlist<'planner' | 'implementer'>;
}): CliArgumentValidation {
  if (input.role !== input.allowlist.role) return { valid: false, conflicts: ['role'] };
  const conflicts: string[] = [];
  for (const arg of input.vector) {
    if (arg.category === null || input.allowlist.owned.includes(arg.category)) continue;
    conflicts.push(arg.token);
  }
  return conflicts.length === 0
    ? { valid: true }
    : { valid: false, conflicts: [...new Set(conflicts)] };
}

export type CliTerminalInput = Readonly<{
  outputContract: CliOutputContract;
  events: readonly CliProtocolEvent[];
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
  baseArgs: (input: BuildArgsInput) => readonly string[];
  buildArgs: (input: BuildArgsInput) => readonly string[];
  validateArgs: (input: {
    invocationArgs: readonly string[];
    baseArgs: readonly string[];
  }) => CliArgumentValidation;
  environment: Readonly<Record<string, string>>;
  outputContract: CliOutputContract;
  parse: (line: string) => readonly CliProtocolEvent[];
  terminal: (input: CliTerminalInput) => CliProtocolTerminalEvent;
  probe: CliProbeContract;
  /** The positive REQ-018 allowlist this role's adapter owns; absent means none declared. */
  roleAllowlist?: CliRoleAllowlist<Role> | undefined;
}>;

export type CliPlannerBuildArgsInput = Readonly<{
  prompt: string;
  model: string | undefined;
  projectDir: string;
  configuredArgs: readonly string[];
  mode: 'plan' | 'escalate';
  sessionId: string | null;
  effort: EffortLevel | undefined;
}>;

export type CliImplementerBuildArgsInput = Readonly<{
  prompt: string;
  model: string | undefined;
  projectDir: string;
  configuredArgs: readonly string[];
  effort?: EffortLevel | undefined;
}>;

export type CliPlannerAdapter<Tool extends CliToolId = CliToolId> = CliAdapterContract<
  Tool,
  'planner',
  CliPlannerBuildArgsInput
> &
  Readonly<{ supportsSessionResume: boolean; supportsEffort: boolean }>;

export type CliImplementerAdapter<Tool extends CliToolId = CliToolId> = CliAdapterContract<
  Tool,
  'implementer',
  CliImplementerBuildArgsInput
>;

/** The subset of the adapter contract the process executor reads. */
export type CliProcessAdapter = Readonly<{
  descriptor: Readonly<{
    id: string;
    auth: Readonly<{ channels: readonly Readonly<{ env: readonly string[] }>[] }>;
  }>;
  promptTransport: CliPromptTransport;
  validateArgs: (input: {
    invocationArgs: readonly string[];
    baseArgs: readonly string[];
  }) => CliArgumentValidation;
  outputContract: CliOutputContract;
  parse: (line: string) => readonly CliProtocolEvent[];
  terminal: (input: CliTerminalInput) => CliProtocolTerminalEvent;
}>;
