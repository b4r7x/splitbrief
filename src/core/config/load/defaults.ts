import { CONFIG_VERSION, ConfigSchema, type Config } from '../../schemas/config.js';
import { DEFAULT_IMPLEMENTER_TEMPERATURE } from '../../schemas/runner-fields.js';
import { getKnownProviderBaseURL } from '../../providers/catalog.js';
import { API_PROVIDER_CATALOG } from '../../providers/api-provider-catalog.js';
import { defaultCliAuthChannel } from '../../runners/cli-tool-catalog.js';
import { narrowRecord } from '../../../utils/type-guards.js';

export function createDefaultConfig(): Config {
  const provider = API_PROVIDER_CATALOG.ollama;
  return {
    version: CONFIG_VERSION,
    planner: {
      kind: 'cli',
      tool: 'claude-code',
      authChannel: defaultCliAuthChannel('claude-code').id,
    },
    implementer: {
      kind: 'api',
      provider: provider.id,
      service: provider.service,
      offering: provider.offering,
      model: 'qwen3-coder:30b',
      apiBase: getKnownProviderBaseURL(provider.id),
      temperature: DEFAULT_IMPLEMENTER_TEMPERATURE,
    },
    validation: {
      typecheck: true,
      lint: true,
      test: true,
    },
    workflow: {
      approve: 'default',
      maxRetries: 3,
      git: { commitStrategy: 'none' },
      isolation: 'worktree',
      persistTranscript: true,
      compactionFormat: 'auto',
      mode: 'standard',
      taskReview: 'none',
    },
    plannerEstimateReview: false,
    autoSplitOverflow: false,
  };
}

function mergeRunner(
  loaded: Record<string, unknown> | null,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  if (!loaded) return defaults;
  // When kinds differ, the loaded runner is already self-contained. Merging
  // would leak kind-specific fields (e.g. provider/apiBase from an api default
  // into a cli config).
  if (loaded.kind !== undefined && loaded.kind !== defaults.kind) return loaded;
  // When the provider is explicitly set and differs from the default, the
  // provider-specific defaults (model/apiBase) do not apply. Merging them would
  // mask schema validation of the genuinely missing model/apiBase fields.
  if (loaded.provider !== undefined && loaded.provider !== defaults.provider) return loaded;
  return { ...defaults, ...loaded };
}

const MERGE_HANDLED_KEYS = new Set([
  'version',
  'planner',
  'implementer',
  'implementerProfiles',
  'validation',
  'workflow',
  'plannerEstimateReview',
  'autoSplitOverflow',
]);

export function mergeWithDefaults(loaded: Record<string, unknown>): Record<string, unknown> {
  const defaults = createDefaultConfig();
  const implementerDefaults: Record<string, unknown> = { ...defaults.implementer };

  const passthrough: Record<string, unknown> = {};
  for (const key of Object.keys(ConfigSchema.shape)) {
    if (MERGE_HANDLED_KEYS.has(key)) continue;
    if (loaded[key] !== undefined) passthrough[key] = loaded[key];
  }

  return {
    version: CONFIG_VERSION,
    planner: loaded['planner'] ?? defaults.planner,
    implementer: mergeRunner(narrowRecord(loaded['implementer']), implementerDefaults),
    ...(loaded['implementerProfiles'] !== undefined && {
      implementerProfiles: loaded['implementerProfiles'],
    }),
    validation: narrowRecord(loaded['validation'])
      ? { ...defaults.validation, ...narrowRecord(loaded['validation']) }
      : defaults.validation,
    workflow: narrowRecord(loaded['workflow'])
      ? { ...defaults.workflow, ...narrowRecord(loaded['workflow']) }
      : defaults.workflow,
    ...passthrough,
    plannerEstimateReview: loaded['plannerEstimateReview'] ?? defaults.plannerEstimateReview,
    autoSplitOverflow: loaded['autoSplitOverflow'] ?? defaults.autoSplitOverflow,
  };
}
