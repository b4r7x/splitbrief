import type { TokenDelta } from '../../core/schemas/tokens.js';

export interface ToolUseInfo {
  name: string;
  input: Record<string, unknown>;
}

export type ParsedLine =
  | { text: string; usage?: TokenDelta | undefined; isResult?: boolean | undefined; sessionId?: string | undefined; toolUse?: ToolUseInfo[] | undefined }
  | { text?: undefined; usage: TokenDelta; isResult?: boolean | undefined; sessionId?: string | undefined; toolUse?: ToolUseInfo[] | undefined }
  | { text?: undefined; usage?: undefined; isResult?: undefined; sessionId?: string | undefined; toolUse?: ToolUseInfo[] | undefined };

export interface InvokeResult {
  text: string;
  usage: TokenDelta | null;
}

export interface RunnerRuntime {
  isAvailable(): Promise<boolean>;
  getVersion(): Promise<string | null>;
}
