import { createDefaultConfig } from '../../core/config/load/defaults.js';
import { readActiveRunner } from '../../core/config/accessors/active-runner.js';
import { projectRunnerDiscoveryContext } from '../../core/config/accessors/runner-discovery-context.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import {
  detectedSeatReady,
  selectDefaultCrew,
  type CrewDetection,
} from '../../core/crew/default.js';
import {
  API_PROVIDER_CATALOG,
  isApiProviderId,
} from '../../core/providers/api-provider-catalog.js';
import { getKnownProviderBaseURL } from '../../core/providers/catalog.js';
import type { ActiveRunnerRole } from '../../core/runners/seat-roles.js';
import type { Config } from '../../core/schemas/config.js';
import { CREW_SEAT_ROLES, deriveCrewSeats } from '../../core/crew/seats.js';
import type { RunnerAvailabilityFact } from '../../core/readiness/checks/availability.js';
import { probeRunnerAvailability } from '../runners/probe-availability.js';
import {
  configuredProviderConnection,
  type ConfiguredProviderRuntime,
} from './provider-outcomes.js';

type CrewDiscovery = CrewDetection &
  Readonly<{
    providerOutcomes?: readonly ConfiguredProviderRuntime[] | undefined;
    apiAvailability?: readonly RunnerAvailabilityFact[] | undefined;
  }>;

function connectionRole(config: Config, role: ActiveRunnerRole): ActiveRunnerRole {
  return role === 'reviewer' && resolveReviewerRunner(config).source === 'planner'
    ? 'planner'
    : role;
}

function availabilityForSeat(input: {
  config: Config;
  role: ActiveRunnerRole;
  detection: CrewDiscovery;
}) {
  const role = connectionRole(input.config, input.role);
  const runner = readActiveRunner(input);
  const profile =
    role === 'implementer'
      ? resolveImplementerProfiles(input.config).defaultProfile.name
      : undefined;
  return runner.kind === 'api'
    ? input.detection.apiAvailability?.find(
        (entry) =>
          entry.slot.role === role &&
          entry.provider === runner.provider &&
          (entry.slot.role !== 'implementer' || entry.slot.profile === profile),
      )
    : undefined;
}

export function crewDetectionForSeat(input: {
  config: Config;
  role: ActiveRunnerRole;
  detection: CrewDiscovery;
}): CrewDetection {
  const { config, detection } = input;
  const role = connectionRole(config, input.role);
  const runner = readActiveRunner({ config, role });
  if (runner.kind !== 'api') {
    return { cliTools: detection.cliTools, providers: [] };
  }
  const fact = availabilityForSeat(input);
  if (fact !== undefined) {
    return {
      cliTools: detection.cliTools,
      providers: [
        {
          provider: runner.provider,
          available: fact.verdict.state === 'available',
          isLocal: isApiProviderId(runner.provider),
          models: runner.model === undefined ? [] : [{ id: runner.model }],
        },
      ],
    };
  }
  if (!isApiProviderId(runner.provider)) {
    return { cliTools: detection.cliTools, providers: [] };
  }
  const scoped = detection.providerOutcomes?.filter((entry) => entry.connection.role === role);
  if (scoped === undefined || scoped.length === 0) {
    return {
      cliTools: detection.cliTools,
      providers:
        runner.apiBase === getKnownProviderBaseURL(runner.provider) && runner.apiKey === undefined
          ? detection.providers
          : [],
    };
  }
  const connection = configuredProviderConnection(
    projectRunnerDiscoveryContext({ config, role }),
    runner.provider,
  );
  const descriptor = API_PROVIDER_CATALOG[runner.provider];
  return {
    cliTools: detection.cliTools,
    providers: scoped
      .filter((entry) => entry.connection.contextKey === connection.contextKey)
      .map((entry) => ({
        provider: connection.provider,
        available: entry.state === 'fresh' && entry.catalog === 'populated',
        isLocal: descriptor.locality === 'local',
        models: [...(entry.models ?? [])],
      })),
  };
}

export function selectDetectedDefaultCrew(detection: CrewDiscovery): Config | null {
  return selectDefaultCrew(
    crewDetectionForSeat({ config: createDefaultConfig(), role: 'implementer', detection }),
  );
}

export function unavailableCrewSeats(input: { config: Config; detection: CrewDiscovery }) {
  return deriveCrewSeats({ config: input.config }).filter(({ id }) => {
    const role = connectionRole(input.config, CREW_SEAT_ROLES[id]);
    const runner = readActiveRunner({ config: input.config, role });
    const fact = availabilityForSeat({ ...input, role });
    if (runner.kind === 'api' && fact !== undefined) return fact.verdict.state !== 'available';
    return (
      (runner.kind === 'api' || runner.kind === 'cli') &&
      !detectedSeatReady(runner, crewDetectionForSeat({ ...input, role }))
    );
  });
}

export async function checkCrewAvailability(input: {
  config: Config;
  detection: CrewDiscovery;
  signal?: AbortSignal | undefined;
}) {
  const roles = deriveCrewSeats({ config: input.config }).flatMap(({ id }) => {
    const role = connectionRole(input.config, CREW_SEAT_ROLES[id]);
    const runner = readActiveRunner({ config: input.config, role });
    return runner.kind === 'api' && crewDetectionForSeat({ ...input, role }).providers.length === 0
      ? [role]
      : [];
  });
  const apiAvailability = await probeRunnerAvailability({
    config: input.config,
    roles,
    signal: input.signal,
  });
  return unavailableCrewSeats({
    config: input.config,
    detection: { ...input.detection, apiAvailability },
  });
}
