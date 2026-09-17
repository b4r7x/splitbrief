import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../core/state/machine.js';
import type { ClarificationQuestion } from '../core/schemas/question.js';
import { HeadlessJsonRecordSchema } from '../engine/events/public-json.js';
import { emitRecoveryAndFailIfPending } from './headless.js';

describe('headless planner input required', () => {
  const question: ClarificationQuestion = {
    id: 'scope',
    type: 'choice',
    text: 'Which module should change?',
    options: ['auth', 'CLI'],
    default: 'auth',
  };

  it.each(['', `<!-- Q:${JSON.stringify(question)} -->`])(
    'reports structured questions when visible reply is absent: %j',
    (text) => {
      const state = {
        ...createInitialState('Refactor the module'),
        pendingPlannerConversation: {
          call: 'research' as const,
          text,
          questions: [question],
          answers: [],
          answered: false,
        },
      };
      const writeRecord = vi.fn();
      expect(() =>
        emitRecoveryAndFailIfPending({ state, sessionId: 'needs-scope', writeRecord }),
      ).toThrow('Which module should change? (auth / CLI)');
      const record = HeadlessJsonRecordSchema.parse(writeRecord.mock.calls[0]?.[0]);
      expect(record).toMatchObject({
        type: 'input_required',
        message: 'Which module should change? (auth / CLI)',
        questions: [question],
      });
      expect(JSON.stringify(record)).not.toContain('<!--');
    },
  );
});
