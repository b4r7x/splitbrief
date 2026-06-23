import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { useReviewContent } from './use-review-content.js';

function Harness({ filePath }: { filePath: string | null }) {
  const content = useReviewContent(filePath);
  return <Text>{content ? `content=${content}` : 'empty'}</Text>;
}

describe('useReviewContent', () => {
  let tmp: string;
  let ui: ReturnType<typeof renderFeature> | null;

  beforeEach(() => {
    resetAllStores();
    tmp = createTempDir('use-review-content');
    ui = null;
  });

  afterEach(() => {
    ui?.unmount();
    cleanupTempDir(tmp);
  });

  it('reads the file without using raw line count as document height', async () => {
    const file = join(tmp, 'spec.md');
    writeFileSync(file, 'line one\nline two\nline three\n');

    ui = renderFeature(<Harness filePath={file} />);

    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('content=line one');
      expect(reviewStore.get().renderedLineCount).toBe(0);
    });
  });

  it('does not write to stores after the component unmounts mid-read', async () => {
    const file = join(tmp, 'spec.md');
    writeFileSync(file, 'mid-read content\n');

    ui = renderFeature(<Harness filePath={file} />);
    // Unmount before giving the microtask/IO a chance to resolve.
    ui.unmount();
    ui = null;
    await tick(50);

    expect(feedbackStore.get().message).toBeNull();
    // renderedLineCount stays at its initial value; the resolved branch never ran.
    expect(reviewStore.get().renderedLineCount).toBe(0);
  });

  it('aborts the prior read when filePath changes', async () => {
    const fileA = join(tmp, 'a.md');
    const fileB = join(tmp, 'b.md');
    writeFileSync(fileA, 'aaa\n');
    writeFileSync(fileB, 'bbb\nbbb\nbbb\n');

    ui = renderFeature(<Harness filePath={fileA} />);
    ui.rerender(<Harness filePath={fileB} />);

    // The final resolved read is for fileB — that's what the user sees.
    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('content=bbb');
      expect(reviewStore.get().renderedLineCount).toBe(0);
      expect(feedbackStore.get().message).toBeNull();
    });
  });

  it('reloads the same file when the review revision changes', async () => {
    const file = join(tmp, 'spec.md');
    writeFileSync(file, 'before edit\n');
    reviewStore.setReviewFile(file);

    ui = renderFeature(<Harness filePath={file} />);

    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('content=before edit');
    });

    reviewStore.setScrollOffset(9);
    reviewStore.setRenderedLineCount(30);
    writeFileSync(file, 'after edit\n');
    reviewStore.reloadReviewFile();

    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('content=after edit');
      expect(reviewStore.get()).toMatchObject({ scrollOffset: 0, renderedLineCount: 0 });
    });
  });
});
