import type { Config } from '../../core/schemas/config.js';
import type { CompactTranscriptResult } from '../../core/runtime/commands/types.js';
import { compactTranscript, DEFAULT_KEEP_RECENT_COUNT, type TranscriptCompactionResult } from '../../core/sessions/compaction.js';
import { readCompactedMessages, readMessages } from '../../core/sessions/log-reader.js';
import { sessionDir } from '../../core/paths.js';
import { createPlanner } from '../runners/factory.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';
import type { PlannerSummaryMessage } from '../planners/types.js';
import { resolveCompactionFormat, type ResolvedCompactionFormat, type StructuredSummary } from '../../core/schemas/compaction.js';

export type ResumeMessage = { role: 'user' | 'assistant'; content: string };

export type ResumeContext = {
  messages: ResumeMessage[];
  warning?: 'transcript-unavailable' | undefined;
};

async function readCompactedResumeMessages(projectDir: string, sessionId: string): Promise<ResumeMessage[]> {
  const messages = await readCompactedMessages(sessionDir(projectDir, sessionId));
  return messages.map(message => ({ role: message.role, content: message.text }));
}

const MIN_COMPACTION_KEEP_RECENT = 1;

export function keepRecentCountForThreshold(threshold: number): number {
  return Math.max(MIN_COMPACTION_KEEP_RECENT, threshold - 1);
}

export async function compactResumeTranscript(
  projectDir: string,
  sessionId: string,
  planner: {
    summarize: (messages: PlannerSummaryMessage[]) => Promise<string>;
    summarizeStructured?: (
      messages: PlannerSummaryMessage[],
      previousSummary?: StructuredSummary,
    ) => Promise<{ text: string; structured: StructuredSummary | null }>;
  },
  keepRecentCount: number,
  format: ResolvedCompactionFormat = 'freeform',
  onFallback?: (text: string) => void | Promise<void>,
): Promise<TranscriptCompactionResult> {
  return compactTranscript({
    sessionDir: sessionDir(projectDir, sessionId),
    planner,
    keepRecentCount,
    format,
    ...(onFallback ? { onFallback } : {}),
  });
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
  const keepRecentCount = threshold !== undefined
    ? keepRecentCountForThreshold(threshold)
    : DEFAULT_KEEP_RECENT_COUNT;
  const format = resolveCompactionFormat(config.workflow.compactionFormat, config.planner.kind);
  const summarizeStructured = planner.summarizeStructured;
  const result = await compactTranscript({
    sessionDir: sessionDir(projectDir, sessionId),
    keepRecentCount,
    format,
    planner: {
      summarize: messages => planner.summarize(messages, projectDir),
      ...(summarizeStructured
        ? { summarizeStructured: (messages, previous) => summarizeStructured(messages, previous, projectDir) }
        : {}),
    },
  });
  return { status: 'compacted', ...result };
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
    for await (const m of readMessages(projectDir, sessionId)) {
      messages.push({ role: m.role, content: m.text });
    }
    return { messages };
  }
}
