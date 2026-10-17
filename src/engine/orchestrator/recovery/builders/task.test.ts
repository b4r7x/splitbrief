import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import { formatRecoveryHeadline } from '../../../../core/recovery/headline.js';
import { haltOf } from '../../../../core/recovery/halt.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import {
  buildApprovalDeniedRecoveryIssue,
  buildCheckoutChangedRecoveryIssue,
  buildContextOverflowRecoveryIssue,
  buildDependencyBlockedRecoveryIssue,
  buildImplementerUnavailableRecoveryIssue,
  buildLeftIsolationRecoveryIssue,
  buildMissingModelRecoveryIssue,
  buildRecipeInvalidRecoveryIssue,
  buildRepeatedTimeoutRecoveryIssue,
  buildRetryExhaustedRecoveryIssue,
  buildReviewFailedRecoveryIssue,
  buildRunnerInputTooLargeRecoveryIssue,
  buildSeatDownIssue,
  runnerDefectRow,
  buildSnapshotFailedRecoveryIssue,
  recoveryBuilderForRunnerOutcome,
  runnerHaltRow,
  switchSeatOffer,
} from './task.js';

const createdAt = '2026-04-28T12:00:00.000Z';

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

describe('runnerHaltRow', () => {
  it.each(['plan', 'build', 'review'] as const)(
    'publishes only the cause for an automatic %s fallback, while keeping panel advice',
    (seat) => {
      const candidate = { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' };
      const issue = buildSeatDownIssue({
        seat,
        runner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        classification: { class: 'account', cause: 'balance' },
        words: 'provider.quota: Insufficient Balance (request_id: smoke-request)',
        phase: 'implementing',
        seatSwap: {
          seat,
          currentTool: 'opencode',
          currentModel: 'deepseek/deepseek-flash',
          fallback: candidate,
          configRevision: 'revision',
          detectedTools: [{ ...candidate, ready: true }],
        },
        createdAt,
      });

      expect(issue.switchSeat?.auto).toBeDefined();
      expect(runnerHaltRow(issue, 'OpenCode CLI', 'provider.quota: Insufficient Balance')).toBe(
        'Balance spent on deepseek (OpenCode CLI)',
      );
      expect(issue.message).toContain('Balance spent on deepseek (OpenCode CLI). Add credit');
      expect(issue.details[0]).toMatch(/^OpenCode CLI reported: /);
      expect(issue.details.join('\n')).toContain('request_id: smoke-request');
      // The row attributes the tool's words the way the panel does.
      expect(runnerHaltRow({ ...issue, switchSeat: undefined }, 'OpenCode CLI', 'raw words')).toBe(
        `${issue.message} (OpenCode CLI reported: raw words)`,
      );
    },
  );
});

function expectValidRecoveryIssue(issue: unknown): void {
  const result = RecoveryIssueSchema.safeParse(issue);
  expect(result.success).toBe(true);
}

function overflowRoutingDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    taskId: makeTask().id,
    requiredWriteMode: 'extracted-code',
    fit: 'overflow',
    estimatedTokens: 45_000,
    untruncatedEstimatedTokens: 48_000,
    contextLength: 32_768,
    currentCodeTruncated: false,
    currentCodeContextMode: 'whole-file',
    reason: 'No capable implementer profile can fit this task prompt',
    rejected: [
      {
        profile: 'local-qwen',
        profileWriteMode: 'extracted-code',
        requiredWriteMode: 'extracted-code',
        reason: 'Estimated 45000 tokens overflows 32768-token context',
        fit: 'overflow',
        estimatedTokens: 45_000,
        untruncatedEstimatedTokens: 48_000,
        contextLength: 32_768,
        currentCodeTruncated: false,
        currentCodeContextMode: 'whole-file',
      },
    ],
    ...overrides,
  };
}

