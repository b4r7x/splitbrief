import { statSync } from 'node:fs';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import {
  CliExecutableReceiptSchema,
  parseDigestBoundExecutableFingerprint,
} from '../../core/discovery/detection.js';
import {
  admitStart,
  type RunnerEvidence,
  type StartAdmission,
  type StartFact,
} from '../../core/discovery/runner-evidence.js';
import { error } from '../../utils/error.js';
import { assertNever } from '../../utils/type-guards.js';
import type { RunnerGate, RunnerGateExpectation } from './prepared-execution.js';
import type {
  CliExecutableIdentity,
  CliExecutableReceipt,
  CliExecutableTrust,
  ExecutableIdentity,
} from '../../core/discovery/detection.js';

export type CliStartGate = Readonly<{
  tool: CliToolId;
  executable: CliExecutableTrust;
}>;

export type FreshCliStartGate = Readonly<{
  tool: CliToolId;
  executable: CliExecutableReceipt;
}>;

export type FreshCliStartGateResult =
  | Readonly<{ kind: 'admitted'; gate: FreshCliStartGate }>
  | Readonly<{ kind: 'disclosure-required'; auth: 'unknown' }>
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
      case 'agent-sdk':
        return expected.kind === 'agent-sdk' && candidate.provider === expected.provider;
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
  });
  if (admission.kind === 'disclosure-required') return admission;
  if (admission.kind === 'denied') return admission;

  if (options.evidence.executable.kind !== 'trusted') return deniedExecutableFact();
  const executable = executableFromEvidence(options.evidence.executable.identity);
  if (executable === null) return deniedExecutableFact();
  return { kind: 'admitted', gate: { tool: options.tool, executable } };
}

function missingCliStartGate(tool: CliToolId): never {
  throw error(
    'cli-executable-untrusted',
    `CLI runner "${tool}" has no trusted readiness identity; run readiness checks again before execution.`,
    { tool },
  );
}

/**
 * The final receipt recheck immediately before spawn: a digest-bound receipt
 * must still match the executable on disk at gate-consumption time, so a
 * binary replaced or removed since detection fails closed. Legacy
 * metadata-only identities carry no digest-bound receipt; the resolver trust
 * ladder revalidates them at resolve time.
 */
function receiptStillMatchesDisk(executable: CliExecutableTrust): boolean {
  if (executable === null || executable === undefined) return false;
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
      `Executable identity changed for ${tool}; run readiness checks again before execution.`,
      { tool },
    );
  }
  return gate.executable;
}
