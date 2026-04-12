import type { ProviderId } from '../../core/providers.js';

export interface KnownModel {
  name: string;
  isDefault?: boolean;
  contextLength?: number;
  pricingInput?: number;
  pricingOutput?: number;
  isFree?: boolean;
}

export const DEFAULT_AGENT_SDK_MODEL = 'claude-sonnet-4-6';

export const KNOWN_MODELS: Partial<Record<ProviderId, KnownModel[]>> = {
  'claude-code': [{ name: 'auto', isDefault: true }, { name: 'claude-sonnet-4-6' }],
  codex:         [{ name: 'auto', isDefault: true }, { name: 'gpt-5.4' }],
  aider:         [{ name: 'auto', isDefault: true }, { name: 'claude-sonnet-4-6' }],
  opencode:      [{ name: 'auto', isDefault: true }, { name: 'anthropic/claude-sonnet-4-6' }],
  copilot:       [{ name: 'auto', isDefault: true }, { name: 'gpt-5.4' }],
  'kilo-code':   [{ name: 'auto', isDefault: true }, { name: 'claude-sonnet-4-6' }],
  'agent-sdk':   [{ name: 'claude-sonnet-4-6', isDefault: true }, { name: 'claude-opus-4-6' }],
  anthropic:     [{ name: 'claude-sonnet-4-6', isDefault: true }, { name: 'claude-opus-4-6' }],
  openrouter:    [{ name: 'anthropic/claude-sonnet-4.6', isDefault: true }],
  ollama:        [{ name: 'qwen2.5-coder:7b', isDefault: true }],
  'lm-studio':   [{ name: 'qwen2.5-coder-7b', isDefault: true }],
  deepseek:      [{ name: 'deepseek-chat', isDefault: true }],
  openai:        [{ name: 'gpt-5.4', isDefault: true }],
  groq:          [],
  together:      [],
};
