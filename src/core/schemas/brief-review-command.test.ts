import { describe, expect, it } from 'vitest';
import {
  allowedBriefReviewCommandsForPrompt,
  allowedSettlingBriefReviewCommandsForPrompt,
} from './brief-review-command.js';

describe('artifact approval prompts', () => {
  it('expose no Task Brief commands through the generic review transport', () => {
    expect(allowedBriefReviewCommandsForPrompt('artifact')).toEqual([]);
    expect(allowedSettlingBriefReviewCommandsForPrompt('artifact')).toEqual([]);
  });
});
