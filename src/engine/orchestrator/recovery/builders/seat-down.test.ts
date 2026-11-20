import { describe, expect, it } from 'vitest';
import { configuredReviewerRunner } from '../../../../core/config/accessors/reviewer-runner.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { formatRecoveryHeadline } from '../../../../core/recovery/headline.js';
import { haltOf } from '../../../../core/recovery/halt.js';
import { createdAt, expectValidRecoveryIssue } from '#testing/helpers/recovery-issue.js';
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

describe('buildSeatDownIssue', () => {
  // Captured live from `codex exec --json` on 2026-08-06.
  const codexLimit =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM.";
  const codexReset = new Date(2026, 7, 8, 15, 27);
  const codexRunner = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer;

  it('records the reset, keeps the tool words verbatim, and never suggests logging in', () => {
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner: codexRunner,
      classification: { class: 'rate-limited', resetAt: codexReset },
      words: codexLimit,
      task: makeTask({ id: 'T003' }),
      phase: 'implementing',
      attempts: 1,
      createdAt,
    });

    expect(issue.reason).toBe('runner-usage-limit');
    // The message is stored, so it names no clock; every surface spells `resetAt` when it is read.
    expect(issue.message).toBe(
      'OpenAI Codex CLI hit its usage limit. Wait for the limit to reset or change the BUILD tool, then continue.',
    );
    expect(issue.resetAt).toBe(codexReset.toISOString());
    expect(issue.details[0]).toBe(`OpenAI Codex CLI reported: ${codexLimit}`);
    expect(issue.details[1]).toBe('no fallback set');
    expect(issue.facts?.cause).toBe('rate-limit');
    expect(issue.facts?.resetsAt).toMatch(/^2026-08-08T/);
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'retry-later',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.recommendedAction).toBe('retry-later');
    expectValidRecoveryIssue(issue);
  });

  it('names the declared fallback and its model on the halt', () => {
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner: codexRunner,
      classification: { class: 'account', cause: 'balance' },
      words: 'provider.quota: Insufficient Balance',
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [],
        fallback: { tool: 'claude-code', model: 'sonnet' },
      },
      task: makeTask({ id: 'T003' }),
      phase: 'implementing',
      createdAt,
    });

    expect(issue.details[1]).toMatch(/^fallback: Claude Code CLI/);
  });

  it('names why a declared fallback is not offered', () => {
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner: codexRunner,
      classification: { class: 'account', cause: 'balance' },
      words: 'provider.quota: Insufficient Balance',
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [],
        fallback: { tool: 'claude-code' },
        fallbackBlockedReason: 'unauthenticated',
      },
      task: makeTask({ id: 'T003' }),
      phase: 'implementing',
      createdAt,
    });

    expect(issue.details[1]).toBe('fallback: Claude Code CLI · not offered: unauthenticated');
  });

  it('takes the automatic intent and headless identity from the context fallback', () => {
    const fallback = { tool: 'claude-code', model: 'sonnet' };
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner: codexRunner,
      classification: { class: 'account', cause: 'balance' },
      words: 'Insufficient Balance',
      phase: 'implementing',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        fallback,
        configRevision: 'revision',
        detectedTools: [{ ...fallback, ready: true }],
      },
    });
    expect(issue.switchSeat?.auto).toEqual({ candidate: fallback, configRevision: 'revision' });
    expect(issue.facts?.fallback).toBe('Claude Code CLI · Sonnet 5.5');
  });

  it('switches to the fallback at once on a usage limit whose reset is two minutes away', () => {
    const fallback = { tool: 'claude-code', model: 'sonnet' };
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner: codexRunner,
      classification: { class: 'rate-limited', resetAt: new Date(Date.now() + 120_000) },
      words: 'HTTP 429 (retry-after: 120)',
      phase: 'implementing',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        fallback,
        configRevision: 'revision',
        detectedTools: [{ ...fallback, ready: true }],
      },
    });
    expect(issue.switchSeat?.auto).toEqual({ candidate: fallback, configRevision: 'revision' });
  });

  it('names the automatic switch already used in this run and offers no automatic intent', () => {
    const fallback = { tool: 'claude-code' };
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner: codexRunner,
      classification: { class: 'account', cause: 'balance' },
      words: 'Insufficient Balance',
      phase: 'implementing',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        fallback,
        configRevision: 'revision',
        detectedTools: [{ ...fallback, ready: true }],
      },
      seatSwitches: [
        {
          seat: 'build',
          from: 'Claude Code CLI',
          to: 'Codex CLI',
          cause: 'runner-usage-limit',
          auto: true,
          configRevision: 'revision',
          ts: createdAt,
        },
      ],
    });
    expect(issue.details[1]).toBe(
      'fallback: Claude Code CLI · automatic switch already used in this run',
    );
    expect(issue.switchSeat?.auto).toBeUndefined();
  });

  it('names a fallback the seat runs now, including an automatic model', () => {
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner: codexRunner,
      classification: { class: 'account', cause: 'balance' },
      words: 'Insufficient Balance',
      phase: 'implementing',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        fallback: { tool: 'codex', model: 'auto' },
        detectedTools: [{ tool: 'codex', model: 'auto', ready: true }],
      },
    });
    expect(issue.details[1]).toBe('fallback: OpenAI Codex CLI · auto · the seat runs it now');
    expect(issue.switchSeat).toBeUndefined();
  });

  it('names an unreadable config of record without a fallback identity', () => {
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner: codexRunner,
      classification: { class: 'account', cause: 'balance' },
      words: 'Insufficient Balance',
      phase: 'implementing',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [],
        fallbackReadFailed: true,
      },
    });
    expect(issue.details[1]).toBe('fallback: not read · config.yaml does not load');
    expect(issue.facts?.fallback).toBeUndefined();
    expect(issue.switchSeat?.auto).toBeUndefined();
  });

  it("files a seat down halt's actions, dropping only the switch with no offer", () => {
    const base = {
      seat: 'build' as const,
      runner: codexRunner,
      classification: { class: 'rate-limited', resetAt: codexReset } as const,
      words: codexLimit,
      task: makeTask({ id: 'T003' }),
      phase: 'implementing' as const,
      createdAt,
    };
    const withOffer = buildSeatDownIssue({
      ...base,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'codex', ready: true },
          { tool: 'claude-code', ready: true },
        ],
      },
    });
    const withoutOffer = buildSeatDownIssue(base);

    expect(haltOf(withOffer.reason)).toBe('seat-down');
    expect(haltOf(withoutOffer.reason)).toBe('seat-down');
    expect(withOffer.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'retry-later',
      'skip-current-task',
      'end-run',
    ]);
    expect(withoutOffer.availableActions).toEqual([
      'retry-same-worker',
      'retry-later',
      'skip-current-task',
      'end-run',
    ]);
    expect(withOffer.recommendedAction).toBe('switch-seat');
    expect(withoutOffer.recommendedAction).toBe('retry-later');
    expectValidRecoveryIssue(withOffer);
    expectValidRecoveryIssue(withoutOffer);
  });

  it('offers the other detected ready tools as seats to switch to', () => {
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner: codexRunner,
      classification: { class: 'rate-limited', resetAt: codexReset },
      words: codexLimit,
      task: makeTask({ id: 'T003' }),
      phase: 'implementing',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'codex', ready: true },
          { tool: 'claude-code', model: 'sonnet', ready: true },
          { tool: 'opencode', ready: false },
        ],
      },
    });

    expect(issue.switchSeat).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code', model: 'sonnet' }],
    });
    expect(issue.details.join('\n')).not.toContain('claude-code');
    expect(issue.resetAt).toMatch(/^2026-08-08T/);
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'retry-later',
      'skip-current-task',
      'end-run',
    ]);
    expectValidRecoveryIssue(issue);
  });

  it('omits the seat switch when nothing else is detected ready', () => {
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner: codexRunner,
      classification: { class: 'rate-limited', resetAt: codexReset },
      words: codexLimit,
      task: makeTask({ id: 'T003' }),
      phase: 'implementing',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'codex', ready: true },
          { tool: 'opencode', ready: false },
        ],
      },
    });

    expect(issue.switchSeat).toBeUndefined();
    expect(issue.availableActions).not.toContain('switch-seat');
    expectValidRecoveryIssue(issue);
  });
});

