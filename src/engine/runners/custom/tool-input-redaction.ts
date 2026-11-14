import {
  type CustomRunnerStreamingRedactor,
  customRunnerRedactionError,
  type CustomRunnerRedactor,
  type CustomRunnerToolInputRedactor,
  createCustomRunnerStreamingRedactor,
} from './redaction.js';
import type { ToolUseDeltaInfo, ParsedLine, ToolUseInfo } from '../types.js';

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
