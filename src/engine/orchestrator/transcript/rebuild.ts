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
  warning?: 'transcript-unavailable' | undefined;
};

function toResumeMessage(message: SessionLogMessageEntry): ResumeMessage {
  const content = message.interrupted ? `${message.text}\n\n[turn interrupted]` : message.text;
  return { role: message.role, content };
}

function pendingQueueEntries(ref: SessionRef): WorkflowState['messageQueue'] {
  return loadState(ref)?.messageQueue.filter(isQueuedMessagePendingDelivery) ?? [];
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

export async function buildResumeContext(opts: {
  ref: SessionRef;
  persistTranscript: boolean;
}): Promise<ResumeContext> {
  const { ref, persistTranscript } = opts;
  if (!persistTranscript) {
    return { messages: [], warning: 'transcript-unavailable' };
  }
  const pendingQueue = pendingQueueEntries(ref);
  try {
    const entries = await readCompactedResumeEntries(ref);
    return {
      messages: entries
        .filter((message) => !isStillPendingQueuedTranscriptMessage(message, pendingQueue))
        .map(toResumeMessage),
    };
  } catch {
    const messages: ResumeMessage[] = [];
    for await (const m of readMessages(ref)) {
      if (isStillPendingQueuedTranscriptMessage(m, pendingQueue)) continue;
      messages.push(toResumeMessage(m));
    }
    return { messages };
  }
}
