import { join } from 'node:path';
import YAML from 'yaml';
import { ConfigSchema, type Config } from '../../schemas/config.js';
import { resolveDefaultApiBase, KNOWN_PROVIDER_BASE_URLS } from '../../providers/catalog.js';
import { validateConfig } from './validate.js';
import { fromYaml, toYaml } from './transform.js';
import { DIPTYCH_DIR, CONFIG_FILE, getDiptychPath } from '../../paths.js';
import { migrateConfig } from './migrate.js';
import { checkConfigPermissions, ensureGitignore } from '../../../lib/fs.js';
import {
  confinedExists,
  confinedReadFile,
  confinedWriteFile,
  confinedEnsureDir,
} from '../../../lib/confined-fs.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { configError } from '../errors.js';

export function configPath(projectDir: string): string {
  return getDiptychPath(projectDir, CONFIG_FILE);
}

export function createDefaultConfig(): Config {
  return {
    version: 3,
    planner: { kind: 'cli', tool: 'claude-code' },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      apiBase: resolveDefaultApiBase('ollama') ?? KNOWN_PROVIDER_BASE_URLS.ollama,
      contextLength: 32768,
      temperature: 0.3,
    },
    validation: {
      typecheck: true,
      lint: true,
      test: true,
      testCommand: 'npm test',
    },
    workflow: {
      autoApproveSpec: false,
      autoApprovePlan: false,
      approve: 'default',
      maxRetries: 3,
      commitStrategy: 'none',
      git: { commitStrategy: 'none' },
      persistTranscript: true,
      compactionFormat: 'auto',
      mode: 'standard',
      taskReview: 'none',
    },
    theme: 'terminal',
    shikiTheme: 'github-dark',
    sessions: { scope: 'project' },
    plannerEstimateReview: false,
    autoSplitOverflow: false,
  };
}

function mergeRunner(
  migrated: Record<string, unknown> | null,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  if (!migrated) return defaults;
  // When kinds differ, the migrated config is already self-contained (from
  // v1→v2 migration or explicitly set in v2). Merging would leak kind-specific
  // fields (e.g. provider/apiBase from an api default into a cli config).
  if (migrated.kind !== undefined && migrated.kind !== defaults.kind) return migrated;
  return { ...defaults, ...migrated };
}

const MERGE_HANDLED_KEYS = new Set([
  'version',
  'planner',
  'implementer',
  'implementerProfiles',
  'validation',
  'workflow',
  'theme',
  'shikiTheme',
  'sessions',
  'plannerEstimateReview',
  'autoSplitOverflow',
]);

function mergeWithDefaults(migrated: Record<string, unknown>): Record<string, unknown> {
  const defaults = createDefaultConfig();
  const implementerDefaults: Record<string, unknown> = { ...defaults.implementer };

  const passthrough: Record<string, unknown> = {};
  for (const key of Object.keys(ConfigSchema.shape)) {
    if (MERGE_HANDLED_KEYS.has(key)) continue;
    if (migrated[key] !== undefined) passthrough[key] = migrated[key];
  }

  return {
    version: 3,
    planner: migrated['planner'] ?? defaults.planner,
    implementer: mergeRunner(narrowRecord(migrated['implementer']), implementerDefaults),
    ...(migrated['implementerProfiles'] !== undefined && {
      implementerProfiles: migrated['implementerProfiles'],
    }),
    validation: narrowRecord(migrated['validation'])
      ? { ...defaults.validation, ...narrowRecord(migrated['validation']) }
      : defaults.validation,
    workflow: narrowRecord(migrated['workflow'])
      ? { ...defaults.workflow, ...narrowRecord(migrated['workflow']) }
      : defaults.workflow,
    theme: migrated['theme'] ?? defaults.theme,
    shikiTheme: migrated['shikiTheme'] ?? defaults.shikiTheme,
    sessions: narrowRecord(migrated['sessions'])
      ? { ...defaults.sessions, ...narrowRecord(migrated['sessions']) }
      : defaults.sessions,
    ...passthrough,
    plannerEstimateReview: migrated['plannerEstimateReview'] ?? defaults.plannerEstimateReview,
    autoSplitOverflow: migrated['autoSplitOverflow'] ?? defaults.autoSplitOverflow,
  };
}

export interface LoadConfigResult {
  config: Config;
  warnings: string[];
}

const CONFIG_RELATIVE_PATH = join(DIPTYCH_DIR, CONFIG_FILE);

export function loadConfig(projectDir: string): LoadConfigResult {
  const filePath = configPath(projectDir);

  if (!confinedExists(projectDir, CONFIG_RELATIVE_PATH)) {
    return { config: createDefaultConfig(), warnings: [] };
  }

  const yamlText = confinedReadFile(projectDir, CONFIG_RELATIVE_PATH);
  if (yamlText === null) return { config: createDefaultConfig(), warnings: [] };

  const warnings: string[] = [];
  if (process.platform !== 'win32' && !checkConfigPermissions(filePath)) {
    warnings.push(
      `Config file ${filePath} has overly permissive permissions. Consider running: chmod 600 ${filePath}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    throw configError.invalidYaml(filePath, err);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError.validationFailed(filePath, [
      `Configuration in ${DIPTYCH_DIR}/${CONFIG_FILE} must be a YAML object.`,
    ]);
  }

  const camelCased = fromYaml(parsed);

  const migrated = narrowRecord(migrateConfig(camelCased, warnings)) ?? {};

  const merged = mergeWithDefaults(migrated);

  const { errors, warnings: validationWarnings, data } = validateConfig(merged);
  if (errors.length > 0) {
    const lines = [`Configuration errors in ${DIPTYCH_DIR}/${CONFIG_FILE}:`];
    for (const err of errors) {
      lines.push(`  ${err.path}: ${err.message}`);
    }
    throw configError.validationFailed(filePath, lines);
  }

  warnings.push(...validationWarnings);

  if (!data) {
    throw configError.validationFailed(filePath, [
      'Unexpected validation state: no data after successful validation',
    ]);
  }
  return { config: data, warnings };
}

export function writeConfig(projectDir: string, config: Config): void {
  confinedEnsureDir(projectDir, DIPTYCH_DIR);
  confinedWriteFile(projectDir, CONFIG_RELATIVE_PATH, YAML.stringify(toYaml(config)));
}

export function initConfig(projectDir: string, opts: { force?: boolean } = {}): void {
  if (!opts.force && confinedExists(projectDir, CONFIG_RELATIVE_PATH)) return;

  ensureGitignore(projectDir, '.diptych/');

  confinedEnsureDir(projectDir, DIPTYCH_DIR);
  confinedWriteFile(
    projectDir,
    CONFIG_RELATIVE_PATH,
    YAML.stringify(toYaml(createDefaultConfig())),
  );
}
