import { randomUUID } from 'node:crypto';
import type { WorkflowState, QueuedMessage } from '../../core/schemas/workflow.js';
import type { EventBus } from '../events/types.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import { readSpecFileOrEmpty, writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE } from '../../core/paths.js';
import { appendMessage } from '../../core/sessions/log-writer.js';
import { transitionAndSave } from './state-ops.js';
import { dispatchNativeInjection } from './queue/native-injection.js';
import type { Planner } from '../planners/types.js';
import { warnError } from '../../lib/warn.js';
import { nowIso } from '../../utils/format-time.js';
import { formatQueuedMessagePreview } from '../../core/queue-preview.js';

export type CollectClarificationsOptions = {
  questions: ClarificationQuestion[];
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  onQuestionAsked: (
    question: ClarificationQuestion,
    index: number,
    total: number,
  ) => Promise<string>;
  persistTranscript: boolean;
  bus: EventBus;
  metadata?: SpecMetadata | null;
  planner?: Planner;
};

export async function collectAndPersistClarifications(
  opts: CollectClarificationsOptions,
): Promise<WorkflowState> {
  const {
    questions,
    projectDir,
    sessionId,
    onQuestionAsked,
    persistTranscript,
    bus,
    metadata,
    planner,
  } = opts;
  let state = opts.state;
  if (
    state.phase !== 'idle' &&
    state.phase !== 'researching' &&
    state.phase !== 'specifying' &&
    state.phase !== 'planning'
  ) {
    warnError('clarifications: unexpected phase', { phase: state.phase });
    return state;
  }

  const clarifications: Array<{ question: string; answer: string }> = [];
  const total = questions.length;

  for (const [qi, question] of questions.entries()) {
    const answer = await onQuestionAsked(question, qi + 1, total);

    if (answer === 'done') break;
    if (answer === 'skip' || answer === '') continue;

    appendMessage(
      { projectDir, sessionId },
      { role: 'user', phase: state.phase, text: answer },
      { persistTranscript },
    );
    clarifications.push({ question: question.text, answer });

    const message: QueuedMessage = {
      id: randomUUID(),
      text: answer,
      queuedAt: nowIso(),
      phase: state.phase,
      deliveredViaNative: false,
      nativeDeliveryState: 'pending',
      origin: 'clarification',
      question: question.text,
    };

    state = transitionAndSave({ projectDir, sessionId }, state, {
      type: 'ENQUEUE_USER_MSG',
      message,
    });

    bus.publish({
      type: 'clarification_answered',
      ts: Date.now(),
      phase: state.phase,
      answer,
    });
    if (planner) {
      const preview = formatQueuedMessagePreview(message);
      bus.publish({
        type: 'message_queued',
        ts: Date.now(),
        phase: state.phase,
        id: message.id,
        origin: 'clarification',
        ...(preview.length > 0 && { preview }),
      });
      await dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId,
        getState: () => state,
        setState: (s) => {
          state = s;
        },
        bus,
      });
    }
  }

  if (clarifications.length === 0) return state;

  let content = readSpecFileOrEmpty({ projectDir, sessionId }, SPEC_FILE);
  const sessionHeader = `### Session ${nowIso().slice(0, 10)}`;
  const entries = clarifications.map((c) => `- Q: ${c.question} \u2192 A: ${c.answer}`).join('\n');

  if (!content.includes('## Clarifications')) {
    content += `\n\n## Clarifications\n\n${sessionHeader}\n${entries}\n`;
  } else if (!content.includes(sessionHeader)) {
    content += `\n${sessionHeader}\n${entries}\n`;
  } else {
    content += `\n${entries}\n`;
  }

  writeSpecFile({ projectDir, sessionId }, SPEC_FILE, content, metadata);

  bus.publish({
    type: 'clarifications_collected',
    ts: Date.now(),
    phase: state.phase,
    count: clarifications.length,
    clarifications,
  });

  return state;
}
