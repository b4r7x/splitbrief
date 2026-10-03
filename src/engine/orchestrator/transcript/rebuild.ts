import { readCompactedMessages, readMessages } from '../../../core/sessions/log-reader.js';
import type { SessionLogMessageEntry } from '../../../core/schemas/session-log.js';
import { sessionDir } from '../../../core/paths.js';
import { loadState } from '../../../core/state/persistence.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { isPlannerDocument } from '../../../core/pipeline-spec/planner-documents.js';
import { extractQuestionsFromStream } from '../../parsers/question.js';
import { parseTaskSourceBlocks } from '../../spec/tasks/parse.js';

export type ResumeMessage = { role: 'user' | 'assistant'; content: string };

export type ResumeContext = {
  messages: ResumeMessage[];
  warning?: 'state-unavailable' | undefined;
};

function toResumeMessage(message: SessionLogMessageEntry): ResumeMessage {
  const content = message.interrupted ? `${message.text}\n\n[turn interrupted]` : message.text;
  return { role: message.role, content };
}

function pendingQueueEntries(ref: SessionRef): {
  queue: WorkflowState['messageQueue'];
  unavailable: boolean;
} {
  try {
    const state = loadState(ref);
    if (state === null) return { queue: [], unavailable: false };
    return {
      queue: state.messageQueue.filter(isQueuedMessagePendingDelivery),
      unavailable: false,
    };
  } catch {
    return { queue: [], unavailable: true };
  }
}

// The implementer's stream is logged in the implementing phase (`implementers/pipeline/run.ts`) so a
// cut brief can continue from it. It is not the planner's side of the conversation.
function isImplementerOutput(message: SessionLogMessageEntry): boolean {
  return message.role === 'assistant' && message.phase === 'implementing';
}

function isStillPendingQueuedTranscriptMessage(
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
      queued.text === message.text,
  );
}

async function readCompactedResumeEntries(ref: SessionRef): Promise<SessionLogMessageEntry[]> {
  return readCompactedMessages(sessionDir(ref.projectDir, ref.sessionId));
}

/**
 * The entries in logged order, grouped by the call that wrote them: one call's assistant text runs
 * together, and its interrupted marker, when the call was cut, closes it.
 */
function turnsOf(messages: readonly SessionLogMessageEntry[]): SessionLogMessageEntry[][] {
  const turns: SessionLogMessageEntry[][] = [];
  for (const message of messages) {
    const turn = turns.at(-1);
    const last = turn?.at(-1);
    if (
      turn !== undefined &&
      last?.role === 'assistant' &&
      message.role === 'assistant' &&
      last.phase === message.phase &&
      last.interrupted !== true
    ) {
      turn.push(message);
    } else {
      turns.push([message]);
    }
  }
  return turns;
}

/**
 * A completed call whose text is the document its step writes. The document is the step's artifact,
 * which the step prompts carry, and a log from before documents stopped being logged still holds it.
 */
function isPlannerDocumentTurn(turn: readonly SessionLogMessageEntry[]): boolean {
  const [first] = turn;
  if (first?.role !== 'assistant' || turn.at(-1)?.interrupted === true) return false;
  const text = turn.map((entry) => entry.text).join('');
  if (extractQuestionsFromStream(text).length > 0) return false;
  switch (first.phase) {
    case 'researching':
      return isPlannerDocument('research', text);
    case 'specifying':
      return isPlannerDocument('spec', text);
    case 'planning':
      return isPlannerDocument('plan', text) || parseTaskSourceBlocks(text).length > 0;
    default:
      return false;
  }
}

function plannerConversation(
  entries: readonly SessionLogMessageEntry[],
  pendingQueue: WorkflowState['messageQueue'],
): ResumeMessage[] {
  const turns = turnsOf(
    entries.filter(
      (message) =>
        !isImplementerOutput(message) &&
        !isStillPendingQueuedTranscriptMessage(message, pendingQueue),
    ),
  ).filter((turn) => !isPlannerDocumentTurn(turn));
  return turns.flat().map(toResumeMessage);
}

/** The planner conversation `session.jsonl` holds, a cut call's partial included. */
export async function buildResumeContext(opts: { ref: SessionRef }): Promise<ResumeContext> {
  const { ref } = opts;
  const pending = pendingQueueEntries(ref);
  if (pending.unavailable) return { messages: [], warning: 'state-unavailable' };
  const pendingQueue = pending.queue;
  try {
    const entries = await readCompactedResumeEntries(ref);
    return { messages: plannerConversation(entries, pendingQueue) };
  } catch {
    // A compacted read that fails degrades to replaying the raw message log.
    // That replay is deliberately unguarded: if the same session directory is
    // unreadable twice the resume fails loudly, because resuming with a
    // silently empty history is worse than not resuming.
    const entries: SessionLogMessageEntry[] = [];
    for await (const m of readMessages(ref)) entries.push(m);
    return { messages: plannerConversation(entries, pendingQueue) };
  }
}
