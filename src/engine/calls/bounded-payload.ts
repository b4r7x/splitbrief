import { boundConsumerPayload } from '../../core/payload-bounds.js';
import { sanitizeTerminalDiagnosticText } from '../../utils/display-text/diagnostic.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  RUNNER_CALL_ARTIFACT_TEXT_MAX_BYTES,
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_PAYLOAD_TRUNCATED_KEY,
  RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES,
  runnerCallByteLimitMessage,
  type RunnerCallOutputLimit,
  type RunnerCallToolUse,
} from './output-limit.js';
import { UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH } from './schema.js';
import type { RunnerCallEvent } from './types.js';

export type RunnerCallArtifact = Extract<RunnerCallEvent, { type: 'call_artifact' }>['artifact'];

export interface RunnerCallBoundedValue<T> {
  value: T;
  limit: RunnerCallOutputLimit | null;
}

export function sanitizeRunnerCallRawPreview(rawPreview: string): string {
  return sanitizeTerminalDiagnosticText(rawPreview, {
    maxChars: UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH,
  });
}

export function boundRunnerCallToolUse(
  toolUse: RunnerCallToolUse,
): RunnerCallBoundedValue<RunnerCallToolUse> {
  const input = boundRunnerCallRecordPayload(
    toolUse.input,
    RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES,
    'A tool call input',
    'runner_call_tool_input_limit',
  );
  const output =
    toolUse.output === undefined
      ? null
      : boundRunnerCallPayload(
          toolUse.output,
          RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES,
          'A tool call output',
          'runner_call_tool_output_limit',
        );
  return {
    value: {
      ...toolUse,
      input: input.value,
      ...(output !== null && { output: output.value }),
    },
    limit: input.limit ?? output?.limit ?? null,
  };
}

export function boundRunnerCallArtifact(
  artifact: RunnerCallArtifact,
): RunnerCallBoundedValue<RunnerCallArtifact> {
  if (artifact.text === null) return { value: artifact, limit: null };
  const bounded = boundRunnerCallStringPayload(
    artifact.text,
    RUNNER_CALL_ARTIFACT_TEXT_MAX_BYTES,
    'An artifact',
    'runner_call_artifact_text_limit',
  );
  return {
    value: { ...artifact, text: bounded.value },
    limit: bounded.limit,
  };
}

export function boundRunnerCallStructured(structured: unknown): RunnerCallBoundedValue<unknown> {
  return boundRunnerCallPayload(
    structured,
    RUNNER_CALL_OUTPUT_MAX_BYTES,
    'The answer',
    'runner_call_structured_limit',
  );
}

function boundRunnerCallRecordPayload(
  value: Record<string, unknown>,
  maxBytes: number,
  label: string,
  code: string,
): RunnerCallBoundedValue<Record<string, unknown>> {
  const bounded = boundRunnerCallPayload(value, maxBytes, label, code);
  if (isRecord(bounded.value)) {
    return { value: bounded.value, limit: bounded.limit };
  }
  return {
    value: { [RUNNER_CALL_PAYLOAD_TRUNCATED_KEY]: bounded.value },
    limit: bounded.limit,
  };
}

function boundRunnerCallStringPayload(
  value: string,
  maxBytes: number,
  label: string,
  code: string,
): RunnerCallBoundedValue<string> {
  const bounded = boundConsumerPayload({
    context: 'session-log',
    payload: value,
    overrides: { maxBytes, maxStringBytes: maxBytes },
  });
  return {
    value: typeof bounded.payload === 'string' ? bounded.payload : String(bounded.payload),
    limit:
      bounded.truncated || bounded.oversized
        ? {
            code,
            message: runnerCallByteLimitMessage(label, maxBytes),
            bytesSeen: bounded.bytes,
            maxBytes,
          }
        : null,
  };
}

function boundRunnerCallPayload(
  value: unknown,
  maxBytes: number,
  label: string,
  code: string,
): RunnerCallBoundedValue<unknown> {
  const bounded = boundConsumerPayload({
    context: 'session-log',
    payload: value,
    overrides: { maxBytes, maxStringBytes: maxBytes },
  });
  return {
    value: bounded.payload,
    limit:
      bounded.truncated || bounded.oversized
        ? {
            code,
            message: runnerCallByteLimitMessage(label, maxBytes),
            bytesSeen: bounded.bytes,
            maxBytes,
          }
        : null,
  };
}
