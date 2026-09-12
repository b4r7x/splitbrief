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
  let usage: TokenDelta | null = null;
  const adapter = bindPlannerToProjectDir(planner, {
    projectDir,
    ...(opts.signal !== undefined && { signal: opts.signal }),
    ...(opts.onCallEvent !== undefined && { onCallEvent: opts.onCallEvent }),
    onUsage: (delta) => {
      if (delta) usage = accumulateTokenUsage(usage, delta);
    },
  });
  const result = await compactTranscript({
    sessionDir: sessionDir(projectDir, sessionId),
    planner: adapter,
    keepRecentCount,
    format: opts.format ?? 'freeform',
    ...(onFallback ? { onFallback } : {}),
  });
  return { ...result, usage };
}