describe('buildRetryExhaustedRecoveryIssue', () => {
  it('offers skip and end without the retry by default, and recommends skip', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'lint failed after all attempts',
      attempts: 3,
      maxAttempts: 3,
    });

    expect(issue.reason).toBe('retry-exhausted');
    expect(issue.phase).toBe('escalating');
    expect(issue.availableActions).toEqual(['skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('skip-current-task');
    expectValidRecoveryIssue(issue);
  });

  it('offers retry only when allowRetryOverride is explicit', () => {
    const override = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'lint failed after all attempts',
      attempts: 3,
      maxAttempts: 3,
      allowRetryOverride: true,
    });
    expect(override.availableActions).toEqual([
      'retry-same-worker',
      'skip-current-task',
      'end-run',
    ]);
    expect(override.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(override);
  });

  const bothVoices = {
    task: makeTask({ id: 'T012' }),
    createdAt,
    validationSummary: 'tsc failed',
    attempts: 4,
    maxAttempts: 3,
    allowRetryOverride: true,
  };

  it('quotes the implementer hand-back', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      handBack: 'I could not find the prop.',
    });

    expect(issue.details).toContain('Attempts: 4');
    expect(issue.details).toContain('Implementer said: I could not find the prop.');
    expectValidRecoveryIssue(issue);
  });

  it('adds no hand-back row when the implementer did not speak', () => {
    const issue = buildRetryExhaustedRecoveryIssue(bothVoices);

    expect(issue.details.some((row) => row.startsWith('Implementer said:'))).toBe(false);
  });

  it('states a bare count over the max attempts', () => {
    const issue = buildRetryExhaustedRecoveryIssue(bothVoices);

    expect(issue.details).toContain('Attempts: 4');
    expect(issue.details.some((row) => row.includes('4/3'))).toBe(false);
  });

  it('names the last error and drops any Validation detail', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'tsc failed',
      attempts: 4,
      maxAttempts: 3,
    });

    expect(issue.details[0]).toBe('Last error: tsc failed');
    expect(issue.details.some((row) => row.startsWith('Validation'))).toBe(false);
  });

  it('bounds a long hand-back row to the summary length', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      handBack: 'x'.repeat(2000),
    });
    const row = issue.details.find((detail) => detail.startsWith('Implementer said:'));

    expect(row).toBe(`Implementer said: …${'x'.repeat(300)}`);
  });

  it('quotes the tail of a long hand-back where an implementer that stopped says why', () => {
    const tail = 'May I edit src/consumer.ts?';
    const handBack = `${'x'.repeat(2000 - tail.length)}${tail}`;
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      handBack,
    });
    const row = issue.details.find((detail) => detail.startsWith('Implementer said:'));

    expect(row?.startsWith('Implementer said: …')).toBe(true);
    expect(row?.endsWith(tail)).toBe(true);
    expect(row?.length).toBeLessThanOrEqual(320);
  });

  it('omits attempts row at zero attempts and formats other attempt counts', () => {
    const zeroAttempts = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      attempts: 0,
      maxAttempts: 3,
    });
    expect(zeroAttempts.details.some((row) => row.startsWith('Attempts'))).toBe(false);

    const one = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      attempts: 1,
    });
    expect(one.details).toContain('Attempts: 1/3');

    const five = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      attempts: 5,
      maxAttempts: 3,
    });
    expect(five.details).toContain('Attempts: 5');
  });

  it('defaults to task failed when neither verdict nor hook reason is set', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
    });
    expect(issue.message).toBe('T012 failed');
  });

  it('sets message and fact when escalationBlockedBy is provided', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      escalationBlockedBy: 'policy',
    });
    expect(issue.message).toBe('T012 escalation blocked by pre_escalation hook: policy');
    expect(issue.facts?.escalationBlockedBy).toBe('policy');
    expect(formatRecoveryHeadline(issue)).toBe(issue.message);
  });
});

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
      maxAttempts: 3,
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

