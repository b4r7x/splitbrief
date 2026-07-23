import { beforeEach, describe, expect, it } from 'vitest';
import { questionPromptStore } from './prompt.js';

describe('questionPromptStore', () => {
  beforeEach(() => {
    questionPromptStore.reset();
  });

  it('stores and clears the active question hint', () => {
    expect(questionPromptStore.get()).toEqual({ hint: null });
    questionPromptStore.setHint('Which database?');
    expect(questionPromptStore.get()).toEqual({ hint: 'Which database?' });

    questionPromptStore.clearHint();
    expect(questionPromptStore.get()).toEqual({ hint: null });
  });
});
