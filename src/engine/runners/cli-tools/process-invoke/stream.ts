import { createLineBuffer } from '../../../../lib/process/line-buffer.js';
import type {
  SpawnPipeCallbackResult,
  SpawnPipeOptions,
} from '../../../../lib/process/spawn/types.js';
import type { CliProtocolEvent } from '../contract.js';
import { fatal, fatalSignal, haltFailure } from './failures.js';
import { recordCliProtocolEvent } from './protocol-event.js';
import type { ProcessCall, ProcessClose } from './types.js';

/**
 * The time a structured tool gets to exit by itself after its terminal result, so its exit code
 * and stderr still decide the call. SPLITBRIEF then stops the tool, and the call keeps the result.
 */
const TERMINAL_EXIT_GRACE_MS = 2_000;

type OutputLines = ReturnType<typeof createLineBuffer>;

/**
 * Once a structured call holds its terminal result, that result decides the call: a configured
 * timeout or an idle cut that fires after it stops the tool and keeps the result.
 */
export function holdsTerminal(call: ProcessCall): boolean {
  return call.state.terminalSeen && call.adapter.outputContract.kind === 'structured-terminal';
}

/** Closes the steering admission once: the session hears it first, then the port lets the call go. */
export function closeAdmission(call: ProcessCall): void {
  const { state } = call;
  if (state.admissionClosed) return;
  state.admissionClosed = true;
  const release = state.detach;
  state.detach = undefined;
  try {
    state.steeringSession?.onAdmissionClosed?.();
  } finally {
    release?.();
  }
}

function needsInspection(
  call: ProcessCall,
  event: Readonly<{ id: string | null; input: unknown }>,
): boolean {
  if (event.id === null) return true;
  const input = JSON.stringify(event.input);
  if (call.inspectedInputs.get(event.id) === input) return false;
  call.inspectedInputs.set(event.id, input);
  return true;
}

function applyProtocolEvent(
  call: ProcessCall,
  event: CliProtocolEvent,
  turnBoundary: boolean,
): void {
  const { context, state } = call;
  // A structured stream may restate its terminal result — Codex describes one
  // failure as an `error` record followed by `turn.failed` — and the adapter's
  // `terminal` reducer picks the authoritative one. Any non-result traffic
  // after a terminal result is still a protocol failure.
  if (state.terminalSeen && event.type !== 'result') {
    throw fatal('CLI emitted output after its terminal result');
  }
  call.protocolEvents.push(event);
  if (
    event.type === 'tool-use' &&
    state.guardFailure === null &&
    context.toolUseGuard !== undefined &&
    needsInspection(call, event)
  ) {
    state.guardFailure = context.toolUseGuard(event);
    if (state.guardFailure !== null) call.guard.abort();
  }
  if (event.type === 'result') state.terminalSeen = !turnBoundary;
  recordCliProtocolEvent(state.recorder, event);
}

function readLine(
  call: ProcessCall,
  parse: (line: string) => readonly CliProtocolEvent[],
  line: string,
): void {
  const { state } = call;
  if (call.settle.signal.aborted) return;
  let parsed: readonly CliProtocolEvent[];
  try {
    parsed = parse(line);
  } catch {
    throw fatal('CLI output did not match its structured protocol');
  }
  // A line the parser drops, such as the tool's echo of the prompt, is not the tool's words.
  state.stdoutLastLine = parsed.length === 0 ? '' : line;
  const turnBoundary = state.steeringSession?.onLine(line, parsed) ?? false;
  for (const event of parsed) applyProtocolEvent(call, event, turnBoundary);
  // A steered tool can open a new turn on its own. Request settlement at once.
  if (state.steeringSession !== undefined && state.terminalSeen) call.settle.abort(call.settled);
  else if (holdsTerminal(call)) {
    state.graceTimer ??= setTimeout(() => call.settle.abort(call.settled), TERMINAL_EXIT_GRACE_MS);
  }
}

function readStdout(call: ProcessCall, lines: OutputLines, chunk: string): SpawnPipeCallbackResult {
  const { state } = call;
  state.stdoutTailCarry = (state.stdoutTailCarry + chunk).split('\n').at(-1) ?? '';
  try {
    lines.push(chunk);
  } catch (cause) {
    closeAdmission(call);
    return fatalSignal(cause);
  }
  return undefined;
}

function readStderr(call: ProcessCall, chunk: string): SpawnPipeCallbackResult {
  const { state } = call;
  state.stderr += chunk;
  state.recorder.stderr({ text: chunk });
  if (state.terminalSeen || state.recognizedHalt !== undefined) return undefined;
  const halt = haltFailure(state.stderr);
  if (halt !== null && (halt.code === 'usage-limit' || halt.code === 'unauthenticated')) {
    state.recognizedHalt = halt.code;
    return { state: 'protocol-failure', remediation: '', drainOutput: true };
  }
  return undefined;
}

function closeOutput(
  call: ProcessCall,
  lines: OutputLines,
  exitCode: number | null,
  signal: string | null,
  stoppedForDrain: boolean,
): ProcessClose {
  closeAdmission(call);
  lines.flush();
  call.state.stdoutTailCarry = '';
  return { exitCode, signal, stderr: call.state.stderr, stoppedForDrain };
}

/** The output callbacks of the spawned tool. An open steering session owns the parser. */
export function processOutput(
  call: ProcessCall,
): Pick<SpawnPipeOptions<ProcessClose>, 'onStdout' | 'onStderr' | 'onClose'> {
  const { adapter, state } = call;
  const parse = state.steeringSession?.parse ?? adapter.createParser?.() ?? adapter.parse;
  const lines = createLineBuffer((line) => readLine(call, parse, line));
  return {
    onStdout: (chunk) => readStdout(call, lines, chunk),
    onStderr: (chunk) => readStderr(call, chunk),
    onClose: (exitCode, signal, stoppedForDrain) =>
      closeOutput(call, lines, exitCode, signal, stoppedForDrain),
  };
}
