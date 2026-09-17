import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { parseApiKeyEnvRef } from '../../core/config/credentials.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import {
  getApiProviderDescriptor,
  isApiProviderId,
} from '../../core/providers/api-provider-catalog.js';
import type {
  RunnerAvailabilityFact,
  RunnerAvailabilitySlot,
  RunnerAvailabilityVerdict,
} from '../../core/readiness/checks/availability.js';
import type { Config } from '../../core/schemas/config.js';
import { createInFlightProbeSharing } from '../detection/runner-evidence.js';
import { sanitizeProviderDiagnostic } from '../providers/client/request.js';
import { getProvider } from '../providers/registry.js';
import {
  apiConnectionContextKey,
  probeSelectedProviderModel,
  type SelectedProviderModelProbe,
} from '../providers/selected-model.js';
import type { ProviderDef } from '../providers/types.js';
import { isAbortError } from '../../utils/abort.js';
import { assertNever } from '../../utils/type-guards.js';

/**
 * Readiness runs before every start, so the budget is what a person will wait
 * for, not what a slow endpoint may take. Overrunning it is evidence of its own
 * — the connection timed out — while a caller that stops waiting leaves no
 * evidence at all and stays `not-probed`.
 */
export const RUNNER_AVAILABILITY_PROBE_TIMEOUT_MS = 2_000;

export type RunnerAvailabilityRole = RunnerAvailabilitySlot['role'];

const ALL_AVAILABILITY_ROLES = [
  'planner',
  'implementer',
  'reviewer',
] as const satisfies readonly RunnerAvailabilityRole[];

type ProbeableRunner = Extract<RunnerConfig, { kind: 'api' }>;

type ProbeTarget = Readonly<{ slot: RunnerAvailabilitySlot; runner: ProbeableRunner }>;

type ProbedRunner = Omit<RunnerAvailabilityFact, 'slot'>;

function isProbeableRunner(runner: RunnerConfig): runner is ProbeableRunner {
  return runner.kind === 'api';
}

function targetsForRole(config: Config, role: RunnerAvailabilityRole): ProbeTarget[] {
  switch (role) {
    case 'planner':
      return isProbeableRunner(config.planner)
        ? [{ slot: { role: 'planner' }, runner: config.planner }]
        : [];
    case 'implementer':
      return resolveImplementerProfiles(config).profiles.flatMap((profile) =>
        isProbeableRunner(profile.config)
          ? [{ slot: { role: 'implementer', profile: profile.name }, runner: profile.config }]
          : [],
      );
    case 'reviewer': {
      const reviewer = resolveReviewerRunner(config);
      return reviewer.source === 'configured' && isProbeableRunner(reviewer.runner)
        ? [{ slot: { role: 'reviewer' }, runner: reviewer.runner }]
        : [];
    }
    default:
      return assertNever(role);
  }
}

