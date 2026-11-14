import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getSplitbriefPath } from '../../../core/paths.js';
import type {
  CliImplementerAdapter,
  CliPlannerAdapter,
  CliProtocolEvent,
} from '../../../engine/runners/cli-tools/contract.js';
import {
  lookupCliImplementerAdapter,
  lookupCliPlannerAdapter,
} from '../../../engine/runners/cli-tools/registry.js';
import {
  classifySeatFailure,
  type SeatFailureClassification,
} from '../../../engine/runners/seat-failure.js';
import { cliError } from '../../errors.js';

export const SEAT_PROBE_SEATS = ['plan', 'build', 'review'] as const;
export type SeatProbeSeat = (typeof SEAT_PROBE_SEATS)[number];

export type SeatProbeCapture = Readonly<{
  seat: SeatProbeSeat;
  tool: string;
  stdout: string;
  stderr: string;
  exitStatus: number | null;
  signal: string | null;
  timedOut: boolean;
  outputExceeded: boolean;
}>;

export type SeatProbeCall = (
  input: Readonly<{ projectDir: string; seat: SeatProbeSeat }>,
) => Promise<SeatProbeCapture>;

export type SeatProbeResult = Readonly<{
  seat: SeatProbeSeat;
  tool: string;
  class: SeatFailureClassification['class'] | 'passed';
  firstErrorLine: string | null;
  recordPath: string;
}>;

type CliTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;
const SEAT_PROBE_RECORDS_DIR = 'probes';

export function parseSeatProbeSeat(value: string): SeatProbeSeat {
  const seat = SEAT_PROBE_SEATS.find((candidate) => candidate === value);
  if (seat !== undefined) return seat;
  throw cliError(`--probe-seat must be one of ${SEAT_PROBE_SEATS.join(', ')}.`, 1);
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function seatProbeDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function appendSeatProbeRecord(
  recordPath: string,
  record: Readonly<Record<string, unknown>>,
): Promise<void> {
  await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
  await appendFile(recordPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(recordPath, 0o600);
}

export async function runSeatProbe(
  input: Readonly<{ projectDir: string; seat: SeatProbeSeat; call: SeatProbeCall }>,
): Promise<SeatProbeResult> {
  const capture = await input.call({ projectDir: input.projectDir, seat: input.seat });
  const terminal = seatProbeTerminal(capture);
  const passed = terminal?.status === 'completed' && capture.exitStatus === 0;
  // A terminal result speaks for the call: its stream frames list tool names such as
  // `browser_get_network_request` that read as a network fault.
  const error = terminal?.error ?? null;
  const diagnostics = (
    terminal === null ? [capture.stderr, capture.stdout] : [error?.message ?? '', capture.stderr]
  )
    .filter((part) => part.trim().length > 0)
    .join('\n');
  const verdict = passed
    ? 'passed'
    : classifySeatFailure({
        message: diagnostics,
        ...(error !== null && { code: error.code }),
        ...(error?.status !== undefined && { status: error.status }),
        ...(error?.providerType !== undefined && { providerType: error.providerType }),
        ...(capture.exitStatus !== null && capture.exitStatus !== 0
          ? { outcome: 'non-zero-exit' as const }
          : {}),
        source: error === null ? 'thrown' : 'result-error',
      }).class;
  const firstErrorLine = passed ? null : firstNonEmptyLine(diagnostics);
  const recordPath = getSplitbriefPath(
    input.projectDir,
    SEAT_PROBE_RECORDS_DIR,
    `${capture.tool}-${seatProbeDate()}.jsonl`,
  );
  await appendSeatProbeRecord(recordPath, {
    ts: new Date().toISOString(),
    seat: input.seat,
    tool: capture.tool,
    class: verdict,
    exitStatus: capture.exitStatus,
    timedOut: capture.timedOut,
    outputExceeded: capture.outputExceeded,
    stdout: capture.stdout,
    stderr: capture.stderr,
  });
  return {
    seat: input.seat,
    tool: capture.tool,
    class: verdict,
    firstErrorLine,
    recordPath,
  };
}

export function seatProbeAdapter(
  tool: string,
  seat: SeatProbeSeat,
): CliPlannerAdapter | CliImplementerAdapter {
  return seat === 'build' ? lookupCliImplementerAdapter(tool) : lookupCliPlannerAdapter(tool);
}

/** The call's terminal result as the seat adapter reads it in a run; null when the stream has none. */
function seatProbeTerminal(capture: SeatProbeCapture): CliTerminalEvent | null {
  const adapter = seatProbeAdapter(capture.tool, capture.seat);
  const parse = adapter.createParser?.() ?? adapter.parse;
  try {
    return adapter.terminal({
      outputContract: adapter.outputContract,
      events: capture.stdout.split('\n').flatMap((line) => [...parse(line)]),
      stderr: capture.stderr,
      exitCode: capture.exitStatus,
      signal: capture.signal,
    });
  } catch {
    return null;
  }
}
