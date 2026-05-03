import type { Config } from '../../core/schemas/config.js';
import type { CompactTranscriptResult } from '../../core/slash-commands/types.js';
import { compactTranscript, type TranscriptCompactionResult } from '../../core/sessions/compaction.js';
import { readCompactedMessages, readMessages } from '../../core/sessions/log-reader.js';
import { sessionDir } from '../../core/paths.js';
import { createPlanner } from '../runners/factory.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';
import type { PlannerSummaryMessage } from '../planners/types.js';

export type ResumeMessage = { role: 'user' | 'assistant'; content: string };

export type ResumeContext = {
  messages: ResumeMessage[];
  warning?: 'transcript-unavailable' | undefined;
};

async function readCompactedResumeMessages(projectDir: string, sessionId: string): Promise<ResumeMessage[]> {
  const messages = await readCompactedMessages(sessionDir(projectDir, sessionId));
  return messages.map(message => ({ role: message.role, content: message.text }));
}

const DEFAULT_KEEP_RECENT_COUNT = 10;
const MIN_COMPACTION_KEEP_RECENT = 1;

export function keepRecentCountForThreshold(threshold: number): number {
  return Math.max(MIN_COMPACTION_KEEP_RECENT, threshold - 1);
}

export async function compactResumeTranscript(
  projectDir: string,
  sessionId: string,
  planner: { summarize: (messages: PlannerSummaryMessage[]) => Promise<string> },
  keepRecentCount: number,
): Promise<TranscriptCompactionResult> {
  return compactTranscript(sessionDir(projectDir, sessionId), planner, keepRecentCount);
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
  const result = await compactTranscript(sessionDir(projectDir, sessionId), {
    summarize: messages => planner.summarize(messages, projectDir),
  }, keepRecentCount);
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
