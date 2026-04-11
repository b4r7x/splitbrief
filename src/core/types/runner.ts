import type { TokenDelta } from './summary.js';

export type ParsedLine =
  | { text: string; usage?: TokenDelta | undefined; isResult?: boolean | undefined; sessionId?: string | undefined }
  | { text?: undefined; usage: TokenDelta; isResult?: boolean | undefined; sessionId?: string | undefined }
  | { text?: undefined; usage?: undefined; isResult?: undefined; sessionId?: string | undefined };

export interface InvokeResult {
  text: string;
  usage: TokenDelta | null;
}

export interface RunnerRuntime {
  isAvailable(): Promise<boolean>;
  getVersion(): Promise<string | null>;
}
