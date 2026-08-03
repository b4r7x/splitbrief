import { error } from '../../utils/error.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  createSanitizedChildEnv,
  isSafePreservedChildEnvKey,
} from '../../lib/process/spawn/lifecycle.js';
import type { ParsedLine, ParsedWarningInfo, ToolUseDeltaInfo, ToolUseInfo } from './types.js';

const CUSTOM_RUNNER_ENVIRONMENT_MAX_BYTES = 256 * 1024;
const CUSTOM_RUNNER_REDACTION_MARKER = '***REDACTED***';

export const customRunnerEnvironmentError = {
  blocked: (name: string) =>
    error(
      'custom-runner-environment-blocked',
      `Custom runner environment reference is blocked: ${name}`,
      { name },
    ),
  duplicate: (name: string) =>
    error(
      'custom-runner-environment-duplicate',
      `Custom runner environment reference is duplicated: ${name}`,
      { name },
    ),
  missing: (name: string) =>
    error(
      'custom-runner-environment-missing',
      `Custom runner environment reference is not set: ${name}`,
      { name },
    ),
  tooLarge: (maxBytes: number) =>
    error(
      'custom-runner-environment-too-large',
      `Custom runner declared environment exceeds ${maxBytes} bytes.`,
      { maxBytes },
    ),
} as const;

export const customRunnerRedactionError = {
  toolInputStateLimit: (maxActive: number) =>
    error(
      'custom-runner-tool-input-state-limit',
      `Custom runner exceeded ${maxActive} concurrent tool-input streams; collection stopped to protect redacted output.`,
      { maxActive },
    ),
} as const;

export type CustomRunnerRedactor = (value: string) => string;

export type CustomRunnerStreamingRedactor = Readonly<{
  push: (value: string) => string;
  flush: () => string;
  flushBeforeTerminal: (value: string) => Readonly<{ before: string; value: string }>;
}>;

export type CustomRunnerToolInputRedactor = Readonly<{
  apply: (line: ParsedLine) => readonly ParsedLine[];
  flush: () => readonly ParsedLine[];
  hasExceededCapacity: () => boolean;
}>;

export type CustomRunnerEnvironment = Readonly<{
  env: NodeJS.ProcessEnv;
  redactionValues: readonly string[];
}>;

const customRunnerRedactionValues = new WeakMap<CustomRunnerRedactor, readonly string[]>();

export function resolveCustomRunnerEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  declaredNames: readonly string[],
): CustomRunnerEnvironment {
  const uniqueNames = new Set<string>();
  const values: string[] = [];
  let bytes = 0;

  for (const name of declaredNames) {
    if (!isSafePreservedChildEnvKey(name)) {
      throw customRunnerEnvironmentError.blocked(name);
    }
    if (uniqueNames.has(name)) {
      throw customRunnerEnvironmentError.duplicate(name);
    }
    uniqueNames.add(name);

    const value = sourceEnv[name];
    if (value === undefined) {
      throw customRunnerEnvironmentError.missing(name);
    }
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > CUSTOM_RUNNER_ENVIRONMENT_MAX_BYTES) {
      throw customRunnerEnvironmentError.tooLarge(CUSTOM_RUNNER_ENVIRONMENT_MAX_BYTES);
    }
    if (value.length > 0) values.push(value);
  }

  return {
    env: createSanitizedChildEnv(sourceEnv, declaredNames),
    redactionValues: [...new Set(values)].sort((left, right) => right.length - left.length),
  };
}

export function createCustomRunnerRedactor(values: readonly string[]): CustomRunnerRedactor {
  const redactionValues = [...new Set(values)]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  const marker = redactionValues.some((value) => CUSTOM_RUNNER_REDACTION_MARKER.includes(value))
    ? ''
    : CUSTOM_RUNNER_REDACTION_MARKER;

  const redact = (value: string): string => {
    let redacted = value;
    for (const secret of redactionValues) {
      redacted = redacted.replaceAll(secret, marker);
    }
    return redacted;
  };
  customRunnerRedactionValues.set(redact, redactionValues);
  return redact;
}

