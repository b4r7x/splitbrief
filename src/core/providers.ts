export {
  PROVIDER_IDS,
  PLANNER_TOOL_IDS,
  CLI_TOOL_IDS,
  API_PROVIDER_IDS,
  LOCAL_PROVIDER_IDS,
  META_PROVIDER_IDS,
  isProviderId,
  isPlannerToolId,
  type ProviderId,
  type PlannerToolId,
  type CliToolId,
  type ApiProviderId,
  type LocalProviderId,
  type MetaProviderId,
} from './types/schemas/enums.js';

export type { ProviderInfo } from './providers/catalog.js';
export {
  KNOWN_PROVIDER_BASE_URLS,
  PROVIDER_CATALOG,
  getProviderBaseURL,
  getProviderDisplayName,
  hasApiKey,
  isProviderLocal,
  isProviderSubscription,
  resolveDefaultApiBase,
} from './providers/catalog.js';

export type { KnownModel } from './providers/known-models.js';
export { DEFAULT_AGENT_SDK_MODEL, KNOWN_MODELS } from './providers/known-models.js';

export { normalizeConfiguredModel, resolveAutoModel } from './providers/model-selection.js';
