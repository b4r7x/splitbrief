import { beforeEach, describe, expect, it } from 'vitest';
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

  beforeEach(() => {
    resetAllStores();
    tmp = createTempDir('use-review-content');
  });

  it('reads the file and syncs content + lineCount to reviewStore', async () => {
    const file = join(tmp, 'spec.md');
    writeFileSync(file, 'line one\nline two\nline three\n');

    const ui = renderFeature(<Harness filePath={file} />);
    await tick(20);

    expect(ui.lastFrame()).toContain('content=line one');
    expect(reviewStore.get().lineCount).toBe(4); // trailing newline → 4 split segments
    ui.unmount();
    cleanupTempDir(tmp);
  });

  it('does not write to stores after the component unmounts mid-read', async () => {
    const file = join(tmp, 'spec.md');
    writeFileSync(file, 'mid-read content\n');

    const ui = renderFeature(<Harness filePath={file} />);
    // Unmount before giving the microtask/IO a chance to resolve.
    ui.unmount();
    await tick(50);

    expect(feedbackStore.get().message).toBeNull();
    // lineCount stays at its initial value; the resolved branch never ran.
    expect(reviewStore.get().lineCount).toBe(0);
    cleanupTempDir(tmp);
  });

  it('aborts the prior read when filePath changes', async () => {
    const fileA = join(tmp, 'a.md');
    const fileB = join(tmp, 'b.md');
    writeFileSync(fileA, 'aaa\n');
    writeFileSync(fileB, 'bbb\nbbb\nbbb\n');

    const ui = renderFeature(<Harness filePath={fileA} />);
    ui.rerender(<Harness filePath={fileB} />);
    await tick(50);

    // The final resolved read is for fileB — that's what the user sees.
    expect(ui.lastFrame()).toContain('content=bbb');
    expect(reviewStore.get().lineCount).toBe(4);
    expect(feedbackStore.get().message).toBeNull();
    ui.unmount();
    cleanupTempDir(tmp);
  });
});
