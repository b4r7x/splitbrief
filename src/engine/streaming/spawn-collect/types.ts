import type { RunnerCallRecorder } from '../../calls/recorder/types.js';
import type { RunnerCallResult } from '../../calls/types.js';
import type { ParsedLineRecorder } from '../parsed-line-recorder.js';
import type { InvocationCancellation } from './cancellation.js';
import type { RedactedStream } from './redacted-stream.js';

export type CollectResult = RunnerCallResult & { sessionId?: string | null };

/** One collected runner call: what its spawn, its close and its thrown failure read. */
export type CollectCall = Readonly<{
  command: string;
  timeoutMs: number | undefined;
  /** The values each record redacts. */
  credentialValues: readonly string[];
  /** Redacts the credential values, then the declared values of the call. */
  redactCredential: (value: string) => string;
  /** Aborts when the tool-call limit stops the call. */
  limitSignal: AbortSignal;
  cancellation: InvocationCancellation;
  recorder: RunnerCallRecorder;
  parsedRecorder: ParsedLineRecorder;
  stream: RedactedStream;
}>;
