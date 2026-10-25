import type { RunnerConfigSlot } from '../../config/accessors/runner-config.js';
import { getApiProviderDescriptor } from '../../providers/api-provider-catalog.js';
import { getRunnerIdentityDisplayName } from '../../providers/catalog.js';
import { assertNever } from '../../../utils/type-guards.js';
import { CREW_SEAT_LABELS, formatSlotLabel } from '../../crew/identity.js';
import { PICKER_ROLE_SEAT_IDS, type ActiveRunnerRole } from '../../runners/seat-roles.js';
import type { ReadinessCheck } from '../types.js';

export type RunnerAvailabilitySlot = Extract<RunnerConfigSlot, { role: ActiveRunnerRole }>;

/**
 * `not-probed` is the only honest verdict when the probe could not run or could
 * not finish: readiness must never upgrade an unknown to `available`.
 */
export type RunnerAvailabilityVerdict =
  | Readonly<{ state: 'available' }>
  | Readonly<{ state: 'unavailable'; diagnostic: string }>
  | Readonly<{ state: 'no-models' }>
  /** The server answered with a catalog that does not carry the selected model. */
  | Readonly<{ state: 'missing-model'; selectionId: string }>
  /** The connection did not answer within the readiness budget. */
  | Readonly<{ state: 'timeout'; diagnostic: string }>
  /** The server answered and rejected the configured authentication. */
  | Readonly<{ state: 'unauthorized'; diagnostic: string }>
  | Readonly<{ state: 'missing-credential'; credentialEnv?: string | undefined }>
  | Readonly<{ state: 'not-probed'; diagnostic: string }>;

export interface RunnerAvailabilityFact {
  readonly slot: RunnerAvailabilitySlot;
  readonly provider: string;
  /** Absent when the verdict was reached without contacting an endpoint. */
  readonly endpoint?: string | undefined;
  readonly verdict: RunnerAvailabilityVerdict;
}

// Derived from the descriptor union rather than the catalog's LocalApiProviderId,
// which resolves to never: a new local provider must add a startup remedy here.
type LocalApiProvider = Extract<
  NonNullable<ReturnType<typeof getApiProviderDescriptor>>,
  { offering: 'local' }
>;

const LOCAL_PROVIDER_STARTUP: Readonly<Record<LocalApiProvider['id'], string>> = {
  ollama: 'Run `ollama serve`',
  'lm-studio': 'Start the LM Studio local server',
  'llama-cpp': 'Start the llama.cpp server (`llama-server`)',
};

/** The one wording for how an operator starts each local server; the picker mirrors it. */
export function localProviderStartup(provider: string): string | undefined {
  const descriptor = getApiProviderDescriptor(provider);
  if (descriptor === undefined || descriptor.offering !== 'local') return undefined;
  return LOCAL_PROVIDER_STARTUP[descriptor.id];
}

function runnerAvailabilityCheckId(slot: RunnerAvailabilitySlot): string {
  switch (slot.role) {
    case 'planner':
      return 'runners.availability.planner';
    case 'implementer':
      return `runners.availability.implementer.${slot.profile}`;
    case 'reviewer':
      return 'runners.availability.reviewer';
    default:
      return assertNever(slot);
  }
}

function pickAnother(slot: RunnerAvailabilitySlot): string {
  if (slot.role === 'implementer' && slot.profile !== 'default') {
    return `change ${formatSlotLabel(slot)} in .splitbrief/config.yaml`;
  }
  return `choose another tool in Settings > Crew > ${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[slot.role]]}`;
}

function providerName(fact: RunnerAvailabilityFact): string {
  return getRunnerIdentityDisplayName('api', fact.provider);
}

function unavailableFix(fact: RunnerAvailabilityFact): string {
  const startup = localProviderStartup(fact.provider);
  if (startup !== undefined) {
    return `${startup}, or ${pickAnother(fact.slot)}, then run \`splitbrief doctor\` again.`;
  }
  return `Check the ${providerName(fact)} endpoint and network, or ${pickAnother(fact.slot)}, then run \`splitbrief doctor\` again.`;
}

