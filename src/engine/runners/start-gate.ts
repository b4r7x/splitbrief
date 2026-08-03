import { CLI_TOOL_CATALOG, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { CliReadinessResult } from '../../core/schemas/readiness.js';
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
import {
  resolveCliExecutableAliases,
  type CliExecutableResolver,
} from './resolve-cli-executable.js';
import { error } from '../../utils/error.js';
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

export type CliStartGates = ReadonlyMap<CliToolId, CliStartGate>;

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

export interface RevalidateCliStartGatesOptions {
  readonly projectDir: string;
  readonly gates: CliStartGates;
  readonly resolveExecutable?: CliExecutableResolver | undefined;
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
    runnerTier: CLI_TOOL_CATALOG[options.tool].compatibilityTier,
    unverifiedAuth: options.unverifiedAuth,
  });
  if (admission.kind === 'disclosure-required') return admission;
  if (admission.kind === 'denied') return admission;

  if (options.evidence.executable.kind !== 'trusted') return deniedExecutableFact();
  const executable = executableFromEvidence(options.evidence.executable.identity);
  if (executable === null) return deniedExecutableFact();
  return { kind: 'admitted', gate: { tool: options.tool, executable } };
}

/** Re-resolve every admitted identity before a session exists. */
export async function revalidateCliStartGates(
  options: RevalidateCliStartGatesOptions,
): Promise<CliStartGates> {
  const gates: CliStartGate[] = [];
  for (const gate of options.gates.values()) {
    const executable = (
      await resolveCliExecutableAliases({
        commands: CLI_TOOL_CATALOG[gate.tool].executableAliases,
        projectDir: options.projectDir,
        trust: gate.executable,
        ...(options.resolveExecutable === undefined
          ? {}
          : { resolveExecutable: options.resolveExecutable }),
      })
    ).executable;
    gates.push({ tool: gate.tool, executable });
  }
  return cliStartGatesFromArray(gates);
}

export function cliStartGatesFromArray(gates: readonly CliStartGate[] | undefined): CliStartGates {
  return new Map((gates ?? []).map((gate) => [gate.tool, gate]));
}

export function cliStartGateFor(
  tool: CliToolId,
  gates: CliStartGates | null | undefined,
): CliStartGate {
  const gate = gates?.get(tool);
  if (gate === undefined || gate.tool !== tool) return missingCliStartGate(tool);
  return gate;
}

function missingCliStartGate(tool: CliToolId): never {
  throw error(
    'cli-executable-untrusted',
    `CLI runner "${tool}" has no trusted readiness identity; run readiness checks again before execution.`,
    { tool },
  );
}

export function assertCliStartGate(
  tool: CliToolId,
  gate: CliStartGate | null | undefined,
): CliExecutableIdentity {
  if (gate === null || gate === undefined || gate.tool !== tool) return missingCliStartGate(tool);
  return gate.executable;
}

export function cliStartGateFromReadiness(
  tool: CliToolId,
  readiness: CliReadinessResult | undefined,
): CliStartGate {
  if (
    readiness === undefined ||
    readiness.tool !== tool ||
    readiness.status !== 'ready' ||
    readiness.trust !== 'trusted' ||
    readiness.executable === null
  ) {
    return missingCliStartGate(tool);
  }
  return { tool, executable: readiness.executable };
}

export function cliStartGatesFromReadiness(
  readiness: readonly CliReadinessResult[] | undefined,
): CliStartGates {
  const gates = new Map<CliToolId, CliStartGate>();
  for (const result of readiness ?? []) {
    if (result.status === 'ready' && result.trust === 'trusted' && result.executable !== null) {
      gates.set(result.tool, { tool: result.tool, executable: result.executable });
    }
  }
  return gates;
}
