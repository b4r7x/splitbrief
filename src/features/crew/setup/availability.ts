import { configError } from '../../../core/config/errors.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import type { Config } from '../../../core/schemas/config.js';
import { checkCrewAvailability } from '../../../engine/detection/crew.js';
import type { DetectionStoreState } from '../../../stores/discovery/model-cache/types.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { configStore } from '../../../stores/project/config.js';
import { persistedConfigForSave } from '../../../stores/project/config-persistence.js';

/** Setup reads each tool's own model list the way the picker does. */
export function withCliCatalogs(detection: DetectionStoreState) {
  return {
    ...detection,
    cliCatalog: (tool: CliToolId) => modelCacheStore.getCliCatalogRuntime({ tool }),
  };
}

export async function unavailableSetupSeats(
  config: Config,
  detection: DetectionStoreState,
  signal?: AbortSignal,
) {
  const { config: effective, diskConfig: persisted } = configStore.get();
  if (effective === null || persisted === null) throw configError.loadNotCalled('setup');
  const saved = persistedConfigForSave({ persisted, effective, updated: config });
  const crewDetection = withCliCatalogs(detection);
  const [invocationSeats, persistedSeats] = await Promise.all([
    checkCrewAvailability({ config, detection: crewDetection, signal }),
    checkCrewAvailability({ config: saved, detection: crewDetection, signal }),
  ]);
  return [...invocationSeats, ...persistedSeats];
}
