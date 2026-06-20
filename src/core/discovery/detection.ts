import type { PlannerToolId, ProviderId } from '../schemas/enums.js';

export interface DetectedPricingTier {
  type: 'context';
  thresholdTokens: number;
  inputPer1M?: number;
  outputPer1M?: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

export interface DetectedModel {
  id: string;
  contextLength?: number;
  maxOutputTokens?: number;
  pricingInput?: number;
  pricingOutput?: number;
  pricingCacheRead?: number;
  pricingCacheWrite?: number;
  pricingTiers?: DetectedPricingTier[];
  isFree?: boolean;
  supportsTemperature?: boolean;
  supportsReasoning?: boolean;
  supportsImages?: boolean;
  capabilities?: string[];
  releaseDate?: string;
}

export type PlannerCompatibility = {
  kind: 'major-version-mismatch';
  installedVersion: string;
  testedVersion: string;
};

export interface PlannerDetection {
  tool: PlannerToolId;
  // agent-sdk excluded: it's programmatic (not detectable via CLI probe).
  type: 'cli' | 'api' | 'shell';
  available: boolean;
  version?: string;
  compatibility?: PlannerCompatibility;
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
