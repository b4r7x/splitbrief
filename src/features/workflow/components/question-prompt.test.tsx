import { describe, expect, it, vi } from 'vitest';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { getQuestionPromptRows } from '../prompt-rows/question.js';
import { getRecoveryPromptRows } from '../prompt-rows/recovery.js';
import { QuestionPrompt } from './question-prompt.js';

const RAW_TOKEN = 'abcdefghijklmnopqrstuvwxyz1234567890abcdef';
const MULTILINE_HINT = [
  'Task review: T001 - Run command',
  `Validation: npm test \u001b]52;c;clipboard\u0007token=${RAW_TOKEN}`,
  '',
  'Commands: continue, redo, notes <text>, abort',
].join('\n');

describe('QuestionPrompt', () => {
  it('renders the prompt as a sanitized multiline panel', () => {
    const rows = getQuestionPromptRows(MULTILINE_HINT, 80);
    const ui = renderFeature(
      <QuestionPrompt hint={MULTILINE_HINT} width={80} clampedBoxRows={rows} />,
    );

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Task review: T001 - Run command');
    expect(frame).toContain('Validation: npm test token=***REDACTED***');
    expect(frame).toContain('Commands: continue, redo, notes <text>, abort');
    expect(frame).not.toContain(RAW_TOKEN);
    expect(frame).not.toContain('clipboard');
    expect(frame).not.toContain('\u001b');

    ui.unmount();
  });

  it('resolves the seat swap in one press and lists no tool of its own', async () => {
    const onResolve = vi.fn();
    const issue = makeRecoveryIssue({
      id: 'recovery-six-tools',
      reason: 'runner-usage-limit',
      message: 'The BUILD tool reached its usage limit.',
      switchSeat: {
        seat: 'build',
        candidates: [
          { tool: 'opencode' },
          { tool: 'codex' },
          { tool: 'claude-code', model: 'sonnet' },
          { tool: 'cursor' },
          { tool: 'copilot' },
          { tool: 'kilo-code' },
        ],
      },
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
    });
    const rows = Math.min(10, getRecoveryPromptRows(issue, 100));
    const ui = renderFeature(
      <QuestionPrompt
        hint=""
        width={100}
        clampedBoxRows={rows}
        recoveryIssue={issue}
        recoveryMenuFocused
        onRecoveryFocusChange={() => {}}
        onRecoveryResolve={onResolve}
      />,
    );
    await flushEffects();

    expect(stripAnsiStyles(ui.lastFrame())).toContain('Change BUILD tool');
    expect(stripAnsiStyles(ui.lastFrame())).not.toContain('more ready tools');

    // Six tools were offered and the panel names none of them: the driver answers `w` by opening
    // the seat's picker, where a tool is chosen beside the model it will run.
    ui.stdin.write('\r');
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(onResolve).toHaveBeenCalledExactlyOnceWith('w');
    expect(frame).not.toContain('OpenCode CLI');
    expect(frame).not.toContain('Kilo Code CLI');
    ui.unmount();
  });
});
