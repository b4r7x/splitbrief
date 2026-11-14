import { statSync } from 'node:fs';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../core/runners/cli-tool/types.js';
import {
  CliExecutableReceiptSchema,
  parseDigestBoundExecutableFingerprint,
} from '../../core/discovery/detection/executable.js';
import {
  admitStart,
  type RunnerEvidence,
  type StartAdmission,
  type StartFact,
} from '../../core/discovery/runner-evidence.js';
import type { RouteAuthState } from '../../core/runners/route-auth.js';
import { runnerSlotId } from '../../core/config/accessors/runner-config.js';
import type { RunnerReadinessCauseId } from '../../core/readiness/types.js';
import { error, matches, type AppError } from '../../utils/error.js';
import { assertNever } from '../../utils/type-guards.js';
import type { RunnerCallResult } from '../calls/types.js';
import type { RunnerGate, RunnerGateExpectation, RunnerSlot } from './prepared-execution.js';
import { executableChangedMessage } from './resolve-cli-executable.js';
import type {
  CliExecutableIdentity,
  CliExecutableReceipt,
  CliExecutableTrust,
  ExecutableIdentity,
} from '../../core/discovery/detection/executable.js';

export type CliStartGate = Readonly<{
  tool: CliToolId;
  executable: CliExecutableTrust;
  /** The release readiness admitted, for an adapter whose argv differs by release. */
  installedVersion?: string | undefined;
}>;

export type FreshCliStartGate = Readonly<{
  tool: CliToolId;
  executable: CliExecutableReceipt;
  installedVersion: string | undefined;
}>;

export type FreshCliStartGateResult =
  | Readonly<{ kind: 'admitted'; gate: FreshCliStartGate }>
  | Extract<StartAdmission, { kind: 'disclosure-required' }>
  | Readonly<{
      kind: 'denied';
      reason: Extract<StartAdmission, { kind: 'denied' }>['reason'];
    }>;

export interface AdmitFreshCliStartOptions {
  readonly tool: CliToolId;
  readonly evidence: RunnerEvidence;
  readonly expectedContextKey: string;
  readonly expectedSelectionId: string;
  readonly interaction: 'interactive' | 'headless';
  readonly unverifiedAuth: 'denied' | 'disclosed' | 'allowed';
  readonly route: RouteAuthState;
}

export function runnerGateFor(
  gates: readonly RunnerGate[],
  expected: RunnerGateExpectation,
): RunnerGate {
  const gate = gates.find((candidate) => {
    if (candidate.preparationId !== expected.preparationId) return false;
    if (candidate.slot.role !== expected.slot.role) return false;
    if (
      candidate.slot.role === 'implementer' &&
      expected.slot.role === 'implementer' &&
      candidate.slot.profile !== expected.slot.profile
    ) {
      return false;
    }

    switch (candidate.kind) {
      case 'cli':
        return expected.kind === 'cli' && candidate.tool === expected.tool;
      case 'api':
        return (
          expected.kind === 'api' &&
          candidate.provider === expected.provider &&
          candidate.endpointOrigin === expected.endpointOrigin
        );
      case 'shell':
      case 'agent':
        if (expected.kind !== candidate.kind) return false;
        switch (candidate.command.kind) {
          case 'validated-config':
            return expected.command.kind === 'validated-config';
          case 'configured-custom':
            return (
              expected.command.kind === 'configured-custom' &&
              candidate.command.invocation.scope.definitionId === expected.command.definitionId
            );
          default:
            return assertNever(candidate.command);
        }
      default:
        return assertNever(candidate);
    }
  });
  if (gate !== undefined) return gate;

  throw error(
    'runner-gate-mismatch',
    `Runner gate does not match the prepared ${expected.slot.role} context.`,
    {
      kind: expected.kind,
      role: expected.slot.role,
      ...(expected.slot.role === 'implementer' && { profile: expected.slot.profile }),
    },
  );
}

const CLI_START_REQUIRED_FACTS = [
  'trusted-executable',
  'compatible-version',
  'authentication',
] as const satisfies readonly StartFact[];

function executableFromEvidence(identity: ExecutableIdentity): CliExecutableReceipt | null {
  const fingerprint = parseDigestBoundExecutableFingerprint(identity.fingerprint);
  if (fingerprint === null) return null;
  const result = CliExecutableReceiptSchema.safeParse({
    path: identity.realPath,
    fingerprint,
    executableIdentity: identity,
  });
  return result.success ? result.data : null;
}

