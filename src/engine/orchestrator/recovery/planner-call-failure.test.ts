import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { cliDetectionFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { defaultCliAuthChannel, type CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import { error } from '../../../utils/error.js';
import { CURSOR_MODEL_REFUSAL } from '#testing/helpers/cursor-refusal.js';
import { inputTooLargeRefusal } from '../../runners/input-limit.js';
import { streamError } from '../../streaming/stream-errors.js';
import { buildPlannerCallFailedRecoveryIssue } from './builders/planner.js';
import {
  diagnosePlannerCallFailure,
  plannerCallHaltIssue,
  plannerHaltRow,
} from './planner-call-failure.js';

const evidence = vi.hoisted(() => ({ detectRunnerEvidence: vi.fn() }));
vi.mock('../../detection/runner-evidence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../detection/runner-evidence.js')>()),
  ...evidence,
}));

it('carries the catalog name through the planner halt and fallback context', async () => {
  await withTempDir('catalog-planner-halt', async (projectDir) => {
    await rememberDetectedTools(projectDir, [cliDetectionFor('ready', 'codex')]);
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'claude-code',
        fallback: { tool: 'codex', model: 'gpt-6-luna' },
      },
    });
    const issue = await plannerCallHaltIssue({
      projectDir,
      config,
      modelCache: makeModelCacheAccessor({
        providerModels: { codex: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] },
      }),
      diagnosis: {
        failure: 'usage-limit',
        message: 'Balance spent',
        words: 'Balance spent',
        seatDown: { classification: { class: 'account', cause: 'balance' } },
      },
      phase: 'planning',
      swap: { seat: 'plan', runner: config.planner },
    });
    expect(issue.details).toContain('fallback: OpenAI Codex CLI · GPT-6-Luna');
    expect(issue.facts?.fallback).toBe('OpenAI Codex CLI · GPT-6-Luna');
  });
});

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

describe('an account refusal on the review seat', () => {
  it('reads a 401 the failed call carries as a sign-out', () => {
    const diagnosis = diagnosePlannerCallFailure({
      err: error('runner-call-failed', 'Planner review call failed', {
        status: 'failed',
        error: {
          code: 'opencode-error',
          message: 'provider.auth: Upstream request failed: Invalid credential',
          status: 401,
          providerType: 'provider.auth',
        },
      }),
      label: 'Final review failed',
      runner: cliSeat('opencode'),
      seat: 'review',
    });

    expect(diagnosis.failure).toBe('unauthenticated');
    expect(diagnosis.seatDown?.classification).toEqual({ class: 'account', cause: 'auth' });
  });

  it("reads Cursor's model refusal as an access refusal", () => {
    const diagnosis = diagnosePlannerCallFailure({
      err: failedCall(CURSOR_MODEL_REFUSAL),
      label: 'Final review failed',
      runner: cliSeat('cursor'),
      seat: 'review',
    });

    expect(diagnosis.seatDown?.classification).toEqual({ class: 'account', cause: 'access' });
    expect(diagnosis.message).toContain('Access refused by Cursor Agent CLI');
    expect(diagnosis.message).not.toContain('hit its usage limit');
  });
});

