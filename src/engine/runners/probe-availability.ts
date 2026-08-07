import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import type {
  RunnerAvailabilityFact,
  RunnerAvailabilitySlot,
  RunnerAvailabilityVerdict,
} from '../../core/readiness/checks/availability.js';
import type { Config } from '../../core/schemas/config.js';
import { resolveApiKeyOverride } from '../providers/client/api-key.js';
import { sanitizeProviderDiagnostic } from '../providers/client/request.js';
import { getProvider } from '../providers/registry.js';
import type { ProviderDef } from '../providers/types.js';
import { isAgentSdkAvailable } from './agent-sdk/availability.js';
import { composeAbortSignal } from '../../utils/abort.js';

/**
 * Readiness runs before every start, so the budget is what a person will wait
 * for, not what a slow endpoint may take. A probe that overruns it is cancelled
 * and reported as `not-probed` — never as available, and never as a blocker on
 * evidence readiness does not have.
 */
export const RUNNER_AVAILABILITY_PROBE_TIMEOUT_MS = 2_000;

export type RunnerAvailabilityRole = RunnerAvailabilitySlot['role'];

const ALL_AVAILABILITY_ROLES: readonly RunnerAvailabilityRole[] = ['planner', 'implementer'];

type ProbeableRunner = Extract<RunnerConfig, { kind: 'api' | 'agent-sdk' }>;

type ProbeTarget = Readonly<{ slot: RunnerAvailabilitySlot; runner: ProbeableRunner }>;

type ProbedRunner = Omit<RunnerAvailabilityFact, 'slot'>;

function isProbeableRunner(runner: RunnerConfig): runner is ProbeableRunner {
  return runner.kind === 'api' || runner.kind === 'agent-sdk';
}

function probeTargets(config: Config, roles: readonly RunnerAvailabilityRole[]): ProbeTarget[] {
  const targets: ProbeTarget[] = [];
  if (roles.includes('planner') && isProbeableRunner(config.planner)) {
    targets.push({ slot: { role: 'planner' }, runner: config.planner });
  }
  if (!roles.includes('implementer')) return targets;
  for (const profile of resolveImplementerProfiles(config).profiles) {
    if (isProbeableRunner(profile.config)) {
      targets.push({
        slot: { role: 'implementer', profile: profile.name },
        runner: profile.config,
      });
    }
  }
  return targets;
}

function hasCredential(provider: ProviderDef): boolean {
  if (provider.isLocal) return true;
  try {
    return provider.apiKey().length > 0;
  } catch {
    // An `env:` reference to an unset variable is an absent credential, not a
    // probe failure — the remedy is the same as never configuring one.
    return false;
  }
}

function missingCredentialVerdict(provider: string): RunnerAvailabilityVerdict {
  const env = getApiProviderDescriptor(provider)?.credentialEnv;
  return {
    state: 'missing-credential',
    ...(env !== null && env !== undefined && { credentialEnv: env }),
  };
}

/** An endpoint that answers with an empty catalog is reachable but unusable. */
function catalogVerdict(lastError: string | undefined): RunnerAvailabilityVerdict {
  return lastError === undefined
    ? { state: 'no-models' }
    : { state: 'unavailable', diagnostic: lastError };
}

async function probeApiRunner(
  runner: Extract<RunnerConfig, { kind: 'api' }>,
  signal: AbortSignal | undefined,
): Promise<ProbedRunner> {
  const diagnose = (cause: unknown): string =>
    sanitizeProviderDiagnostic(cause, { credentialValues: [runner.apiKey] });

  let provider: ProviderDef;
  try {
    provider = getProvider(runner.provider, {
      apiBase: runner.apiBase,
      ...(runner.apiKey !== undefined && { apiKey: runner.apiKey }),
    });
  } catch (cause) {
    return {
      provider: runner.provider,
      verdict: { state: 'not-probed', diagnostic: diagnose(cause) },
    };
  }

  // Every endpoint policy rejects userinfo, but a custom provider may still
  // carry a query string, and this value is published by `doctor --json`.
  const endpoint = sanitizeProviderDiagnostic(provider.baseURL, {
    credentialValues: [runner.apiKey],
  });
  if (!hasCredential(provider)) {
    return {
      provider: runner.provider,
      endpoint,
      verdict: missingCredentialVerdict(runner.provider),
    };
  }

  try {
    const models = await provider.listModels({
      signal: composeAbortSignal(signal, RUNNER_AVAILABILITY_PROBE_TIMEOUT_MS),
    });
    return {
      provider: runner.provider,
      endpoint,
      verdict:
        models.length > 0 ? { state: 'available' } : catalogVerdict(provider.getLastError?.()),
    };
  } catch (cause) {
    return {
      provider: runner.provider,
      endpoint,
      verdict: { state: 'not-probed', diagnostic: diagnose(cause) },
    };
  }
}

async function probeAgentSdkRunner(
  runner: Extract<RunnerConfig, { kind: 'agent-sdk' }>,
): Promise<ProbedRunner> {
  let apiKey: string | undefined;
  try {
    apiKey = resolveApiKeyOverride(runner.apiKey) ?? process.env.ANTHROPIC_API_KEY;
  } catch {
    apiKey = undefined;
  }
  if (apiKey === undefined || apiKey.length === 0) {
    return { provider: 'anthropic', verdict: missingCredentialVerdict('anthropic') };
  }
  const installed = await isAgentSdkAvailable(apiKey);
  return {
    provider: 'anthropic',
    verdict: installed
      ? { state: 'available' }
      : {
          state: 'unavailable',
          diagnostic: 'Agent SDK not installed (npm install @anthropic-ai/claude-agent-sdk)',
        },
  };
}

async function probeTarget(
  target: ProbeTarget,
  signal: AbortSignal | undefined,
): Promise<RunnerAvailabilityFact> {
  const probed =
    target.runner.kind === 'api'
      ? await probeApiRunner(target.runner, signal)
      : await probeAgentSdkRunner(target.runner);
  return { slot: target.slot, ...probed };
}

/**
 * Contacts only the endpoints the configured runners would call anyway, once
 * each, in parallel — so the wall cost is one model-list round trip.
 */
export async function probeRunnerAvailability(
  input: Readonly<{
    config: Config;
    roles?: readonly RunnerAvailabilityRole[] | undefined;
    signal?: AbortSignal | undefined;
  }>,
): Promise<readonly RunnerAvailabilityFact[]> {
  const targets = probeTargets(input.config, input.roles ?? ALL_AVAILABILITY_ROLES);
  return Promise.all(targets.map((target) => probeTarget(target, input.signal)));
}
