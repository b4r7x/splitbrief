import type { RunnerDiscoveryContext } from '../../../core/config/accessors/runner-discovery-context.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection/executable.js';
import type { RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
import { CLI_TOOL_IDS, CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { includes, assertNever } from '../../../utils/type-guards.js';
import {
  resolveCliExecutable,
  resolveCliExecutableAliases,
} from '../../runners/cli-executable/resolve.js';
import {
  type CliRunnerDiscoveryContext,
  snapshotCliContext,
  isCredentialFreeCliContext,
  immutableCliExecutableIdentity,
} from '../cli-context.js';
import { createInFlightProbeSharing } from '../in-flight-probes.js';
import { runnerEvidenceBase } from './facts.js';
import { unresolvedCliEvidence } from './outcomes.js';
import { probeResolvedCliEvidence } from './probe-resolved.js';
import type { DetectRunnerEvidenceOptions } from './types.js';

const cliEvidenceProbes = createInFlightProbeSharing<RunnerEvidence>();

function isCliContext(context: RunnerDiscoveryContext): context is CliRunnerDiscoveryContext {
  return context.kind === 'cli' && includes(CLI_TOOL_IDS, context.id);
}

function nonCliRunnerEvidence(context: RunnerDiscoveryContext, observedAt: number): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  switch (context.kind) {
    case 'api':
      return {
        ...base,
        installation: 'not-applicable',
        executable: { kind: 'not-applicable' },
        compatibility: { kind: 'not-applicable' },
        credential: context.credentialPresent ? 'present' : 'absent',
        auth: context.credentialPresent ? 'unknown' : 'missing',
      };
    case 'shell':
    case 'agent':
      return {
        ...base,
        installation: 'not-applicable',
        executable: { kind: 'not-applicable' },
        compatibility: { kind: 'not-applicable' },
        credential: 'not-applicable',
        auth: 'not-required',
      };
    case 'cli':
      return {
        ...base,
        installation: 'unknown',
        executable: { kind: 'unknown' },
        compatibility: {
          kind: 'unknown',
          installedVersion: null,
          testedVersion: 'unknown',
        },
        credential: 'unknown',
        auth: 'unknown',
      };
    default:
      return assertNever(context.kind);
  }
}

/**
 * Probes exactly one sanitized active-runner context. It never chooses an auth
 * channel, runs a catalog unless requested, or returns probe output. Resolving
 * and attributing the executable happens per caller. Native auth has no reliable
 * freshness identity, so concurrent calls each obtain their own observation.
 */
export async function detectRunnerEvidence(
  options: DetectRunnerEvidenceOptions,
): Promise<RunnerEvidence> {
  throwIfAborted(options.signal);
  const now = options.now ?? Date.now;
  const observedAt = now();
  if (!isCliContext(options.context)) return nonCliRunnerEvidence(options.context, observedAt);

  const context = snapshotCliContext(options.context);
  if (!isCredentialFreeCliContext(context)) return nonCliRunnerEvidence(context, observedAt);
  const projectDir = options.projectDir ?? process.cwd();
  const resolveExecutable = options.resolveExecutable ?? resolveCliExecutable;
  let executable: CliExecutableIdentity;
  try {
    const resolvedExecutable = (
      await resolveCliExecutableAliases({
        commands: CLI_TOOL_CATALOG[context.id].executableAliases,
        projectDir,
        resolveExecutable,
      })
    ).executable;
    executable = immutableCliExecutableIdentity(resolvedExecutable);
  } catch (cause) {
    throwIfAborted(options.signal);
    return unresolvedCliEvidence(context, observedAt, cause);
  }
  options.onResolvedCliExecutable?.(executable);

  return cliEvidenceProbes.share({
    // A tool's native auth channel does not identify the account/session
    // currently behind it. Keep its cancellation boundary, but never reuse it.
    key: undefined,
    signal: options.signal,
    run: (probeSignal) =>
      probeResolvedCliEvidence(options, { context, observedAt, executable, signal: probeSignal }),
  });
}
