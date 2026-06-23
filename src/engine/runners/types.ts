import type { TokenDelta } from '../../core/schemas/tokens.js';
import type {
  RunnerCallTextChannel,
  RUNNER_CALL_USAGE_SEMANTICS,
  RUNNER_CALL_WARNING_SEVERITIES,
  RUNNER_CALL_WARNING_SURFACES,
} from '../../core/runner-call-contract.js';

export interface ToolUseInfo {
  id?: string | undefined;
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
}

export interface ToolUseDeltaInfo {
  id?: string | undefined;
  name?: string | undefined;
  inputDelta: string;
}

export interface ParsedWarningInfo {
  code: string;
  message: string;
  severity?: (typeof RUNNER_CALL_WARNING_SEVERITIES)[number] | undefined;
  source?: string | undefined;
  surface?: (typeof RUNNER_CALL_WARNING_SURFACES)[number] | undefined;
  parser?: string | undefined;
  upstreamType?: string | undefined;
  channel?: RunnerCallTextChannel | 'stderr' | 'tool' | undefined;
  fingerprint?: string | undefined;
  rawRef?: string | undefined;
}

export type ParsedTextChannel = RunnerCallTextChannel;
export type ParsedUsageSemantics = (typeof RUNNER_CALL_USAGE_SEMANTICS)[number];

export type ParsedLine =
  | {
      text: string;
      channel?: ParsedTextChannel | undefined;
      usage?: TokenDelta | undefined;
      usageSemantics?: ParsedUsageSemantics | undefined;
      isResult?: boolean | undefined;
      isError?: boolean | undefined;
      sessionId?: string | undefined;
      toolUse?: ToolUseInfo[] | undefined;
      toolUseStart?: ToolUseInfo[] | undefined;
      toolUseDelta?: ToolUseDeltaInfo[] | undefined;
      toolUseDone?: ToolUseInfo[] | undefined;
      warning?: ParsedWarningInfo[] | undefined;
    }
  | {
      text?: undefined;
      channel?: undefined;
      usage: TokenDelta;
      usageSemantics?: ParsedUsageSemantics | undefined;
      isResult?: boolean | undefined;
      isError?: boolean | undefined;
      sessionId?: string | undefined;
      toolUse?: ToolUseInfo[] | undefined;
      toolUseStart?: ToolUseInfo[] | undefined;
      toolUseDelta?: ToolUseDeltaInfo[] | undefined;
      toolUseDone?: ToolUseInfo[] | undefined;
      warning?: ParsedWarningInfo[] | undefined;
    }
  | {
      text?: undefined;
      channel?: undefined;
      usage?: undefined;
      usageSemantics?: undefined;
      isResult?: undefined;
      isError?: boolean | undefined;
      sessionId?: string | undefined;
      toolUse?: ToolUseInfo[] | undefined;
      toolUseStart?: ToolUseInfo[] | undefined;
      toolUseDelta?: ToolUseDeltaInfo[] | undefined;
      toolUseDone?: ToolUseInfo[] | undefined;
      warning?: ParsedWarningInfo[] | undefined;
    };

/**
 * Compatibility return shape for legacy runner adapters.
 * New typed call records should use `RunnerCallResult` from `src/engine/calls/types.ts`.
 */
export interface InvokeResult {
  text: string;
  usage: TokenDelta | null;
}

export interface RunnerRuntime {
  isAvailable(): Promise<boolean>;
  getVersion(): Promise<string | null>;
}
