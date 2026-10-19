import { describe, expect, it } from 'vitest';
import { layoutFeedbackNotice } from './feedback-notice.js';

describe('layoutFeedbackNotice', () => {
  it.for([
    {
      surface: 'Settings',
      width: 90,
      message:
        'Saved BUILD fallback · OpenCode CLI · Claude Sonnet 4.5 · via anthropic to .splitbrief/config.yaml · OpenCode CLI has no credential for anthropic — run opencode auth login anthropic before start',
      lines: [
        'Saved BUILD fallback · OpenCode CLI · Claude Sonnet 4.5 · via anthropic to',
        '.splitbrief/config.yaml · OpenCode CLI has no credential for anthropic — run opencode auth',
        'login anthropic before start',
      ],
    },
    {
      surface: 'Setup',
      width: 120,
      message:
        'Saved PLAN · OpenCode CLI · DeepSeek V4.1 Flash 1017 · via openrouter to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore',
      lines: [
        'Saved PLAN · OpenCode CLI · DeepSeek V4.1 Flash 1017 · via openrouter to .splitbrief/config.yaml · Added .splitbrief/ to',
        '.gitignore',
      ],
    },
  ])(
    'wraps a $surface save message at $width columns with no row led by a space and no path cut',
    ({ width, message, lines }) => {
      const notice = layoutFeedbackNotice({ message, isError: false }, width);

      expect(notice?.text.split('\n')).toEqual(lines);
      expect(notice?.rows).toBe(1 + lines.length);
    },
  );
});
