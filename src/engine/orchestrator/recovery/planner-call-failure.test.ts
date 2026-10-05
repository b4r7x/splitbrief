import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { defaultCliAuthChannel, type CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import { error } from '../../../utils/error.js';
import { streamError } from '../../streaming/stream-errors.js';
import { diagnosePlannerCallFailure } from './planner-call-failure.js';

function cliSeat(tool: CliToolId) {
  return { kind: 'cli', tool, authChannel: defaultCliAuthChannel(tool).id } as const;
}

/** A planner-tier call that failed with the tool's own words, as `requireCompletedCall` throws it. */
function failedCall(words: string): unknown {
  return error('runner-call-failed', 'Planner review call failed', {
    status: 'failed',
    error: { code: 'turn-failed', message: words },
  });
}

function diagnose(tool: CliToolId, words: string) {
  return diagnosePlannerCallFailure({
    err: failedCall(words),
    label: 'Final review failed',
    runner: cliSeat(tool),
    seat: 'plan',
  });
}

describe('diagnosePlannerCallFailure', () => {
  // A relative reset is read against the clock the halt is raised on.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 8, 29, 10, 0) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The message is stored, so it names no clock: the row spells `resetsAt` when it is read.
  it("reads a codex reset into resetsAt and drops it from the tool's own words", () => {
    const words =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 1:02 PM.";

    const diagnosis = diagnose('codex', words);

    expect(diagnosis.failure).toBe('usage-limit');
    expect(diagnosis.resetsAt).toEqual(new Date(2026, 9, 3, 13, 2));
    expect(diagnosis.message).toBe(
      "Final review failed: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits. OpenAI Codex CLI hit its usage limit. Wait for the limit to reset or change the PLAN tool, then continue.",
    );
    // The details are the tool's words as it said them; the panel drops the clause when it renders.
    expect(diagnosis.details).toEqual([`OpenAI Codex CLI reported: ${words}`]);
  });

  it("drops Claude Code's clock and antigravity's countdown from their words", () => {
    const claude = diagnose('claude-code', "You've hit your session limit · resets 3:45pm");
    const agy = diagnose(
      'antigravity',
      'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s. (response may be truncated)',
    );

    expect(claude.resetsAt).toEqual(new Date(2026, 8, 29, 15, 45));
    expect(claude.message).toBe(
      "Final review failed: You've hit your session limit. Claude Code CLI hit its usage limit. Wait for the limit to reset or change the PLAN tool, then continue.",
    );
    expect(agy.resetsAt).toEqual(new Date(2026, 8, 29, 12, 6, 30));
    expect(agy.message).toContain('increase your limits. (response may be truncated).');
    expect(agy.message).not.toContain('Resets in');
  });

  it("keeps the tool's words whole when they name no reset", () => {
    const diagnosis = diagnose('codex', "You've hit your usage limit.");

    expect(diagnosis.resetsAt).toBeNull();
    expect(diagnosis.message).toBe(
      "Final review failed: You've hit your usage limit. OpenAI Codex CLI hit its usage limit. Wait for the limit to reset or change the PLAN tool, then continue.",
    );
  });
});

describe('diagnosePlannerCallFailure on an API seat', () => {
  // An OpenAI account configured the way a custom endpoint is.
  const apiSeat = makeConfig({
    planner: {
      kind: 'api',
      provider: 'openai-account',
      service: 'openai-account',
      offering: 'payg',
      apiBase: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-5',
    },
  }).planner;

  // The provider's error arrives under a rewritten hint that gives advice of its own; the halt
  // gives the one piece of advice the menu backs, so it starts from the provider's words.
  it.each([
    [
      429,
      '429 You exceeded your current quota, please check your plan and billing details.',
      'Wait for the limit to reset or change the PLAN tool, then continue.',
    ],
    [
      401,
      'Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys.',
      'API key, then retry.',
    ],
  ])(
    'starts a %i from the provider words and gives one piece of advice',
    (status, body, advice) => {
      const diagnosis = diagnosePlannerCallFailure({
        err: streamError.httpStatus('openai', status, body),
        label: 'Planning failed',
        runner: apiSeat,
        seat: 'plan',
      });

      expect(diagnosis.message.startsWith(`Planning failed: ${body}`)).toBe(true);
      expect(diagnosis.message).toContain(advice);
      expect(diagnosis.message).not.toContain('PROVIDER_API_KEY');
      expect(diagnosis.message).not.toContain('switch the seat');
    },
  );

  it.each([
    [402, '{"error":{"message":"Account on hold"}}', 'usage-limit'],
    [403, 'Access denied', 'unauthenticated'],
  ] as const)('halts a thrown %i on the seat with the provider words', (status, body, failure) => {
    const diagnosis = diagnosePlannerCallFailure({
      err: streamError.httpStatus('deepseek', status, body),
      label: 'Planning failed',
      runner: apiSeat,
      seat: 'plan',
    });

    expect(diagnosis.failure).toBe(failure);
    expect(diagnosis.message).toContain(body);
  });
});
