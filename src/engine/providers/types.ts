import type { DetectedModel } from '../../core/discovery/detection.js';
import type { ApiProviderId } from '../../core/providers/api-provider-catalog.js';

export interface ProviderModelListOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface ProviderDef {
  readonly name: string;
  readonly baseURL: string;
  readonly apiKey: () => string;
  readonly isLocal: boolean;
  listModels(options?: ProviderModelListOptions): Promise<string[]>;
  listModelsWithMetadata?(options?: ProviderModelListOptions): Promise<DetectedModel[]>;
  detectContextLength?(model: string): Promise<number | null>;
  getLastError?(): string | undefined;
}

export interface ProviderDefWithMetadata extends ProviderDef {
  listModelsWithMetadata(options?: ProviderModelListOptions): Promise<DetectedModel[]>;
  detectContextLength(model: string): Promise<number | null>;
}

export interface ProviderOverrides {
  apiBase?: string | undefined;
  apiKey?: string | undefined;
}

export const PROVIDER_CATALOG_FAILURE_KINDS = [
  'endpoint-invalid',
  'missing-credential',
  'invalid-credential',
  'policy-denied',
  'privacy-filtered',
  'guardrail-filtered',
  'offline',
  'timeout',
  'malformed',
  'request-failed',
] as const;

export type ProviderCatalogFailureKind = (typeof PROVIDER_CATALOG_FAILURE_KINDS)[number];

export type ProviderCatalogCredentialState = 'not-required' | 'present' | 'absent';

export type ProviderCatalogOutcome =
  | Readonly<{
      kind: 'success';
      source: 'provider-runtime';
      provider: ApiProviderId;
      isLocal: boolean;
      credential: ProviderCatalogCredentialState;
      catalog: 'populated' | 'empty';
      models: readonly DetectedModel[];
      warning?: string | undefined;
    }>
  | Readonly<{
      kind: 'failed';
      source: 'provider-runtime';
      provider: ApiProviderId;
      isLocal: boolean;
      credential: ProviderCatalogCredentialState;
      failure: ProviderCatalogFailureKind;
      diagnostic: string;
    }>;

export type StreamMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};
