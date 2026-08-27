import type { CrewLabVerdict } from '../../core/crew/labs.js';
import { computeCrewPresets, type CrewPreset } from '../../core/crew/presets.js';
import { deriveCrewRows, type CrewRow } from '../../core/crew/rows.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { useCrewDisplayNames } from '../../hooks/use-crew-display-names.js';
import { crewVerdict } from './rows.js';

export interface Crew {
  readonly rows: readonly CrewRow[];
  readonly verdict: CrewLabVerdict | undefined;
  readonly presets: readonly CrewPreset[];
}

export function useCrew(): Crew {
  const config = configStore.useConfig();
  const cliTools = detectionStore.use((state) => state.cliTools);
  const readyTools = cliTools
    .filter((detection) => detection.diagnostic.state === 'ready')
    .map((detection) => detection.tool);
  const displayNames = useCrewDisplayNames(config);
  const rows = deriveCrewRows({ config, displayNames });

  return {
    rows,
    verdict: crewVerdict(rows),
    presets: computeCrewPresets({ config, readyTools }),
  };
}