describe('an OpenCode route refusal (provider.no-route)', () => {
  // Recorded on 2026-10-17: opencode with no Ollama Cloud credential. A misspelled model or an
  // unavailable variant prints the same refusal, so only the tool's own credential listing tells
  // a sign-out from a model the seat cannot run.
  const route = 'ollama-cloud/deepseek-v4.1-flash';
  const noRoute = `provider.no-route: Model unavailable: ${route}`;
  const runner = makeConfig({
    implementer: { kind: 'cli', tool: 'opencode', model: route },
  }).implementer;
  const fallback = { tool: 'claude-code', model: 'sonnet' } as const;
  const seatSwap = (providers: readonly string[]) => ({
    seat: 'build' as const,
    currentTool: 'opencode',
    currentModel: route,
    detectedTools: [
      { tool: 'opencode', ready: true },
      { ...fallback, ready: true },
    ],
    fallback,
    configRevision: 'revision',
    routeAuth: providers.includes('Ollama Cloud')
      ? { kind: 'configured' as const, source: 'api' as const }
      : { kind: 'needs-sign-in' as const, tool: 'opencode' as const, provider: 'ollama-cloud' },
  });

  it('on a route with no credential, halts as Seat down with the sign-in step and the fallback move', () => {
    const issue = buildMissingModelRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      phase: 'implementing',
      runner,
      toolMessage: noRoute,
      seatSwap: seatSwap(['OpenCode Go']),
      createdAt,
    });

    expect(issue.reason).toBe('runner-unauthenticated');
    expect(haltOf(issue.reason)).toBe('seat-down');
    // Doctor's sentence, so the halt and `splitbrief doctor` name the cause the same way.
    expect(issue.message).toBe(
      'OpenCode CLI has no credential for ollama-cloud. Run `opencode auth login ollama-cloud` in a separate terminal, then retry.',
    );
    expect(formatRecoveryHeadline(issue)).toBe('OpenCode CLI has no credential for ollama-cloud');
    expect(issue.facts).toMatchObject({ tool: 'OpenCode CLI', provider: 'ollama-cloud' });
    expect(issue.details).toContain(`OpenCode CLI reported: ${noRoute}`);
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.switchSeat?.auto).toEqual({ candidate: fallback, configRevision: 'revision' });
    // The seat moves by itself, so the row names the halt and never asks for the sign-in.
    expect(runnerDefectRow(issue, 'OpenCode CLI', noRoute)).toBe(
      'OpenCode CLI has no credential for ollama-cloud',
    );
    expectValidRecoveryIssue(issue);
  });

  it("names the tool's own gateway by the id its sign-in command takes", () => {
    const gateway = 'opencode/big-pickle';
    const issue = buildMissingModelRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      phase: 'implementing',
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'opencode', model: gateway } })
        .implementer,
      toolMessage: `provider.no-route: Model unavailable: ${gateway}`,
      seatSwap: {
        seat: 'build',
        currentTool: 'opencode',
        currentModel: gateway,
        detectedTools: [{ tool: 'claude-code', ready: true }],
        routeAuth: { kind: 'needs-sign-in', tool: 'opencode', provider: 'opencode' },
      },
      createdAt,
    });

    expect(issue.message).toBe(
      'OpenCode CLI has no credential for opencode. Run `opencode auth login opencode` in a separate terminal, then retry.',
    );
    expect(formatRecoveryHeadline(issue)).toBe('OpenCode CLI has no credential for opencode');
    expect(issue.facts).toMatchObject({ tool: 'OpenCode CLI', provider: 'opencode' });
    expect(runnerDefectRow(issue, 'OpenCode CLI', 'provider.no-route')).toBe(
      `${issue.message} (OpenCode CLI reported: provider.no-route)`,
    );
  });

  it('on a route that has a credential, halts as a model the tool does not list, with no move and no sign-in', () => {
    const issue = buildMissingModelRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      phase: 'implementing',
      runner,
      toolMessage: noRoute,
      seatSwap: seatSwap(['OpenCode Go', 'Ollama Cloud']),
      createdAt,
    });

    expect(issue.reason).toBe('implementer-recipe-invalid');
    expect(issue.message).toBe(`Model ${route} is not listed by OpenCode CLI; pick a listed model`);
    expect(issue.message).not.toMatch(/sign|auth login/i);
    expect(runnerDefectRow(issue, 'OpenCode CLI', noRoute)).toBe(issue.message);
    expect(issue.switchSeat?.auto).toBeUndefined();
    // The seat's own tool is offered without a model: taking it opens the picker on that tool.
    expect(issue.switchSeat?.candidates).toEqual([fallback, { tool: 'opencode' }]);
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.details).toContain(`OpenCode CLI reported: ${noRoute}`);
    // A model refusal is named as one, never as a command line the tool rejected.
    expect(formatRecoveryHeadline(issue)).toBe('Model not listed by OpenCode CLI');
    expect(issue.details).toContain(
      'The run stopped instead of spending retries on a model the tool refuses.',
    );
    expect(issue.details.join('\n')).not.toMatch(/command/);
    expectValidRecoveryIssue(issue);
  });

  it('with no credential listing read, names both causes and moves nothing', () => {
    const issue = buildMissingModelRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      phase: 'implementing',
      runner,
      toolMessage: noRoute,
      seatSwap: { ...seatSwap([]), routeAuth: { kind: 'unknown', reason: 'exit-failure' } },
      createdAt,
    });

    expect(issue.reason).toBe('implementer-recipe-invalid');
    expect(issue.message).toBe(
      `OpenCode CLI cannot use ${route}: sign in with \`opencode auth login ollama-cloud\` if ollama-cloud has no credential, or pick a listed model`,
    );
    expect(issue.switchSeat?.auto).toBeUndefined();
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(formatRecoveryHeadline(issue)).toBe('Model refused by OpenCode CLI');
    expect(issue.details.join('\n')).not.toMatch(/command/);
  });

  it("on a machine with only the seat's own tool, offers that tool to pick a listed model", () => {
    const issue = buildMissingModelRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      phase: 'implementing',
      runner,
      toolMessage: noRoute,
      seatSwap: {
        seat: 'build',
        currentTool: 'opencode',
        currentModel: route,
        detectedTools: [{ tool: 'opencode', ready: true }],
        routeAuth: { kind: 'configured', source: 'listed' },
      },
      createdAt,
    });

    expect(issue.switchSeat).toEqual({ seat: 'build', candidates: [{ tool: 'opencode' }] });
    expect(issue.recommendedAction).toBe('switch-seat');
    expectValidRecoveryIssue(issue);
  });

  it('moves the seat automatically at most once per run', () => {
    const issue = buildMissingModelRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      phase: 'implementing',
      runner,
      toolMessage: noRoute,
      seatSwap: seatSwap(['OpenCode Go']),
      seatSwitches: [
        {
          seat: 'build',
          from: 'OpenCode CLI · ollama-cloud/deepseek-v4.1-flash',
          to: 'Claude Code CLI · sonnet',
          cause: 'runner-unauthenticated',
          auto: true,
          configRevision: 'revision',
          ts: createdAt,
        },
      ],
      createdAt,
    });

    expect(issue.reason).toBe('runner-unauthenticated');
    expect(issue.switchSeat?.auto).toBeUndefined();
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
      maxAttempts: 1,
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
      "Billing refused by deepseek (OpenCode CLI). Fix the account's billing or change the PLAN tool, then continue.",
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
      maxAttempts: 1,
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
      maxAttempts: 1,
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

