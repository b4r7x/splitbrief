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

  it.each([
    [90, 'Could not release the run lock: permission denied · .splitbrief/…/lockfile.json …'],
    [78, 'Could not release the run lock: permission denied · …/lockfile.json …'],
    [70, 'Could not release the run lock: permission denied · …/lockfile.json …'],
  ])('keeps the file name of an error on its one row at %i columns', (width, text) => {
    const notice = layoutFeedbackNotice(
      {
        message:
          'Could not release the run lock: permission denied · .splitbrief/sessions/2026-10-23-create-src-kebab-js-commonjs-exporting-kebab-text-/lockfile.json · other SPLITBRIEF processes can see the run as running for a few more seconds',
        isError: true,
      },
      width,
    );

    expect(notice).toEqual({ text, isError: true, rows: 2 });
  });
});
