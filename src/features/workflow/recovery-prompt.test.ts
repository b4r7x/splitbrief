import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { RecoveryIssue, SwitchSeatOffer } from '../../core/schemas/recovery/schemas.js';
import { taskId } from '../../core/schemas/task.js';
import { glyph } from '../../lib/glyphs.js';
import { buildRequiredChecksUnrunnableRecoveryIssue } from '../../engine/orchestrator/recovery/builders/checks.js';
import { buildCheckoutChangedRecoveryIssue } from '../../engine/orchestrator/recovery/builders/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { PromptBody } from './components/prompt-body.js';
import { countPromptBodyRows, promptBodyRows } from './prompt-body-rows.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import {
  formatActionRow,
  formatMiddotList,
  formatRecoveryPrompt,
  getRecoveryPromptActions,
  isActionRowLine,
  parseRecoveryActionAnswer,
  passHeadlinePrefix,
  recoveryComposerHint,
  recoveryMenuLabel,
  recoveryMenuParts,
  recoveryPromptSummaryRows,
  recommendedRowPrefix,
  switchSeatCandidateForAnswer,
} from './recovery-prompt.js';

async function renderPromptBody(prompt: string): Promise<string> {
  const ui = renderFeature(createElement(PromptBody, { prompt, height: 40, width: 120 }));
  await tick(20);
  const text = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return text;
}

const baseIssue: RecoveryIssue = {
  id: 'rec_test',
  reason: 'retry-exhausted',
  phase: 'escalating',
  status: 'awaiting-user',
  taskId: taskId('T003'),
  taskTitle: 'Patch auth validation',
  files: ['src/auth/session.ts', 'src/auth/session.test.ts'],
  affectedTaskIds: [taskId('T003')],
  message: 'T003 failed',
  details: [
    'Validation test failed: npm test -- auth failed in src/auth/session.test.ts',
    'Attempts: 3/3',
    'Worker profile: local-qwen',
  ],
  attempts: 3,
  maxAttempts: 3,
  selectedImplementerProfile: 'local-qwen',
  facts: {
    validationStage: 'test',
    validationSummary: 'npm test -- auth failed',
  },
  availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
  recommendedAction: 'retry-same-worker',
  createdAt: '2026-04-29T12:00:00.000Z',
};

it('builds a context cause from its recorded seat, with dim separators', () => {
  const issue = makeRecoveryIssue({
    reason: 'planner-call-failed',
    seat: 'review',
    attempts: undefined,
    facts: {
      apiContextCode: 'insufficient-context',
      apiContextSeat: 'review',
      apiContextCause: 'input-budget',
    },
  });
  expect(recoveryPromptSummaryRows(issue)[0]).toMatchObject({
    parts: [
      { text: 'Seat down', tone: 'warning' },
      { text: ' · ', tone: 'textDim' },
      { text: 'Nothing was sent to ', tone: 'text' },
      { text: 'REVIEW', tone: 'reviewer' },
      { text: ' · ', tone: 'textDim' },
      { text: 'larger than the context window', tone: 'text' },
    ],
  });
});

it('keeps the default summary at seven rows at width 30 and five at width 120', () => {
  const issue = makeRecoveryIssue();
  const rows = recoveryPromptSummaryRows(issue);
  expect(rows.at(-1)?.kind).toBe('facts');
  expect(countPromptBodyRows(rows, 30)).toBe(7);
  expect(countPromptBodyRows(rows, 120)).toBe(5);
  expect(
    promptBodyRows(rows, 30)
      .filter((row) => row.kind === 'facts-line')
      .map((row) => row.text),
  ).toEqual([
    '  Task T001 · Fix login ',
    '  validation',
    '  Files src/auth/session.ts',
    '  npm test failed in ',
    '  src/auth/session.test.ts',
  ]);
});

it('carries the action seat and consequence before formatting the label', () => {
  expect(recoveryMenuParts('switch-seat', makeRecoveryIssue({ seat: 'build' }))).toEqual([
    { text: 'Change ', tone: 'text' },
    { text: 'BUILD', tone: 'implementer' },
    { text: ' tool', tone: 'text' },
    { text: ' · ', tone: 'textDim' },
    { text: 'restarts this brief', tone: 'textDim' },
  ]);
});

