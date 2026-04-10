import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Config } from '../types/index.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../providers/catalog.js';
import { validateConfig } from './validation.js';
import { fromYaml, toYaml } from './transforms.js';
import { TINY_SPEC_DIR, CONFIG_FILE } from '../paths.js';
import { migratePlannerConfig } from './migration.js';
import { ConfigSchema } from '../types/schemas/config.js';
import { narrowRecord } from '../../utils/type-guards.js';

export function configPath(projectDir: string): string {
  return path.join(projectDir, TINY_SPEC_DIR, CONFIG_FILE);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
        result[key] !== null && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function createDefaultConfig(): Config {
  return {
    planner: { kind: 'cli', tool: 'claude-code' },
    implementer: {
      kind: 'api',
      tool: 'ollama',
      model: 'qwen2.5-coder:7b',
      apiBase: KNOWN_PROVIDER_BASE_URLS.ollama,
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

export function loadConfig(projectDir: string): Config {
  const filePath = configPath(projectDir);

  if (!fs.existsSync(filePath)) return createDefaultConfig();

  const yamlText = fs.readFileSync(filePath, 'utf-8');
  const parsed = YAML.parse(yamlText);

  if (!parsed || typeof parsed !== 'object') return createDefaultConfig();

  const camelCased = fromYaml(parsed);

  // Extract raw planner separately — defaults use a DU shape and would merge
  // incorrectly with a legacy flat YAML shape. Migrate the raw YAML planner
  // into the DU, then attach it to the merged config.
  const rawPlanner = narrowRecord(camelCased.planner) ?? {};
  const withoutPlanner = { ...camelCased };
  delete withoutPlanner.planner;

  const defaults = structuredClone(createDefaultConfig());
  const { planner: _defaultPlanner, ...defaultsWithoutPlanner } = defaults as Record<string, unknown> & Config;

  const merged = deepMerge(defaultsWithoutPlanner, withoutPlanner);

  const workflow = narrowRecord(merged.workflow);
  if (workflow && 'commitPerTask' in workflow) {
    workflow.commitStrategy = workflow.commitPerTask ? 'per-task' : 'none';
    delete workflow.commitPerTask;
  }

  const hasPlannerKeys = Object.keys(rawPlanner).length > 0;
  merged.planner = hasPlannerKeys ? migratePlannerConfig(rawPlanner) : defaults.planner;

  const errors = validateConfig(merged);
  if (errors.length > 0) {
    const lines = [`Configuration errors in ${TINY_SPEC_DIR}/${CONFIG_FILE}:`];
    for (const err of errors) {
      lines.push(`  ${err.path}: ${err.message}`);
    }
    throw new Error(lines.join('\n'));
  }

  return ConfigSchema.parse(merged);
}

export function writeConfig(projectDir: string, config: Config): void {
  const dirPath = path.join(projectDir, TINY_SPEC_DIR);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(
    path.join(dirPath, CONFIG_FILE),
    YAML.stringify(toYaml(config)),
    'utf-8',
  );
}

export function initConfig(projectDir: string, opts: { force?: boolean } = {}): void {
  const dirPath = path.join(projectDir, TINY_SPEC_DIR);
  const configFilePath = path.join(dirPath, CONFIG_FILE);

  if (!opts.force && fs.existsSync(configFilePath)) return;

  fs.mkdirSync(dirPath, { recursive: true });

  const yamlObj = toYaml(createDefaultConfig());
  fs.writeFileSync(configFilePath, YAML.stringify(yamlObj), 'utf-8');
}