function deniedExecutableFact(): FreshCliStartGateResult {
  return { kind: 'denied', reason: { kind: 'executable', fact: 'unknown' } };
}

/**
 * Admits one CLI runner only from a fresh, exact-config evidence record.
 * Legacy readiness is intentionally absent from this boundary.
 */
export function admitFreshCliStart(options: AdmitFreshCliStartOptions): FreshCliStartGateResult {
  if (options.evidence.runner.kind !== 'cli' || options.evidence.runner.id !== options.tool) {
    return { kind: 'denied', reason: { kind: 'context-mismatch' } };
  }

  const admission = admitStart({
    evidence: options.evidence,
    expectedContextKey: options.expectedContextKey,
    expectedSelectionId: options.expectedSelectionId,
    requiredFacts: CLI_START_REQUIRED_FACTS,
    interaction: options.interaction,
    unverifiedAuth: options.unverifiedAuth,
    route: options.route,
  });
  if (admission.kind === 'disclosure-required') return admission;
  if (admission.kind === 'denied') return admission;

  if (options.evidence.executable.kind !== 'trusted') return deniedExecutableFact();
  const executable = executableFromEvidence(options.evidence.executable.identity);
  if (executable === null) return deniedExecutableFact();
  const { compatibility } = options.evidence;
  return {
    kind: 'admitted',
    gate: {
      tool: options.tool,
      executable,
      installedVersion:
        compatibility.kind === 'compatible' ? compatibility.installedVersion : undefined,
    },
  };
}

function missingCliStartGate(tool: CliToolId): never {
  throw error(
    'cli-executable-untrusted',
    `${CLI_TOOL_CATALOG[tool].displayName} has no trusted readiness identity; run \`splitbrief doctor\` again before execution.`,
    { tool },
  );
}

/**
 * The receipt check before a call starts: a digest-bound receipt must still
 * match the real file it pins, so a file replaced or removed since detection
 * is a drift the seat re-checks. Legacy metadata-only identities carry no
 * digest-bound receipt; the pre-spawn revalidation reads their pinned file.
 */
function receiptStillMatchesDisk(executable: CliExecutableTrust): boolean {
  if (!('executableIdentity' in executable)) return true;
  const identity = executable.executableIdentity;
  const expected = parseDigestBoundExecutableFingerprint(identity.fingerprint);
  if (expected === null) return false;
  try {
    const info = statSync(identity.realPath);
    if (!info.isFile()) return false;
    return (
      info.dev === expected.dev &&
      info.ino === expected.ino &&
      info.size === expected.size &&
      info.mtimeMs === expected.mtimeMs
    );
  } catch {
    return false;
  }
}

export function assertCliStartGate(
  tool: CliToolId,
  gate: CliStartGate | null | undefined,
): CliExecutableIdentity {
  if (gate === null || gate === undefined || gate.tool !== tool) return missingCliStartGate(tool);
  if (!receiptStillMatchesDisk(gate.executable)) {
    throw error(
      'cli-executable-identity-drift',
      executableChangedMessage(CLI_TOOL_CATALOG[tool].displayName),
      { tool },
    );
  }
  return gate.executable;
}

/** Why a CLI tool that changed during a run did not pass its re-check. */
export type CliToolCheckFailure = Readonly<{
  message: string;
  fix: string;
  cause?: RunnerReadinessCauseId | undefined;
}>;

export type CliToolRecheck =
  | Readonly<{ kind: 'admitted'; gates: readonly Extract<RunnerGate, { kind: 'cli' }>[] }>
  | Readonly<{ kind: 'blocked'; failure: CliToolCheckFailure }>;

/** Checks one CLI tool again the way the run's preparation checked it, for every seat on it. */
export type RecheckCliTool = (
  tool: CliToolId,
  signal: AbortSignal | undefined,
) => Promise<CliToolRecheck>;

/** One CLI seat of a run: the gate its calls start from, and the re-check that replaces it. */
export type CliSeat = Readonly<{
  tool: CliToolId;
  current: () => CliStartGate;
  recheck: (signal: AbortSignal | undefined) => Promise<void>;
}>;

export type CliSeatGates = Readonly<{ seat: (slot: RunnerSlot) => CliSeat }>;

export type CliToolCheckFailedError = AppError<
  'cli-tool-check-failed',
  Readonly<{ tool: CliToolId; fix: string; cause?: RunnerReadinessCauseId | undefined }>
>;

