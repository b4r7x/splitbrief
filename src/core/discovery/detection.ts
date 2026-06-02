import type { PlannerToolId, ProviderId } from '../schemas/enums.js';

export interface DetectedModel {
  id: string;
  contextLength?: number;
  pricingInput?: number;
  pricingOutput?: number;
  isFree?: boolean;
  capabilities?: string[];
  releaseDate?: string;
}

export interface PlannerDetection {
  tool: PlannerToolId;
  // agent-sdk excluded: it's programmatic (not detectable via CLI probe).
  type: 'cli' | 'api' | 'shell';
  available: boolean;
  version?: string;
  description?: string;
  error?: string;
}

export interface ProviderDetection {
  provider: ProviderId;
  available: boolean;
  models?: DetectedModel[];
  isLocal: boolean;
  hasKey?: boolean;
  error?: string;
}