function probeTargets(config: Config, roles: readonly RunnerAvailabilityRole[]): ProbeTarget[] {
  return ALL_AVAILABILITY_ROLES.filter((role) => roles.includes(role)).flatMap((role) =>
    targetsForRole(config, role),
  );
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

/**
 * Catalog membership is the whole admission test: a listed model the server has
 * not loaded stays available, because the server loads it when execution asks.
 */
function selectedModelVerdict(
  probe: SelectedProviderModelProbe,
  runner: ProbeableRunner,
): RunnerAvailabilityVerdict {
  if (probe.kind === 'found') return { state: 'available' };
  switch (probe.failure) {
    case 'empty-catalog':
      return { state: 'no-models' };
    case 'missing-model':
      return { state: 'missing-model', selectionId: probe.selectionId };
    case 'timeout':
      return { state: 'timeout', diagnostic: probe.diagnostic };
    case 'invalid-credential':
      // Only an actual rejection earns the label; a reachable server does not.
      return { state: 'unauthorized', diagnostic: probe.diagnostic };
    case 'missing-credential':
      return missingCredentialVerdict(runner.provider);
    case 'endpoint-invalid':
      // The probe never left the process, so there is nothing to report about
      // the server itself.
      return { state: 'not-probed', diagnostic: probe.diagnostic };
    case 'policy-denied':
    case 'privacy-filtered':
    case 'guardrail-filtered':
    case 'offline':
    case 'malformed':
    case 'request-failed':
      return { state: 'unavailable', diagnostic: probe.diagnostic };
    default:
      return assertNever(probe.failure);
  }
}

type ProbeDeadline = Readonly<{ signal: AbortSignal; expired: () => boolean }>;

/** Keeps the readiness budget distinguishable from the caller's own abort. */
function probeDeadline(signal: AbortSignal | undefined): ProbeDeadline {
  const deadline = AbortSignal.timeout(RUNNER_AVAILABILITY_PROBE_TIMEOUT_MS);
  return {
    signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    expired: () => deadline.aborted,
  };
}

async function catalogAdmission(
  runner: ProbeableRunner,
  provider: ProviderDef,
  signal: AbortSignal,
): Promise<RunnerAvailabilityVerdict> {
  const selectionId = runner.model;
  if (isApiProviderId(runner.provider) && selectionId !== undefined && selectionId.length > 0) {
    const probe = await probeSelectedProviderModel({
      provider: runner.provider,
      overrides: {
        apiBase: runner.apiBase,
        ...(runner.apiKey !== undefined && { apiKey: runner.apiKey }),
      },
      contextKey: apiConnectionContextKey(runner.provider, runner.apiBase),
      selectionId,
      signal,
    });
    return selectedModelVerdict(probe, runner);
  }
  const models = await provider.listModels({ signal });
  return models.length > 0 ? { state: 'available' } : catalogVerdict(provider.getLastError?.());
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

  const deadline = probeDeadline(signal);
  try {
    return {
      provider: runner.provider,
      endpoint,
      verdict: await catalogAdmission(runner, provider, deadline.signal),
    };
  } catch (cause) {
    // Our own budget running out is an observation about the connection; the
    // caller's abort is the absence of one.
    const timedOut = deadline.expired() && signal?.aborted !== true;
    return {
      provider: runner.provider,
      endpoint,
      verdict: timedOut
        ? { state: 'timeout', diagnostic: diagnose(cause) }
        : { state: 'not-probed', diagnostic: diagnose(cause) },
    };
  }
}

const availabilityProbes = createInFlightProbeSharing<ProbedRunner>();

const envCredentialIdentities = new Map<
  string,
  { readonly value: string | undefined; readonly identity: string }
>();
let nextEnvCredentialIdentity = 0;

function envCredentialIdentity(name: string): string {
  const value = process.env[name];
  const previous = envCredentialIdentities.get(name);
  if (previous !== undefined && previous.value === value) return previous.identity;
  const identity = `value-${++nextEnvCredentialIdentity}`;
  envCredentialIdentities.set(name, { value, identity });
  return identity;
}

function credentialObservationIdentity(apiKey: string | undefined): string | undefined {
  const envName = parseApiKeyEnvRef(apiKey);
  if (envName !== undefined) return `env:${envName}:${envCredentialIdentity(envName)}`;
  if (apiKey === undefined || apiKey.length === 0) return 'no-credential';
  return undefined;
}

/** The identity of the observation: which seat asks which endpoint for which model, as whom. */
function availabilityObservationKey(target: ProbeTarget): string | undefined {
  // Inline credentials never share;
  // an env reference shares only while its process-local value identity stays
  // the same, so a rotation cannot inherit the old observation.
  const credentialIdentity = credentialObservationIdentity(target.runner.apiKey);
  if (credentialIdentity === undefined) return undefined;
  if (getApiProviderDescriptor(target.runner.provider)?.offering !== 'local') return undefined;
  return [
    'runner-availability-v1',
    target.slot.role,
    target.slot.role === 'implementer' ? target.slot.profile : 'single',
    target.runner.provider,
    target.runner.apiBase,
    target.runner.model ?? 'unselected',
    credentialIdentity,
  ]
    .map((part) => encodeURIComponent(part))
    .join('|');
}

async function probeTarget(
  target: ProbeTarget,
  signal: AbortSignal | undefined,
): Promise<RunnerAvailabilityFact> {
  try {
    const probed = await availabilityProbes.share({
      key: availabilityObservationKey(target),
      signal,
      run: (probeSignal) => probeApiRunner(target.runner, probeSignal),
    });
    return { slot: target.slot, ...probed };
  } catch (cause) {
    if (!isAbortError(cause)) throw cause;
    // A caller that stopped waiting has no evidence, which readiness reports
    // as `not-probed` — never as available, and never as a blocker.
    return {
      slot: target.slot,
      provider: target.runner.provider,
      verdict: {
        state: 'not-probed',
        diagnostic: sanitizeProviderDiagnostic(cause, {
          credentialValues: [target.runner.apiKey],
        }),
      },
    };
  }
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
