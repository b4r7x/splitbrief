import type { DetectedModel } from '../../core/types/config.js';
import { API_PROVIDER_IDS, CLI_TOOL_IDS, type ProviderId } from '../../core/types/schemas/enums.js';
import { isProviderId, isProviderLocal, isProviderSubscription, stripVendorPrefix } from '../../core/providers.js';
import { KNOWN_MODELS } from './known.js';
import { getModelsForProvider } from './models-dev.js';

export interface ModelCacheAccessor {
  getModelsDevCatalog(): import('./models-dev.js').ModelsDevCatalog | null;
  getProviderModels(providerId: ProviderId): DetectedModel[] | null;
}

export interface ParsedModelId {
  provider: ProviderId | null;
  modelName: string;
}

export interface ModelPricing {
  input: number | undefined;
  output: number | undefined;
  isFree: boolean | undefined;
}

export type PricingMode =
  | 'api-priced'
  | 'unpriced-cli'
  | 'unpriced-local'
  | 'unpriced-meta'
  | 'unpriced-unknown';

export interface ResolvedPricing {
  inputPer1M: number;
  outputPer1M: number;
  isLocal: boolean;
  isPriced: boolean;
  pricingMode: PricingMode;
  name: string;
  source: 'models-dev' | 'runtime' | 'bundled-fallback' | 'unpriced';
}

export interface ResolvedModelCatalogEntry extends DetectedModel {
  id: string;
  isDefault?: boolean;
  isDetected?: boolean;
  source: 'models-dev' | 'runtime' | 'bundled-fallback';
  pricingMode: PricingMode;
}

const MODEL_PREFIX_TO_PROVIDER: Record<string, ProviderId> = {
  claude: 'anthropic',
  gpt: 'openai',
  o1: 'openai',
  o3: 'openai',
  o4: 'openai',
  o5: 'openai',
  deepseek: 'deepseek',
  gemini: 'openai',
  qwen: 'together',
  llama: 'together',
  mistral: 'together',
  glm: 'together',
};

const PRICED_PROVIDER_IDS = new Set<ProviderId>(API_PROVIDER_IDS);
const UNPRICED_CLI_PROVIDER_IDS = new Set<string>(CLI_TOOL_IDS);
const META_UNPRICED_IDS = new Set<string>(['shell', 'agent']);

const DATE_SUFFIX_RE = /[-_.]?\d{8}$/;
const CLAUDE_DOTTED_VERSION_RE = /claude-([a-z0-9-]+)-(\d+)\.(\d+)/g;

export const LOCAL_PRICING: ResolvedPricing = {
  inputPer1M: 0,
  outputPer1M: 0,
  isLocal: true,
  isPriced: false,
  pricingMode: 'unpriced-local',
  name: 'Local model',
  source: 'unpriced',
};

function makeUnpriced(providerId: string, name?: string): ResolvedPricing {
  if (isProviderLocal(providerId)) return name ? { ...LOCAL_PRICING, name } : LOCAL_PRICING;
  if (UNPRICED_CLI_PROVIDER_IDS.has(providerId) || isProviderSubscription(providerId)) {
    return {
      inputPer1M: 0,
      outputPer1M: 0,
      isLocal: false,
      isPriced: false,
      pricingMode: 'unpriced-cli',
      name: name ?? providerId,
      source: 'unpriced',
    };
  }
  if (META_UNPRICED_IDS.has(providerId)) {
    return {
      inputPer1M: 0,
      outputPer1M: 0,
      isLocal: false,
      isPriced: false,
      pricingMode: 'unpriced-meta',
      name: name ?? providerId,
      source: 'unpriced',
    };
  }
  return {
    inputPer1M: 0,
    outputPer1M: 0,
    isLocal: false,
    isPriced: false,
    pricingMode: 'unpriced-unknown',
    name: name ?? providerId,
    source: 'unpriced',
  };
}

function normalizeModelKey(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(CLAUDE_DOTTED_VERSION_RE, 'claude-$1-$2-$3')
    .replace(DATE_SUFFIX_RE, '');
}

