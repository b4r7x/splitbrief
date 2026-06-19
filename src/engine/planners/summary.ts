import {
  tryParseStructuredSummary,
  type StructuredSummary,
} from '../../core/schemas/compaction.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { error } from '../../utils/error.js';
import { throwIfAborted } from '../../utils/abort.js';
import type {
  PlannerCallEventCallbacks,
  PlannerStructuredSummaryOptions,
  PlannerSummaryMessage,
  PlannerSummaryOptions,
} from './types.js';
import { toTokenDelta } from '../calls/projection.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';

type PlannerSummaryConfig = {
  invokeEscalate: (opts: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: { onOutput: (text: string) => void } & PlannerCallEventCallbacks;
    signal?: AbortSignal | undefined;
  }) => Promise<RunnerCallResult>;
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
};

const DEFAULT_BACKEND_KIND: RunnerCallContext['backendKind'] = 'cli';

let summaryCallSequence = 0;

function createSummaryCallContext(
  config: PlannerSummaryConfig,
  role: RunnerCallContext['role'],
): RunnerCallContext {
  return {
    callId: `summary-${++summaryCallSequence}`,
    role,
    backendKind: config.backendKind ?? DEFAULT_BACKEND_KIND,
    ...(config.runnerName !== undefined && { runnerName: config.runnerName }),
    ...(config.model !== undefined && { model: config.model }),
  };
}

function requireCompletedCall(result: RunnerCallResult): RunnerCallResult {
  if (result.status === 'completed') return result;
  throw error('runner-call-failed', `Planner ${result.role} call ${result.status}`, {
    callId: result.callId,
    role: result.role,
    backendKind: result.backendKind,
    status: result.status,
    partial: result.partial,
    error: result.error,
  });
}

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
  opts: PlannerSummaryOptions = {},
): Promise<{ text: string; usage: TokenDelta | null }> {
  if (messages.length === 0) return { text: '', usage: null };
  throwIfAborted(opts.signal);
  const callContext = createSummaryCallContext(config, opts.role ?? 'summary');
  const result = requireCompletedCall(
    await config.invokeEscalate({
      prompt: buildSummaryPrompt(messages),
      projectDir: opts.projectDir ?? process.cwd(),
      callContext,
      callbacks: {
        onOutput: () => {},
        ...(opts.callbacks?.onCallEvent !== undefined && {
          onCallEvent: opts.callbacks.onCallEvent,
        }),
      },
      signal: opts.signal,
    }),
  );
  return { text: result.text.trim(), usage: toTokenDelta(result.usage) };
}

export async function summarizeStructured(
  config: PlannerSummaryConfig,
  messages: PlannerSummaryMessage[],
  opts: PlannerStructuredSummaryOptions = {},
): Promise<{ text: string; structured: StructuredSummary | null; usage: TokenDelta | null }> {
  if (messages.length === 0) return { text: '', structured: null, usage: null };
  throwIfAborted(opts.signal);
  const callContext = createSummaryCallContext(config, opts.role ?? 'summary');
  const result = requireCompletedCall(
    await config.invokeEscalate({
      prompt: buildStructuredSummaryPrompt(messages, opts.previousSummary),
      projectDir: opts.projectDir ?? process.cwd(),
      callContext,
      callbacks: {
        onOutput: () => {},
        ...(opts.callbacks?.onCallEvent !== undefined && {
          onCallEvent: opts.callbacks.onCallEvent,
        }),
      },
      signal: opts.signal,
    }),
  );
  const text = result.text.trim();
  return { text, structured: tryParseStructuredSummary(text), usage: toTokenDelta(result.usage) };
}
