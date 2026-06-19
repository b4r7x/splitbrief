import type { TokenDelta } from '../../core/schemas/tokens.js';

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
}

export type ParsedTextChannel = 'stdout' | 'assistant' | 'result' | 'system';

export type ParsedLine =
  | {
      text: string;
      channel?: ParsedTextChannel | undefined;
      usage?: TokenDelta | undefined;
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
