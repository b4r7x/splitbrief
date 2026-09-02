import { API_PROVIDER_CATALOG } from '../src/core/providers/api-provider-catalog.js';
import { ConfigSchema, type Config } from '../src/core/schemas/config.js';
import { error } from '../src/utils/error.js';

export type EvalMode = 'baseline' | 'routed';

export type ModelPair = {
  plannerModel: string;
  baselineImplementerModel: string;
  routedImplementerModel: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
};

/**
 * No admitted preset fills both eval seats, so an eval always names its own
 * custom endpoint. A name the catalog already knows is rejected here, or the
 * schema would reject it later with a less useful message.
 */
function rejectCatalogProvider(provider: string): void {
  const knownToCatalog = Object.values(API_PROVIDER_CATALOG).some(
    (descriptor) => descriptor.id === provider || descriptor.service === provider,
  );
  if (knownToCatalog) {
    throw error(
      'eval-provider-not-usable-for-both-roles',
      `Eval provider "${provider}" is not usable for both eval roles; name a custom endpoint instead.`,
    );
  }
}

export function buildEvalConfig(pair: ModelPair, mode: EvalMode): Config {
  const implementerModel =
    mode === 'baseline' ? pair.baselineImplementerModel : pair.routedImplementerModel;
  rejectCatalogProvider(pair.provider);

  return ConfigSchema.parse({
    version: 3,
    planner: {
      kind: 'api',
      provider: pair.provider,
      service: pair.provider,
      offering: 'payg',
      apiBase: pair.baseUrl,
      model: pair.plannerModel,
      apiKey: pair.apiKey,
    },
    implementer: {
      kind: 'api',
      provider: pair.provider,
      service: pair.provider,
      offering: 'payg',
      apiBase: pair.baseUrl,
      model: implementerModel,
      apiKey: pair.apiKey,
    },
    validation: {
      typecheck: true,
      lint: false,
      test: true,
      testCommand: 'npm test',
    },
    workflow: {
      maxRetries: 1,
      mode: 'quick',
      persistTranscript: true,
    },
  });
}
