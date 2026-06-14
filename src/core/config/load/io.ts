import { join } from 'node:path';
import YAML, { parseDocument } from 'yaml';
import { ConfigSchema, type Config } from '../../schemas/config.js';
import { resolveDefaultApiBase, KNOWN_PROVIDER_BASE_URLS } from '../../providers/catalog.js';
import { validateConfig } from './validate.js';
import { fromYaml, toYaml } from './transform.js';
import { DIPTYCH_DIR, TREES_DIR, CONFIG_FILE, getDiptychPath } from '../../paths.js';
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
    },
    workflow: {
      approve: 'default',
      maxRetries: 3,
      git: { commitStrategy: 'none' },
      persistTranscript: true,
      compactionFormat: 'auto',
      mode: 'standard',
      taskReview: 'none',
    },
    theme: 'terminal',
    plannerEstimateReview: false,
    autoSplitOverflow: false,
  };
}

function stripLegacyTestCommandDefault(
  validation: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!validation) return {};
  if (validation['testCommand'] !== 'npm test') return validation;
  const { testCommand, ...rest } = validation;
  return rest;
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
  // When the provider is explicitly set and differs from the default, the
  // provider-specific defaults (model/apiBase) do not apply. Merging them would
  // mask schema validation of the genuinely missing model/apiBase fields.
  if (migrated.provider !== undefined && migrated.provider !== defaults.provider) return migrated;
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
      ? {
          ...defaults.validation,
          ...stripLegacyTestCommandDefault(narrowRecord(migrated['validation'])),
        }
      : defaults.validation,
    workflow: narrowRecord(migrated['workflow'])
      ? { ...defaults.workflow, ...narrowRecord(migrated['workflow']) }
      : defaults.workflow,
    theme: migrated['theme'] ?? defaults.theme,
    ...passthrough,
    plannerEstimateReview: migrated['plannerEstimateReview'] ?? defaults.plannerEstimateReview,
    autoSplitOverflow: migrated['autoSplitOverflow'] ?? defaults.autoSplitOverflow,
  };
}

export interface LoadConfigResult {
  config: Config;
  warnings: string[];
  rawYaml: string;
}

const CONFIG_RELATIVE_PATH = join(DIPTYCH_DIR, CONFIG_FILE);

export function loadConfig(projectDir: string): LoadConfigResult {
  const filePath = configPath(projectDir);

  if (!confinedExists(projectDir, CONFIG_RELATIVE_PATH)) {
    return { config: createDefaultConfig(), warnings: [], rawYaml: '' };
  }

  const yamlText = confinedReadFile(projectDir, CONFIG_RELATIVE_PATH);
  if (yamlText === null) throw configError.unreadable(filePath);

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
  return { config: data, warnings, rawYaml: yamlText };
}

export function writeConfig(projectDir: string, config: Config): string {
  const text = YAML.stringify(toYaml(config));
  ensureGitignore(projectDir, `${DIPTYCH_DIR}/`);
  ensureGitignore(projectDir, `${TREES_DIR}/`);
  confinedEnsureDir(projectDir, DIPTYCH_DIR);
  confinedWriteFile(projectDir, CONFIG_RELATIVE_PATH, text);
  return text;
}

export function rawDocumentHasVersion(rawYaml: string): boolean {
  if (rawYaml.trim() === '') return false;
  let parsed: unknown;
  try {
    parsed = YAML.parse(rawYaml);
  } catch {
    return false;
  }
  return narrowRecord(parsed)?.['version'] !== undefined;
}

export interface ConfigDocumentEdit {
  path: readonly string[];
  value: unknown;
}

export function writeConfigDocument(
  projectDir: string,
  rawYaml: string,
  edits: readonly ConfigDocumentEdit[],
): string {
  const doc = parseDocument(rawYaml);
  for (const { path, value } of edits) {
    if (path.length === 0) continue;
    if (value === undefined) {
      doc.deleteIn(path);
    } else {
      doc.setIn(path, value);
    }
  }
  const text = doc.toString();
  confinedEnsureDir(projectDir, DIPTYCH_DIR);
  confinedWriteFile(projectDir, CONFIG_RELATIVE_PATH, text);
  return text;
}

export function initConfig(projectDir: string, opts: { force?: boolean } = {}): void {
  if (!opts.force && confinedExists(projectDir, CONFIG_RELATIVE_PATH)) return;
  writeConfig(projectDir, createDefaultConfig());
}
