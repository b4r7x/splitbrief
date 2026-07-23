import { describe, expect, it } from 'vitest';
import { getTheme } from '../../../components/theme.js';
import type { MarkdownLayoutSegment } from '../../../utils/markdown/types.js';
import { workflowMarkdownRenderSegments } from './markdown-rows/review-segments.js';

describe('workflowMarkdownRenderSegments', () => {
  it('colors only the status word, leaving the doc region free of accent/state hues', () => {
    const theme = getTheme();
    const segment: MarkdownLayoutSegment = {
      kind: 'text',
      text: 'T001 in src/foo.ts is HIGH risk and FAILED',
    };

    const parts = workflowMarkdownRenderSegments({ segment, theme, projectDir: undefined });

    expect(parts).toContainEqual({ text: 'T001' });
    expect(parts).toContainEqual({ text: 'src/foo.ts', style: { color: theme.textDim } });
    expect(parts).toContainEqual({ text: 'HIGH' });
    expect(parts).toContainEqual({
      text: 'FAILED',
      style: { color: theme.dimError, bold: false },
    });
    expect(
      parts.every(
        (part) =>
          part.text === 'FAILED' || part.style === undefined || part.style.color === theme.textDim,
      ),
    ).toBe(true);
  });

  it('does not color short prose verdict words on the doc surface', () => {
    const theme = getTheme();
    const segment: MarkdownLayoutSegment = {
      kind: 'text',
      text: 'all checks PASS and tasks DONE, nothing is OK to skip',
    };

    const parts = workflowMarkdownRenderSegments({ segment, theme, projectDir: undefined });

    expect(parts.every((part) => part.style === undefined)).toBe(true);
    expect(parts.map((part) => part.text).join('')).toBe(
      'all checks PASS and tasks DONE, nothing is OK to skip',
    );
  });

  it('folds an inconclusive verdict to a dim word on the doc surface', () => {
    const theme = getTheme();
    const segment: MarkdownLayoutSegment = { kind: 'text', text: 'result is INCONCLUSIVE' };

    const parts = workflowMarkdownRenderSegments({ segment, theme, projectDir: undefined });

    expect(parts).toContainEqual({
      text: 'INCONCLUSIVE',
      style: { color: theme.textDim, bold: false },
    });
  });
});
