import { createLineBuffer } from '../../../lib/process/line-buffer.js';
import type { SpawnPipeFatalSignal } from '../../../lib/process/spawn/types.js';
import { runnerCallLineOutputLimit } from '../../calls/output-limit.js';
import type { RunnerCallRecorder } from '../../calls/recorder/types.js';
import type { TextChunkMarks } from '../../events/types.js';
import {
  type CustomRunnerRedactor,
  type CustomRunnerStreamingRedactor,
  type CustomRunnerToolInputRedactor,
  customRunnerRedactionValuesFor,
  createCustomRunnerStreamingRedactor,
  redactCustomRunnerParsedLine,
} from '../../runners/custom/redaction.js';
import {
  createCustomRunnerToolInputRedactor,
  customRunnerToolInputStateLimitError,
} from '../../runners/custom/tool-input-redaction.js';
import type { ParsedLine, ParsedTextChannel } from '../../runners/types.js';
import type { ParsedLineRecorder } from '../parsed-line-recorder.js';

type SubagentLine = {
  line: ParsedLine;
  marks: Pick<TextChunkMarks, 'continues'> | undefined;
};

/** What the steps of the stream change in place while the call runs. */
type RedactedStreamState = {
  /** The channel of the main-loop text that the stdout redactor holds. */
  stdoutChannel: ParsedTextChannel;
  readonly subagentRedactors: Map<string, CustomRunnerStreamingRedactor>;
  /** Subagent lines that wait while the stdout redactor holds main-loop text. */
  readonly pendingSubagentLines: SubagentLine[];
};

/**
 * The redacted output of one runner call. Each redactor holds a tail that can start a protected
 * value until more text or the close of the call releases it.
 */
type RedactedStream = {
  readonly redact: CustomRunnerRedactor | undefined;
  readonly redactCredential: (value: string) => string;
  readonly protectedValues: readonly string[];
  readonly parsedRecorder: ParsedLineRecorder;
  readonly stdoutRedactor: CustomRunnerStreamingRedactor;
  readonly toolInputRedactor: CustomRunnerToolInputRedactor | undefined;
  readonly stderrRedactor: CustomRunnerStreamingRedactor;
  readonly stderrBuffer: ReturnType<typeof createRunnerCallStderrBuffer>;
  readonly onStderr: ((chunk: string) => void) | undefined;
  readonly state: RedactedStreamState;
};

export function createRedactedStream(input: {
  redact: CustomRunnerRedactor | undefined;
  redactCredential: (value: string) => string;
  credentialValues: readonly string[];
  recorder: RunnerCallRecorder;
  parsedRecorder: ParsedLineRecorder;
  onStderr: ((chunk: string) => void) | undefined;
}): RedactedStream {
  const { redact, redactCredential } = input;
  const protectedValues = [...input.credentialValues, ...customRunnerRedactionValuesFor(redact)];
  return {
    redact,
    redactCredential,
    protectedValues,
    parsedRecorder: input.parsedRecorder,
    stdoutRedactor: createCustomRunnerStreamingRedactor(redactCredential, protectedValues),
    toolInputRedactor:
      redact === undefined
        ? undefined
        : createCustomRunnerToolInputRedactor(redactCredential, protectedValues),
    stderrRedactor: createCustomRunnerStreamingRedactor(redactCredential, protectedValues),
    stderrBuffer: createRunnerCallStderrBuffer(input.recorder),
    onStderr: input.onStderr,
    state: { stdoutChannel: 'stdout', subagentRedactors: new Map(), pendingSubagentLines: [] },
  };
}

function emitSubagentParsed(
  stream: RedactedStream,
  line: ParsedLine,
  marks?: Pick<TextChunkMarks, 'continues'>,
): void {
  if (stream.stdoutRedactor.hasHeld()) {
    stream.state.pendingSubagentLines.push({ line, marks });
    return;
  }
  stream.parsedRecorder.apply(line, marks);
}

function drainSubagentText(stream: RedactedStream, force = false): void {
  if (!force && stream.stdoutRedactor.hasHeld()) return;
  const pending = stream.state.pendingSubagentLines;
  while (pending.length > 0) {
    const next = pending.shift();
    if (next !== undefined) stream.parsedRecorder.apply(next.line, next.marks);
  }
}

function flushSubagentText(
  stream: RedactedStream,
  subagentIds: readonly string[] = [...stream.state.subagentRedactors.keys()],
): void {
  const { subagentRedactors } = stream.state;
  for (const subagentId of subagentIds) {
    const text = subagentRedactors.get(subagentId)?.flush() ?? '';
    subagentRedactors.delete(subagentId);
    if (text.length > 0) {
      emitSubagentParsed(stream, { text, channel: 'assistant', subagentId }, { continues: true });
    }
  }
}

function flushText(stream: RedactedStream): void {
  const text = stream.stdoutRedactor.flush();
  if (text.length > 0)
    stream.parsedRecorder.apply({ text, channel: stream.state.stdoutChannel }, { continues: true });
  drainSubagentText(stream);
}

