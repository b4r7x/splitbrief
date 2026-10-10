import { readCompactedMessages, readMessages } from '../../../core/sessions/log-reader.js';
import type { SessionLogMessageEntry } from '../../../core/schemas/session-log.js';
import { sessionDir } from '../../../core/paths.js';
import { loadState } from '../../../core/state/persistence.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { error } from '../../../utils/error.js';

const transcriptError = {
  missingAttachmentAnswer: (answerIndex: number) =>
    error('transcript-missing-attachment-answer', 'Saved attachment answer is missing.', {
      answerIndex,
    }),
} as const;

export type ResumeMessage = { role: 'user' | 'assistant'; content: string };

export type ResumeContext = {
  messages: ResumeMessage[];
  warning?: 'state-unavailable' | undefined;
};

function toResumeMessage(message: SessionLogMessageEntry, text: string): ResumeMessage {
  const content = message.interrupted ? `${text}\n\n[turn interrupted]` : text;
  return { role: message.role, content };
}

function savedResumeState(ref: SessionRef): {
  state: WorkflowState | null;
  unavailable: boolean;
} {
  try {
    const state = loadState(ref);
    return { state, unavailable: false };
  } catch {
    return { state: null, unavailable: true };
  }
}

// The implementer's stream is logged in the implementing phase (`implementers/pipeline/run.ts`) so a
// cut brief can continue from it. It is not the planner's side of the conversation.
function isImplementerOutput(message: SessionLogMessageEntry): boolean {
  return message.role === 'assistant' && message.phase === 'implementing';
}

export function isStillPendingQueuedTranscriptMessage(
  message: SessionLogMessageEntry,
  pendingQueue: WorkflowState['messageQueue'],
): boolean {
  if (message.role !== 'user') return false;
  if (message.queueMessageId !== undefined) {
    return pendingQueue.some((queued) => queued.id === message.queueMessageId);
  }
  if (message.queuedAt === undefined || message.phase === undefined) return false;
  return pendingQueue.some(
    (queued) =>
      queued.queuedAt === message.queuedAt &&
      queued.phase === message.phase &&
      (queued.displayText === message.text || queued.text === message.text),
  );
}

async function readCompactedResumeEntries(ref: SessionRef): Promise<SessionLogMessageEntry[]> {
  return readCompactedMessages(sessionDir(ref.projectDir, ref.sessionId));
}

export function reconstructPlannerConversation(
  entries: readonly SessionLogMessageEntry[],
  state: WorkflowState | null,
): {
  messages: ResumeMessage[];
  expanded: SessionLogMessageEntry[];
  unmatched: NonNullable<WorkflowState['resumeUserMessages']>;
} {
  const queue = state?.messageQueue ?? [];
  const pendingQueue = queue.filter(isQueuedMessagePendingDelivery);
  const savedMessages = [...(state?.resumeUserMessages ?? [])];
  const answers = [
    ...(state?.userAnswers ?? []),
    ...(state?.pendingPlannerConversation?.answers ?? []),
  ];
  const messages: ResumeMessage[] = [];
  const expanded = [...entries];
  for (const [entryIndex, message] of [...entries.entries()].reverse()) {
    if (
      isImplementerOutput(message) ||
      isStillPendingQueuedTranscriptMessage(message, pendingQueue)
    )
      continue;
    let text = message.text;
    if (message.role === 'user') {
      if (message.queueMessageId !== undefined) {
        const queued = queue.find((item) => item.id === message.queueMessageId);
        if (queued !== undefined) text = queued.text;
      } else {
        const index = savedMessages.findLastIndex(
          (saved) =>
            saved.ts === message.ts &&
            saved.phase === message.phase &&
            saved.displayText === message.text,
        );
        const saved = savedMessages[index];
        if (saved !== undefined) {
          if ('text' in saved) text = saved.text;
          else {
            const answer = answers[saved.answerIndex];
            if (answer === undefined)
              throw transcriptError.missingAttachmentAnswer(saved.answerIndex);
            text = answer.answer;
          }
          savedMessages.splice(index, 1);
        }
      }
    }
    expanded[entryIndex] = { ...message, text };
    messages.push(toResumeMessage(message, text));
  }
  return { messages: messages.reverse(), expanded, unmatched: savedMessages };
}

/** The planner conversation `session.jsonl` holds, a cut call's partial included. */
export async function buildResumeContext(opts: { ref: SessionRef }): Promise<ResumeContext> {
  const { ref } = opts;
  const saved = savedResumeState(ref);
  if (saved.unavailable) return { messages: [], warning: 'state-unavailable' };
  let entries: SessionLogMessageEntry[];
  try {
    entries = await readCompactedResumeEntries(ref);
  } catch {
    // A compacted read that fails degrades to replaying the raw message log.
    // That replay is deliberately unguarded: if the same session directory is
    // unreadable twice the resume fails loudly, because resuming with a
    // silently empty history is worse than not resuming.
    entries = [];
    for await (const m of readMessages(ref)) entries.push(m);
  }
  return { messages: reconstructPlannerConversation(entries, saved.state).messages };
}
