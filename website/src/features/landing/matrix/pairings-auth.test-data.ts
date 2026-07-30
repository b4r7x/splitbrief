export const API_KEY_CONTRACT = {
  anthropic: { env: 'ANTHROPIC_API_KEY' },
  'agent-sdk': { env: 'ANTHROPIC_API_KEY' },
  ollama: { env: 'OLLAMA_API_KEY', optional: true },
  deepseek: { env: 'DEEPSEEK_API_KEY' },
  groq: { env: 'GROQ_API_KEY' },
  openrouter: { env: 'OPENROUTER_API_KEY' },
  together: { env: 'TOGETHER_API_KEY' },
} as const;
