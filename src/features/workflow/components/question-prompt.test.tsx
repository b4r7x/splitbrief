import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { getQuestionPromptRows } from '../prompt-rows/question.js';
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
});
