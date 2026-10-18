import type { CrewLabVerdict } from '../../core/crew/labs.js';
import { computeCrewPresets, type CrewPreset } from '../../core/crew/presets.js';
import { deriveCrewRows, type CrewRow } from '../../core/crew/rows.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';
import { servedProviders } from '../../core/runners/route-auth.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { useCrewDisplayNames } from '../../hooks/use-crew-display-names.js';
import { crewVerdict } from './rows.js';

export interface Crew {
  readonly rows: readonly CrewRow[];
  readonly verdict: CrewLabVerdict | undefined;
  readonly presets: readonly CrewPreset[];
  /** The installed tools that are not signed in and call no provider set up in their config, by display name. */
  readonly signedOut: readonly string[];
}

export function useCrew(): Crew {
  const config = configStore.useConfig();
  const cliTools = detectionStore.use((state) => state.cliTools);
  // A catalog-only publication changes which providers a tool serves, so it rerenders the list.
  detectionStore.use((state) => state.cliCatalogOutcomes);
  const displayNames = useCrewDisplayNames(config);
  const rows = deriveCrewRows({ config, displayNames });

  return {
    rows,
    verdict: crewVerdict(rows),
    presets: computeCrewPresets({
      config,
      detection: {
        cliTools,
        providers: [],
        cliCatalog: (tool) => modelCacheStore.getCliCatalogRuntime({ tool }),
      },
    }),
    signedOut: cliTools
      .filter(
        (detection) =>
          detection.diagnostic.state === 'unauthenticated' &&
          servedProviders({
            tool: detection.tool,
            providerAuth: detection.providerAuth,
            catalog: modelCacheStore.getCliCatalogRuntime({ tool: detection.tool }),
          }).length === 0,
      )
      .map((detection) => CLI_TOOL_CATALOG[detection.tool].displayName),
  };
}