export const cliToolCheckError = {
  failed: (tool: CliToolId, failure: CliToolCheckFailure): CliToolCheckFailedError =>
    error('cli-tool-check-failed', failure.message, {
      tool,
      fix: failure.fix,
      cause: failure.cause,
    }),
  isFailed: (err: unknown): err is CliToolCheckFailedError => matches('cli-tool-check-failed')(err),
} as const;

/** The words a check-failed halt shows on every seat: what the check found, then its fix. */
export function cliToolCheckWords(err: CliToolCheckFailedError): string {
  return `${err.message} ${err.data.fix}`;
}

type CliRunnerGate = Extract<RunnerGate, { kind: 'cli' }>;

/**
 * The run's CLI gates, one cell per seat. A re-check runs once per tool however
 * many seats ask for it at the same time, and its new receipt replaces the gate
 * of every seat on that tool.
 */
export function createCliSeatGates(
  input: Readonly<{ gates: readonly RunnerGate[]; recheck: RecheckCliTool }>,
): CliSeatGates {
  const cells = new Map<string, { gate: CliRunnerGate }>(
    input.gates.flatMap((gate) =>
      gate.kind === 'cli' ? [[runnerSlotId(gate.slot), { gate }] as const] : [],
    ),
  );
  const running = new Map<CliToolId, Promise<void>>();

  async function recheckTool(tool: CliToolId, signal: AbortSignal | undefined): Promise<void> {
    const answer = await input.recheck(tool, signal);
    if (answer.kind === 'blocked') throw cliToolCheckError.failed(tool, answer.failure);
    for (const gate of answer.gates) {
      const cell = cells.get(runnerSlotId(gate.slot));
      if (cell !== undefined) cell.gate = gate;
    }
  }

  function recheck(tool: CliToolId, signal: AbortSignal | undefined): Promise<void> {
    const pending = running.get(tool);
    if (pending !== undefined) return pending;
    const next = recheckTool(tool, signal).finally(() => running.delete(tool));
    running.set(tool, next);
    return next;
  }

  return {
    seat: (slot) => {
      const cell = cells.get(runnerSlotId(slot));
      if (cell === undefined) {
        throw error(
          'runner-gate-mismatch',
          `Runner gate does not match the prepared ${slot.role} context.`,
          {
            kind: 'cli',
            role: slot.role,
          },
        );
      }
      const tool = cell.gate.tool;
      return {
        tool,
        current: () => ({
          tool: cell.gate.tool,
          executable: cell.gate.executable,
          installedVersion: cell.gate.installedVersion,
        }),
        recheck: (signal) => recheck(tool, signal),
      };
    },
  };
}

/** The seat a CLI adapter calls through; an adapter built with none was never admitted. */
export function requireCliSeat(tool: CliToolId, seat: CliSeat | undefined): CliSeat {
  if (seat === undefined || seat.tool !== tool) return missingCliStartGate(tool);
  return seat;
}

const isExecutableDrift = matches('cli-executable-identity-drift');

/** A call that stopped before spawn because the admitted file changed or is gone. */
function driftedBeforeSpawn(result: RunnerCallResult): boolean {
  return (
    result.status !== 'completed' &&
    (result.error.code === 'cli-executable-identity-drift' ||
      result.error.code === 'spawn-not-found')
  );
}

/**
 * Every CLI call of a seat starts the exact file its gate admitted. When that
 * file changed in place or is gone, the seat re-checks the tool once and makes
 * the call again on the new receipt. A file that changes again after its
 * re-check passed fails closed.
 */
export async function callAdmittedCli(
  seat: CliSeat,
  signal: AbortSignal | undefined,
  call: (executable: CliExecutableIdentity, gate: CliStartGate) => Promise<RunnerCallResult>,
): Promise<RunnerCallResult> {
  const attempt = async (): Promise<RunnerCallResult | 'drift'> => {
    const gate = seat.current();
    try {
      const result = await call(assertCliStartGate(seat.tool, gate), gate);
      return driftedBeforeSpawn(result) ? 'drift' : result;
    } catch (cause) {
      if (isExecutableDrift(cause)) return 'drift';
      throw cause;
    }
  };
  const first = await attempt();
  if (first !== 'drift') return first;
  await seat.recheck(signal);
  const second = await attempt();
  if (second !== 'drift') return second;
  const displayName = CLI_TOOL_CATALOG[seat.tool].displayName;
  throw cliToolCheckError.failed(seat.tool, {
    message: executableChangedMessage(displayName),
    fix: `Wait until the ${displayName} update is complete.`,
  });
}