describe('switchSeatOffer', () => {
  it('offers only tools the seat can host', () => {
    expect(
      switchSeatOffer({
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'a-tool-no-seat-hosts', ready: true },
          { tool: 'claude-code', ready: true },
        ],
      }),
    ).toEqual({ seat: 'build', candidates: [{ tool: 'claude-code' }] });
  });

  it('offers nothing when no ready tool can host the seat', () => {
    expect(
      switchSeatOffer({
        seat: 'plan',
        currentTool: 'codex',
        detectedTools: [{ tool: 'a-tool-no-seat-hosts', ready: true }],
      }),
    ).toBeUndefined();
  });

  it('offers a fallback on the same tool and another model, not the tool alone', () => {
    expect(
      switchSeatOffer({
        seat: 'build',
        currentTool: 'codex',
        currentModel: 'gpt-5',
        detectedTools: [
          { tool: 'codex', ready: true },
          { tool: 'codex', model: 'gpt-5', ready: true },
          { tool: 'codex', model: 'gpt-5-mini', effort: 'high', ready: true },
        ],
      }),
    ).toEqual({
      seat: 'build',
      candidates: [{ tool: 'codex', model: 'gpt-5-mini', effort: 'high' }],
    });
  });

  it("passes a candidate's variant through", () => {
    expect(
      switchSeatOffer({
        seat: 'plan',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'claude-code', model: 'opus', effort: 'xhigh', variant: 'xhigh', ready: true },
        ],
      }),
    ).toEqual({
      seat: 'plan',
      candidates: [{ tool: 'claude-code', model: 'opus', effort: 'xhigh', variant: 'xhigh' }],
    });
  });
});