it('keeps a fix action hint dim', () => {
  expect(recoveryMenuParts('revise', makeRecoveryIssue({ reason: 'review-failed' }))).toEqual([
    { text: 'Fix again', tone: 'text' },
    { text: ' · ', tone: 'textDim' },
    { text: 'add a note, grant one more fix cycle', tone: 'textDim' },
  ]);
});

it.each([
  [
    'apply-conflict',
    'retry-same-worker',
    'Re-run Apply',
    'after you resolve the files in the workspace',
  ],
  ['apply-partial', 'retry-same-worker', 'Re-run Apply', 'writes the files still missing'],
  [
    'apply-partial',
    'restore-backup',
    'Restore backup',
    'puts back the files Apply replaced and removes the ones it created',
  ],
] as const)('keeps the %s %s action consequence dim', (reason, action, label, consequence) => {
  expect(recoveryMenuParts(action, makeRecoveryIssue({ reason }))).toEqual([
    { text: label, tone: 'text' },
    { text: ' · ', tone: 'textDim' },
    { text: consequence, tone: 'textDim' },
  ]);
});

it('preserves the canonical retry cause when an old message starts with its seat', () => {
  const issue = makeRecoveryIssue({
    reason: 'retry-exhausted',
    seat: 'build',
    message: 'BUILD exhausted recovery retries',
    attempts: 3,
    facts: {},
  });
  expect(recoveryPromptSummaryRows(issue)[0]).toMatchObject({
    text: 'Needs you · T001 failed after 3 attempts',
    parts: [
      { text: 'Needs you', tone: 'warning' },
      { text: ' · ', tone: 'textDim' },
      { text: 'T001 failed after 3 attempts', tone: 'text' },
    ],
  });
});

