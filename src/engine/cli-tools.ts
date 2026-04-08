export const CLI_TOOLS = {
  codex: {
    command: 'codex',
    description: 'OpenAI Codex CLI',
    notFoundMessage: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
  },
  opencode: {
    command: 'opencode',
    description: 'OpenCode CLI',
    notFoundMessage: 'OpenCode CLI not found. Install it from https://opencode.ai',
  },
  aider: {
    command: 'aider',
    description: 'Aider CLI',
    notFoundMessage: 'Aider not found. Install it from https://aider.chat',
  },
} as const;

export type CliToolName = keyof typeof CLI_TOOLS;