describe('buildContextOverflowRecoveryIssue', () => {
  it('offers a retry, skip or end and recommends the retry', () => {
    const task = makeTask({ id: 'T013', suggestedFiles: ['src/large.ts'] });

    const issue = buildContextOverflowRecoveryIssue({
      task,
      createdAt,
      routingDecision: overflowRoutingDecision({ taskId: task.id }),
    });

    expect(issue.reason).toBe('context-overflow');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.facts).toMatchObject({ estimatedTokens: 45_000, contextLength: 32_768 });
    expectValidRecoveryIssue(issue);
  });
});

describe('buildImplementerUnavailableRecoveryIssue', () => {
  it('offers a retry, skip or end and recommends the retry', () => {
    const issue = buildImplementerUnavailableRecoveryIssue({
      task: makeTask({ id: 'T014' }),
      createdAt,
      tool: 'codex',
      availabilityReason: 'not installed',
    });

    expect(issue.reason).toBe('implementation-error');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildDependencyBlockedRecoveryIssue', () => {
  it('builds dependency-blocked issues with affected tasks and safe actions', () => {
    const dependency = makeTask({ id: 'T018', suggestedFiles: ['src/base.ts'], status: 'failed' });
    const task = makeTask({
      id: 'T019',
      suggestedFiles: ['src/followup.ts'],
      dependsOn: ['T018'],
    });

    const issue = buildDependencyBlockedRecoveryIssue({
      createdAt,
      task,
      blockedByTasks: [dependency],
    });

    expect(issue.reason).toBe('dependency-blocked');
    expect(issue.files).toEqual(['src/base.ts', 'src/followup.ts']);
    expect(issue.affectedTaskIds).toEqual([dependency.id, task.id]);
    expect(issue.details).toEqual(['Blocked dependencies: T018 (failed)']);
    expect(issue.availableActions).toEqual(['skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('skip-current-task');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildRecipeInvalidRecoveryIssue', () => {
  it('names the tool that refused the command line and offers a retry or end', () => {
    const issue = buildRecipeInvalidRecoveryIssue({
      task: makeTask({ id: 'T022' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: "error: unknown option '--nope'",
      createdAt,
    });

    expect(issue.reason).toBe('implementer-recipe-invalid');
    expect(issue.message).toContain('rejected the command');
    expect(issue.details.join('\n')).toContain("unknown option '--nope'");
    expect(formatRecoveryHeadline(issue)).toBe('Tool recipe rejected by OpenAI Codex CLI');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildLeftIsolationRecoveryIssue', () => {
  const runner = makeConfig({ implementer: { kind: 'cli', tool: 'antigravity' } }).implementer;
  const toolMessage = 'searched ~ with run_command: find ~ -name "process-invoke.ts" 2>/dev/null';

  it('halts the brief on the evidence and recommends a retry', () => {
    const issue = buildLeftIsolationRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner,
      toolMessage,
      attempts: 0,
      maxAttempts: 2,
      createdAt,
    });

    expect(issue.reason).toBe('implementer-left-isolation');
    expect(issue.seat).toBe('build');
    expect(issue.message).toBe(
      `T004 left the isolation directory · Google Antigravity CLI ${toolMessage}`,
    );
    expect(issue.details).toEqual([
      `Google Antigravity CLI ${toolMessage}`,
      "Your checkout gets the run's changes only through Apply.",
    ]);
    expect(issue.attempts).toBeUndefined();
    expect(issue.facts).toEqual({ tool: 'Google Antigravity CLI' });
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });

  it('offers the seat switch when another ready tool was detected', () => {
    const issue = buildLeftIsolationRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner,
      toolMessage,
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'antigravity',
        detectedTools: [{ tool: 'codex', ready: true }],
      },
    });

    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.switchSeat).toEqual({ seat: 'build', candidates: [{ tool: 'codex' }] });
    expectValidRecoveryIssue(issue);
  });
});

describe('isolation halts of a call that ran in the checkout itself', () => {
  const runner = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } }).implementer;
  const inPlace = { revertedDir: '.splitbrief/sessions/s1/reverted' };

  it('says the attempt was put back and where the replaced bytes are, never promoted', () => {
    const left = buildLeftIsolationRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner,
      toolMessage: 'wrote to ~/x with Bash: touch ~/x',
      attempts: 0,
      maxAttempts: 2,
      inPlace,
      createdAt,
    });
    const changed = buildCheckoutChangedRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner,
      toolMessage: 'branch topic',
      attempts: 0,
      maxAttempts: 2,
      inPlace,
      createdAt,
    });

    expect(left.details[1]).toBe(
      'SPLITBRIEF put back what this attempt changed in your checkout; the bytes it replaced are in .splitbrief/sessions/s1/reverted.',
    );
    expect(changed.details[1]).toBe(
      'SPLITBRIEF put back the files this attempt changed in your checkout (the bytes it replaced are in .splitbrief/sessions/s1/reverted); the git change stays for you to check.',
    );
    for (const issue of [left, changed]) {
      expect(issue.details.join(' ')).not.toContain('promoted');
      expectValidRecoveryIssue(issue);
    }
  });
});