describe('a seat whose account the provider refuses', () => {
  // Recorded on 2026-10-05: opencode on a spent DeepSeek account.
  const balance =
    'provider.quota: Insufficient Balance (request_id: 021cfcdf-894e-4f9c-8e1b-85ac99f6a0fe)';
  const runner = makeConfig({
    implementer: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
  }).implementer;
  const seatSwap = {
    seat: 'build' as const,
    currentTool: 'opencode',
    currentModel: 'deepseek/deepseek-flash',
    detectedTools: [
      { tool: 'opencode', ready: true },
      { tool: 'claude-code', model: 'sonnet', ready: true },
    ],
  };

  it('halts on the spent balance with the seat switch recommended and the provider words kept', () => {
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner,
      classification: { class: 'account', cause: 'balance' },
      words: balance,
      task: makeTask({ id: 'T001' }),
      phase: 'implementing',
      attempts: 1,
      seatSwap,
      createdAt,
    });

    expect(issue.reason).toBe('runner-usage-limit');
    expect(issue.resetAt).toBeUndefined();
    expect(issue.facts?.cause).toBe('balance');
    expect(issue.message).toBe(
      'Balance spent on deepseek (OpenCode CLI). Add credit or change the BUILD tool, then continue.',
    );
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.switchSeat).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code', model: 'sonnet' }],
    });
    expect(issue.details).toContain(`OpenCode CLI reported: ${balance}`);
    expectValidRecoveryIssue(issue);
  });

  it.each([
    [
      'balance',
      'build',
      'Balance spent on deepseek (OpenCode CLI). Add credit or change the BUILD tool, then continue.',
    ],
    [
      'billing',
      'plan',
      'Account issue with deepseek (OpenCode CLI). Check your account settings or change the PLAN tool, then continue.',
    ],
    [
      'quota',
      'review',
      'Quota spent on deepseek (OpenCode CLI). Wait for the quota to renew or change the REVIEW tool, then continue.',
    ],
  ] as const)(
    'gives %s advice for the %s seat with the panel headline as its lead',
    (cause, seat, message) => {
      const issue = buildSeatDownIssue({
        seat,
        runner,
        classification: { class: 'account', cause },
        words: balance,
        phase: 'implementing',
        createdAt,
      });

      expect(issue.message).toBe(message);
      expect(issue.message.startsWith(`${formatRecoveryHeadline(issue)}.`)).toBe(true);
    },
  );

  it('keeps the selected profile on the issue without writing a Worker profile detail', () => {
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner,
      classification: { class: 'account', cause: 'balance' },
      words: balance,
      task: makeTask({ id: 'T001' }),
      phase: 'implementing',
      attempts: 1,
      selectedImplementerProfile: 'default',
      seatSwap,
      createdAt,
    });

    expect(issue.selectedImplementerProfile).toBe('default');
    expect(issue.details.some((detail) => detail.startsWith('Worker profile:'))).toBe(false);
  });

  it('recommends the seat switch beside the login when the account is signed out', () => {
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner,
      classification: { class: 'account', cause: 'auth' },
      words: 'HTTP 403 Forbidden',
      task: makeTask({ id: 'T001' }),
      phase: 'implementing',
      attempts: 1,
      seatSwap,
      createdAt,
    });

    expect(issue.reason).toBe('runner-unauthenticated');
    expect(issue.message).toBe(
      'Signed out of deepseek (OpenCode CLI). Run `opencode auth login deepseek` in a separate terminal, then retry.',
    );
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.switchSeat).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code', model: 'sonnet' }],
    });
    expect(issue.details).toContain('OpenCode CLI reported: HTTP 403 Forbidden');
    expectValidRecoveryIssue(issue);
  });
});

