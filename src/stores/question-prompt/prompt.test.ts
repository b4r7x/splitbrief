import { beforeEach, describe, expect, it } from 'vitest';
import { questionPromptStore } from './prompt.js';

describe('questionPromptStore', () => {
  beforeEach(() => {
    questionPromptStore.reset();
  });

  it('starts idle', () => {
    expect(questionPromptStore.get()).toEqual({ hint: null });
  });

  it('stores and clears the active question hint', () => {
    questionPromptStore.setHint('Which database?');
    expect(questionPromptStore.get()).toEqual({ hint: 'Which database?' });

    questionPromptStore.clearHint();
    expect(questionPromptStore.get()).toEqual({ hint: null });
  });
});
