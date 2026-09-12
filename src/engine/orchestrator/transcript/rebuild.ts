import { readCompactedMessages, readMessages } from '../../../core/sessions/log-reader.js';
import type { SessionLogMessageEntry } from '../../../core/schemas/session-log.js';
import { sessionDir } from '../../../core/paths.js';
import { loadState } from '../../../core/state/persistence.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';

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

export async function buildResumeContext(opts: { ref: SessionRef }): Promise<ResumeContext> {
  const { ref } = opts;
  const pending = pendingQueueEntries(ref);
  if (pending.unavailable) return { messages: [], warning: 'state-unavailable' };
  const pendingQueue = pending.queue;
  try {
    const entries = await readCompactedResumeEntries(ref);
    return {
      messages: entries
        .filter((message) => !isStillPendingQueuedTranscriptMessage(message, pendingQueue))
        .map(toResumeMessage),
    };
  } catch {
    // A compacted read that fails degrades to replaying the raw message log.
    // That replay is deliberately unguarded: if the same session directory is
    // unreadable twice the resume fails loudly, because resuming with a
    // silently empty history is worse than not resuming.
    const messages: ResumeMessage[] = [];
    for await (const m of readMessages(ref)) {
      if (isStillPendingQueuedTranscriptMessage(m, pendingQueue)) continue;
      messages.push(toResumeMessage(m));
    }
    return { messages };
  }
}
