import type { ProviderId } from '../../src/core/schemas/enums.js';

export const PENDING_EVALUATION_CANDIDATE_IDS = Object.freeze([
  { provider: 'ollama', model: 'qwen3-coder:30b' },
  { provider: 'lm-studio', model: 'qwen2.5-coder-7b' },
] as const satisfies readonly { provider: ProviderId; model: string }[]);
