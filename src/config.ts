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

export function toYaml(obj: unknown): unknown {
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

export interface ConfigError {
  path: string;
  message: string;
}

export function validateConfig(config: Record<string, unknown>): ConfigError[] {
  const errors: ConfigError[] = [];

  const validTools = ['claude-code', 'codex', 'opencode', 'aider', 'agent-sdk', 'shell'];
  const tool = (config as any)?.planner?.tool;
  if (tool !== undefined && !validTools.includes(tool)) {
    errors.push({ path: 'planner.tool', message: `Must be one of: ${validTools.join(', ')} (got ${JSON.stringify(tool)})` });
  }

  if (tool === 'agent-sdk') {
    const apiKey = (config as any)?.planner?.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      errors.push({ path: 'planner.apiKey', message: 'Agent SDK requires planner.apiKey or ANTHROPIC_API_KEY env var' });
    }
  }

  if (tool === 'shell') {
    const command = (config as any)?.planner?.command;
    if (!command || typeof command !== 'string') {
      errors.push({ path: 'planner.command', message: 'Shell planner requires planner.command to be set' });
    }
    const outputFormat = (config as any)?.planner?.outputFormat;
    if (outputFormat !== undefined && !['stream-json', 'jsonl', 'text'].includes(outputFormat)) {
      errors.push({ path: 'planner.outputFormat', message: `Must be one of: stream-json, jsonl, text (got ${JSON.stringify(outputFormat)})` });
    }
  }

  const implType = (config as any)?.implementer?.type;
  if (implType !== undefined && implType !== 'api' && implType !== 'shell' && implType !== 'agent') {
    errors.push({ path: 'implementer.type', message: `Must be one of: api, shell, agent (got ${JSON.stringify(implType)})` });
  }

  if (implType === 'shell' || implType === 'agent') {
    const implCommand = (config as any)?.implementer?.command;
    if (!implCommand || typeof implCommand !== 'string') {
      errors.push({ path: 'implementer.command', message: `${implType === 'agent' ? 'Agent' : 'Shell'} implementer requires implementer.command to be set` });
    }
  }

  const timeout = (config as any)?.implementer?.timeout;
  if (timeout !== undefined && (typeof timeout !== 'number' || timeout <= 0 || timeout > 600000)) {
    errors.push({ path: 'implementer.timeout', message: 'Must be a positive number <= 600000 (10 minutes)' });
  }

  const implOutputFormat = (config as any)?.implementer?.outputFormat;
  if (implOutputFormat !== undefined && !['stream-json', 'jsonl', 'text'].includes(implOutputFormat)) {
    errors.push({ path: 'implementer.outputFormat', message: `Must be one of: stream-json, jsonl, text (got ${JSON.stringify(implOutputFormat)})` });
  }

  const knownProviders = ['ollama', 'lm-studio', 'deepseek', 'openrouter'];
  const provider = (config as any)?.implementer?.provider;
  if (provider !== undefined && typeof provider !== 'string') {
    errors.push({ path: 'implementer.provider', message: 'Must be a string' });
  }
  if (provider !== undefined && typeof provider === 'string' && !knownProviders.includes(provider)) {
    const apiBase = (config as any)?.implementer?.apiBase;
    if (!apiBase || typeof apiBase !== 'string') {
      errors.push({ path: 'implementer.apiBase', message: `Unknown provider "${provider}" requires implementer.apiBase to be set` });
    }
  }

  const model = (config as any)?.implementer?.model;
  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
    errors.push({ path: 'implementer.model', message: 'Must be a non-empty string' });
  }

  const ctx = (config as any)?.implementer?.contextLength;
  if (ctx !== undefined && (typeof ctx !== 'number' || !Number.isInteger(ctx) || ctx <= 0)) {
    errors.push({ path: 'implementer.contextLength', message: 'Must be a positive integer' });
  }

  const temp = (config as any)?.implementer?.temperature;
  if (temp !== undefined && (typeof temp !== 'number' || temp < 0 || temp > 2)) {
    errors.push({ path: 'implementer.temperature', message: 'Must be a number between 0 and 2' });
  }

  const boolFields = [
    'validation.typecheck', 'validation.lint', 'validation.test',
    'workflow.autoApproveSpec', 'workflow.autoApprovePlan', 'workflow.commitPerTask',
  ];
  for (const field of boolFields) {
    const [section, key] = field.split('.');
    const val = (config as any)?.[section]?.[key];
    if (val !== undefined && typeof val !== 'boolean') {
      errors.push({ path: field, message: 'Must be true or false' });
    }
  }

  const testCmd = (config as any)?.validation?.testCommand;
  if (testCmd !== undefined && (typeof testCmd !== 'string' || testCmd.length === 0)) {
    errors.push({ path: 'validation.testCommand', message: 'Must be a non-empty string' });
  }

  const retries = (config as any)?.workflow?.maxRetries;
  if (retries !== undefined && (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0)) {
    errors.push({ path: 'workflow.maxRetries', message: 'Must be a non-negative integer' });
  }

  return errors;
}

export function loadConfig(projectDir: string): Config {
  const configPath = path.join(projectDir, CONFIG_DIR, CONFIG_FILE);

  if (!fs.existsSync(configPath)) return createDefaultConfig();

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw);

  if (!parsed || typeof parsed !== 'object') return createDefaultConfig();

  const camelCased = fromYaml(parsed) as Record<string, unknown>;
  const defaults = createDefaultConfig() as unknown as Record<string, unknown>;
  const merged = deepMerge(defaults, camelCased);

  const errors = validateConfig(merged);
  if (errors.length > 0) {
    console.error('Configuration errors in .tiny-spec/config.yaml:');
    for (const err of errors) {
      console.error(`  ${err.path}: ${err.message}`);
    }
    process.exit(2);
  }

  return merged as unknown as Config;
}

export function initConfig(projectDir: string): void {
  const dirPath = path.join(projectDir, CONFIG_DIR);
  const configPath = path.join(dirPath, CONFIG_FILE);

  if (fs.existsSync(configPath)) return;

  fs.mkdirSync(dirPath, { recursive: true });

  const yamlObj = toYaml(createDefaultConfig());
  fs.writeFileSync(configPath, YAML.stringify(yamlObj), 'utf-8');
}
