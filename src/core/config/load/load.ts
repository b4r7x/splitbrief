import fs from 'node:fs';
import YAML from 'yaml';
import type { Config } from '../../schemas/config.js';
import { resolveDefaultApiBase, KNOWN_PROVIDER_BASE_URLS } from '../../providers/catalog.js';
import { validateConfig } from './validate.js';
import { fromYaml, toYaml } from './transform.js';
import { DIPTYCH_DIR, CONFIG_FILE, getDiptychPath } from '../../paths.js';
import { migrateConfig } from './migrate.js';
import { writeSecureFile, checkConfigPermissions, ensureGitignore } from '../../../lib/fs.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { configError } from '../errors.js';

export function configPath(projectDir: string): string {
  return getDiptychPath(projectDir, CONFIG_FILE);
}

export function createDefaultConfig(): Config {
  return {
    version: 2,
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
      maxRetries: 3,
      commitStrategy: 'none',
      persistTranscript: true,
      mode: 'standard',
    },
    theme: 'terminal',
    shikiTheme: 'github-dark',
    sessions: { scope: 'project' },
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

function mergeWithDefaults(migrated: Record<string, unknown>): Record<string, unknown> {
  const defaults = createDefaultConfig();
  const implementerDefaults: Record<string, unknown> = { ...defaults.implementer };

  return {
    version: 2,
    planner: migrated['planner'] ?? defaults.planner,
    implementer: mergeRunner(
      narrowRecord(migrated['implementer']),
      implementerDefaults,
    ),
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
    ...(migrated['escalation'] !== undefined && { escalation: migrated['escalation'] }),
  };
}

export interface LoadConfigResult {
  config: Config;
  warnings: string[];
}

export function loadConfig(projectDir: string): LoadConfigResult {
  const filePath = configPath(projectDir);

  if (!fs.existsSync(filePath)) return { config: createDefaultConfig(), warnings: [] };

  const yamlText = fs.readFileSync(filePath, 'utf-8');

  const warnings: string[] = [];
  if (process.platform !== 'win32' && !checkConfigPermissions(filePath)) {
    warnings.push(`Config file ${filePath} has overly permissive permissions. Consider running: chmod 600 ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    throw configError.invalidYaml(filePath, err);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: createDefaultConfig(), warnings };
  }

  const camelCased = fromYaml(parsed);

  const migrated = narrowRecord(migrateConfig(camelCased)) ?? {};

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
  const configFilePath = getDiptychPath(projectDir, CONFIG_FILE);
  writeSecureFile(configFilePath, YAML.stringify(toYaml(config)));
}

export function initConfig(projectDir: string, opts: { force?: boolean } = {}): void {
  const configFilePath = getDiptychPath(projectDir, CONFIG_FILE);

  if (!opts.force && fs.existsSync(configFilePath)) return;

  ensureGitignore(projectDir, '.diptych/');

  const yamlObj = toYaml(createDefaultConfig());
  writeSecureFile(configFilePath, YAML.stringify(yamlObj));
}
