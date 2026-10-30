import { createStore, storeBase } from '../create-store.js';
import type { ClarificationQuestion, PlannerReplyAnswer } from '../../core/schemas/question.js';
import { plainUserMessage, type UserMessageInput } from '../../core/types/user-input.js';
import { DECIDE_YOURSELF_ANSWER } from '../../core/recovery/decide.js';
import { error } from '../../utils/error.js';

const questionPromptError = {
  missingAnswer: (index: number) =>
    error('question-prompt-missing-answer', `Missing answer for question ${index + 1}`, { index }),
} as const;

export interface QuestionAnswerDraft {
  text: string;
  selected: number;
}

export interface QuestionPromptState {
  hint: string | null;
  questions?: readonly ClarificationQuestion[] | undefined;
  index: number;
  drafts: readonly QuestionAnswerDraft[];
  answers: readonly UserMessageInput[];
  focus: 'menu' | 'answer' | 'composer';
  openedAt: number;
  complete: boolean;
  /** The round Esc closed, kept on screen until the reply answers it or another prompt opens. */
  unanswered: readonly ClarificationQuestion[];
}

/** The default as the card shows it: a confirm's boolean reads Yes or No. */
export function questionDefault(question: ClarificationQuestion): string | undefined {
  return typeof question.default === 'boolean'
    ? question.default
      ? 'Yes'
      : 'No'
    : question.default;
}

/** A question with no options of its own offers its default as the one option, like a choice. */
export function questionOptions(question: ClarificationQuestion): readonly string[] {
  const value = questionDefault(question);
  const listed =
    question.type === 'confirm'
      ? ['Yes', 'No']
      : question.type === 'choice'
        ? question.options
        : [];
  const options = listed.length === 0 && value?.trim() ? [value] : listed;
  const preferred = value === undefined ? -1 : options.indexOf(value);
  return preferred > 0
    ? [
        ...options.slice(preferred, preferred + 1),
        ...options.slice(0, preferred),
        ...options.slice(preferred + 1),
      ]
    : options;
}

const initial: QuestionPromptState = {
  hint: null,
  index: 0,
  drafts: [],
  answers: [],
  focus: 'composer',
  openedAt: 0,
  complete: false,
  unanswered: [],
};
const store = createStore<QuestionPromptState>(initial);

// The pairs a completed batch was flattened from. resolve() resets the store before the waiting
// reply callback resumes, so the batch survives outside it; every new prompt opener clears it.
let answeredBatch: PlannerReplyAnswer | undefined;

function setHint(hint: string): void {
  answeredBatch = undefined;
  store.set({ ...initial, hint });
}

function setQuestions(questions: readonly ClarificationQuestion[]): void {
  answeredBatch = undefined;
  store.set((state) => ({
    ...initial,
    hint: state.hint,
    questions,
    drafts: questions.map(() => ({ text: '', selected: 0 })),
    openedAt: Date.now(),
    focus: questions[0] && questionOptions(questions[0]).length > 0 ? 'menu' : 'answer',
  }));
}

/** Esc closes the panel: the round waits for a composer reply, as an ordinary planner reply does. */
function close(): void {
  answeredBatch = undefined;
  store.set((state) => ({
    ...initial,
    hint: state.hint,
    questions: [],
    unanswered: state.questions ?? [],
  }));
}

function select(selected: number): void {
  store.set((state) => ({
    ...state,
    drafts: state.drafts.map((draft, index) =>
      index === state.index ? { ...draft, selected } : draft,
    ),
  }));
}

function setFocus(focus: QuestionPromptState['focus'], text?: string): void {
  store.set((state) => ({
    ...state,
    focus,
    drafts: state.drafts.map((draft, index) =>
      index === state.index && text !== undefined ? { ...draft, text } : draft,
    ),
  }));
}

function previous(): void {
  store.set((state) => {
    const index = Math.max(0, state.index - 1);
    const question = state.questions?.[index];
    return {
      ...state,
      index,
      focus: question && questionOptions(question).length > 0 ? 'menu' : 'answer',
    };
  });
}

/** Only the completed batch crosses the existing planner-reply boundary. */
function answer(message: UserMessageInput): PlannerReplyAnswer | undefined {
  const state = store.get();
  if (state.complete || !state.questions?.length || message.text.trim() === '') return undefined;
  const answers = [...state.answers];
  answers[state.index] = message;
  const complete = state.index === state.questions.length - 1;
  const index = complete ? state.index : state.index + 1;
  const next = state.questions[index];
  const qa = complete ? answerBatch(state.questions, answers) : undefined;
  store.set({
    ...state,
    answers,
    complete,
    index,
    focus: next && questionOptions(next).length > 0 ? 'menu' : 'answer',
  });
  answeredBatch = qa;
  return qa;
}

/**
 * Decide for me: the answers given stay, every open question takes its default, and the seat that
 * reads the answer decides one that has none: the brief's implementer or the next review. The batch asks the run to stop asking.
 */
function decideForMe(): PlannerReplyAnswer | undefined {
  const state = store.get();
  if (state.complete || !state.questions?.length) return undefined;
  const answers = state.questions.map(
    (question, i) =>
      (i < state.index ? state.answers[i] : undefined) ??
      plainUserMessage(questionDefault(question) ?? DECIDE_YOURSELF_ANSWER),
  );
  const batch: PlannerReplyAnswer = {
    ...answerBatch(state.questions, answers),
    decideForMe: true,
  };
  store.set({ ...state, answers, complete: true });
  answeredBatch = batch;
  return batch;
}

function answerBatch(
  questions: readonly ClarificationQuestion[],
  answers: readonly UserMessageInput[],
): PlannerReplyAnswer {
  const answerAt = (index: number): UserMessageInput => {
    const answer = answers[index];
    if (answer === undefined) throw questionPromptError.missingAnswer(index);
    return answer;
  };
  return {
    message: {
      text: questions
        .map((question, i) => `${i + 1}. ${question.text}\n${answerAt(i).text}`)
        .join('\n\n'),
      displayText: questions
        .map((question, i) => `${i + 1}. ${question.text}\n${answerAt(i).displayText}`)
        .join('\n\n'),
      images: answers.flatMap((answer) => answer.images),
      attachedInputs: answers.flatMap((answer) => answer.attachedInputs),
    },
    qa: questions.map((question, i) => ({
      question: question.text,
      answer: answerAt(i).displayText,
    })),
  };
}

/** The pairs of the batch that just completed, once; every later prompt opens with a clear slate. */
function takeAnswerBatch(): PlannerReplyAnswer | undefined {
  const batch = answeredBatch;
  answeredBatch = undefined;
  return batch;
}

export const questionPromptStore = {
  ...storeBase(store),
  setHint,
  setQuestions,
  close,
  select,
  setFocus,
  previous,
  answer,
  decideForMe,
  takeAnswerBatch,
  clearHint: (): void => store.set(initial),
};
