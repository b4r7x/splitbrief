import type { Phase } from '../../../core/schemas/enums.js';
import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import { createStore, storeBase } from '../../create.js';

export interface PhaseTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  plannerInputTokens?: number | undefined;
  plannerOutputTokens?: number | undefined;
  plannerCacheReadTokens?: number | undefined;
  plannerCacheCreateTokens?: number | undefined;
  implementerInputTokens?: number | undefined;
  implementerOutputTokens?: number | undefined;
  implementerCacheReadTokens?: number | undefined;
  implementerCacheCreateTokens?: number | undefined;
  reviewerInputTokens?: number | undefined;
  reviewerOutputTokens?: number | undefined;
  reviewerCacheReadTokens?: number | undefined;
  reviewerCacheCreateTokens?: number | undefined;
}

export type TaskAttemptTokens = Pick<
  TaskTokenUsage,
  | 'method'
  | 'implementerTokens'
  | 'escalationTokens'
  | 'implementerCacheReadTokens'
  | 'implementerCacheCreateTokens'
  | 'escalationCacheReadTokens'
  | 'escalationCacheCreateTokens'
  | 'implementerInputTokens'
  | 'implementerOutputTokens'
  | 'implementerReasoningTokens'
  | 'escalationInputTokens'
  | 'escalationOutputTokens'
  | 'escalationReasoningTokens'
  | 'retryCount'
  | 'tool'
  | 'model'
  | 'implementerProfile'
  | 'contextFit'
  | 'estimatedTokens'
  | 'untruncatedEstimatedTokens'
  | 'contextLength'
  | 'currentCodeTruncated'
  | 'currentCodeContextMode'
  | 'routingReason'
>;

export interface PerTaskTokens {
  totalTokens: number;
  title: string;
  attempts?: TaskAttemptTokens[] | undefined;
}

export interface TokensState {
  tokenUsage: TokenUsage | null;
  perPhase: Partial<Record<Phase, PhaseTokens>>;
  perTask: Record<string, PerTaskTokens>;
}

const initial: TokensState = {
  tokenUsage: null,
  perPhase: {},
  perTask: {},
};

const store = createStore<TokensState>(initial);

// Test escape hatch — see docs/STORES-AND-UI.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<TokensState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

// Test escape hatch — see docs/STORES-AND-UI.md#test-escape-hatches. Do not use outside tests.
export const _tokensInternal = { set: store.set };

export const tokensStore = {
  ...storeBase(store),
  __testReset,
};
