import { KNOWN_PROVIDER_NAMES } from '../engine/providers/registry.js';

const VALID_PLANNER_TOOLS = ['claude-code', 'codex', 'opencode', 'aider', 'agent-sdk', 'shell', 'anthropic', 'openrouter'] as const;

function get(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export interface ConfigError {
  path: string;
  message: string;
}

export function validateConfig(config: Record<string, unknown>): ConfigError[] {
  const errors: ConfigError[] = [];

  const tool = get(config, 'planner', 'tool');
  if (tool !== undefined && (typeof tool !== 'string' || !VALID_PLANNER_TOOLS.includes(tool as typeof VALID_PLANNER_TOOLS[number]))) {
    errors.push({ path: 'planner.tool', message: `Must be one of: ${VALID_PLANNER_TOOLS.join(', ')} (got ${JSON.stringify(tool)})` });
  }

  if (tool === 'agent-sdk' || tool === 'anthropic') {
    const apiKey = get(config, 'planner', 'apiKey') ?? process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      const label = tool === 'agent-sdk' ? 'Agent SDK' : 'Anthropic planner';
      errors.push({ path: 'planner.apiKey', message: `${label} requires planner.apiKey or ANTHROPIC_API_KEY env var` });
    }
  }

  if (tool === 'openrouter') {
    const apiKey = get(config, 'planner', 'apiKey') ?? process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      errors.push({ path: 'planner.apiKey', message: 'OpenRouter planner requires planner.apiKey or OPENROUTER_API_KEY env var' });
    }
  }

  if (tool === 'shell') {
    const command = get(config, 'planner', 'command');
    if (!command || typeof command !== 'string') {
      errors.push({ path: 'planner.command', message: 'Shell planner requires planner.command to be set' });
    }
    const outputFormat = get(config, 'planner', 'outputFormat');
    if (outputFormat !== undefined && (typeof outputFormat !== 'string' || !['stream-json', 'jsonl', 'text'].includes(outputFormat))) {
      errors.push({ path: 'planner.outputFormat', message: `Must be one of: stream-json, jsonl, text (got ${JSON.stringify(outputFormat)})` });
    }
  }

  const implType = get(config, 'implementer', 'type');
  if (implType !== undefined && implType !== 'api' && implType !== 'shell' && implType !== 'agent') {
    errors.push({ path: 'implementer.type', message: `Must be one of: api, shell, agent (got ${JSON.stringify(implType)})` });
  }

  if (implType === 'shell' || implType === 'agent') {
    const implCommand = get(config, 'implementer', 'command');
    if (!implCommand || typeof implCommand !== 'string') {
      errors.push({ path: 'implementer.command', message: `${implType === 'agent' ? 'Agent' : 'Shell'} implementer requires implementer.command to be set` });
    }
  }

  const timeout = get(config, 'implementer', 'timeout');
  if (timeout !== undefined && (typeof timeout !== 'number' || timeout <= 0 || timeout > 600000)) {
    errors.push({ path: 'implementer.timeout', message: 'Must be a positive number <= 600000 (10 minutes)' });
  }

  const implOutputFormat = get(config, 'implementer', 'outputFormat');
  if (implOutputFormat !== undefined && (typeof implOutputFormat !== 'string' || !['stream-json', 'jsonl', 'text'].includes(implOutputFormat))) {
    errors.push({ path: 'implementer.outputFormat', message: `Must be one of: stream-json, jsonl, text (got ${JSON.stringify(implOutputFormat)})` });
  }

  const provider = get(config, 'implementer', 'provider');
  if (provider !== undefined && typeof provider !== 'string') {
    errors.push({ path: 'implementer.provider', message: 'Must be a string' });
  }
  if (provider !== undefined && typeof provider === 'string' && !KNOWN_PROVIDER_NAMES.includes(provider)) {
    const apiBase = get(config, 'implementer', 'apiBase');
    if (!apiBase || typeof apiBase !== 'string') {
      errors.push({ path: 'implementer.apiBase', message: `Unknown provider "${provider}" requires implementer.apiBase to be set` });
    }
  }

  const model = get(config, 'implementer', 'model');
  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
    errors.push({ path: 'implementer.model', message: 'Must be a non-empty string' });
  }

  const ctx = get(config, 'implementer', 'contextLength');
  if (ctx !== undefined && (typeof ctx !== 'number' || !Number.isInteger(ctx) || ctx <= 0)) {
    errors.push({ path: 'implementer.contextLength', message: 'Must be a positive integer' });
  }

  const temp = get(config, 'implementer', 'temperature');
  if (temp !== undefined && (typeof temp !== 'number' || temp < 0 || temp > 2)) {
    errors.push({ path: 'implementer.temperature', message: 'Must be a number between 0 and 2' });
  }

  const boolFields = [
    'validation.typecheck', 'validation.lint', 'validation.test',
    'workflow.autoApproveSpec', 'workflow.autoApprovePlan',
  ];
  for (const field of boolFields) {
    const [section, key] = field.split('.');
    const val = get(config, section, key);
    if (val !== undefined && typeof val !== 'boolean') {
      errors.push({ path: field, message: 'Must be true or false' });
    }
  }

  const testCmd = get(config, 'validation', 'testCommand');
  if (testCmd !== undefined && (typeof testCmd !== 'string' || testCmd.length === 0)) {
    errors.push({ path: 'validation.testCommand', message: 'Must be a non-empty string' });
  }

  const workflowMode = get(config, 'workflow', 'mode');
  if (workflowMode !== undefined && workflowMode !== 'quick' && workflowMode !== 'standard' && workflowMode !== 'full') {
    errors.push({ path: 'workflow.mode', message: `Must be one of: quick, standard, full (got ${JSON.stringify(workflowMode)})` });
  }

  const commitStrategy = get(config, 'workflow', 'commitStrategy');
  if (commitStrategy !== undefined && commitStrategy !== 'none' && commitStrategy !== 'checkpoint' && commitStrategy !== 'per-task') {
    errors.push({ path: 'workflow.commitStrategy', message: `Must be one of: none, checkpoint, per-task (got ${JSON.stringify(commitStrategy)})` });
  }

  const retries = get(config, 'workflow', 'maxRetries');
  if (retries !== undefined && (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0)) {
    errors.push({ path: 'workflow.maxRetries', message: 'Must be a non-negative integer' });
  }

  const theme = get(config, 'theme');
  if (theme !== undefined && theme !== 'terminal' && theme !== 'mono') {
    errors.push({ path: 'theme', message: `Must be one of: terminal, mono (got ${JSON.stringify(theme)})` });
  }

  const shikiTheme = get(config, 'shikiTheme');
  if (shikiTheme !== undefined && (typeof shikiTheme !== 'string' || shikiTheme.length === 0)) {
    errors.push({ path: 'shikiTheme', message: 'Must be a non-empty string' });
  }

  const sessionsScope = get(config, 'sessions', 'scope');
  if (sessionsScope !== undefined && sessionsScope !== 'project' && sessionsScope !== 'global') {
    errors.push({ path: 'sessions.scope', message: `Must be one of: project, global (got ${JSON.stringify(sessionsScope)})` });
  }

  return errors;
}