export function buildComparableKeys(modelId: string): string[] {
  const stripped = stripVendorPrefix(modelId);
  const keys = new Set([normalizeModelKey(modelId), normalizeModelKey(stripped)]);
  return [...keys];
}

export function idsMatch(a: string, b: string): boolean {
  const aKeys = new Set(buildComparableKeys(a));
  return buildComparableKeys(b).some((key) => aKeys.has(key));
}

export function isApiPricedProvider(providerId: string): providerId is ProviderId {
  return isProviderId(providerId) && PRICED_PROVIDER_IDS.has(providerId);
}

export function getPricingMode(providerId: ProviderId): PricingMode {
  if (isProviderLocal(providerId)) return 'unpriced-local';
  if (isApiPricedProvider(providerId)) return 'api-priced';
  if (UNPRICED_CLI_PROVIDER_IDS.has(providerId) || isProviderSubscription(providerId)) return 'unpriced-cli';
  return 'unpriced-meta';
}

export function mergeModelMetadata(
  providerId: ProviderId,
  base: ResolvedModelCatalogEntry | undefined,
  runtime: DetectedModel | undefined,
  modelsDev: DetectedModel | undefined,
): ResolvedModelCatalogEntry | undefined {
  const seed = base ?? (runtime
    ? {
        id: runtime.id,
        source: 'runtime' as const,
        pricingMode: getPricingMode(providerId),
      }
    : modelsDev
      ? {
          id: modelsDev.id,
          source: 'models-dev' as const,
          pricingMode: getPricingMode(providerId),
        }
      : undefined);

  if (!seed) return undefined;

  const contextLength = modelsDev?.contextLength ?? runtime?.contextLength ?? seed.contextLength;
  const pricingInput = modelsDev?.pricingInput ?? runtime?.pricingInput ?? seed.pricingInput;
  const pricingOutput = modelsDev?.pricingOutput ?? runtime?.pricingOutput ?? seed.pricingOutput;
  const isFree = modelsDev?.isFree ?? runtime?.isFree ?? seed.isFree;
  const isDetected = seed.isDetected ?? !!runtime;
  const releaseDate = modelsDev?.releaseDate ?? runtime?.releaseDate ?? seed.releaseDate;

  const merged: ResolvedModelCatalogEntry = {
    ...seed,
    source: modelsDev
      ? 'models-dev'
      : seed.source === 'models-dev'
        ? 'models-dev'
        : runtime
          ? 'runtime'
          : seed.source,
    ...(contextLength !== undefined && { contextLength }),
    ...(pricingInput !== undefined && { pricingInput }),
    ...(pricingOutput !== undefined && { pricingOutput }),
    ...(isFree !== undefined && { isFree }),
    ...(isDetected !== undefined && { isDetected }),
    ...(releaseDate !== undefined && { releaseDate }),
  };

  if (!isApiPricedProvider(providerId)) {
    delete merged.pricingInput;
    delete merged.pricingOutput;
    delete merged.isFree;
  }

  return merged;
}

export function parseModelId(modelId: string): ParsedModelId {
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    const providerPart = modelId.slice(0, slash);
    const modelName = modelId.slice(slash + 1);
    if (isProviderId(providerPart)) {
      return { provider: providerPart, modelName };
    }
    return { provider: null, modelName: modelId };
  }

  const lowerModel = modelId.toLowerCase();
  for (const [prefix, provider] of Object.entries(MODEL_PREFIX_TO_PROVIDER)) {
    if (lowerModel.startsWith(prefix)) {
      return { provider, modelName: modelId };
    }
  }

  return { provider: null, modelName: modelId };
}

function findKnownModel(providerId: ProviderId, modelId: string) {
  const bundled = KNOWN_MODELS[providerId] ?? [];
  const direct = bundled.find((entry) =>
    idsMatch(entry.name, modelId)
    || entry.aliases?.some((alias) => idsMatch(alias, modelId)));
  if (direct) return direct;
  return bundled.find((entry) => entry.catalogModelId ? idsMatch(entry.catalogModelId, modelId) : false);
}

function getDefaultKnownModel(providerId: ProviderId) {
  return (KNOWN_MODELS[providerId] ?? []).find((entry) => entry.isDefault);
}

