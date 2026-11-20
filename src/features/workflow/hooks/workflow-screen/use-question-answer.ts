import { createDraftDocument } from '../../../../core/composer/document.js';
import { prepareDraftSubmission } from '../../../../core/composer/submission.js';
import { formatSubmissionFailure } from '../../../../components/composer/home-hint.js';
import { plannerSupportsImages } from '../../../../engine/providers/capabilities.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../../lib/terminal/typeahead-grace.js';
import { modelCacheStore } from '../../../../stores/discovery/model-cache/state.js';
import { configStore } from '../../../../stores/project/config.js';
import { questionOptions, questionPromptStore } from '../../../../stores/prompts/question.js';
import { feedbackStore } from '../../../../stores/ui/feedback.js';
import { attachmentsStore } from '../../../../stores/workflow/attachments.js';
import type { useWorkflowScreen } from './use-model.js';

/** The planner's round of questions: whether its panel is open, and what its rows send. */
export function useQuestionAnswer(
  model: Pick<
    ReturnType<typeof useWorkflowScreen>,
    'inputMode' | 'handleInput' | 'handleRuntimeCommand'
  >,
) {
  const state = questionPromptStore.use((prompt) => prompt);
  const structured = model.inputMode.mode === 'question' && (state.questions?.length ?? 0) > 0;

  const answer = (text: string): void => {
    const prompt = questionPromptStore.get();
    if (Date.now() - prompt.openedAt < PROMPT_TYPEAHEAD_GRACE_MS) return;
    if (text.trim() === '') return;
    const { config, projectDir } = configStore.get();
    const submission = prepareDraftSubmission(createDraftDocument(text), {
      projectDir,
      supportsImages: plannerSupportsImages(config, modelCacheStore),
    });
    if (!submission.ok && submission.reason === 'command') {
      questionPromptStore.setFocus('answer', '');
      model.handleRuntimeCommand(text.trim(), 'answer');
      return;
    }
    if (!submission.ok) {
      feedbackStore.setWarning(formatSubmissionFailure(submission));
      return;
    }
    const answered = questionPromptStore.answer(submission.message);
    attachmentsStore.replacePendingImages(
      questionPromptStore.get().answers.flatMap((reply) => reply.images),
    );
    if (answered !== undefined) void model.handleInput(answered.message);
  };
  const decide = (): void => {
    const decided = questionPromptStore.decideForMe();
    if (decided !== undefined) void model.handleInput(decided.message);
  };
  const compose = (): void => {
    const prompt = questionPromptStore.get();
    const question = prompt.questions?.[prompt.index];
    if (question) questionPromptStore.select(questionOptions(question).length);
    questionPromptStore.setFocus('answer');
  };
  const returnToQuestion = (): void => {
    const prompt = questionPromptStore.get();
    const question = prompt.questions?.[prompt.index];
    const options = question ? questionOptions(question) : [];
    questionPromptStore.setFocus(
      options.length === 0 || prompt.drafts[prompt.index]?.selected === options.length
        ? 'answer'
        : 'menu',
    );
  };

  return {
    state,
    structured,
    panelFocused: structured && state.focus !== 'composer',
    answer,
    decide,
    compose,
    returnToQuestion,
  };
}
