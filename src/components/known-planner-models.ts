export interface KnownModel {
  name: string;
  isDefault?: boolean;
}

// Each tool should have exactly one entry with isDefault: true
export const KNOWN_PLANNER_MODELS: Record<string, KnownModel[]> = {
  'claude-code': [
    { name: 'claude-sonnet-4-6', isDefault: true },
    { name: 'claude-opus-4-6' },
    { name: 'claude-haiku-4-5' },
    { name: 'claude-sonnet-4-5' },
  ],
  codex: [
    { name: 'gpt-5.4', isDefault: true },
    { name: 'gpt-5.4-mini' },
    { name: 'gpt-5.3-codex' },
    { name: 'codex-mini-latest' },
  ],
  aider: [
    { name: 'claude-sonnet-4-6', isDefault: true },
    { name: 'claude-opus-4-6' },
    { name: 'gpt-5.4' },
    { name: 'deepseek/deepseek-r1' },
    { name: 'o3-mini' },
  ],
  opencode: [
    { name: 'anthropic/claude-sonnet-4-6', isDefault: true },
    { name: 'anthropic/claude-opus-4-6' },
    { name: 'openai/gpt-5.4' },
    { name: 'google/gemini-3.1-pro-preview' },
    { name: 'deepseek/deepseek-v3.2' },
  ],
  'agent-sdk': [
    { name: 'claude-sonnet-4-6', isDefault: true },
    { name: 'claude-opus-4-6' },
    { name: 'claude-haiku-4-5' },
  ],
  anthropic: [
    { name: 'claude-sonnet-4-6', isDefault: true },
    { name: 'claude-opus-4-6' },
    { name: 'claude-haiku-4-5' },
  ],
  openrouter: [
    { name: 'anthropic/claude-sonnet-4.6', isDefault: true },
    { name: 'anthropic/claude-opus-4.6' },
    { name: 'openai/gpt-5.4' },
    { name: 'deepseek/deepseek-v3.2' },
    { name: 'deepseek/deepseek-r1-0528' },
    { name: 'google/gemini-3.1-pro-preview' },
  ],
};
