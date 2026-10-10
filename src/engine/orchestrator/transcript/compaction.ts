import {
  compactTranscript,
  type TranscriptCompactionResult,
} from '../../../core/sessions/compaction.js';
import { sessionDir } from '../../../core/paths.js';
import type { Planner, PlannerSummaryMessage } from '../../planners/types.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import type {
  ResolvedCompactionFormat,
  StructuredSummary,
} from '../../../core/schemas/compaction.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import { throwIfAborted } from '../../../utils/abort.js';
import {
  findLatestSummary,
  readCompactedMessages,
  readSessionLog,
} from '../../../core/sessions/log-reader.js';
import type { SessionLogEntry } from '../../../core/schemas/session-log.js';
import { loadState } from '../../../core/state/persistence.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import {
  isStillPendingQueuedTranscriptMessage,
  reconstructPlannerConversation,
} from './rebuild.js';
import { pruneResumeUserMessages } from '../state-ops.js';

const MIN_COMPACTION_KEEP_RECENT = 1;

export function keepRecentCountForThreshold(threshold: number): number {
  return Math.max(MIN_COMPACTION_KEEP_RECENT, threshold - 1);
}

export type PlannerCompactionAdapter = {
  summarize: (messages: PlannerSummaryMessage[]) => Promise<string>;
  summarizeStructured?: (
    messages: PlannerSummaryMessage[],
    previousSummary?: StructuredSummary,
  ) => Promise<{ text: string; structured: StructuredSummary | null }>;
};

export type PlannerCompactionAdapterOptions = {
  projectDir: string;
  signal?: AbortSignal | undefined;
  onUsage?: ((usage: TokenDelta | null) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
};

export function bindPlannerToProjectDir(
  planner: Pick<Planner, 'summarize' | 'summarizeStructured'>,
  opts: PlannerCompactionAdapterOptions,
): PlannerCompactionAdapter {
  const summarizeStructured = planner.summarizeStructured;
  return {
    summarize: async (messages) => {
      throwIfAborted(opts.signal);
      const result = await planner.summarize(messages, {
        projectDir: opts.projectDir,
        role: 'compaction',
        ...(opts.signal !== undefined && { signal: opts.signal }),
        ...(opts.onCallEvent !== undefined && { callbacks: { onCallEvent: opts.onCallEvent } }),
      });
      opts.onUsage?.(result.usage);
      return result.text;
    },
    ...(summarizeStructured
      ? {
          summarizeStructured: async (messages, previous) => {
            throwIfAborted(opts.signal);
            const result = await summarizeStructured(messages, {
              projectDir: opts.projectDir,
              previousSummary: previous,
              role: 'compaction',
              ...(opts.signal !== undefined && { signal: opts.signal }),
              ...(opts.onCallEvent !== undefined && {
                callbacks: { onCallEvent: opts.onCallEvent },
              }),
            });
            opts.onUsage?.(result.usage);
            return { text: result.text, structured: result.structured };
          },
        }
      : {}),
  };
}

export type ResumeCompactionResult = TranscriptCompactionResult & {
  usage: TokenDelta | null;
};

export async function compactResumeTranscript(opts: {
  projectDir: string;
  sessionId: string;
  planner: Pick<Planner, 'summarize' | 'summarizeStructured'>;
  keepRecentCount: number;
  format?: ResolvedCompactionFormat | undefined;
  signal?: AbortSignal | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  onFallback?: ((text: string) => void | Promise<void>) | undefined;
}): Promise<ResumeCompactionResult> {
  const { projectDir, sessionId, planner, keepRecentCount, onFallback } = opts;
  const ref = { projectDir, sessionId };
  const dir = sessionDir(projectDir, sessionId);
  const state = loadState(ref);
  const log: SessionLogEntry[] = [];
  for await (const entry of readSessionLog(ref)) log.push(entry);
  const entries = log.filter((entry) => entry.kind === 'message');
  const pendingQueue = state?.messageQueue.filter(isQueuedMessagePendingDelivery) ?? [];
  const firstPendingIndex = entries.findIndex((entry) =>
    isStillPendingQueuedTranscriptMessage(entry, pendingQueue),
  );
  const expanded = reconstructPlannerConversation(entries, state).expanded;
  const summary = findLatestSummary(log);
  const compacted = await readCompactedMessages(dir);
  const offset = summary === null ? 0 : entries.length - compacted.length + 1;
  const structured = opts.format === 'structured' && summary?.structured !== undefined;
  const expandedInput = (messages: PlannerSummaryMessage[]): PlannerSummaryMessage[] => {
    const selected = structured
      ? expanded.slice(offset, offset + messages.length)
      : [
          ...compacted.slice(0, summary === null ? 0 : 1),
          ...expanded.slice(offset, messages.length),
        ];
    return reconstructPlannerConversation(selected, state).messages.map(({ role, content }) => ({
      role,
      text: content,
    }));
  };
  let usage: TokenDelta | null = null;
  const adapter = bindPlannerToProjectDir(planner, {
    projectDir,
    ...(opts.signal !== undefined && { signal: opts.signal }),
    ...(opts.onCallEvent !== undefined && { onCallEvent: opts.onCallEvent }),
    onUsage: (delta) => {
      if (delta) usage = accumulateTokenUsage(usage, delta);
    },
  });
  const summarizeStructured = adapter.summarizeStructured;
  const result = await compactTranscript({
    sessionDir: dir,
    planner: {
      summarize: (messages) => adapter.summarize(expandedInput(messages)),
      ...(summarizeStructured !== undefined && {
        summarizeStructured: (messages, previous) =>
          summarizeStructured(expandedInput(messages), previous),
      }),
    },
    keepRecentCount:
      firstPendingIndex === -1
        ? keepRecentCount
        : Math.max(keepRecentCount, entries.length - firstPendingIndex),
    format: opts.format ?? 'freeform',
    ...(onFallback ? { onFallback } : {}),
  });
  if (result.entriesRemoved > 0) {
    const kept = await readCompactedMessages(dir);
    pruneResumeUserMessages(ref, reconstructPlannerConversation(kept, state).unmatched);
  }
  return { ...result, usage };
}