describe('buildCheckoutChangedRecoveryIssue', () => {
  const runner = makeConfig({ implementer: { kind: 'cli', tool: 'antigravity' } }).implementer;

  it('names what changed without blaming the implementer, and recommends a retry', () => {
    const issue = buildCheckoutChangedRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      runner,
      toolMessage: 'branch escaped · hook pre-commit',
      attempts: 0,
      maxAttempts: 2,
      createdAt,
    });

    expect(issue.reason).toBe('checkout-changed');
    expect(issue.seat).toBe('build');
    expect(issue.message).toBe('Repository changed under T001 · branch escaped · hook pre-commit');
    expect(issue.details).toEqual([
      'Changed while Google Antigravity CLI ran; the audit cannot tell who made the change.',
      "Your checkout gets the run's changes only through Apply, and nothing in your checkout was reverted.",
    ]);
    expect(issue.attempts).toBeUndefined();
    expect(issue.facts).toEqual({
      tool: 'Google Antigravity CLI',
      changes: 'branch escaped · hook pre-commit',
    });
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.switchSeat).toBeUndefined();
    expectValidRecoveryIssue(issue);
  });

  // In a real run, another session created a worktree on a new branch during T004's call. The
  // checkout's HEAD, branch and files stayed as they were, and final-group.ts is only T004's file.
  it('names the branch another session created, not the brief file, in its headline', () => {
    const issue = buildCheckoutChangedRecoveryIssue({
      task: makeTask({
        id: 'T004',
        suggestedFiles: ['src/engine/runners/cli-tools/final-group.ts'],
      }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } }).implementer,
      toolMessage: 'branch fix/implementer-never-runs-gates',
      attempts: 0,
      maxAttempts: 2,
      createdAt,
    });

    expect(formatRecoveryHeadline(issue)).toBe(
      'Repository changed under T004 · branch fix/implementer-never-runs-gates',
    );
    // The Error row and the recovery headline are one sentence with one separator (UI debt #55).
    expect(issue.message).toBe(formatRecoveryHeadline(issue));
    expect(issue.files).toEqual([]);
    expect(issue.details.join(' ')).not.toContain('final-group.ts');
    expectValidRecoveryIssue(issue);
  });

  it('offers no seat switch even when another ready tool was detected', () => {
    const issue = buildCheckoutChangedRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      runner,
      toolMessage: 'branch escaped',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'antigravity',
        detectedTools: [{ tool: 'codex', ready: true }],
      },
    });

    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.switchSeat).toBeUndefined();
  });
});