describe('recovery prompt', () => {
  beforeEach(() => {
    process.env.TERM = 'xterm-256color';
    process.env.LANG = 'en_US.UTF-8';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  function usageLimitIssue(candidates: SwitchSeatOffer['candidates']): RecoveryIssue {
    return {
      ...baseIssue,
      reason: 'runner-usage-limit',
      message: 'Codex hit its usage limit',
      details: ['Codex reported: 5-hour limit reached'],
      facts: {},
      switchSeat: { seat: 'build', candidates },
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
    };
  }

  it('names a spent balance in the panel title, not a usage limit', async () => {
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'claude-code' }]),
      message: 'Balance spent on OpenCode CLI. Add credit or change the BUILD tool, then continue.',
      details: ['OpenCode CLI reported: provider.quota: Insufficient Balance'],
      facts: { tool: 'OpenCode CLI', cause: 'balance' },
      resetAt: undefined,
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Seat down · Balance spent on OpenCode CLI');
    expect(visible).not.toContain('Usage limit');
  });

  it('keeps the install advice of a halt with six checks that miss a program', async () => {
    const issue = buildRequiredChecksUnrunnableRecoveryIssue({
      phase: 'final-review',
      checks: ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'].map((checkId) => ({
        checkId,
        output: 'sh: vitest: command not found',
        missingProgram: true as const,
      })),
      createdAt: '2026-10-05T00:00:00.000Z',
    });

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Install what is missing, then run the checks again.');
  });

  it('states a quota halt once, in the clock the header uses', async () => {
    const resetAt = new Date();
    resetAt.setHours(17, 0, 0, 0);
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'opencode' }]),
      message:
        'Ollama hit its usage limit. The limit resets at Jan 1, 2026, 5:00 PM; wait for it, switch the seat to another tool, or end the run.',
      facts: { tool: 'Ollama' },
      resetAt: resetAt.toISOString(),
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Seat down · Usage limit on Ollama · resets 17:00');
    expect(visible).not.toContain('5:00 PM');
    expect(visible.match(/resets 17:00/g)).toHaveLength(1);
  });

  it("drops codex's own reset clause from its quote, keeping the rest of its words", async () => {
    const resetAt = new Date();
    resetAt.setHours(17, 0, 0, 0);
    const quote = (when: string): RecoveryIssue => ({
      ...usageLimitIssue([{ tool: 'claude-code' }]),
      details: [
        `OpenAI Codex CLI reported: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again ${when}.`,
      ],
      facts: { tool: 'OpenAI Codex CLI' },
      resetAt: resetAt.toISOString(),
    });

    for (const when of ['at 5:00 PM', 'at Oct 3rd, 2026 5:00 PM', 'in 7.66s']) {
      const visible = (await renderPromptBody(formatRecoveryPrompt(quote(when)))).replace(
        /\s+/g,
        ' ',
      );

      expect(visible).toContain('Usage limit on OpenAI Codex CLI · resets 17:00');
      expect(visible).toContain('to purchase more credits.');
      expect(visible).not.toMatch(/\bWorker\b/);
      expect(visible).not.toContain('try again');
    }
  });

  it('gives each tool a quota-blocked seat can switch to its own row', async () => {
    const issue = usageLimitIssue([{ tool: 'claude-code', model: 'sonnet' }, { tool: 'opencode' }]);

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('w1   switch BUILD to Claude Code CLI · Sonnet 5');
    expect(visible).toContain('w2   switch BUILD to OpenCode CLI');
    expect(visible).toContain('r    retry same worker');
    expect(visible).toContain('a    end run');
    expect(visible).not.toContain('opencode,');
  });

  it("offers the seat's own tool as a model to pick, never as a switch to the tool it runs", async () => {
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'claude-code' }, { tool: 'opencode' }]),
      facts: { tool: 'OpenCode CLI' },
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('w1   switch BUILD to Claude Code CLI');
    expect(visible).toContain('w2   pick another BUILD model');
    expect(visible).not.toContain('switch BUILD to OpenCode CLI');
  });

  it("names the menu row a model pick when the seat's own tool is the only offer", () => {
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'opencode' }]),
      facts: { tool: 'OpenCode CLI' },
    };

    expect(recoveryMenuLabel('switch-seat', issue)).toBe(
      'Pick another BUILD model · restarts this brief',
    );
  });

  it('keeps the bare seat key when only one tool is offered', async () => {
    const issue = usageLimitIssue([{ tool: 'opencode' }]);

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('w   switch BUILD to OpenCode CLI');
    expect(visible).not.toContain('w1');
    expect(parseRecoveryActionAnswer('w2', issue)).toBeNull();
  });

  it('reads a usage-limit halt as seat down with its rows and no pause', async () => {
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'opencode' }]),
      facts: { tool: 'Ollama' },
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Seat down · Usage limit on Ollama');
    expect(visible).toContain('r   retry same worker');
    expect(visible).toContain('w   switch BUILD to OpenCode CLI');
    expect(visible).toContain('s   skip task');
    expect(visible).toContain('a   end run · closes this run, changes kept');
    expect(visible).not.toContain('pause');
  });

  it('counts the ready tools that did not fit the offer', async () => {
    const issue = usageLimitIssue([
      { tool: 'claude-code', model: 'sonnet' },
      { tool: 'opencode' },
      { tool: 'cursor' },
      { tool: 'copilot' },
      { tool: 'kilo-code' },
    ]);

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('w3   switch BUILD to Cursor Agent CLI');
    expect(visible).toContain('(2 more ready tools detected)');
    expect(visible).not.toContain('w4');
  });

  it('reads a numbered seat key back as the candidate its row named', () => {
    const issue = usageLimitIssue([{ tool: 'claude-code', model: 'sonnet' }, { tool: 'opencode' }]);

    expect(parseRecoveryActionAnswer('w', issue)).toBe('switch-seat');
    expect(parseRecoveryActionAnswer('w2', issue)).toBe('switch-seat');
    expect(parseRecoveryActionAnswer('', issue)).toBe('switch-seat');
    expect(parseRecoveryActionAnswer('w3', issue)).toBeNull();
    expect(switchSeatCandidateForAnswer('w2', issue.switchSeat)).toEqual({ tool: 'opencode' });
    expect(switchSeatCandidateForAnswer('w', issue.switchSeat)).toEqual({
      tool: 'claude-code',
      model: 'sonnet',
    });
    expect(switchSeatCandidateForAnswer('w9', issue.switchSeat)).toBeUndefined();
  });

  it('builds a compact retry-exhausted recovery prompt with only available actions', async () => {
    const prompt = formatRecoveryPrompt(baseIssue);
    const visible = await renderPromptBody(prompt);

    expect(visible).toContain('Needs you · T003 failed after 3 attempts');
    expect(visible).toContain('Task T003 · Patch auth validation');
    expect(visible).toContain('Files src/auth/session.ts · src/auth/session.test.ts');
    expect(visible).toContain(
      'Last check test failed: npm test -- auth failed in src/auth/session.test.ts',
    );
    expect(visible).not.toMatch(/\bWorker\b/);
    expect(visible).toContain('r   retry same worker recommended');
    expect(visible).toContain('s   skip task');
    expect(visible).toContain('a   end run · closes this run, changes kept');
    expect(visible).not.toContain('continue');
  });

  it.each(['default', 'local-fixture'])(
    'states no Worker row for the %s profile, saved detail or not',
    async (profile) => {
      const visible = await renderPromptBody(
        formatRecoveryPrompt({
          ...baseIssue,
          details: [...baseIssue.details, `Worker profile: ${profile}`],
          selectedImplementerProfile: profile,
          facts: { contextLength: 32_768 },
        }),
      );

      expect(visible).not.toMatch(/\bWorker\b/);
    },
  );

  it.each([
    ['plan-questions-exhausted', 'Needs you · Planner still asks questions after 2 rounds'],
    ['plan-checks-failed', 'Needs you · Plan still fails its checks after one repair'],
  ] as const)('names a %s halt by its headline, not a second wording of it', (reason, header) => {
    const prompt = formatRecoveryPrompt({
      ...baseIssue,
      reason,
      taskId: undefined,
      attempts: undefined,
      message: 'The plan failed its checks again after one repair.',
    });

    expect(prompt).toContain(header);
    expect(prompt).not.toContain('again after one repair.');
  });

  it('serializes the rows into a flat prompt with the recommended accent marker', () => {
    const prompt = formatRecoveryPrompt(baseIssue);

    expect(prompt).toContain('Needs you · T003 failed after 3 attempts');
    expect(prompt).toContain('▌ [r]  retry same worker');
    expect(prompt).toContain('[s]  skip task');
    expect(prompt).not.toContain('[c]  continue');
  });

  it('shares one action-row shape between the builder and the parser detector', () => {
    const row = formatActionRow('r', 'retry same worker');

    expect(row).toBe('[r]  retry same worker');
    expect(isActionRowLine(row)).toBe(true);
    expect(isActionRowLine(`${recommendedRowPrefix()}${row}`)).toBe(true);
    expect(isActionRowLine('Task T003 · Patch auth validation')).toBe(false);
  });

  it('parses answers into typed recovery actions', () => {
    expect(parseRecoveryActionAnswer('r', baseIssue)).toBe('retry-same-worker');
    expect(parseRecoveryActionAnswer('skip', baseIssue)).toBe('skip-current-task');
    expect(parseRecoveryActionAnswer('abort', baseIssue)).toBe('end-run');
  });

  it('marks the recommended action and applies it only for empty Enter', async () => {
    const issue: RecoveryIssue = { ...baseIssue, recommendedAction: 'skip-current-task' };
    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('s   skip task recommended');
    expect(parseRecoveryActionAnswer('', issue)).toBe('skip-current-task');
    expect(parseRecoveryActionAnswer('   ', issue)).toBe('skip-current-task');
  });

  it('returns null for unknown or unavailable non-empty input so the caller re-prompts', () => {
    expect(parseRecoveryActionAnswer('continue', baseIssue)).toBeNull();
    expect(parseRecoveryActionAnswer('w', baseIssue)).toBeNull();
    expect(parseRecoveryActionAnswer('nope', baseIssue)).toBeNull();
  });

  it('recommends the first listed action when the saved recommendation is not offered', async () => {
    const issue: RecoveryIssue = {
      ...baseIssue,
      id: 'rec_unoffered',
      availableActions: ['skip-current-task', 'end-run'],
      recommendedAction: 'retry-same-worker',
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('s   skip task recommended');
    expect(parseRecoveryActionAnswer('', issue)).toBe('skip-current-task');
  });

  it('parses continue only when the issue allows it', () => {
    const issue: RecoveryIssue = {
      id: 'rec_bound',
      reason: 'consult-bound-spent',
      phase: 'implementing',
      status: 'awaiting-user',
      message: 'T003 used its consult allowance',
      files: [],
      affectedTaskIds: [],
      details: [],
      availableActions: ['continue', 'skip-current-task', 'end-run'],
      recommendedAction: 'continue',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    expect(parseRecoveryActionAnswer('c', issue)).toBe('continue');
    expect(parseRecoveryActionAnswer('c', { ...issue, availableActions: ['end-run'] })).toBeNull();
  });

  it('offers only the actions the issue carries, with its details under the headline', async () => {
    const issue: RecoveryIssue = {
      id: 'rec_overflow',
      reason: 'context-overflow',
      phase: 'implementing',
      status: 'awaiting-user',
      message: 'Context overflowed on T004',
      files: [],
      affectedTaskIds: [],
      details: ['Blocked step: before T004'],
      availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
      recommendedAction: 'retry-same-worker',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Seat down · Context overflowed on T004');
    expect(visible).toContain('Blocked step: before T004');
    expect(visible).toContain('r   retry same worker recommended');
    expect(visible).toContain('s   skip task');
    expect(visible).toContain('a   end run · closes this run, changes kept');
    expect(visible).not.toContain('continue');
    expect(parseRecoveryActionAnswer('c', issue)).toBeNull();
  });

  // In a real run, the panel blamed the checkout and listed T004's own file as a Files row,
  // although only a branch another session created had changed.
  it('heads a checkout-changed halt with the ref that changed and lists no brief file', async () => {
    const issue = buildCheckoutChangedRecoveryIssue({
      task: makeTask({
        id: 'T004',
        suggestedFiles: ['src/engine/runners/cli-tools/final-group.ts'],
      }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } }).implementer,
      toolMessage: 'branch fix/implementer-never-runs-gates',
      attempts: 0,
      maxAttempts: 2,
      createdAt: '2026-10-07T05:54:04.413Z',
    });

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain(
      'Needs you · Repository changed under T004 · branch fix/implementer-never-runs-gates',
    );
    expect(visible).not.toContain('Your checkout changed');
    expect(visible).not.toContain('Files ');
    expect(visible).not.toContain('final-group.ts');
    expect(visible.match(/fix\/implementer-never-runs-gates/g)).toHaveLength(1);
  });

  it('uses the shared truncated-list spelling', () => {
    expect(formatMiddotList(['a', 'b', 'c', 'd'], 3)).toBe('a · b · c · +1 more');
  });

  it('spells the run-level answers in the words the gate uses', () => {
    const prompt = formatRecoveryPrompt({
      ...baseIssue,
      reason: 'plan-checks-failed',
      taskId: undefined,
      availableActions: ['retry-same-worker', 'revise', 'end-run'],
      recommendedAction: 'revise',
    });

    expect(prompt).toContain(
      `${recommendedRowPrefix()}[v]  revise · send the planner a correction`,
    );
    expect(prompt).toContain('[a]  end run · closes this run, changes kept');
  });

  it.each([
    ['v', 'revise'],
    ['revise', 'revise'],
    ['a', 'end-run'],
    ['end', 'end-run'],
    ['abort', 'end-run'],
  ] as const)('parses %s as %s when the halt offers it', (answer, action) => {
    const issue: RecoveryIssue = {
      ...baseIssue,
      reason: 'plan-checks-failed',
      availableActions: ['revise', 'end-run'],
      recommendedAction: 'revise',
    };

    expect(parseRecoveryActionAnswer(answer, issue)).toBe(action);
  });

  it('uses ascii recommended-row and pass-headline prefixes when the glyph tier is ascii', () => {
    const prev = process.env.TERM;
    process.env.TERM = 'dumb';
    try {
      expect(formatRecoveryPrompt(baseIssue)).toContain(
        `${glyph('liveBar', 'ascii')} [r]  retry same worker`,
      );
      expect(passHeadlinePrefix()).toBe(`${glyph('check', 'ascii')} `);
    } finally {
      process.env.TERM = prev;
    }
  });

  it('quotes a tool diagnostic without repeating the reset the headline already carries', async () => {
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'opencode' }]),
      facts: { tool: 'Ollama' },
      details: ['Ollama reported: quota exhausted · resets 5pm'],
      resetAt: new Date(Date.parse('2026-01-01T17:00:00.000Z')).toISOString(),
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Ollama reported: quota exhausted');
    expect(visible.match(/resets/g)).toHaveLength(1);
  });
  function apiContextIssue(overrides: Partial<RecoveryIssue> = {}): RecoveryIssue {
    return {
      id: 'rec_api_context',
      reason: 'planner-call-failed',
      seat: 'plan',
      phase: 'planning',
      status: 'awaiting-user',
      files: [],
      affectedTaskIds: [],
      message:
        'The planning seat was not given the context this call needs, so nothing was dispatched. Evidence this call requires is missing. Missing: evidence.json, drift-report.json',
      details: [
        'Missing: evidence.json, drift-report.json',
        'Pick a plan seat with a larger context in /crew plan, then choose Try again.',
      ],
      facts: {
        apiContextCode: 'insufficient-context',
        apiContextSeat: 'plan',
        apiContextCause: 'missing-required',
        apiContextMissingSectionsJson: '["evidence.json","drift-report.json"]',
        apiContextModel: 'qwen3-coder-30b',
        apiContextInputEstimate: 148_000,
        apiContextRequiredTokens: 156_000,
        apiContextAvailableTokens: 32_768,
      },
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
      createdAt: '2026-04-29T12:00:00.000Z',
      ...overrides,
    };
  }

  it('names the plan seat that was never called, and the sections it never got', async () => {
    const visible = await renderPromptBody(formatRecoveryPrompt(apiContextIssue()));

    expect(visible).toContain(
      'Seat down · Nothing was sent to PLAN · required evidence was missing',
    );
    expect(visible).toContain('Missing: evidence.json, drift-report.json');
    expect(visible).toContain(
      'Pick a plan seat with a larger context in /crew plan, then choose Try again.',
    );
    expect(visible).toContain('r   retry PLAN recommended');
    expect(visible).toContain('a   end run · closes this run, changes kept');
    // The figures are the details view's; the panel states the cause and nothing numeric.
    expect(visible).not.toMatch(/148,?000|156,?000|32,?768/);
    expect(visible).not.toMatch(/blocking|0 finding/i);
    expect(visible).not.toContain('skip task');
    // The boundary's sentence repeats the list the detail row already carries.
    expect(visible.match(/evidence\.json/g)).toHaveLength(1);
  });

  it('names the review seat, and calls it a call that was never made rather than a verdict', async () => {
    const issue = apiContextIssue({
      id: 'rec_api_context_review',
      reason: 'review-failed',
      seat: 'review',
      phase: 'final-review',
      message: 'The review seat was not given the context this call needs.',
      details: ['Pick a review seat with a larger context in /crew review, then choose Try again.'],
      facts: {
        apiContextCode: 'insufficient-context',
        apiContextSeat: 'review',
        apiContextCause: 'input-budget',
        apiContextMissingSectionsJson: '[]',
        reviewFailureKind: 'insufficient-context',
        apiContextRequiredTokens: 412_000,
        apiContextAvailableTokens: 32_768,
      },
    });

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Nothing was sent to REVIEW · larger than the context window');
    expect(visible).toContain('r   retry REVIEW');
    expect(visible).toContain('/crew review');
    expect(visible).not.toMatch(/blocking/i);
    expect(visible).not.toMatch(/412,?000|32,?768/);
    expect(visible).not.toMatch(/review fix|repair/i);
  });

  it('names the seat on a review call that never landed, and keeps the retry key', async () => {
    const issue = apiContextIssue({
      id: 'rec_review_call_failed',
      reason: 'review-failed',
      seat: 'review',
      phase: 'final-review',
      message: 'The review call did not land: socket hang up',
      details: [],
      facts: { reviewFailureKind: 'call-failed' },
      recommendedAction: 'retry-same-worker',
    });

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    // No context diagnosis, so the halt keeps the ordinary headline — only the retry is seat-level.
    expect(visible).toContain('Needs you · The review call did not land: socket hang up');
    expect(visible).not.toContain('/crew');
    expect(visible).toContain('r   retry REVIEW');
    expect(parseRecoveryActionAnswer('r', issue)).toBe('retry-same-worker');
    expect(parseRecoveryActionAnswer('retry', issue)).toBe('retry-same-worker');
  });

  it('leaves a halt that names a brief calling its retry what it is: a replay of that brief', async () => {
    const withBrief = apiContextIssue({
      id: 'rec_api_context_brief',
      taskId: taskId('T003'),
      taskTitle: 'Patch auth validation',
    });

    const visible = await renderPromptBody(formatRecoveryPrompt(withBrief));

    expect(visible).toContain('r   retry same worker');
    expect(visible).not.toContain('retry PLAN');
    expect(await renderPromptBody(formatRecoveryPrompt(baseIssue))).toContain(
      'r   retry same worker',
    );
  });

  // At its widest the retry-exhausted builder ends on the two voices and the verdict. A tighter
  // budget would drop exactly the evidence the halt is for.
  it('keeps both voices and the verdict on the widest retry-exhausted halt', async () => {
    const issue: RecoveryIssue = {
      ...baseIssue,
      reason: 'retry-exhausted',
      phase: 'escalating',
      message: 'T003: the planner found the brief wrong',
      details: [
        'Last error: test failed: npm test -- auth failed in src/auth/session.test.ts',
        'Attempts: 4 (3 local, then 1 with planner hints)',
        'Worker profile: local-qwen',
        'Implementer said: the session type has no expiry field, so I stopped.',
        'Planner said: Add expiry to the session type in its own brief first.',
        'Planner verdict: the brief itself is wrong — the brief names a field the type never had',
      ],
      facts: { ...baseIssue.facts, plannerVerdict: 'brief' },
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Implementer said: the session type has no expiry field');
    expect(visible).toContain('Planner said: Add expiry');
    expect(visible).toContain('Planner verdict: the brief itself is wrong');
    expect(visible).not.toContain('VERDICT:');
  });

  it('formats headers reading headline cause and omitting attempt suffix at zero attempts', () => {
    const verdictIssue: RecoveryIssue = {
      ...baseIssue,
      reason: 'retry-exhausted',
      taskId: taskId('T003'),
      attempts: 0,
      facts: { plannerVerdict: 'brief' },
    };
    expect(formatRecoveryPrompt(verdictIssue).split('\n')[0]).toBe(
      'Needs you · T003: the planner found the brief wrong',
    );

    const retryIssue: RecoveryIssue = {
      ...baseIssue,
      reason: 'retry-exhausted',
      taskId: taskId('T005'),
      attempts: 4,
      facts: {},
    };
    expect(formatRecoveryPrompt(retryIssue).split('\n')[0]).toBe(
      'Needs you · T005 failed after 4 attempts',
    );

    const legacyWords = 'exhausted recovery' + ' retries';
    const legacyIssue: RecoveryIssue = {
      ...retryIssue,
      message: `T005 ${legacyWords}`,
    };
    expect(formatRecoveryPrompt(legacyIssue).split('\n')[0]).toBe(
      'Needs you · T005 failed after 4 attempts',
    );
    expect(formatRecoveryPrompt(legacyIssue)).not.toContain(legacyWords);

    const zeroAttemptsIssue: RecoveryIssue = {
      ...baseIssue,
      attempts: 0,
    };
    expect(formatRecoveryPrompt(zeroAttemptsIssue).split('\n')[0]).toBe('Needs you · T003 failed');
  });

  it('leaves a substantive review failure on the words it earned', async () => {
    const issue: RecoveryIssue = {
      id: 'rec_review_blocking',
      reason: 'review-failed',
      seat: 'build',
      phase: 'final-review',
      status: 'awaiting-user',
      files: [],
      affectedTaskIds: [],
      message: 'Final review failed with 2 blocking findings',
      details: ['See review.md'],
      facts: { blocking: 2 },
      availableActions: ['revise', 'end-run'],
      recommendedAction: 'revise',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('Needs you · Final review failed with 2 blocking findings');
    expect(visible).not.toContain('Nothing was sent');
    expect(visible).not.toContain('retry');
  });

  it('offers the Apply halts a re-run of Apply, never a brief or a retry of a worker', async () => {
    const conflict: RecoveryIssue = {
      id: 'rec_apply_conflict',
      reason: 'apply-conflict',
      phase: 'complete',
      status: 'awaiting-user',
      files: ['a.txt', 'gone.txt'],
      affectedTaskIds: [],
      message: 'Apply found 2 conflicting files',
      details: [
        'a.txt · both sides changed the same lines',
        'gone.txt · deleted on one side, changed on the other',
      ],
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
      createdAt: '2026-10-04T09:00:00.000Z',
    };
    const partial: RecoveryIssue = {
      ...conflict,
      id: 'rec_apply_partial',
      reason: 'apply-partial',
      message: 'Apply stopped part way',
      details: ['Wrote 1 of 2 files; b.txt failed: disk full'],
    };

    expect(recoveryMenuLabel('retry-same-worker', conflict)).toBe(
      'Re-run Apply · after you resolve the files in the workspace',
    );
    expect(recoveryMenuLabel('retry-same-worker', partial)).toBe(
      'Re-run Apply · writes the files still missing',
    );
    const offered: RecoveryIssue = {
      ...partial,
      availableActions: ['retry-same-worker', 'restore-backup', 'end-run'],
      recommendedAction: 'retry-same-worker',
    };
    expect(recoveryMenuLabel('restore-backup', offered)).toBe(
      'Restore backup · puts back the files Apply replaced and removes the ones it created',
    );
    expect(getRecoveryPromptActions(offered)).toContain('restore-backup');
    const partialVisible = await renderPromptBody(formatRecoveryPrompt(offered));
    expect(partialVisible).toContain('restore backup');
    for (const answer of ['u', 'restore', 'restore backup', 'restore-backup']) {
      expect(parseRecoveryActionAnswer(answer, offered)).toBe('restore-backup');
    }
    expect(parseRecoveryActionAnswer('restore', conflict)).toBeNull();
    const reconciled: RecoveryIssue = {
      ...offered,
      details: [
        'Apply was cut off: wrote 3 of 9 files',
        ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((name) => `${name}.txt · not written`),
        'Backup of the replaced files: /tmp/backup',
      ],
    };
    const wide = formatRecoveryPrompt(reconciled);
    expect(wide).toContain('i.txt · not written');
    expect(wide).toContain('Backup of the replaced files: /tmp/backup');
    const visible = await renderPromptBody(formatRecoveryPrompt(conflict));
    expect(visible).toContain('Needs you · Apply found 2 conflicting files');
    expect(visible).toContain('a.txt · both sides changed the same lines');
    expect(visible).toContain('re-run Apply');
    expect(visible).not.toContain('retry same worker');
    expect(visible).not.toContain('restarts this brief');
  });

  it('lists every file of a wide Apply conflict with the place to resolve it', async () => {
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt'];
    const issue: RecoveryIssue = {
      id: 'rec_apply_wide',
      reason: 'apply-conflict',
      phase: 'complete',
      status: 'awaiting-user',
      files,
      affectedTaskIds: [],
      message: 'Apply found 7 conflicting files',
      details: [
        "Resolve each file in /tmp/ws: keep the run's version, copy your checkout's version over it, or edit it; then choose Re-run Apply.",
        ...files.map((file) => `${file} · both sides changed the same lines`),
      ],
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
      createdAt: '2026-10-04T09:00:00.000Z',
    };

    const prompt = formatRecoveryPrompt(issue);

    for (const file of files)
      expect(prompt).toContain(`${file} · both sides changed the same lines`);
    expect(prompt).toContain('Resolve each file in /tmp/ws');
  });

  it.each([
    [true, true, 'Choose an action above, or tab to type a correction…'],
    [true, false, 'Type a correction, or tab to choose an action…'],
    [false, true, 'Choose an action above…'],
    [false, false, 'Tab to choose an action…'],
  ] as const)(
    'names the focused side in the composer placeholder (correction %s, menu focused %s)',
    (takesCorrection, menuFocused, hint) => {
      const issue: RecoveryIssue = {
        ...baseIssue,
        availableActions: takesCorrection
          ? ['retry-same-worker', 'skip-current-task', 'end-run']
          : ['skip-current-task', 'end-run'],
      };

      expect(recoveryComposerHint(issue, menuFocused, false)).toBe(hint);
    },
  );

  it.each([true, false])(
    'omits the Tab promise while the stop sheet is open (menu focused %s)',
    (menuFocused) => {
      expect(recoveryComposerHint(baseIssue, menuFocused, true)).toBe('Choose an action above…');
    },
  );
});