function credentialFix(
  fact: RunnerAvailabilityFact,
  verdict: Extract<RunnerAvailabilityVerdict, { state: 'missing-credential' }>,
): string {
  const supply =
    verdict.credentialEnv === undefined
      ? `Set an apiKey for ${providerName(fact)}`
      : `Export ${verdict.credentialEnv}`;
  return `${supply}, or ${pickAnother(fact.slot)}, then run \`splitbrief doctor\` again.`;
}

function atEndpoint(fact: RunnerAvailabilityFact): string {
  return fact.endpoint === undefined ? '' : ` at ${fact.endpoint}`;
}

interface AvailabilityCopy {
  summary: string;
  details?: string[] | undefined;
  fix?: string | undefined;
}

function availabilityCopy(fact: RunnerAvailabilityFact, label: string): AvailabilityCopy {
  const verdict = fact.verdict;
  switch (verdict.state) {
    case 'available':
      return { summary: `${label} is available${atEndpoint(fact)}.` };
    case 'unavailable':
      return {
        summary: `${label} is not reachable${atEndpoint(fact)}.`,
        details: [`Probe: ${verdict.diagnostic}`],
        fix: unavailableFix(fact),
      };
    case 'no-models':
      return {
        summary: `${label} answered${atEndpoint(fact)} but offers no models.`,
        fix: `Install a model for ${providerName(fact)}, or ${pickAnother(fact.slot)}, then run \`splitbrief doctor\` again.`,
      };
    case 'missing-model':
      return {
        summary: `${label} answered${atEndpoint(fact)} but does not serve "${verdict.selectionId}".`,
        // Readiness never substitutes another model the catalog happens to carry.
        fix: `Select a model ${providerName(fact)} serves, or ${pickAnother(fact.slot)}, then run \`splitbrief doctor\` again.`,
      };
    case 'timeout':
      return {
        summary: `${label} did not answer in time${atEndpoint(fact)}.`,
        details: [`Probe: ${verdict.diagnostic}`],
        fix: unavailableFix(fact),
      };
    case 'unauthorized':
      return {
        summary: `${label} rejected the configured credential${atEndpoint(fact)}.`,
        details: [`Probe: ${verdict.diagnostic}`],
        fix: `Check the credential for ${providerName(fact)}, or ${pickAnother(fact.slot)}, then run \`splitbrief doctor\` again.`,
      };
    case 'missing-credential':
      return {
        summary: `${label} has no credential configured.`,
        fix: credentialFix(fact, verdict),
      };
    case 'not-probed':
      return {
        summary: `${label} availability was not probed.`,
        details: [`Probe: ${verdict.diagnostic}`],
      };
    default:
      return assertNever(verdict);
  }
}

function availabilitySeverity(
  fact: RunnerAvailabilityFact,
  isDefaultImplementer: boolean,
): ReadinessCheck['severity'] {
  if (fact.verdict.state === 'available') return 'ok';
  if (fact.verdict.state === 'not-probed') return 'info';
  // A runner the workflow is certain to call cannot be advisory: the planning
  // phase is paid for before the implementer is first used, and a configured
  // reviewer always runs the final review.
  switch (fact.slot.role) {
    case 'planner':
    case 'reviewer':
      return 'blocker';
    case 'implementer':
      return isDefaultImplementer ? 'blocker' : 'warning';
    default:
      return assertNever(fact.slot);
  }
}

export function runnerAvailabilityCheck(
  input: Readonly<{
    fact: RunnerAvailabilityFact;
    label: string;
    isDefaultImplementer: boolean;
  }>,
): ReadinessCheck {
  const copy = availabilityCopy(input.fact, input.label);
  const severity = availabilitySeverity(input.fact, input.isDefaultImplementer);
  return {
    id: runnerAvailabilityCheckId(input.fact.slot),
    severity,
    summary: copy.summary,
    ...(copy.details !== undefined && { details: copy.details }),
    ...(copy.fix !== undefined && { fix: copy.fix }),
    ...(severity === 'blocker' && { nextAction: 'prepare-runner' as const }),
    metadata: {
      role: input.fact.slot.role,
      ...(input.fact.slot.role === 'implementer' && { profile: input.fact.slot.profile }),
      provider: input.fact.provider,
      endpoint: input.fact.endpoint ?? null,
      availability: input.fact.verdict.state,
    },
  };
}
