const replayApiKey = process.env.DIPTYCH_E2E_RECORD === '1'
  ? undefined
  : 'e2e-placeholder';

export const e2eApiBase = process.env.DIPTYCH_E2E_API_BASE ?? 'http://localhost:11434/v1';

export const e2ePlanner = {
  kind: 'api',
  provider: 'anthropic',
  apiBase: e2eApiBase,
  ...(replayApiKey ? { apiKey: replayApiKey } : {}),
  model: 'claude-sonnet-4-6',
} as const;

export const e2eImplementer = {
  kind: 'api',
  provider: 'anthropic',
  apiBase: e2eApiBase,
  ...(replayApiKey ? { apiKey: replayApiKey } : {}),
  model: 'claude-haiku-4-5-20251001',
} as const;