describe('a seat whose plan does not include the model', () => {
  const cursorRunner = configuredReviewerRunner(
    makeConfig({ reviewer: { kind: 'cli', tool: 'cursor', model: 'claude-haiku-5.5' } }),
  );
  const copilotRunner = makeConfig({ implementer: { kind: 'cli', tool: 'copilot' } }).implementer;

  it.each([
    ['cursor', 'review', 'REVIEW', cursorRunner],
    ['copilot', 'build', 'BUILD', copilotRunner],
  ] as const)(
    'halts %s on the %s seat with the access advice, its words kept and the fallback taken',
    (tool, seat, seatLabel, runner) => {
      if (runner === undefined) throw new Error('the config has no runner for this seat');
      const fallback = { tool: 'claude-code', model: 'sonnet' };
      const issue = buildSeatDownIssue({
        seat,
        runner,
        classification: { class: 'account', cause: 'access' },
        words: 'Error: Access denied by policy settings',
        phase: seat === 'review' ? 'final-review' : 'implementing',
        seatSwap: {
          seat,
          currentTool: tool,
          fallback,
          configRevision: 'revision',
          detectedTools: [{ ...fallback, ready: true }],
        },
        createdAt,
      });

      const holder = issue.facts?.tool;
      expect(issue.reason).toBe('runner-usage-limit');
      expect(issue.facts?.cause).toBe('access');
      expect(formatRecoveryHeadline(issue)).toBe(`Access refused by ${holder}`);
      expect(issue.message).toBe(
        `Access refused by ${holder}. Check what the ${holder} account allows, or change the ${seatLabel} tool, then continue.`,
      );
      expect(issue.message).not.toMatch(/balance|credit|quota|usage limit/i);
      expect(issue.details[0]).toMatch(/reported: Error: Access denied by policy settings$/);
      expect(issue.switchSeat?.auto).toEqual({ candidate: fallback, configRevision: 'revision' });
      expect(issue.recommendedAction).toBe('switch-seat');
      expectValidRecoveryIssue(issue);
    },
  );
});
