export interface ProviderDef {
  readonly name: string;
  readonly baseURL: string;
  readonly apiKey: () => string;
  readonly isLocal: boolean;
  listModels(): Promise<string[]>;
  isAvailable(): Promise<boolean>;
  detectContextLength?(model: string): Promise<number | null>;
}

export interface ProviderDetection {
  provider: string;
  available: boolean;
  models?: string[];
  isLocal: boolean;
}

export interface ProviderOverrides {
  apiBase?: string;
  apiKey?: string;
}
