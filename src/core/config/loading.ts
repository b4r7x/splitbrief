import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Config } from '../types/index.js';
import { resolveDefaultApiBase, KNOWN_PROVIDER_BASE_URLS } from '../providers.js';
import { validateConfig } from './validation.js';
import { fromYaml, toYaml } from './transforms.js';
import { TINY_SPEC_DIR, CONFIG_FILE } from '../paths.js';
import { migrateConfig } from './migration.js';
import { SECURE_DIR_MODE, SECURE_FILE_MODE, checkConfigPermissions } from '../../utils/fs.js';
import { ensureGitignore } from '../../utils/git.js';

export function configPath(projectDir: string): string {
  return path.join(projectDir, TINY_SPEC_DIR, CONFIG_FILE);
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
      mode: 'standard',
    },
    theme: 'terminal',
    shikiTheme: 'github-dark',
    sessions: { scope: 'project' },
  };
}

function mergeWithDefaults(migrated: Config): Config {
  const defaults = createDefaultConfig();

  return {
    version: 2,
    planner: migrated.planner ?? defaults.planner,
    implementer: migrated.implementer
      ? { ...defaults.implementer, ...migrated.implementer }
      : defaults.implementer,
    validation: migrated.validation
      ? { ...defaults.validation, ...migrated.validation }
      : defaults.validation,
    workflow: migrated.workflow
      ? { ...defaults.workflow, ...migrated.workflow }
      : defaults.workflow,
    theme: migrated.theme ?? defaults.theme,
    shikiTheme: migrated.shikiTheme ?? defaults.shikiTheme,
    sessions: migrated.sessions
      ? { ...defaults.sessions, ...migrated.sessions }
      : defaults.sessions,
    ...(migrated.escalation !== undefined && { escalation: migrated.escalation }),
  };
}

export function loadConfig(projectDir: string): Config {
  const filePath = configPath(projectDir);

  if (!fs.existsSync(filePath)) return createDefaultConfig();

  const yamlText = fs.readFileSync(filePath, 'utf-8');

  if (process.platform !== 'win32' && !checkConfigPermissions(filePath)) {
    console.warn(`⚠ Config file ${filePath} has overly permissive permissions. Consider running: chmod 600 ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch {
    throw new Error(`Malformed YAML in ${filePath} — fix the syntax or delete the file to use defaults.`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return createDefaultConfig();

  // Convert snake_case to camelCase
  const camelCased = fromYaml(parsed);

  const migrated = migrateConfig(camelCased) as Config;

  // Merge with defaults for missing sections
  const merged = mergeWithDefaults(migrated);

  const { errors, warnings, data } = validateConfig(merged);
  if (errors.length > 0) {
    const lines = [`Configuration errors in ${TINY_SPEC_DIR}/${CONFIG_FILE}:`];
    for (const err of errors) {
      lines.push(`  ${err.path}: ${err.message}`);
    }
    throw new Error(lines.join('\n'));
  }

  for (const w of warnings) {
    console.warn(`⚠ ${w}`);
  }

  if (!data) throw new Error('Unexpected validation state: no data after successful validation');
  return data;
}

export function writeConfig(projectDir: string, config: Config): void {
  const dirPath = path.join(projectDir, TINY_SPEC_DIR);
  fs.mkdirSync(dirPath, { recursive: true, mode: SECURE_DIR_MODE });
  fs.writeFileSync(
    path.join(dirPath, CONFIG_FILE),
    YAML.stringify(toYaml(config)),
    { encoding: 'utf-8', mode: SECURE_FILE_MODE },
  );
}

export function initConfig(projectDir: string, opts: { force?: boolean } = {}): void {
  const dirPath = path.join(projectDir, TINY_SPEC_DIR);
  const configFilePath = path.join(dirPath, CONFIG_FILE);

  if (!opts.force && fs.existsSync(configFilePath)) return;

  fs.mkdirSync(dirPath, { recursive: true, mode: SECURE_DIR_MODE });
  ensureGitignore(projectDir, '.tiny-spec/');

  const yamlObj = toYaml(createDefaultConfig());
  fs.writeFileSync(configFilePath, YAML.stringify(yamlObj), { encoding: 'utf-8', mode: SECURE_FILE_MODE });
}
