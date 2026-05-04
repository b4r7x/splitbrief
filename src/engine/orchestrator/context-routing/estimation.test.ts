import { describe, expect, it } from 'vitest';
import type { ProjectContext } from '../../../core/state/types.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  classifyContextFit,
  estimateFormattedTaskPromptTokens,
} from './estimation.js';
import { formatTaskPrompt } from '../../spec/prompt-formatter.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { buildSystemPreamble } from '../../spec/prompts/system.js';
import { estimateTokens } from '../../../core/tokens/estimate.js';

const context: ProjectContext = {
  name: 'test-project',
  dir: '/repo',
  runtime: 'Node.js 22',
  testCommand: 'npm test',
};

describe('classifyContextFit', () => {
  it('classifies fits, tight, and overflow after applying the safety margin', () => {
    const opts = { safetyMargin: 0.1, tightThreshold: 0.8 };

    expect(classifyContextFit(700, 1000, opts)).toBe('fits');
    expect(classifyContextFit(750, 1000, opts)).toBe('tight');
    expect(classifyContextFit(920, 1000, opts)).toBe('overflow');
  });
});

describe('estimateFormattedTaskPromptTokens', () => {
  it('includes the system preamble in the formatted task prompt estimate', () => {
    const task = makeTask();
    const languageContext = buildLanguageContext('python');

    const estimatedTokens = estimateFormattedTaskPromptTokens({ task, context, contextLength: 10_000, languageContext });
    const promptOnlyTokens = estimateTokens(formatTaskPrompt(task, context, 10_000, languageContext));

    expect(estimatedTokens).toBe(promptOnlyTokens + estimateTokens(buildSystemPreamble(languageContext)));
  });
});
