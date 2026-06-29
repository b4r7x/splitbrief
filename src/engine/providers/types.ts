import type { DetectedModel } from '../../core/discovery/detection.js';

export interface ProviderDef {
  readonly name: string;
  readonly baseURL: string;
  readonly apiKey: () => string;
  readonly isLocal: boolean;
  listModels(): Promise<string[]>;
  listModelsWithMetadata?(): Promise<DetectedModel[]>;
  detectContextLength?(model: string): Promise<number | null>;
  getLastError?(): string | undefined;
}

export interface ProviderDefWithMetadata extends ProviderDef {
  listModelsWithMetadata(): Promise<DetectedModel[]>;
  detectContextLength(model: string): Promise<number | null>;
}

export interface ProviderOverrides {
  apiBase?: string | undefined;
  apiKey?: string | undefined;
}

export type StreamMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};
