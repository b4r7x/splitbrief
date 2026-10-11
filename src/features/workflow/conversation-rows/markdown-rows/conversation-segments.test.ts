import { describe, expect, it } from 'vitest';
import { defaultTheme } from '../../../../components/theme.js';
import { workflowMarkdownConversationSegments } from './conversation-segments.js';
import { workflowMarkdownRenderSegments } from './review-segments.js';

describe('workflow markdown status colors', () => {
  it.each(['FAIL', 'ERROR', 'WARNING', 'WARN', 'DONE', 'PASS', 'OK'])(
    'keeps prose %s in its markdown tone on both documents',
    (word) => {
      const segment = { kind: 'text', text: `Status ${word}, details unchanged.` } as const;
      expect(workflowMarkdownConversationSegments(segment, { projectDir: undefined })).toEqual([
        { text: segment.text, tone: 'text' },
      ]);
      expect(
        workflowMarkdownRenderSegments({ segment, projectDir: undefined, theme: defaultTheme }),
      ).toEqual([{ text: segment.text }]);
    },
  );

  it.each([
    ['FAILED', 'error'],
    ['BLOCKED', 'error'],
    ['NOT VERIFIED', 'error'],
    ['INCONCLUSIVE', 'warning'],
    ['VERIFIED', 'success'],
    ['PASSED', 'success'],
  ] as const)('uses the same %s tone in the transcript and review', (text, tone) => {
    const segment = { kind: 'text', text: `Status ${text}, details unchanged.` } as const;
    const transcript = workflowMarkdownConversationSegments(segment, { projectDir: undefined });
    const review = workflowMarkdownRenderSegments({
      segment,
      projectDir: undefined,
      theme: defaultTheme,
    });
    expect(transcript).toContainEqual({ text, tone });
    expect(review).toContainEqual({ text, style: { color: defaultTheme[tone], bold: false } });
    expect(transcript.find((span) => span.text === 'Status ')?.tone).toBe('text');
  });
});
