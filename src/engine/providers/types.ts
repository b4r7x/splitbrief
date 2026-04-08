export interface ProviderDef {
  readonly name: string;
  readonly baseURL: string;
  readonly apiKey: () => string;
  readonly isLocal: boolean;
  listModels(): Promise<string[]>;
  detectContextLength?(model: string): Promise<number | null>;
}

export type { ProviderDetection } from '../../types.js';

export interface ProviderOverrides {
  apiBase?: string;
  apiKey?: string;
}
