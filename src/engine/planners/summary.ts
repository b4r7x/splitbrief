import {
  tryParseStructuredSummary,
  type StructuredSummary,
} from '../../core/schemas/compaction.js';
import type { InvokeResult } from '../runners/types.js';
import type { PlannerSummaryMessage } from './types.js';

type PlannerSummaryConfig = {
  invokeEscalate: (opts: {
    prompt: string;
    projectDir: string;
    callbacks: { onOutput: (text: string) => void };
  }) => Promise<InvokeResult>;
};

const SUMMARY_PROMPT =
  'Summarize this conversation compactly. Preserve: feature goal, key decisions, progress (phases/tasks done), files modified, active constraints, pending items. Output as structured markdown.';
const STRUCTURED_SUMMARY_PROMPT = `Summarize this conversation as JSON with exactly these fields:
{
  "goal": "what feature is being built",
  "stepsCompleted": ["phase/task completed", ...],
  "currentStep": "what is in progress now",
  "filesModified": ["path/to/file.ts", ...],
  "constraintsDiscovered": ["constraint or pattern found", ...],
  "remainingWork": ["what is left to do", ...]
}
Return ONLY valid JSON, no markdown fences, no explanation.`;
const STRUCTURED_MERGE_PROMPT = `You have a previous structured summary and new conversation messages.
Merge the new information into the existing summary. Extend arrays, update currentStep, add new files/constraints.
Return ONLY valid JSON with the same schema. Do not regenerate - merge incrementally.

Previous summary:
`;

function formatSummaryTranscript(messages: PlannerSummaryMessage[]): string {
  return messages.map((message) => `[${message.role}]\n${message.text}`).join('\n\n');
}

function buildSummaryPrompt(messages: PlannerSummaryMessage[]): string {
  const transcript = formatSummaryTranscript(messages);
  return `${SUMMARY_PROMPT}\n\nConversation:\n${transcript}`;
}

function buildStructuredSummaryPrompt(
  messages: PlannerSummaryMessage[],
  previousSummary: StructuredSummary | undefined,
): string {
  const transcript = formatSummaryTranscript(messages);
  if (previousSummary) {
    return `${STRUCTURED_MERGE_PROMPT}${JSON.stringify(previousSummary)}\n\nNew messages:\n${transcript}`;
  }
  return `${STRUCTURED_SUMMARY_PROMPT}\n\nConversation:\n${transcript}`;
}

export async function summarize(
  config: PlannerSummaryConfig,
  messages: PlannerSummaryMessage[],
  projectDir?: string,
): Promise<string> {
  if (messages.length === 0) return '';
  const result = await config.invokeEscalate({
    prompt: buildSummaryPrompt(messages),
    projectDir: projectDir ?? process.cwd(),
    callbacks: { onOutput: () => {} },
  });
  return result.text.trim();
}

export async function summarizeStructured(
  config: PlannerSummaryConfig,
  messages: PlannerSummaryMessage[],
  previousSummary?: StructuredSummary,
  projectDir?: string,
): Promise<{ text: string; structured: StructuredSummary | null }> {
  if (messages.length === 0) return { text: '', structured: null };
  const result = await config.invokeEscalate({
    prompt: buildStructuredSummaryPrompt(messages, previousSummary),
    projectDir: projectDir ?? process.cwd(),
    callbacks: { onOutput: () => {} },
  });
  const text = result.text.trim();
  return { text, structured: tryParseStructuredSummary(text) };
}
