import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Config } from './types.js';

const CONFIG_DIR = '.tiny-spec';
const CONFIG_FILE = 'config.yaml';

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function fromYaml(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(fromYaml);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[snakeToCamel(key)] = fromYaml(value);
    }
    return result;
  }
  return obj;
}

function toYaml(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(toYaml);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())] = toYaml(value);
    }
    return result;
  }
  return obj;
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
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      apiBase: 'http://localhost:11434/v1',
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
      commitPerTask: true,
    },
  };
}

export function loadConfig(projectDir: string): Config {
  const configPath = path.join(projectDir, CONFIG_DIR, CONFIG_FILE);

  if (!fs.existsSync(configPath)) return createDefaultConfig();

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw);

  if (!parsed || typeof parsed !== 'object') return createDefaultConfig();

  const camelCased = fromYaml(parsed) as Record<string, unknown>;
  const defaults = createDefaultConfig() as unknown as Record<string, unknown>;

  return deepMerge(defaults, camelCased) as unknown as Config;
}

export function initConfig(projectDir: string): void {
  const dirPath = path.join(projectDir, CONFIG_DIR);
  const configPath = path.join(dirPath, CONFIG_FILE);

  if (fs.existsSync(configPath)) return;

  fs.mkdirSync(dirPath, { recursive: true });

  const yamlObj = toYaml(createDefaultConfig());
  fs.writeFileSync(configPath, YAML.stringify(yamlObj), 'utf-8');
}
