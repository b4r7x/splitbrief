import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { CliReadinessResult } from '../../core/schemas/readiness.js';
import { error } from '../../utils/error.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';

export type CliStartGate = Readonly<{
  tool: CliToolId;
  executable: CliExecutableIdentity;
}>;

export type CliStartGates = ReadonlyMap<CliToolId, CliStartGate>;

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
