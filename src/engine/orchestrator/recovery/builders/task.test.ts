import { expect, it } from 'vitest';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { createdAt } from '#testing/helpers/recovery-issue.js';
import { buildSeatDownIssue } from './seat-down.js';

it.each(['plan', 'build', 'review'] as const)(
  'names the %s fallback with its catalog label in halt details and facts',
  (seat) => {
    const fallback = { tool: 'codex', model: 'gpt-6-luna' };
    const issue = buildSeatDownIssue({
      seat,
      runner: { kind: 'cli', tool: 'claude-code', model: 'opus' },
      classification: { class: 'account', cause: 'balance' },
      words: 'Insufficient Balance',
      phase: 'implementing',
      createdAt,
      seatSwap: {
        seat,
        currentTool: 'claude-code',
        fallback,
        detectedTools: [{ ...fallback, ready: true }],
        modelCache: makeModelCacheAccessor({
          providerModels: { codex: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] },
        }),
      },
    });
    expect(issue.details).toContain('fallback: OpenAI Codex CLI · GPT-6-Luna');
    expect(issue.facts?.fallback).toBe('OpenAI Codex CLI · GPT-6-Luna');
  },
);
