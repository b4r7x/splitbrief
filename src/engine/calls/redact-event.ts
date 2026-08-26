import type { RunnerCallCredentialRedactor } from './status.js';
import { isRecord } from '../../utils/type-guards.js';
import type { RunnerCallEvent, RunnerCallEventInput, RunnerCallWarningInput } from './types.js';

export type RunnerCallToolUse = Extract<RunnerCallEvent, { type: 'call_tool_use_done' }>['toolUse'];

export function redactRunnerCallEventInput(
  input: RunnerCallEventInput,
  redact: RunnerCallCredentialRedactor,
): RunnerCallEventInput {
  switch (input.type) {
    case 'call_text_delta':
    case 'call_stderr_delta':
      return { ...input, text: redact(input.text) };
    case 'call_tool_use_delta':
      return {
        ...input,
        toolUseId: input.toolUseId === null ? null : redact(input.toolUseId),
        name: input.name === null ? null : redact(input.name),
        inputDelta: redact(input.inputDelta),
      };
    case 'call_tool_use_done':
      return { ...input, toolUse: redactRunnerCallToolUse(input.toolUse, redact) };
    case 'call_session_id':
      return { ...input, nativeSessionId: redact(input.nativeSessionId) };
    case 'call_artifact':
      return {
        ...input,
        artifact: {
          ...input.artifact,
          id: redact(input.artifact.id),
          name: redact(input.artifact.name),
          path: input.artifact.path === null ? null : redact(input.artifact.path),
          mimeType: input.artifact.mimeType === null ? null : redact(input.artifact.mimeType),
          text: input.artifact.text === null ? null : redact(input.artifact.text),
        },
      };
    case 'call_warning':
      return { ...input, warning: redactRunnerCallWarningInput(input.warning, redact) };
    case 'call_error':
      return {
        ...input,
        error: {
          code: redact(input.error.code),
          message: redact(input.error.message),
        },
        nativeSessionId: input.nativeSessionId === null ? null : redact(input.nativeSessionId),
      };
    case 'call_completed':
      return {
        ...input,
        nativeSessionId: input.nativeSessionId === null ? null : redact(input.nativeSessionId),
      };
    case 'call_unknown_upstream':
      return {
        ...input,
        rawPreview: redact(input.rawPreview),
        backendMetadata: {
          ...input.backendMetadata,
          ...(input.backendMetadata.source !== undefined && {
            source: redact(input.backendMetadata.source),
          }),
          ...(input.backendMetadata.parser !== undefined && {
            parser: redact(input.backendMetadata.parser),
          }),
          ...(input.backendMetadata.upstreamType !== undefined && {
            upstreamType: redact(input.backendMetadata.upstreamType),
          }),
        },
      };
    case 'call_started':
    case 'call_usage':
    case 'call_stalled':
    case 'call_stall_cleared':
      return input;
  }
}

export function redactRunnerCallWarningInput(
  warning: RunnerCallWarningInput,
  redact: RunnerCallCredentialRedactor,
): RunnerCallWarningInput {
  const code = redact(warning.code);
  const message = redact(warning.message);
  const source = warning.source === undefined ? undefined : redact(warning.source);
  const parser = warning.parser === undefined ? undefined : redact(warning.parser);
  const upstreamType =
    warning.upstreamType === undefined ? undefined : redact(warning.upstreamType);
  const fingerprint = warning.fingerprint === undefined ? undefined : redact(warning.fingerprint);
  const rawRef = warning.rawRef === undefined ? undefined : redact(warning.rawRef);
  const wasRedacted =
    code !== warning.code ||
    message !== warning.message ||
    source !== warning.source ||
    parser !== warning.parser ||
    upstreamType !== warning.upstreamType ||
    fingerprint !== warning.fingerprint ||
    rawRef !== warning.rawRef;

  return {
    ...warning,
    code,
    message,
    ...(source !== undefined && { source }),
    ...(parser !== undefined && { parser }),
    ...(upstreamType !== undefined && { upstreamType }),
    ...(fingerprint !== undefined && { fingerprint }),
    ...(rawRef !== undefined && { rawRef }),
    ...(wasRedacted && { redacted: true }),
  };
}

export function redactRunnerCallToolUse(
  toolUse: RunnerCallToolUse,
  redact: RunnerCallCredentialRedactor,
): RunnerCallToolUse {
  return {
    id: toolUse.id === null ? null : redact(toolUse.id),
    name: redact(toolUse.name),
    input: redactRunnerCallRecord(toolUse.input, redact),
    ...(toolUse.output !== undefined && {
      output: redactRunnerCallUnknown(toolUse.output, redact, new WeakSet<object>()),
    }),
  };
}

function redactRunnerCallRecord(
  value: Readonly<Record<string, unknown>>,
  redact: RunnerCallCredentialRedactor,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  const seen = new WeakSet<object>();
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    redacted[redact(key)] = redactRunnerCallUnknown(item, redact, seen);
  }
  return redacted;
}

function redactRunnerCallUnknown(
  value: unknown,
  redact: RunnerCallCredentialRedactor,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactRunnerCallUnknown(item, redact, seen));
    }
    if (!isRecord(value)) return value;
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[redact(key)] = redactRunnerCallUnknown(item, redact, seen);
    }
    return redacted;
  } finally {
    seen.delete(value);
  }
}
