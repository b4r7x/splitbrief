import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../core/state/machine.js';
import type { ClarificationQuestion } from '../core/schemas/question.js';
import { HeadlessJsonRecordSchema } from '../engine/events/public-json.js';
import { buildReviewInputTooLargeRecoveryIssue } from '../engine/orchestrator/recovery/builders/review-input.js';
import { emitRecoveryAndFailIfPending } from './headless.js';

describe('headless planner input required', () => {
  const question: ClarificationQuestion = {
    id: 'scope',
    type: 'choice',
    text: 'Which module should change?',
    options: ['auth', 'CLI'],
    default: 'auth',
  };

  it('reports structured questions when visible reply is absent', () => {
    const state = {
      ...createInitialState('Refactor the module'),
      pendingPlannerConversation: {
        call: 'research' as const,
        text: '',
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
  });
});

describe('headless review input too large', () => {
  it('reports the review input limit as one sentence', () => {
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: 'final-review',
      failure: {
        kind: 'input-too-large',
        figures: { unit: 'characters', size: 1_106_026, limit: 1_048_576 },
        promptSize: { characters: 1_106_026 },
        changeFile: '.splitbrief/reviews/run-1.diff',
        workspaceDir: '/work',
      },
      tool: 'OpenAI Codex CLI',
      acceptAsIs: true,
      createdAt: '2026-04-28T12:00:00.000Z',
    });
    const state = {
      ...createInitialState('Review the module'),
      pendingRecovery: issue,
    };
    const writeRecord = vi.fn();
    let thrown: unknown;
    try {
      emitRecoveryAndFailIfPending({ state, sessionId: 'review-cap', writeRecord });
    } catch (err) {
      thrown = err;
    }
    const record = HeadlessJsonRecordSchema.parse(writeRecord.mock.calls[0]?.[0]);
    if (record.type !== 'recovery_required') throw new Error('expected recovery_required');
    expect(record.message).toBe(
      'Review input is 1,106,026 characters; OpenAI Codex CLI takes at most 1,048,576.',
    );
    if (!(thrown instanceof Error)) throw new Error('expected an error');
    expect(thrown.message.split('\n')[0]).toBe(
      'Seat down (review-input-too-large): Review input is 1,106,026 characters; OpenAI Codex CLI takes at most 1,048,576.',
    );
  });
});