function getEffectiveModelId(providerId: ProviderId, modelId?: string): string | undefined {
  const selected = modelId?.trim();
  if (selected) {
    const known = findKnownModel(providerId, selected);
    return known?.catalogModelId ?? known?.name ?? selected;
  }

  const fallback = getDefaultKnownModel(providerId);
  return fallback?.catalogModelId ?? fallback?.name;
}

function lookupModelsDevModelForPricing(providerId: ProviderId, modelId: string, cache: ModelCacheAccessor): DetectedModel | null {
  const catalog = cache.getModelsDevCatalog();
  if (!catalog) return null;
  for (const entry of getModelsForProvider(catalog, providerId)) {
    if (idsMatch(entry.id, modelId)) return entry;
  }
  return null;
}

function lookupRuntimeModelForPricing(providerId: ProviderId, modelId: string, cache: ModelCacheAccessor): DetectedModel | null {
  const runtimeProvider = cache.getProviderModels(providerId === 'agent-sdk' ? 'anthropic' : providerId);
  return runtimeProvider?.find((entry) => idsMatch(entry.id, modelId)) ?? null;
}

const NULL_CACHE: ModelCacheAccessor = {
  getModelsDevCatalog: () => null,
  getProviderModels: () => null,
};

export function lookupModelPricing(providerId: ProviderId, modelName: string, cache: ModelCacheAccessor = NULL_CACHE): ModelPricing | null {
  const match = lookupModelsDevModelForPricing(providerId, modelName, cache)
    ?? lookupRuntimeModelForPricing(providerId, modelName, cache);
  if (!match) return null;
  return {
    input: match.pricingInput,
    output: match.pricingOutput,
    isFree: match.isFree,
  };
}

export function formatPricing(input: number | undefined, output: number | undefined): string | null {
  if (input === undefined && output === undefined) return null;

  const formatNum = (n: number | undefined): string => {
    if (n === undefined) return '?';
    if (n === 0) return '$0';
    if (n < 0.01) return `$${n.toFixed(4)}`;
    if (n < 1) return `$${n.toFixed(2)}`;
    return `$${n}`;
  };

  return `${formatNum(input)}/${formatNum(output)}`;
}

export function resolvePricing(providerId: string, cache: ModelCacheAccessor = NULL_CACHE, modelId?: string): ResolvedPricing {
  if (!isProviderId(providerId)) return makeUnpriced(providerId, modelId);
  if (!isApiPricedProvider(providerId)) return makeUnpriced(providerId, modelId);

  const effectiveModelId = getEffectiveModelId(providerId, modelId);
  if (!effectiveModelId) return makeUnpriced(providerId, modelId);

  const modelsDev = lookupModelsDevModelForPricing(providerId, effectiveModelId, cache);
  if (modelsDev?.pricingInput !== undefined && modelsDev.pricingOutput !== undefined) {
    return {
      inputPer1M: modelsDev.pricingInput,
      outputPer1M: modelsDev.pricingOutput,
      isLocal: false,
      isPriced: true,
      pricingMode: 'api-priced',
      name: effectiveModelId,
      source: 'models-dev',
    };
  }

  const runtime = lookupRuntimeModelForPricing(providerId, effectiveModelId, cache);
  if (runtime?.pricingInput !== undefined && runtime.pricingOutput !== undefined) {
    return {
      inputPer1M: runtime.pricingInput,
      outputPer1M: runtime.pricingOutput,
      isLocal: false,
      isPriced: true,
      pricingMode: 'api-priced',
      name: effectiveModelId,
      source: 'runtime',
    };
  }

  const fallback = findKnownModel(providerId, effectiveModelId);
  if (fallback?.pricingInput !== undefined && fallback.pricingOutput !== undefined) {
    return {
      inputPer1M: fallback.pricingInput,
      outputPer1M: fallback.pricingOutput,
      isLocal: false,
      isPriced: true,
      pricingMode: 'api-priced',
      name: effectiveModelId,
      source: 'bundled-fallback',
    };
  }

  return makeUnpriced(providerId, effectiveModelId);
}
