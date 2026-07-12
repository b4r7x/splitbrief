import { createElement } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { useReferenceCompletion } from './hook.js';

const FILES = ['src/app.ts', 'src/index.ts'];

function ShowSuggestionsHarness({ value, suppressed }: { value: string; suppressed?: boolean }) {
  const reference = useReferenceCompletion({
    files: FILES,
    value,
    setValue: () => {},
    suppressed,
  });
  return createElement(Text, null, String(reference.showSuggestions));
}

describe('useReferenceCompletion suppression', () => {
  it('suppressed hides reference suggestions', async () => {
    const shown = renderFeature(createElement(ShowSuggestionsHarness, { value: '@src' }));
    await tick(20);
    expect(shown.lastFrame()).toContain('true');
    shown.unmount();

    const hidden = renderFeature(
      createElement(ShowSuggestionsHarness, { value: '@src', suppressed: true }),
    );
    await tick(20);
    expect(hidden.lastFrame()).toContain('false');
    hidden.unmount();
  });
});
