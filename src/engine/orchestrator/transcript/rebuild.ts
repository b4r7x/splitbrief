import { readCompactedMessages, readMessages } from '../../../core/sessions/log-reader.js';
import type { SessionLogMessageEntry } from '../../../core/schemas/session-log.js';
import { sessionDir } from '../../../core/paths.js';
import { loadStateForResume } from '../../../core/state/persistence.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { ResumeLoadAuthority, StateAuthorityReceipt } from '../../../core/state/types.js';
import type { SessionRef } from '../../../core/types/session-ref.js';

export type ResumeMessage = { role: 'user' | 'assistant'; content: string };

export type ResumeContext = {
  messages: ResumeMessage[];
  warning?: 'transcript-unavailable' | 'state-unavailable' | undefined;
};

function toResumeMessage(message: SessionLogMessageEntry): ResumeMessage {
  const content = message.interrupted ? `${message.text}\n\n[turn interrupted]` : message.text;
  return { role: message.role, content };
}

function pendingQueueEntries(
  ref: SessionRef,
  authority: StateAuthorityReceipt | undefined,
): { queue: WorkflowState['messageQueue']; unavailable: boolean } {
  // Callers that only need transcript bytes may omit state hydration. Owner paths pass
  // their receipt so queue filtering is based on the same current v4 projection.
  if (authority === undefined) return { queue: [], unavailable: false };
  const resumeAuthority: ResumeLoadAuthority = {
    kind: 'fenced',
    receipt: authority,
    promotedFromVersion: null,
  };
  try {
    const result = loadStateForResume({ ref, authority: resumeAuthority });
    if (result.kind === 'missing') return { queue: [], unavailable: false };
    if (result.kind === 'invalid') return { queue: [], unavailable: true };
    return {
      queue: result.state.messageQueue.filter(isQueuedMessagePendingDelivery),
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

export async function buildResumeContext(opts: {
  ref: SessionRef;
  persistTranscript: boolean;
  authority?: StateAuthorityReceipt | undefined;
}): Promise<ResumeContext> {
  const { ref, persistTranscript, authority } = opts;
  if (!persistTranscript) {
    return { messages: [], warning: 'transcript-unavailable' };
  }
  const pending = pendingQueueEntries(ref, authority);
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
    const messages: ResumeMessage[] = [];
    for await (const m of readMessages(ref)) {
      if (isStillPendingQueuedTranscriptMessage(m, pendingQueue)) continue;
      messages.push(toResumeMessage(m));
    }
    return { messages };
  }
}
