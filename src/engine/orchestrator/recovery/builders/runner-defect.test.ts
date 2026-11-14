import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { formatRecoveryHeadline } from '../../../../core/recovery/headline.js';
import { haltOf } from '../../../../core/recovery/halt.js';
import type { SavedCatalog } from '../../../../core/discovery/catalog-read-merge.js';
import { routeAuthState } from '../../../../core/runners/route-auth.js';
import { createdAt, expectValidRecoveryIssue } from '#testing/helpers/recovery-issue.js';
import {
  buildMissingModelRecoveryIssue,
  buildRecipeInvalidRecoveryIssue,
  buildRepeatedTimeoutRecoveryIssue,
  buildRunnerCheckFailedRecoveryIssue,
  buildRunnerInputTooLargeRecoveryIssue,
  runnerDefectRow,
  runnerHaltRow,
} from './runner-defect.js';
import { buildSeatDownIssue } from './seat-down.js';

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

  // A tool that stores no credential: the route reads from its model list alone.
  const noCredentialHalt = (catalog: SavedCatalog | undefined) =>
    buildMissingModelRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      phase: 'implementing',
      runner,
      toolMessage: noRoute,
      seatSwap: {
        ...seatSwap([]),
        routeAuth: routeAuthState({
          tool: 'opencode',
          model: route,
          providerAuth: { kind: 'empty' },
          catalog,
        }),
      },
      createdAt,
    });

  it('on a tool that stores no credential and whose model list does not serve the route, halts as Seat down', () => {
    const issue = noCredentialHalt({ models: [{ id: 'ollama/llama3' }] });

    expect(issue.reason).toBe('runner-unauthenticated');
    expect(issue.message).toBe(
      'OpenCode CLI has no credential for ollama-cloud. Run `opencode auth login ollama-cloud` in a separate terminal, then retry.',
    );
    expect(issue.switchSeat?.auto).toEqual({ candidate: fallback, configRevision: 'revision' });
  });

  it('on a tool that stores no credential and whose model list could not be read, names both causes and never moves the seat', () => {
    const issue = noCredentialHalt(undefined);

    expect(issue.reason).toBe('implementer-recipe-invalid');
    expect(issue.message).toBe(
      `OpenCode CLI cannot use ${route}: sign in with \`opencode auth login ollama-cloud\` if ollama-cloud has no credential, or pick a listed model`,
    );
    expect(issue.switchSeat?.auto).toBeUndefined();
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
      createdAt,
    });

    expect(issue.reason).toBe('runner-timeout-repeated');
    expect(issue.message).toContain('timed out twice in a row on T024');
    expect(issue.details).toContain('implementer timed out');
    expect(issue.details.join('\n')).not.toContain('reported:');
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

describe('buildRunnerCheckFailedRecoveryIssue', () => {
  const toolMessage =
    'OpenAI Codex CLI version is not compatible. Install the tested OpenAI Codex CLI version (0.128.0), then run `splitbrief doctor` again.';

  it('names the changed tool, keeps its check words and recommends the retry that checks it again', () => {
    const issue = buildRunnerCheckFailedRecoveryIssue({
      task: makeTask({ id: 'T024' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage,
      attempts: 1,
      createdAt,
    });

    expect(issue.reason).toBe('runner-check-failed');
    expect(issue.message).toBe(
      'OpenAI Codex CLI changed during the run and failed its check on T024',
    );
    expect(issue.details).toEqual([
      toolMessage,
      'The run stopped instead of starting a tool that did not pass its check.',
      'Attempts: 1',
    ]);
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });

  it('offers the seat switch when another ready tool exists and still recommends the retry', () => {
    const issue = buildRunnerCheckFailedRecoveryIssue({
      task: makeTask({ id: 'T024' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage,
      attempts: 1,
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
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.switchSeat).toEqual({ seat: 'build', candidates: [{ tool: 'claude-code' }] });
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

  function inputTooLargeHalt(tool: 'codex' | 'claude-code' | 'opencode', toolMessage: string) {
    const issue = buildRunnerInputTooLargeRecoveryIssue({
      task: makeTask({ id: 'T030' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool } }).implementer,
      toolMessage,
      createdAt,
    });
    expectValidRecoveryIssue(issue);
    return { message: issue.message, details: issue.details, facts: issue.facts };
  }

  it('states the figures of a Codex refusal in place of its raw words', () => {
    const halt = inputTooLargeHalt(
      'codex',
      'Input exceeds the maximum length of 1000000 characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":1000000,"actual_chars":5000000}',
    );

    expect(halt).toEqual({
      message: 'Prompt too large for OpenAI Codex CLI on T030',
      details: [
        'The prompt is 5,000,000 characters; OpenAI Codex CLI takes at most 1,000,000.',
        'A retry sends the same prompt.',
      ],
      facts: { tool: 'OpenAI Codex CLI', chars: 5_000_000, maxChars: 1_000_000 },
    });
  });

  it('names only the limit when a Codex refusal names no size', () => {
    const halt = inputTooLargeHalt(
      'codex',
      'Input exceeds the maximum length of 1000000 characters.',
    );

    expect(halt.details[0]).toBe(
      'The prompt is larger than the 1,000,000 characters OpenAI Codex CLI takes.',
    );
    expect(halt.facts).toEqual({ tool: 'OpenAI Codex CLI', maxChars: 1_000_000 });
  });

  it('shows no size when a Claude Code refusal names none, and quotes its words', () => {
    const halt = inputTooLargeHalt('claude-code', 'Prompt is too long');

    expect(halt).toEqual({
      message: 'Prompt too large for Claude Code CLI on T030',
      details: ['Claude Code CLI reported: Prompt is too long', 'A retry sends the same prompt.'],
      facts: { tool: 'Claude Code CLI' },
    });
  });
});
