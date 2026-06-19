import type { Config } from '../../core/schemas/config.js';
import type { CompactTranscriptResult } from '../../core/runtime/commands/types.js';
import {
  compactTranscript,
  DEFAULT_KEEP_RECENT_COUNT,
  type TranscriptCompactionResult,
} from '../../core/sessions/compaction.js';
import { readCompactedMessages, readMessages } from '../../core/sessions/log-reader.js';
import type { SessionLogMessageEntry } from '../../core/schemas/session-log.js';
import { sessionDir } from '../../core/paths.js';
import { createPlanner } from '../runners/factory.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';
import type { Planner, PlannerSummaryMessage } from '../planners/types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { accumulateUsage } from '../streaming/token-usage.js';
import { addUsage } from './tokens.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import {
  resolveCompactionFormat,
  type ResolvedCompactionFormat,
  type StructuredSummary,
} from '../../core/schemas/compaction.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { throwIfAborted } from '../../utils/abort.js';

export type ResumeMessage = { role: 'user' | 'assistant'; content: string };

export type ResumeContext = {
  messages: ResumeMessage[];
  warning?: 'transcript-unavailable' | undefined;
};

function toResumeMessage(message: SessionLogMessageEntry): ResumeMessage {
  const content = message.interrupted ? `${message.text}\n\n[turn interrupted]` : message.text;
  return { role: message.role, content };
}

async function readCompactedResumeMessages(
  projectDir: string,
  sessionId: string,
): Promise<ResumeMessage[]> {
  const messages = await readCompactedMessages(sessionDir(projectDir, sessionId));
  return messages.map(toResumeMessage);
}

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
      if (delta) usage = accumulateUsage(usage, delta);
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

export async function performManualCompaction(
  config: Config,
  projectDir: string,
  sessionId: string,
): Promise<CompactTranscriptResult> {
  const planner = await createPlanner(config);
  const plannerName = getRunnerDisplayName(config.planner);
  if (planner.capabilities.supportsSelfSummarisation !== true) {
    return { status: 'unsupported', plannerName };
  }
  const threshold = config.workflow.compactionThreshold;
  const keepRecentCount =
    threshold !== undefined ? keepRecentCountForThreshold(threshold) : DEFAULT_KEEP_RECENT_COUNT;
  const format = resolveCompactionFormat(config.workflow.compactionFormat, config.planner.kind);
  let usage: TokenDelta | null = null;
  const adapter = bindPlannerToProjectDir(planner, {
    projectDir,
    onUsage: (delta) => {
      if (delta) usage = accumulateUsage(usage, delta);
    },
  });
  const result = await compactTranscript({
    sessionDir: sessionDir(projectDir, sessionId),
    keepRecentCount,
    format,
    planner: adapter,
  });
  bookCompactionUsage(projectDir, sessionId, usage);
  return { status: 'compacted', ...result };
}

function bookCompactionUsage(
  projectDir: string,
  sessionId: string,
  usage: TokenDelta | null,
): void {
  if (!usage) return;
  const state = loadState({ projectDir, sessionId });
  if (!state) return;
  saveState({ projectDir, sessionId }, addUsage(state, 'planner', usage));
}

export async function buildResumeContext(
  projectDir: string,
  sessionId: string,
  persistTranscript: boolean,
): Promise<ResumeContext> {
  if (!persistTranscript) {
    return { messages: [], warning: 'transcript-unavailable' };
  }
  try {
    return { messages: await readCompactedResumeMessages(projectDir, sessionId) };
  } catch {
    const messages: ResumeMessage[] = [];
    for await (const m of readMessages({ projectDir: projectDir, sessionId: sessionId })) {
      messages.push(toResumeMessage(m));
    }
    return { messages };
  }
}
