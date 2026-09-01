import { describe, expect, it } from 'vitest';
import { getTheme } from '../../../components/theme.js';
import { workflowMarkdownRenderSegments } from '../conversation-rows/markdown-rows/review-segments.js';
import { renderReviewRows } from './review-rows-cache.js';

const theme = getTheme();
const source = '# Title\n\nSome **bold** body text.\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n';

function options(overrides: Partial<Parameters<typeof renderReviewRows>[0]> = {}) {
  return {
    source,
    width: 60,
    theme,
    decorateSegment: workflowMarkdownRenderSegments,
    projectDir: '/tmp/project',
    ...overrides,
  };
}

describe('renderReviewRows', () => {
  it('reuses the rendered rows when every input is unchanged', () => {
    const first = renderReviewRows(options());
    const second = renderReviewRows(options());

    expect(second).toBe(first);
  });

  it('re-renders when the source changes', () => {
    const first = renderReviewRows(options());
    const second = renderReviewRows(options({ source: `${source}\nAppended paragraph.\n` }));

    expect(second).not.toBe(first);
    expect(second.length).toBeGreaterThan(first.length);
  });

  it('re-renders when the width changes', () => {
    const wide = renderReviewRows(options({ width: 80 }));
    const narrow = renderReviewRows(options({ width: 24 }));

    expect(narrow).not.toBe(wide);
  });

  it('re-renders when the theme changes', () => {
    const first = renderReviewRows(options({ theme: getTheme() }));
    const modifiedTheme = { ...getTheme(), accent: 'magenta' };
    const second = renderReviewRows(options({ theme: modifiedTheme }));

    expect(second).not.toBe(first);
  });

  it('re-renders when the project directory changes', () => {
    const first = renderReviewRows(options({ projectDir: '/tmp/project' }));
    const second = renderReviewRows(options({ projectDir: '/tmp/other' }));

    expect(second).not.toBe(first);
  });

  it('produces the same row shape whether or not the cache is hit', () => {
    const cached = renderReviewRows(options());
    renderReviewRows(options({ source: 'unrelated document' }));
    const recomputed = renderReviewRows(options());

    expect(recomputed).not.toBe(cached);
    expect(recomputed.map((row) => [row.key, row.lines])).toEqual(
      cached.map((row) => [row.key, row.lines]),
    );
  });
});
