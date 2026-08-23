import { computeCrewPresets, type CrewPreset } from '../../core/crew/presets.js';
import { deriveCrewSeats, type CrewSeat } from '../../core/crew/seats.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';

export interface Crew {
  readonly seats: readonly CrewSeat[];
  readonly presets: readonly CrewPreset[];
}

export function useCrew(): Crew {
  const config = configStore.useConfig();
  const cliTools = detectionStore.use((state) => state.cliTools);
  const readyTools = cliTools
    .filter((detection) => detection.diagnostic.state === 'ready')
    .map((detection) => detection.tool);

  return {
    seats: deriveCrewSeats({ config }),
    presets: computeCrewPresets({ config, readyTools }),
  };
}
