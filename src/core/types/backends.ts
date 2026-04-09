import type { TokenDelta } from './summary.js';

export interface ParsedLine {
  text?: string | undefined;
  usage?: TokenDelta | undefined;
  isResult?: boolean | undefined;
  sessionId?: string | undefined;
}

export interface InvokeResult {
  text: string;
  usage: TokenDelta | null;
}

export interface Backend {
  isAvailable(): Promise<boolean>;
  getVersion(): Promise<string | null>;
}
