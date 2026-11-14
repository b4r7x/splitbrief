import type { RunnerConfig } from '../../src/core/config/accessors/runner-config.js';

export const planner = {
  kind: 'cli',
  tool: 'claude-code',
  model: 'claude-sonnet-4',
} satisfies RunnerConfig;
export const build = {
  kind: 'api',
  provider: 'ollama',
  service: 'ollama',
  offering: 'local',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://127.0.0.1:11434/v1',
} satisfies RunnerConfig;
export const cursorMultiAxis = {
  kind: 'cli',
  tool: 'cursor',
  model: 'claude-opus-5-thinking-xhigh-fast',
} satisfies RunnerConfig;