describe('a model refusal on a planner-tier seat', () => {
  const route = 'ollama-cloud/glm-5';
  const words = `provider.no-route: Model unavailable: ${route}`;
  const runner = { kind: 'cli', tool: 'opencode', model: route } as const;
  const refused = error('runner-call-failed', 'Planner review call failed', {
    status: 'failed',
    error: { code: 'missing-model', message: words },
  });
  const diagnosis = diagnosePlannerCallFailure({
    err: refused,
    label: 'Planning failed',
    runner,
    seat: 'plan',
  });

  afterEach(() => {
    evidence.detectRunnerEvidence.mockReset();
  });

  async function halt(projectDir: string) {
    // The remembered listing predates a sign-out: it still names the route's provider.
    await rememberDetectedTools(projectDir, [
      cliDetectionFor('ready', 'opencode', {
        providerAuth: {
          kind: 'read',
          facts: [{ id: 'ollama-cloud', provider: 'Ollama Cloud', source: 'stored' }],
        },
      }),
    ]);
    const config = makeConfig({ planner: runner });
    return plannerCallHaltIssue({
      modelCache: undefined,
      projectDir,
      config,
      diagnosis,
      phase: 'planning',
      swap: { seat: 'plan', runner: config.planner },
    });
  }

  it('reads as a missing model, not a failed call', () => {
    expect(diagnosis.failure).toBe('missing-model');
  });

  it("re-reads the route's credential once and halts as the sign-out it finds", async () => {
    evidence.detectRunnerEvidence.mockResolvedValue({
      providerAuth: {
        kind: 'read',
        facts: [{ id: 'opencode-go', provider: 'OpenCode Go', source: 'stored' }],
      },
      catalog: { kind: 'success', value: [{ id: 'opencode-go/kimi-k3' }] },
    });
    await withTempDir('planner-halt-probe-signed-out', async (projectDir) => {
      const issue = await halt(projectDir);

      expect(evidence.detectRunnerEvidence).toHaveBeenCalledTimes(1);
      expect(issue.reason).toBe('runner-unauthenticated');
      expect(issue.message).toContain('OpenCode CLI has no credential for ollama-cloud.');
      expect(plannerHaltRow(issue, diagnosis)).toBe(
        `${issue.message} (OpenCode CLI reported: ${words})`,
      );
    });
  });

  it('names both causes when the re-read fails', async () => {
    evidence.detectRunnerEvidence.mockRejectedValue(new Error('spawn opencode ENOENT'));
    await withTempDir('planner-halt-probe-failed', async (projectDir) => {
      const issue = await halt(projectDir);

      expect(issue.reason).toBe('planner-call-failed');
      expect(issue.message).toContain('if ollama-cloud has no credential, or pick a listed model');
      // A model refusal publishes the row the BUILD seat publishes for it: the halt's own message.
      expect(plannerHaltRow(issue, diagnosis)).toBe(issue.message);
    });
  });

  it('reads no credential for a halt that is not a model refusal', async () => {
    await withTempDir('planner-halt-no-probe', async (projectDir) => {
      const config = makeConfig({ planner: runner });
      await plannerCallHaltIssue({
        modelCache: undefined,
        projectDir,
        config,
        diagnosis: {
          failure: 'usage-limit',
          message: 'Quota spent',
          words: 'Quota spent',
          seatDown: { classification: { class: 'account', cause: 'quota' } },
        },
        phase: 'planning',
        swap: { seat: 'plan', runner: config.planner },
      });

      expect(evidence.detectRunnerEvidence).not.toHaveBeenCalled();
    });
  });

  it('publishes a failed call as its own message', async () => {
    const failed = diagnosePlannerCallFailure({
      err: failedCall('socket hang up'),
      label: 'Planning failed',
      runner,
      seat: 'plan',
    });
    await withTempDir('planner-halt-call-failed-row', async (projectDir) => {
      const config = makeConfig({ planner: runner });
      const issue = await plannerCallHaltIssue({
        modelCache: undefined,
        projectDir,
        config,
        diagnosis: failed,
        phase: 'planning',
        swap: { seat: 'plan', runner: config.planner },
      });

      expect(failed.failure).toBe('call-failed');
      expect(plannerHaltRow(issue, failed)).toBe(failed.message);
    });
  });
});

describe('a planner call the tool refused as too large', () => {
  const runner = cliSeat('claude-code');
  const task = makeTask({ id: 'T001', suggestedFiles: ['src/greet.ts'] });
  const refused = error('input-too-large', 'Prompt is too long', {
    error: { code: 'input-too-large', message: 'Prompt is too long' },
  });

  function haltFor(err: unknown) {
    const diagnosis = diagnosePlannerCallFailure({
      err,
      label: 'Planner consult for T001 failed',
      runner,
      seat: 'plan',
    });
    const issue = buildPlannerCallFailedRecoveryIssue({
      diagnosis,
      task,
      phase: 'implementing',
      runner,
      createdAt: '2026-10-19T12:00:00.000Z',
    });
    return { diagnosis, issue };
  }

  it('halts with no retry, because a retry sends the same prompt', () => {
    const { diagnosis, issue } = haltFor(refused);

    expect(diagnosis.failure).toBe('input-too-large');
    expect(issue.reason).toBe('planner-call-failed');
    expect(issue.message).toBe('Planner consult for T001 failed: the prompt is too large');
    expect(issue.details).toContain('Claude Code CLI reported: Prompt is too long');
    expect(issue.availableActions).not.toContain('retry-same-worker');
    expect(issue.availableActions).toEqual(['skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('skip-current-task');
    expect(issue.details.join('\n')).toContain('A retry sends the same prompt');
    expect(plannerHaltRow(issue, diagnosis)).toBe(diagnosis.message);
  });

  it('names the figures a refusal carries', () => {
    const { diagnosis, issue } = haltFor(
      inputTooLargeRefusal(5_000_000, { max: 1_000_000, unit: 'characters' }),
    );

    expect(diagnosis.failure).toBe('input-too-large');
    expect(issue.message).toBe('Planner consult for T001 failed: the prompt is too large');
    expect(issue.details).toContain(
      'The prompt is 5,000,000 characters; Claude Code CLI takes at most 1,000,000.',
    );
    expect(issue.facts).toMatchObject({ chars: 5_000_000, maxChars: 1_000_000 });
    expect(issue.availableActions).not.toContain('retry-same-worker');
  });

  function callFailure(code: string, message: string): unknown {
    return error('runner-call-failed', 'Planner call failed', {
      status: 'failed',
      error: { code, message },
    });
  }

  const calls = [
    { seat: 'plan', label: 'Planning failed' },
    { seat: 'plan', label: 'Planner consult for T001 failed' },
    { seat: 'review', label: 'Final review failed' },
  ] as const;

  it.each(calls)('$label: a Codex refusal that names only its limit', ({ seat, label }) => {
    const diagnosis = diagnosePlannerCallFailure({
      err: callFailure(
        'input-too-large',
        'Input exceeds the maximum length of 1000000 characters.',
      ),
      label,
      runner: cliSeat('codex'),
      seat,
    });

    expect(diagnosis.details).toEqual([
      'The prompt is larger than the 1,000,000 characters OpenAI Codex CLI takes.',
    ]);
  });
});
