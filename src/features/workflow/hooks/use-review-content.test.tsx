import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { useReviewContent, type ReviewContentReader } from './use-review-content.js';

function Harness({ filePath, reader }: { filePath: string | null; reader?: ReviewContentReader }) {
  const content = useReviewContent(filePath, reader);
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
    let resolveRead: ((value: string) => void) | undefined;
    const deferredReader: ReviewContentReader = (_path, { signal }) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          return;
        }
        const onAbort = () => {
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        };
        signal.addEventListener('abort', onAbort);
        resolveRead = (value: string) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        };
      });

    const file = join(tmp, 'spec.md');
    writeFileSync(file, 'mid-read content\n');

    ui = renderFeature(<Harness filePath={file} reader={deferredReader} />);
    ui.unmount();
    ui = null;
    resolveRead?.('should not apply');
    await tick(50);

    expect(feedbackStore.get().message).toBeNull();
    expect(reviewStore.get().renderedLineCount).toBe(0);
  });

  it('aborts the prior read when filePath changes', async () => {
    const fileA = join(tmp, 'a.md');
    const fileB = join(tmp, 'b.md');
    writeFileSync(fileA, 'aaa\n');
    writeFileSync(fileB, 'bbb\n');

    let resolveA: ((value: string) => void) | undefined;
    let resolveB: ((value: string) => void) | undefined;

    const reader: ReviewContentReader = (path, { signal }) =>
      new Promise((resolve, reject) => {
        const onAbort = () => {
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        };
        signal.addEventListener('abort', onAbort);
        const settle = (value: string) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        };
        if (path === fileA) resolveA = settle;
        if (path === fileB) resolveB = settle;
      });

    ui = renderFeature(<Harness filePath={fileA} reader={reader} />);
    ui.rerender(<Harness filePath={fileB} reader={reader} />);

    resolveB?.('bbb');
    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('content=bbb');
      expect(reviewStore.get().renderedLineCount).toBe(0);
      expect(feedbackStore.get().message).toBeNull();
    });

    resolveA?.('stale aaa');
    await tick(50);
    expect(ui?.lastFrame()).toContain('content=bbb');
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

  it('surfaces read failures for the active path', async () => {
    const file = join(tmp, 'broken.md');
    writeFileSync(file, 'contents\n');

    const reader: ReviewContentReader = async () => {
      throw new Error('boom');
    };

    ui = renderFeature(<Harness filePath={file} reader={reader} />);

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toBe(`Failed to read ${file}: boom`);
      expect(feedbackStore.get().isError).toBe(true);
      expect(ui?.lastFrame()).toContain('empty');
    });
  });
});
