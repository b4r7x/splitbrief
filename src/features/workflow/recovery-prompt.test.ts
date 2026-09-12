import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { RecoveryIssue, SwitchSeatOffer } from '../../core/schemas/recovery/schemas.js';
import { taskId } from '../../core/schemas/task.js';
import { glyph } from '../../lib/glyphs.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { PromptBody } from './components/prompt-body.js';
import {
  formatActionRow,
  formatRecoveryActionLines,
  formatRecoveryPrompt,
  isActionRowLine,
  parseRecoveryActionAnswer,
  passHeadlinePrefix,
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
  reason: 'validation-failed',
  phase: 'validating-task',
  status: 'awaiting-user',
  taskId: taskId('T003'),
  taskTitle: 'Patch auth validation',
  files: ['src/auth/session.ts', 'src/auth/session.test.ts'],
  affectedTaskIds: [taskId('T003')],
  message: 'T003 validation failed',
  details: [
    'Validation test failed: npm test -- auth failed in src/auth/session.test.ts',
    'Attempts: 3/3',
    'Worker profile: local-qwen',
    'Bigger worker available: cheap-cloud',
  ],
  attempts: 3,
  maxAttempts: 3,
  selectedImplementerProfile: 'local-qwen',
  facts: {
    validationStage: 'test',
    validationSummary: 'npm test -- auth failed',
    routeBiggerProfile: 'cheap-cloud',
  },
  availableActions: [
    'retry-same-worker',
    'route-bigger-worker',
    'planner-split-rebase',
    'skip-current-task',
    'pause-run',
    'abort-workflow',
  ],
  recommendedAction: 'route-bigger-worker',
  createdAt: '2026-04-29T12:00:00.000Z',
};

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
      availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'abort-workflow'],
      recommendedAction: 'switch-seat',
    };
  }

  it('states a quota halt once, in the clock the header uses', async () => {
    const resetAt = new Date();
    resetAt.setHours(17, 0, 0, 0);
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'opencode' }]),
      message:
        'Ollama hit its usage limit. The limit resets at Jan 1, 2026, 5:00 PM; wait for it, switch the seat to another tool, or abort.',
      facts: { tool: 'Ollama' },
      resetAt: resetAt.toISOString(),
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('recovery needed · Ollama hit its limit · resets 17:00');
    expect(visible).not.toContain('5:00 PM');
    expect(visible.match(/resets 17:00/g)).toHaveLength(1);
  });

  it('gives each tool a quota-blocked seat can switch to its own row', async () => {
    const issue = usageLimitIssue([{ tool: 'claude-code', model: 'sonnet' }, { tool: 'opencode' }]);

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('[w1]  switch BUILD to Claude Code CLI · sonnet');
    expect(visible).toContain('[w2]  switch BUILD to OpenCode CLI');
    expect(visible).toContain('[r]  retry same worker');
    expect(visible).toContain('[a]  abort');
    expect(visible).not.toContain('opencode,');
  });

  it('keeps the bare seat key when only one tool is offered', async () => {
    const issue = usageLimitIssue([{ tool: 'opencode' }]);

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('[w]  switch BUILD to OpenCode CLI');
    expect(visible).not.toContain('[w1]');
    expect(parseRecoveryActionAnswer('w2', issue)).toBeNull();
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

    expect(visible).toContain('[w3]  switch BUILD to Cursor Agent CLI');
    expect(visible).toContain('(2 more ready tools detected)');
    expect(visible).not.toContain('[w4]');
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

  it('builds a compact validation recovery prompt with only available actions', async () => {
    const prompt = formatRecoveryPrompt(baseIssue);
    const visible = await renderPromptBody(prompt);

    expect(visible).toContain('recovery needed · T003 validation failed after 3 attempts');
    expect(visible).toContain('task T003 · Patch auth validation');
    expect(visible).toContain('files src/auth/session.ts · src/auth/session.test.ts');
    expect(visible).toContain(
      'last check test failed: npm test -- auth failed in src/auth/session.test.ts',
    );
    expect(visible).toContain('[r]  retry same worker');
    expect(visible).toContain('[b]  route to bigger worker · cheap-cloud');
    expect(visible).toContain('[s]  skip task');
    expect(visible).toContain('[space]  pause');
    expect(visible).toContain('[a]  abort');
    expect(visible).not.toContain('[c]  continue');
    expect(visible).not.toContain('ask planner');
  });

  it('emits the rebase action with its tail on a separate continuation line', () => {
    const lines = formatRecoveryActionLines(
      ['planner-split-rebase', 'pause-run'],
      { reason: 'user-edit-conflict' },
      'planner-split-rebase',
    );

    expect(lines[0]).toBe('▌ [p]  ask planner to rebase on your edits');
    expect(lines[1]).toBe('(approve / edit / reject the proposal)');
    expect(lines[0]).not.toContain('(approve');
  });

  it('serializes the rows into a flat prompt with the recommended accent marker', () => {
    const prompt = formatRecoveryPrompt(baseIssue);

    expect(prompt).toContain('recovery needed · T003 validation failed after 3 attempts');
    expect(prompt).toContain('▌ [b]  route to bigger worker · cheap-cloud');
    expect(prompt).toContain('[r]  retry same worker');
    expect(prompt).not.toContain('[c]  continue');
  });

  it('shares one action-row shape between the builder and the parser detector', () => {
    const row = formatActionRow('r', 'retry same worker');

    expect(row).toBe('[r]  retry same worker');
    expect(isActionRowLine(row)).toBe(true);
    expect(isActionRowLine(`${recommendedRowPrefix()}${row}`)).toBe(true);
    expect(isActionRowLine('task T003 · Patch auth validation')).toBe(false);
  });

  it('parses answers into typed recovery actions', () => {
    expect(parseRecoveryActionAnswer('r', baseIssue)).toBe('retry-same-worker');
    expect(parseRecoveryActionAnswer('route bigger', baseIssue)).toBe('route-bigger-worker');
    expect(parseRecoveryActionAnswer('skip', baseIssue)).toBe('skip-current-task');
    expect(parseRecoveryActionAnswer(' ', baseIssue)).toBe('pause-run');
    expect(parseRecoveryActionAnswer('abort', baseIssue)).toBe('abort-workflow');
  });

  it('marks the recommended action and applies it only for empty Enter', async () => {
    const prompt = formatRecoveryPrompt(baseIssue);
    const visible = await renderPromptBody(prompt);

    expect(visible).toContain(`${glyph('liveBar')} [b]  route to bigger worker · cheap-cloud`);
    expect(parseRecoveryActionAnswer('', baseIssue)).toBe('route-bigger-worker');
  });

  it('returns null for unknown or unavailable non-empty input so the caller re-prompts', () => {
    expect(parseRecoveryActionAnswer('continue', baseIssue)).toBeNull();
    expect(parseRecoveryActionAnswer('p', baseIssue)).toBeNull();
    expect(parseRecoveryActionAnswer('nope', baseIssue)).toBeNull();
  });

  it('marks and applies pause when the recommended action is not promptable', async () => {
    const issue: RecoveryIssue = {
      ...baseIssue,
      id: 'rec_unpromptable',
      availableActions: ['planner-split-rebase', 'pause-run', 'abort-workflow'],
      recommendedAction: 'planner-split-rebase',
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain(`${glyph('liveBar')} [space]  pause`);
    expect(parseRecoveryActionAnswer('', issue)).toBe('pause-run');
  });

  it('parses continue only when the issue allows it', () => {
    const issue: RecoveryIssue = {
      id: 'rec_budget_pause',
      reason: 'budget-paused',
      phase: 'implementing',
      status: 'awaiting-user',
      message: 'Budget pause at 87%',
      files: [],
      affectedTaskIds: [],
      details: ['Spent $4.36 of $5.00'],
      facts: { currentCost: 4.36, maxBudget: 5, belowMaxBudget: true },
      availableActions: ['continue', 'pause-run', 'abort-workflow'],
      recommendedAction: 'continue',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    expect(parseRecoveryActionAnswer('c', issue)).toBe('continue');
  });

  it('hides ordinary continue for budget exceeded even if malformed state advertises it', async () => {
    const issue: RecoveryIssue = {
      id: 'rec_budget',
      reason: 'budget-exceeded',
      phase: 'implementing',
      status: 'awaiting-user',
      message: 'Budget exceeded at 105%',
      files: [],
      affectedTaskIds: [],
      details: [
        'Spent $5.25 of $5.00',
        'Blocked step: before T004',
        'Continuing requires a separate raise-budget flow.',
      ],
      facts: { currentCost: 5.25, maxBudget: 5 },
      availableActions: ['continue', 'pause-run', 'abort-workflow'],
      recommendedAction: 'continue',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('recovery needed · Budget exceeded at 105%');
    expect(visible).toContain('spent $5.25 of $5.00');
    expect(visible).toContain('[space]  pause');
    expect(visible).toContain('[a]  abort');
    expect(visible).not.toContain('[c]  continue');
    expect(parseRecoveryActionAnswer('c', issue)).toBeNull();
  });

  it('hides legacy planner rebase actions and falls back to pause', async () => {
    const issue: RecoveryIssue = {
      id: 'rec_user_edit',
      reason: 'user-edit-conflict',
      phase: 'implementing',
      status: 'awaiting-user',
      message: 'User edits conflict with T004',
      taskId: taskId('T004'),
      taskTitle: 'Update session store',
      files: ['src/auth/session.ts'],
      affectedTaskIds: [taskId('T004'), taskId('T006')],
      details: ['Conflict kind: current-task-conflict', 'Safe to continue: no'],
      facts: { conflictKind: 'current-task-conflict', safeToContinue: false },
      availableActions: [
        'planner-split-rebase',
        'skip-current-task',
        'pause-run',
        'abort-workflow',
      ],
      recommendedAction: 'planner-split-rebase',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    const visible = await renderPromptBody(formatRecoveryPrompt(issue));

    expect(visible).toContain('[space]  pause');
    expect(visible).not.toContain('ask planner');
    expect(parseRecoveryActionAnswer('p', issue)).toBeNull();
  });

  it('uses ascii recommended-row and pass-headline prefixes when the glyph tier is ascii', () => {
    const prev = process.env.TERM;
    process.env.TERM = 'dumb';
    try {
      const lines = formatRecoveryActionLines(['route-bigger-worker'], {}, 'route-bigger-worker');
      expect(lines[0]).toBe(`${glyph('liveBar', 'ascii')} [b]  route to bigger worker`);
      expect(passHeadlinePrefix()).toBe(`${glyph('check', 'ascii')} `);
    } finally {
      process.env.TERM = prev;
    }
  });
});
