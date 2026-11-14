import type { CrewSeatId } from '../../../core/crew/identity.js';
import type { SeatIdentity } from '../../../core/providers/seat-identity.js';
import type { RunnerKind, Phase } from '../../../core/schemas/enums.js';
import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import { createStore, storeBase } from '../../create-store.js';

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

/** The model id a seat's call reported running, beside the runner and model value of that call. */
export type SeatResolvedModel = Readonly<{
  runnerName: string | undefined;
  model: string | undefined;
  resolvedModel: string;
  backendKind: RunnerKind;
}>;

export interface TokensState {
  tokenUsage: TokenUsage | null;
  perPhase: Partial<Record<Phase, PhaseTokens>>;
  perTask: Record<string, PerTaskTokens>;
  /** The seats this run pass holds: the run is priced on them, and the chrome names them. */
  passSeats: SeatIdentity | null;
  resolvedModels: Partial<Record<CrewSeatId, SeatResolvedModel>>;
}

const initial: TokensState = {
  tokenUsage: null,
  perPhase: {},
  perTask: {},
  passSeats: null,
  resolvedModels: {},
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
