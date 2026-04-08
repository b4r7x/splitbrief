export const CLI_TOOLS = {
  codex: {
    command: 'codex',
    notFoundMessage: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
  },
  opencode: {
    command: 'opencode',
    notFoundMessage: 'OpenCode CLI not found. Install it from https://opencode.ai',
  },
  aider: {
    command: 'aider',
    notFoundMessage: 'Aider not found. Install it from https://aider.chat',
  },
} as const;

export type CliToolName = keyof typeof CLI_TOOLS;
