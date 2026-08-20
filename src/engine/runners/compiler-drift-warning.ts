import type { Planner } from '../planners/types.js';
import { readPlannerCompilerSeam } from '../planners/base.js';
import type { CompilerCapabilityReceipt } from './compiler-capability.js';
import { hasRuntimeConformance, readRuntimeConformance } from './runtime-conformance-cache.js';

export function driftedCompilerReceipt(planner: Planner): CompilerCapabilityReceipt | null {
  const receipt = readPlannerCompilerSeam(planner)?.receipt;
  return receipt?.versionObservation === 'drifted' ? receipt : null;
}

/**
 * The single runtime-drift decision every run surface makes: a drifted
 * capability receipt warns unless this project already recorded conformance
 * for that exact (backend, runtime version) pair.
 */
export function compilerDriftWarning(
  input: Readonly<{ planner: Planner; projectDir: string }>,
): string | null {
  const receipt = driftedCompilerReceipt(input.planner);
  if (receipt === null) return null;
  const proven = hasRuntimeConformance(readRuntimeConformance(input.projectDir), {
    backend: receipt.backend,
    version: receipt.runtimeVersion,
  });
  if (proven) return null;
  return `planner ${receipt.backend} ${receipt.runtimeVersion} differs from the tested ${receipt.version}; compiled with runtime-drift evidence`;
}
