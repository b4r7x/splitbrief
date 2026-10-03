import type { ClarificationQuestion } from '../schemas/question.js';
import type { PlannerConversation, WorkflowState } from '../schemas/workflow.js';

export function questionsText(questions: readonly ClarificationQuestion[]): string {
  return questions
    .map((question, index) => {
      const fallback = question.default === undefined ? '' : ` (default: ${question.default})`;
      return `${index + 1}. ${question.text}${fallback}`;
    })
    .join('\n');
}

/**
 * The planning session writes its conversation's text from its questions. An older chain's `plan`
 * step kept the planner's own reply there, and that conversation is earlier planning, not this
 * session's pending questions.
 */
export function isSessionConversation(conversation: PlannerConversation): boolean {
  return (
    conversation.call === 'plan' &&
    conversation.questions.length > 0 &&
    conversation.text === questionsText(conversation.questions)
  );
}

export function sessionConversation(state: WorkflowState): PlannerConversation | undefined {
  const conversation = state.pendingPlannerConversation;
  return conversation !== undefined && isSessionConversation(conversation)
    ? conversation
    : undefined;
}
