export type { DetectedModel } from '../../core/types/config.js';
import type { DetectedModel } from '../../core/types/config.js';

export interface ProviderDef {
  readonly name: string;
  readonly baseURL: string;
  readonly apiKey: () => string;
  readonly isLocal: boolean;
  listModels(): Promise<string[]>;
  listModelsWithMetadata?(): Promise<DetectedModel[]>;
  detectContextLength?(model: string): Promise<number | null>;
}

export interface ProviderOverrides {
  apiBase?: string | undefined;
  apiKey?: string | undefined;
}