describe('buildMissingModelRecoveryIssue', () => {
  it('names the unlisted model and the tool that does not list it', () => {
    const issue = buildMissingModelRecoveryIssue({
      task: makeTask({ id: 'T023' }),
      runner: makeConfig({
        implementer: { kind: 'cli', tool: 'codex', model: 'gpt-nope' },
      }).implementer,
      toolMessage: 'model not found: gpt-nope',
      createdAt,
    });

    expect(issue.reason).toBe('implementer-recipe-invalid');
    expect(issue.message).toBe(
      'Model gpt-nope is not listed by OpenAI Codex CLI; pick a listed model',
    );
    expect(issue.facts?.model).toBe('gpt-nope');
    expectValidRecoveryIssue(issue);
  });

  it('a recipe-invalid halt offers the seat switch', () => {
    const issue = buildMissingModelRecoveryIssue({
      task: makeTask({ id: 'T023' }),
      runner: makeConfig({
        implementer: { kind: 'cli', tool: 'codex', model: 'gpt-nope' },
      }).implementer,
      toolMessage: 'model not found: gpt-nope',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'codex', ready: true },
          { tool: 'claude-code', model: 'sonnet', ready: true },
        ],
      },
    });

    expect(issue.message).toContain('pick a listed model');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'switch-seat', 'end-run']);
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.switchSeat).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code', model: 'sonnet' }, { tool: 'codex' }],
    });
    expectValidRecoveryIssue(issue);
  });
});