export function createCustomRunnerStreamingRedactor(
  redact: CustomRunnerRedactor,
  supplementalValues: readonly string[] = [],
): CustomRunnerStreamingRedactor {
  const values = [
    ...new Set([
      ...(customRunnerRedactionValues.get(redact)?.filter((value) => value.length > 0) ?? []),
      ...supplementalValues.filter((value) => value.length > 0),
    ]),
  ];
  const maximumValueLength = Math.max(0, ...values.map((value) => value.length));
  let retained = '';

  const safePrefix = (value: string): string => {
    const maximumOverlapLength = Math.min(maximumValueLength, value.length);
    for (let length = maximumOverlapLength; length > 0; length -= 1) {
      const suffix = value.slice(-length);
      if (values.some((protectedValue) => protectedValue.startsWith(suffix))) return suffix;
    }
    return '';
  };

  const flushRetained = (): string => {
    if (retained.length === 0) return '';
    const partialValue = values.find((protectedValue) => protectedValue.startsWith(retained));
    const output = partialValue === undefined ? redact(retained) : redact(partialValue);
    retained = '';
    return output;
  };

  return {
    push: (value) => {
      if (value.length === 0) return '';
      const buffered = retained + value;
      retained = safePrefix(buffered);
      return redact(buffered.slice(0, buffered.length - retained.length));
    },
    flush: flushRetained,
    flushBeforeTerminal: (value) => {
      if (retained.length === 0) return { before: '', value: redact(value) };

      const held = retained;
      if (values.some((protectedValue) => value.includes(protectedValue))) {
        retained = '';
        return { before: '', value: redact(value) };
      }
      if (values.some((protectedValue) => `${held}${value}`.includes(protectedValue))) {
        const redactedValue = redact(`${held}${value}`);
        retained = '';
        return { before: '', value: redactedValue };
      }

      return { before: flushRetained(), value: redact(value) };
    },
  };
}

type BufferedToolInput = {
  redactor: CustomRunnerStreamingRedactor;
  delta: ToolUseDeltaInfo;
  sequence: number;
};

export const CUSTOM_RUNNER_TOOL_INPUT_MAX_ACTIVE = 128;

export function customRunnerToolInputStateLimitError() {
  return customRunnerRedactionError.toolInputStateLimit(CUSTOM_RUNNER_TOOL_INPUT_MAX_ACTIVE);
}

function toolInputKey(delta: ToolUseDeltaInfo): string {
  return delta.id ?? `unnamed:${delta.name ?? ''}`;
}

function mergeToolInputDelta(previous: ToolUseDeltaInfo, next: ToolUseDeltaInfo): ToolUseDeltaInfo {
  return {
    ...(next.id === undefined
      ? previous.id === undefined
        ? {}
        : { id: previous.id }
      : { id: next.id }),
    ...(next.name === undefined
      ? previous.name === undefined
        ? {}
        : { name: previous.name }
      : { name: next.name }),
    inputDelta: '',
  };
}

function withToolUseDeltas(line: ParsedLine, toolUseDelta: ToolUseDeltaInfo[]): ParsedLine {
  return { ...line, toolUseDelta };
}

function toolInputKeyFromCompletedTool(toolUse: ToolUseInfo): string {
  return toolUse.id ?? `unnamed:${toolUse.name}`;
}

function completedToolInputKeys(line: ParsedLine): readonly string[] {
  const keys = new Set<string>();
  for (const toolUse of line.toolUse ?? []) {
    keys.add(toolInputKeyFromCompletedTool(toolUse));
  }
  for (const toolUse of line.toolUseDone ?? []) {
    keys.add(toolInputKeyFromCompletedTool(toolUse));
  }
  return [...keys];
}

function isTerminalToolInputBoundary(line: ParsedLine): boolean {
  return line.isError === true || line.isResult === true || line.channel === 'result';
}

/**
 * Holds ambiguous suffixes independently for each streamed tool-input id.
 * Unrelated parser records must not flush another tool's suffix: only that
 * tool's completion, a terminal result/error, or collector shutdown resolves
 * the boundary. Exceeding the bounded active-ID limit fails closed: evicting
 * one incomplete state could make a later suffix observable on a new state.
 */
