import { randomUUID } from 'node:crypto';
import type { WorkflowState, QueuedMessage } from '../../core/types/state-actions.js';
import type { OrchestratorCallbacks } from './types.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import { readSpecFileOrEmpty, writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE } from '../../core/paths.js';
import { emit } from './events.js';
import { appendMessage } from '../../core/state/persistence.js';
import { transitionAndSave } from './state-ops.js';
import { dispatchNativeInjection } from './native-injection.js';
import type { Planner } from '../planners/types.js';

export async function collectAndPersistClarifications(
  questions: ClarificationQuestion[],
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  onQuestionAsked: NonNullable<OrchestratorCallbacks['onQuestionAsked']>,
  persistTranscript: boolean,
  metadata?: SpecMetadata | null,
  planner?: Planner,
  callbacks?: OrchestratorCallbacks,
): Promise<WorkflowState> {
  if (state.phase !== 'researching' && state.phase !== 'specifying') {
    process.stderr.write(`[clarifications] skipping: unexpected phase "${state.phase}"\n`);
    return state;
  }

  const clarifications: Array<{ question: string; answer: string }> = [];
  const total = questions.length;

  for (const [qi, question] of questions.entries()) {
    const answer = await onQuestionAsked(question, qi + 1, total);

    if (answer === 'done') break;
    if (answer === 'skip' || answer === '') continue;

    appendMessage(projectDir, sessionId, { role: 'user', phase: state.phase, text: answer }, persistTranscript);
    clarifications.push({ question: question.text, answer });

    const message: QueuedMessage = {
      id: randomUUID(),
      text: answer,
      queuedAt: new Date().toISOString(),
      phase: state.phase,
      deliveredViaNative: false,
      origin: 'clarification',
      question: question.text,
      questionId: question.id ?? undefined,
    };

    state = transitionAndSave(projectDir, sessionId, state, { type: 'ENQUEUE_USER_MSG', message });
    emit(projectDir, sessionId, state, 'clarification_answered', undefined, { questionId: question.id, answer });

    if (planner && callbacks) {
      void dispatchNativeInjection(message, planner, projectDir, sessionId, state, (s) => { state = s; }, callbacks);
      callbacks.onEvent({ type: 'message-queued', ts: Date.now(), id: message.id, phase: state.phase });
    }
  }

  if (clarifications.length === 0) return state;

  let content = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);
  const sessionHeader = `### Session ${new Date().toISOString().slice(0, 10)}`;
  const entries = clarifications.map(c => `- Q: ${c.question} \u2192 A: ${c.answer}`).join('\n');

  if (!content.includes('## Clarifications')) {
    content += `\n\n## Clarifications\n\n${sessionHeader}\n${entries}\n`;
  } else if (!content.includes(sessionHeader)) {
    content += `\n${sessionHeader}\n${entries}\n`;
  } else {
    content += `\n${entries}\n`;
  }

  writeSpecFile(projectDir, sessionId, SPEC_FILE, content, metadata);
  emit(projectDir, sessionId, state, 'clarifications_collected', undefined, {
    count: clarifications.length,
    clarifications,
  });

  return state;
}
