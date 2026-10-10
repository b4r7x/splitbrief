import type { Phase } from '../../../core/schemas/enums.js';
import type { AnsweredQuestion } from '../../../core/schemas/question.js';
import type { SessionLogMessageEntry } from '../../../core/schemas/session-log.js';
import type { QueuedMessage } from '../../../core/schemas/workflow.js';
import { createSessionLogAppender } from '../../../core/sessions/log-writer.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { nowIso } from '../../../utils/format-time.js';
import type { EventBus } from '../../events/types.js';
import { publishUserMessage } from '../events.js';
import { recordResumeUserMessage } from '../state-ops.js';

export function recordUserMessage(
  scope: SessionRef & { bus: EventBus; phase: Phase },
  message: UserMessageInput,
  details: {
    qa?: AnsweredQuestion[];
    queuedMessage?: Pick<QueuedMessage, 'id' | 'queuedAt'>;
    answerIndex?: number;
  } = {},
): void {
  const entry: SessionLogMessageEntry = {
    kind: 'message',
    ts: nowIso(),
    role: 'user',
    phase: scope.phase,
    text: message.displayText,
    ...(details.qa !== undefined && { qa: details.qa }),
    ...(details.queuedMessage !== undefined && {
      queueMessageId: details.queuedMessage.id,
      queuedAt: details.queuedMessage.queuedAt,
    }),
  };
  if (details.queuedMessage === undefined) {
    recordResumeUserMessage(scope, {
      ts: entry.ts,
      phase: scope.phase,
      displayText: message.displayText,
      text: message.text,
      ...(details.answerIndex !== undefined && { answerIndex: details.answerIndex }),
    });
  }
  createSessionLogAppender(scope)(entry);
  publishUserMessage(scope, message.displayText, {
    attachedInputs: message.attachedInputs,
    ...(details.qa !== undefined && { qa: details.qa }),
  });
}