export function createCustomRunnerToolInputRedactor(
  redact: CustomRunnerRedactor,
  supplementalValues: readonly string[] = [],
): CustomRunnerToolInputRedactor {
  const buffered = new Map<string, BufferedToolInput>();
  let sequence = 0;
  let capacityExceeded = false;

  const flushEntries = (entries: readonly BufferedToolInput[]): readonly ParsedLine[] =>
    [...entries]
      .sort((left, right) => left.sequence - right.sequence)
      .flatMap(({ redactor, delta }) => {
        const inputDelta = redactor.flush();
        return inputDelta.length === 0 ? [] : [withToolUseDeltas({}, [{ ...delta, inputDelta }])];
      });

  const flush = (): readonly ParsedLine[] => {
    if (capacityExceeded) return [];
    const pending = flushEntries([...buffered.values()]);
    buffered.clear();
    return pending;
  };

  const flushKeys = (keys: readonly string[]): readonly ParsedLine[] => {
    const entries: BufferedToolInput[] = [];
    for (const key of keys) {
      const entry = buffered.get(key);
      if (entry === undefined) continue;
      buffered.delete(key);
      entries.push(entry);
    }
    return flushEntries(entries);
  };

  return {
    apply: (line) => {
      if (capacityExceeded) return [];
      const toolUseDelta = line.toolUseDelta;
      if (toolUseDelta === undefined || toolUseDelta.length === 0) {
        if (isTerminalToolInputBoundary(line)) return [...flush(), line];
        return [...flushKeys(completedToolInputKeys(line)), line];
      }

      const newKeys = new Set(toolUseDelta.map(toolInputKey).filter((key) => !buffered.has(key)));
      if (buffered.size + newKeys.size > CUSTOM_RUNNER_TOOL_INPUT_MAX_ACTIVE) {
        capacityExceeded = true;
        buffered.clear();
        return [];
      }

      const redactedDeltas = toolUseDelta.map((delta) => {
        const key = toolInputKey(delta);
        const existing = buffered.get(key);
        const entry = existing ?? {
          redactor: createCustomRunnerStreamingRedactor(redact, supplementalValues),
          delta: { ...delta, inputDelta: '' },
          sequence: 0,
        };
        entry.delta = mergeToolInputDelta(entry.delta, delta);
        entry.sequence = ++sequence;
        buffered.set(key, entry);
        return { ...delta, inputDelta: entry.redactor.push(delta.inputDelta) };
      });
      const redactedLine = withToolUseDeltas(line, redactedDeltas);
      if (isTerminalToolInputBoundary(line)) {
        return [redactedLine, ...flush()];
      }
      return [redactedLine, ...flushKeys(completedToolInputKeys(line))];
    },
    flush,
    hasExceededCapacity: () => capacityExceeded,
  };
}

export function customRunnerRedactionValuesFor(
  redact: CustomRunnerRedactor | undefined,
): readonly string[] {
  return redact === undefined ? [] : (customRunnerRedactionValues.get(redact) ?? []);
}

export function redactCustomRunnerParsedLine(
  line: ParsedLine,
  redact: CustomRunnerRedactor,
): ParsedLine {
  return {
    ...line,
    ...(line.text === undefined ? {} : { text: redact(line.text) }),
    ...(line.sessionId === undefined ? {} : { sessionId: redact(line.sessionId) }),
    ...(line.toolUse === undefined
      ? {}
      : { toolUse: line.toolUse.map((toolUse) => redactToolUse(toolUse, redact)) }),
    ...(line.toolUseStart === undefined
      ? {}
      : { toolUseStart: line.toolUseStart.map((toolUse) => redactToolUse(toolUse, redact)) }),
    ...(line.toolUseDelta === undefined
      ? {}
      : {
          toolUseDelta: line.toolUseDelta.map((toolUse) => redactToolUseDelta(toolUse, redact)),
        }),
    ...(line.toolUseDone === undefined
      ? {}
      : { toolUseDone: line.toolUseDone.map((toolUse) => redactToolUse(toolUse, redact)) }),
    ...(line.warning === undefined
      ? {}
      : { warning: line.warning.map((warning) => redactWarning(warning, redact)) }),
  };
}

function redactToolUse(toolUse: ToolUseInfo, redact: CustomRunnerRedactor): ToolUseInfo {
  return {
    ...(toolUse.id === undefined ? {} : { id: redact(toolUse.id) }),
    name: redact(toolUse.name),
    input: redactRecord(toolUse.input, redact),
    ...(toolUse.output === undefined ? {} : { output: redactUnknown(toolUse.output, redact) }),
  };
}

function redactToolUseDelta(
  toolUse: ToolUseDeltaInfo,
  redact: CustomRunnerRedactor,
): ToolUseDeltaInfo {
  return {
    ...(toolUse.id === undefined ? {} : { id: redact(toolUse.id) }),
    ...(toolUse.name === undefined ? {} : { name: redact(toolUse.name) }),
    inputDelta: redact(toolUse.inputDelta),
  };
}

function redactWarning(
  warning: ParsedWarningInfo,
  redact: CustomRunnerRedactor,
): ParsedWarningInfo {
  return {
    ...warning,
    code: redact(warning.code),
    message: redact(warning.message),
    ...(warning.source === undefined ? {} : { source: redact(warning.source) }),
    ...(warning.parser === undefined ? {} : { parser: redact(warning.parser) }),
    ...(warning.upstreamType === undefined ? {} : { upstreamType: redact(warning.upstreamType) }),
    ...(warning.fingerprint === undefined ? {} : { fingerprint: redact(warning.fingerprint) }),
    ...(warning.rawRef === undefined ? {} : { rawRef: redact(warning.rawRef) }),
  };
}

function redactRecord(
  value: Record<string, unknown>,
  redact: CustomRunnerRedactor,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[redact(key)] = redactUnknown(item, redact);
  }
  return output;
}

function redactUnknown(value: unknown, redact: CustomRunnerRedactor): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, redact));
  if (isRecord(value)) return redactRecord(value, redact);
  return value;
}
