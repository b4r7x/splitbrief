import { createStore, storeBase } from '../create-store.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import { cloneDetectedModel } from '../../core/discovery/clone-model.js';

interface DetectionState {
  cliTools: CliToolDetection[];
  implementers: ProviderDetection[];
}

const initial: DetectionState = {
  cliTools: [],
  implementers: [],
};

const store = createStore<DetectionState>(initial);

function cloneCliTool(cliTool: CliToolDetection): CliToolDetection {
  return {
    ...cliTool,
    executable: cliTool.executable
      ? {
          path: cliTool.executable.path,
          fingerprint: { ...cliTool.executable.fingerprint },
        }
      : null,
    diagnostic:
      cliTool.diagnostic.state === 'ready'
        ? { state: 'ready', remediation: null }
        : { state: cliTool.diagnostic.state, remediation: cliTool.diagnostic.remediation },
  };
}

function cloneDetection(detection: DetectionState): DetectionState {
  return {
    cliTools: detection.cliTools.map(cloneCliTool),
    implementers: detection.implementers.map((implementer) => ({
      ...implementer,
      ...(implementer.models ? { models: implementer.models.map(cloneDetectedModel) } : {}),
    })),
  };
}

export const detectionStore = {
  ...storeBase(store),
  setDetection: (detection: DetectionState) => store.set(cloneDetection(detection)),
};
