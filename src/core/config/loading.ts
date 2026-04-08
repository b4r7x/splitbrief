import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Config, CommitStrategy, PlannerTool } from '../types/index.js';
import { KNOWN_PROVIDER_BASE_URLS, getProviderBaseUrl } from '../providers/catalog.js';
import { validateConfig } from './validation.js';
import { fromYaml, toYaml } from './transforms.js';
import { TINY_SPEC_DIR } from '../../utils/fs.js';

const CONFIG_FILE = 'config.yaml';

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
    planner: { tool: 'claude-code' },
    implementer: {
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
      commitStrategy: 'none' as CommitStrategy,
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

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = YAML.parse(raw);

  if (!parsed || typeof parsed !== 'object') return createDefaultConfig();

  const camelCased = fromYaml(parsed) as Record<string, unknown>;
  const defaults = createDefaultConfig() as unknown as Record<string, unknown>;
  const merged = deepMerge(defaults, camelCased);

  const workflow = merged.workflow as Record<string, unknown> | undefined;
  if (workflow && 'commitPerTask' in workflow) {
    workflow.commitStrategy = workflow.commitPerTask ? 'per-task' : 'none';
    delete workflow.commitPerTask;
  }

  const errors = validateConfig(merged);
  if (errors.length > 0) {
    const lines = ['Configuration errors in .tiny-spec/config.yaml:'];
    for (const err of errors) {
      lines.push(`  ${err.path}: ${err.message}`);
    }
    throw new Error(lines.join('\n'));
  }

  return merged as unknown as Config;
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

export function initConfig(projectDir: string): void {
  const dirPath = path.join(projectDir, TINY_SPEC_DIR);
  const configFilePath = path.join(dirPath, CONFIG_FILE);

  if (fs.existsSync(configFilePath)) return;

  fs.mkdirSync(dirPath, { recursive: true });

  const yamlObj = toYaml(createDefaultConfig());
  fs.writeFileSync(configFilePath, YAML.stringify(yamlObj), 'utf-8');
}

export function writeConfigSelection(
  projectDir: string,
  planner: { tool: PlannerTool; command?: string },
  implementer: { tool: string; model: string; apiBase?: string },
): void {
  const config = loadConfig(projectDir);

  config.planner.tool = planner.tool;
  if (planner.tool === 'shell' && planner.command) {
    config.planner.command = planner.command;
  }

  config.implementer.tool = implementer.tool;
  config.implementer.model = implementer.model;

  config.implementer.apiBase = implementer.apiBase ?? (getProviderBaseUrl(implementer.tool) || config.implementer.apiBase);

  writeConfig(projectDir, config);
}