describe('buildRepeatedTimeoutRecoveryIssue', () => {
  it('reports the repeated timeout and recommends the retry when no other tool is ready', () => {
    const issue = buildRepeatedTimeoutRecoveryIssue({
      task: makeTask({ id: 'T024' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: 'implementer timed out',
      attempts: 2,
      maxAttempts: 3,
      createdAt,
    });

    expect(issue.reason).toBe('runner-timeout-repeated');
    expect(issue.message).toContain('timed out twice in a row on T024');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });

  it('offers and recommends the seat switch when another ready tool exists', () => {
    const issue = buildRepeatedTimeoutRecoveryIssue({
      task: makeTask({ id: 'T024' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: 'implementer timed out',
      attempts: 2,
      maxAttempts: 3,
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [{ tool: 'claude-code', ready: true }],
      },
    });

    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.switchSeat).toEqual({ seat: 'build', candidates: [{ tool: 'claude-code' }] });
    expectValidRecoveryIssue(issue);
  });
});

describe('buildApprovalDeniedRecoveryIssue', () => {
  it('carries the denied files and the denial reason', () => {
    const issue = buildApprovalDeniedRecoveryIssue({
      task: makeTask({ id: 'T025', suggestedFiles: ['src/main.ts'] }),
      createdAt,
      deniedFiles: ['src/secret.ts'],
      denialReason: 'operator denied',
    });

    expect(issue.reason).toBe('approval-denied');
    expect(issue.files).toEqual(['src/secret.ts']);
    expect(issue.details.join('\n')).toContain('Denied: operator denied');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildSnapshotFailedRecoveryIssue', () => {
  it('explains that scope cannot be enforced and offers the retry', () => {
    const issue = buildSnapshotFailedRecoveryIssue({
      task: makeTask({ id: 'T026' }),
      createdAt,
      detail: 'git status failed: not a repository',
    });

    expect(issue.reason).toBe('snapshot-failed');
    expect(issue.details).toEqual([
      'git status failed: not a repository',
      'Scope and revert cannot be enforced without the snapshot.',
    ]);
    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildReviewFailedRecoveryIssue', () => {
  it('counts the blocking findings and offers a correction or the end, recommending the correction', () => {
    const issue = buildReviewFailedRecoveryIssue({
      createdAt,
      blocking: 3,
      detail: 'Critical: missing test for the new route',
    });

    expect(issue.reason).toBe('review-failed');
    expect(issue.phase).toBe('final-review');
    expect(issue.message).toBe('Final review failed with 3 blocking findings');
    expect(issue.availableActions).toEqual(['revise', 'end-run']);
    expect(issue.recommendedAction).toBe('revise');
    expectValidRecoveryIssue(issue);
  });

  it('offers accept as is on a reviewed workspace', () => {
    const issue = buildReviewFailedRecoveryIssue({ createdAt, blocking: 1, acceptAsIs: true });

    expect(issue.availableActions).toEqual(['revise', 'accept-as-is', 'end-run']);
    expect(issue.recommendedAction).toBe('revise');
    expectValidRecoveryIssue(issue);
  });

  it.each(['exit-1', 'timeout', 'transport-error'])(
    'offers a retry without a seat remedy after %s',
    (code) => {
      const issue = buildReviewFailedRecoveryIssue({
        createdAt,
        failure: { kind: 'call-failed', code, message: 'Review call failed.' },
      });

      expect(issue.seat).toBe('review');
      expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
      expect(issue.recommendedAction).toBe('retry-same-worker');
      expect(issue.details).toEqual([]);
      expectValidRecoveryIssue(issue);
    },
  );

  it('offers more context only when the review was not given enough context', () => {
    const issue = buildReviewFailedRecoveryIssue({
      createdAt,
      failure: {
        kind: 'insufficient-context',
        diagnostic: {
          code: 'insufficient-context',
          seat: 'review',
          cause: 'input-budget',
          missingSections: [],
        },
      },
    });

    expect(issue.details).toEqual([
      'Pick a review seat with a larger context in /crew review, then choose Try again.',
    ]);
    expectValidRecoveryIssue(issue);
  });
});

describe('buildRunnerInputTooLargeRecoveryIssue', () => {
  const runner = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer;

  it('halts the seat with no retry, since a retry sends the same prompt', () => {
    const issue = buildRunnerInputTooLargeRecoveryIssue({
      task: makeTask({ id: 'T030' }),
      runner,
      toolMessage: 'Input exceeds the maximum length',
      createdAt,
    });

    expect(issue.reason).toBe('context-overflow');
    expect(issue.availableActions).toEqual(['skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('skip-current-task');
    expectValidRecoveryIssue(issue);
  });

  it('offers and recommends the seat switch when another ready tool exists', () => {
    const issue = buildRunnerInputTooLargeRecoveryIssue({
      task: makeTask({ id: 'T030' }),
      runner,
      toolMessage: 'Input exceeds the maximum length',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [{ tool: 'claude-code', ready: true }],
      },
    });

    expect(issue.availableActions).toEqual(['switch-seat', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.switchSeat).toEqual({ seat: 'build', candidates: [{ tool: 'claude-code' }] });
    expectValidRecoveryIssue(issue);
  });
});

describe('recoveryBuilderForRunnerOutcome', () => {
  it('maps every runner defect to its builder and nothing else', () => {
    expect(recoveryBuilderForRunnerOutcome('implementer-recipe-invalid')).toBe(
      buildRecipeInvalidRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('missing-model')).toBe(buildMissingModelRecoveryIssue);
    expect(recoveryBuilderForRunnerOutcome('implementer-left-isolation')).toBe(
      buildLeftIsolationRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('checkout-changed')).toBe(
      buildCheckoutChangedRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('runner-timeout-repeated')).toBe(
      buildRepeatedTimeoutRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('timeout')).toBeUndefined();
    expect(recoveryBuilderForRunnerOutcome('unauthenticated')).toBeUndefined();
  });
});
