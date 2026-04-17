export interface ModelsDevModel {
  id: string;
  name?: string | undefined;
  cost?: { input?: number | undefined; output?: number | undefined } | undefined;
  limit?: { context?: number | undefined; output?: number | undefined } | undefined;
  release_date?: string | undefined;
  last_updated?: string | undefined;
}

export interface ModelsDevProvider {
  id: string;
  name?: string | undefined;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;
