import { CONFIG_VERSION, type Config } from '../../schemas/config.js';
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
      compactionFormat: 'auto',
      mode: 'standard',
      taskReview: 'none',
    },
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
]);

export function mergeWithDefaults(loaded: Record<string, unknown>): Record<string, unknown> {
  const defaults = createDefaultConfig();
  const implementerDefaults: Record<string, unknown> = { ...defaults.implementer };

  // Every remaining key is carried through, known or not: validation is what names a removed key,
  // and a key dropped here would reach it as an absence. The accumulator has no prototype, so a
  // `__proto__` key in the file is carried as data instead of re-pointing this object.
  const passthrough: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(loaded)) {
    if (MERGE_HANDLED_KEYS.has(key)) continue;
    if (value !== undefined) passthrough[key] = value;
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
  };
}