function applyRedactedParsed(stream: RedactedStream, parsed: ParsedLine): void {
  const { parsedRecorder, stdoutRedactor, state } = stream;
  const parsedText = parsed.text;
  const redacted =
    stream.redact === undefined
      ? parsed
      : redactCustomRunnerParsedLine(parsed, stream.redactCredential);
  if (redacted.subagentId !== undefined && parsedText !== undefined) {
    const subagentId = redacted.subagentId;
    const existing = state.subagentRedactors.get(subagentId);
    const redactor =
      existing ??
      createCustomRunnerStreamingRedactor(stream.redactCredential, stream.protectedValues);
    if (existing === undefined) state.subagentRedactors.set(subagentId, redactor);
    const released = redactor.pushSplit(parsedText);
    if (released.held.length > 0) {
      emitSubagentParsed(
        stream,
        { text: released.held, channel: 'assistant', subagentId },
        { continues: true },
      );
    }
    emitSubagentParsed(stream, { ...redacted, text: released.value });
    return;
  }
  const channel = redacted.channel ?? (redacted.isResult ? 'result' : 'stdout');
  const isFinalBoundary = redacted.isResult === true || channel === 'result';
  const isStreamingText = channel === 'assistant' || channel === 'stdout';

  if (isFinalBoundary) flushSubagentText(stream);
  // The main-loop `tool_result` of a subagent's tool use ends that subagent.
  if (redacted.toolUse !== undefined) {
    flushSubagentText(
      stream,
      redacted.toolUse.flatMap((tool) => (tool.id === undefined ? [] : [tool.id])),
    );
  }

  if (isFinalBoundary && parsedText !== undefined) {
    const terminal = stdoutRedactor.flushBeforeTerminal(parsedText);
    if (terminal.before.length > 0) {
      parsedRecorder.apply(
        { text: terminal.before, channel: state.stdoutChannel },
        { continues: true },
      );
    }
    drainSubagentText(stream);
    parsedRecorder.apply({ ...redacted, text: terminal.value });
    return;
  } else if (redacted.isError === true || !isStreamingText) {
    flushText(stream);
  }
  if (parsedText === undefined) {
    parsedRecorder.apply(redacted);
    return;
  }

  state.stdoutChannel = channel;
  const released = stdoutRedactor.pushSplit(parsedText);
  if (released.held.length > 0) {
    parsedRecorder.apply(
      { text: released.held, channel: state.stdoutChannel },
      { continues: true },
    );
  }
  const tail = isStreamingText ? '' : stdoutRedactor.flush();
  drainSubagentText(stream, released.held.length > 0 || released.value.length > 0);
  parsedRecorder.apply({ ...redacted, text: released.value + tail });
}

function flushToolInput(stream: RedactedStream): void {
  for (const parsed of stream.toolInputRedactor?.flush() ?? []) {
    applyRedactedParsed(stream, parsed);
  }
}

export function flushStdout(stream: RedactedStream): void {
  flushToolInput(stream);
  flushSubagentText(stream);
  flushText(stream);
  drainSubagentText(stream);
}

export function applyParsed(stream: RedactedStream, parsed: ParsedLine): void {
  for (const redacted of stream.toolInputRedactor?.apply(parsed) ?? [parsed]) {
    applyRedactedParsed(stream, redacted);
  }
}

function emitStderr(stream: RedactedStream, chunk: string): void {
  if (chunk.length === 0) return;
  stream.stderrBuffer.push(chunk);
  stream.onStderr?.(chunk);
}

export function pushStderr(stream: RedactedStream, chunk: string): void {
  emitStderr(stream, stream.stderrRedactor.push(chunk));
}

export function flushStderr(stream: RedactedStream): void {
  emitStderr(stream, stream.stderrRedactor.flush());
  stream.stderrBuffer.flush();
}

export function toolInputCapacityExceeded(stream: RedactedStream): boolean {
  return stream.toolInputRedactor?.hasExceededCapacity() === true;
}

export function toolInputCapacitySignal(stream: RedactedStream): SpawnPipeFatalSignal | undefined {
  return toolInputCapacityExceeded(stream)
    ? {
        state: 'protocol-failure',
        remediation: customRunnerToolInputStateLimitError().message,
      }
    : undefined;
}

const STDERR_LINE_MAX_BYTES = 8 * 1024;

function createRunnerCallStderrBuffer(recorder: RunnerCallRecorder): {
  push(chunk: string): void;
  flush(): void;
} {
  return createLineBuffer(
    (line) => {
      if (line.length > 0) recorder.stderr({ text: line });
    },
    {
      maxLineBytes: STDERR_LINE_MAX_BYTES,
      onOverflow: (overflow) => {
        const limit = runnerCallLineOutputLimit({
          code: 'stderr_line_overflow',
          label: 'the tool error output',
          lineBytes: overflow.lineBytes,
          maxLineBytes: STDERR_LINE_MAX_BYTES,
        });
        recorder.warning({
          warning: { code: limit.code, message: limit.message },
        });
      },
    },
  );
}
