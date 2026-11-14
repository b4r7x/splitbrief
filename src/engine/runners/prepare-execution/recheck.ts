import type { ReadinessCheck } from '../../../core/readiness/types.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import { throwIfAborted, isAbortError } from '../../../utils/abort.js';
import type { RunnerAvailabilityRole } from '../probe-availability.js';
import type { CliToolRecheck, RecheckCliTool } from '../seat-gates.js';
import { checkRunnerTrust } from '../trust.js';
import { evaluateCandidate } from './evaluate-candidate.js';
import type { RunnerGate } from './prepared.js';
import { blockedCheck, runnerCandidates } from './runner-candidates.js';
import type {
  PreparationContext,
  AdmissionInput,
  AdmittedRunners,
  PreparationPolicy,
} from './types.js';

export async function revalidateCliGates(
  gates: readonly RunnerGate[],
  context: PreparationContext,
): Promise<ReadinessCheck[]> {
  const blockers: ReadinessCheck[] = [];
  for (const gate of gates) {
    if (gate.kind !== 'cli') continue;
    try {
      await context.deps.resolveCliExecutableAliases({
        commands: CLI_TOOL_CATALOG[gate.tool].executableAliases,
        projectDir: context.projectDir,
        trust: gate.executable,
      });
      throwIfAborted(context.signal);
    } catch (cause) {
      if (context.signal.aborted || isAbortError(cause)) throw cause;
      blockers.push(
        blockedCheck(gate.slot, gate.kind, 'CLI executable identity changed after admission.'),
      );
    }
  }
  return blockers;
}

export function preparationContext(
  input: Omit<PreparationContext, 'nativeTrustViolations' | 'versionProbes'>,
): PreparationContext {
  return {
    ...input,
    nativeTrustViolations: new Set(
      checkRunnerTrust(input.config, input.projectDir).violations.map(
        (violation) => violation.label,
      ),
    ),
    versionProbes: new Map(),
  };
}

export function installedVersionsOf(
  gates: readonly RunnerGate[],
): Partial<Record<CliToolId, string>> {
  return Object.fromEntries(
    gates.flatMap((gate) =>
      gate.kind === 'cli' && gate.installedVersion !== undefined
        ? [[gate.tool, gate.installedVersion]]
        : [],
    ),
  );
}

function recheckBlocked(check: ReadinessCheck, message: string): CliToolRecheck {
  return {
    kind: 'blocked',
    failure: {
      message,
      fix: check.fix ?? 'Run `splitbrief doctor`, then try again.',
      cause: check.runnerCause?.cause,
    },
  };
}

/**
 * A run's re-check of one CLI tool, after the file it admitted changed: the
 * same per-seat ladder, gate revalidation and arg-vector preflight admission
 * ran, for every seat on that tool, under the same preparation id with fresh
 * version and model reads.
 */
export function cliToolRecheck(
  input: AdmissionInput,
  admitted: Pick<AdmittedRunners, 'config' | 'sourceConfig' | 'preparationId' | 'deps'>,
): RecheckCliTool {
  return async (tool, signal) => {
    const context = preparationContext({
      projectDir: input.projectDir,
      config: admitted.sourceConfig,
      policy: input.policy,
      preparationId: admitted.preparationId,
      signal: signal ?? new AbortController().signal,
      routeCatalogs: new Map(),
      deps: admitted.deps,
    });
    const candidates = runnerCandidates(admitted.sourceConfig, input.policy.purpose).candidates;
    const gates: Extract<RunnerGate, { kind: 'cli' }>[] = [];
    for (const candidate of candidates) {
      if (candidate.runner.kind !== 'cli' || candidate.runner.tool !== tool) continue;
      const evaluation = await evaluateCandidate(candidate, context);
      throwIfAborted(context.signal);
      if (evaluation.kind === 'blocked') {
        return recheckBlocked(
          evaluation.check,
          evaluation.check.details?.join(' ') ?? evaluation.check.summary,
        );
      }
      if (evaluation.gate.kind === 'cli') gates.push(evaluation.gate);
    }
    const [changed] = await revalidateCliGates(gates, context);
    if (changed !== undefined) {
      return recheckBlocked(changed, changed.details?.join(' ') ?? changed.summary);
    }
    const preflight = await admitted.deps.collectArgVectorPreflightChecks({
      config: admitted.config,
      projectDir: input.projectDir,
      roles: calledRoles(input.policy.purpose),
      tool,
      installedVersions: installedVersionsOf(gates),
      signal: context.signal,
    });
    const blocker = preflight.find((check) => check.severity === 'blocker');
    if (blocker !== undefined) return recheckBlocked(blocker, blocker.summary);
    return { kind: 'admitted', gates };
  };
}

/**
 * The seats a run of this purpose calls. A spec run calls only the planner and a
 * one-shot review only the review seat, so no other seat's readiness can gate one.
 */
export function calledRoles(
  purpose: PreparationPolicy['purpose'],
): readonly RunnerAvailabilityRole[] {
  switch (purpose) {
    case 'spec':
      return ['planner'];
    case 'review':
      return ['reviewer'];
    default:
      return ['planner', 'implementer', 'reviewer'];
  }
}
