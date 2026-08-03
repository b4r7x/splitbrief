import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Text } from 'ink';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useReviewContent } from './use-review-content.js';

type ReviewContentReader = NonNullable<Parameters<typeof useReviewContent>[1]>;

const itUnix = process.platform === 'win32' ? it.skip : it;

function Harness({ reader }: { reader?: ReviewContentReader }) {
  const source = reviewStore.use((state) => state.source);
  const content = useReviewContent(source, reader);
  const viewport = terminalSizeStore.use((state) => `${state.cols}x${state.rows}`);
  return <Text>{`${viewport}:${content ? `content=${content}` : 'empty'}`}</Text>;
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
    reviewStore.setReviewFile(file);

    ui = renderFeature(<Harness />);

    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('content=line one');
      expect(reviewStore.get().renderedLineCount).toBe(0);
    });
  });

  it('does not write to stores after the component unmounts mid-read', async () => {
    let resolveRead: ((value: string) => void) | undefined;
    const deferredReader: ReviewContentReader = (_path, { signal }) =>
      new Promise((resolve, reject) => {
        const onAbort = () => {
          reject(new Error('Aborted'));
        };
        signal.addEventListener('abort', onAbort);
        resolveRead = (value: string) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        };
      });

    const file = join(tmp, 'spec.md');
    writeFileSync(file, 'mid-read content\n');
    reviewStore.setReviewFile(file);

    ui = renderFeature(<Harness reader={deferredReader} />);
    ui.unmount();
    ui = null;
    resolveRead?.('should not apply');
    await tick(50);

    expect(feedbackStore.get().message).toBeNull();
    expect(reviewStore.get().renderedLineCount).toBe(0);
  });

  it('keeps content and feedback owned by the active read when superseded readers settle late', async () => {
    const fileA = join(tmp, 'a.md');
    const fileB = join(tmp, 'b.md');
    const fileC = join(tmp, 'c.md');
    const fileD = join(tmp, 'd.md');

    const pending = new Map<
      string,
      {
        resolve: (value: string) => void;
        reject: (error: Error) => void;
      }
    >();
    const reader: ReviewContentReader = (path) =>
      new Promise((resolve, reject) => {
        pending.set(path, { resolve, reject });
      });

    reviewStore.setReviewFile(fileA);
    ui = renderFeature(<Harness reader={reader} />);
    await vi.waitFor(() => {
      expect(pending.has(fileA)).toBe(true);
    });
    reviewStore.setReviewFile(fileB);
    await vi.waitFor(() => {
      expect(pending.has(fileB)).toBe(true);
    });

    const readA = pending.get(fileA);
    const readB = pending.get(fileB);
    if (!readA || !readB) throw new Error('expected pending reads for a.md and b.md');
    readB.resolve('current bbb');
    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('content=current bbb');
      expect(reviewStore.get().renderedLineCount).toBe(0);
      expect(feedbackStore.get().message).toBeNull();
    });

    readA.resolve('stale aaa');
    await tick(50);
    expect(ui?.lastFrame()).toContain('content=current bbb');

    reviewStore.setReviewFile(fileC);
    await vi.waitFor(() => {
      expect(pending.has(fileC)).toBe(true);
    });
    reviewStore.setReviewFile(fileD);
    await vi.waitFor(() => {
      expect(pending.has(fileD)).toBe(true);
    });

    const readC = pending.get(fileC);
    const readD = pending.get(fileD);
    if (!readC || !readD) throw new Error('expected pending reads for c.md and d.md');
    readD.resolve('current ddd');
    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('content=current ddd');
    });

    feedbackStore.setMessage('unrelated feedback');
    readC.reject(new Error('stale failure'));
    await tick(50);
    expect(ui?.lastFrame()).toContain('content=current ddd');
    expect(feedbackStore.get()).toMatchObject({
      message: 'unrelated feedback',
      isError: false,
    });
  });

  it('shows no stale frame and ignores late settlement when the same path gets a new owner', async () => {
    const file = join(tmp, 'same-path.md');
    writeFileSync(file, 'disk content\n');
    reviewStore.setReviewFile(file);
    const pending: Array<{
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }> = [];
    const reader: ReviewContentReader = () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      });

    ui = renderFeature(<Harness reader={reader} />);
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    pending[0]?.resolve('first owner');
    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('content=first owner');
    });

    reviewStore.setReviewFile(file);
    await flushEffects();
    expect(ui.lastFrame()).toContain('empty');
    expect(ui.lastFrame()).not.toContain('first owner');
    await vi.waitFor(() => {
      expect(pending).toHaveLength(2);
    });

    reviewStore.setReviewFile(file);
    await flushEffects();
    expect(ui.lastFrame()).toContain('empty');
    await vi.waitFor(() => {
      expect(pending).toHaveLength(3);
    });

    pending[2]?.resolve('third owner');
    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('content=third owner');
    });

    feedbackStore.setMessage('new owner feedback');
    pending[1]?.reject(new Error('late second-owner failure'));
    await tick(20);
    expect(ui.lastFrame()).toContain('content=third owner');
    expect(feedbackStore.get()).toMatchObject({
      message: 'new owner feedback',
      isError: false,
    });
  });

  it('keeps the same review through viewport rerenders and reloads it after an editor revision', async () => {
    const file = join(tmp, 'spec.md');
    writeFileSync(file, 'before edit\n');
    reviewStore.setReviewFile(file);
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });

    ui = renderFeature(<Harness />);

    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('120x40:content=before edit');
    });

    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('80x24:content=before edit');
    });
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('60x18:content=before edit');
      expect(reviewStore.get().revision).toBe(0);
    });

    reviewStore.setScrollOffset(9);
    reviewStore.setRenderedLineCount(30);
    writeFileSync(file, 'after edit\n');
    reviewStore.reloadReviewFile();

    await vi.waitFor(() => {
      expect(ui?.lastFrame()).toContain('60x18:content=after edit');
      expect(reviewStore.get()).toMatchObject({
        revision: 1,
        scrollOffset: 0,
        renderedLineCount: 0,
      });
    });
  });

  it('surfaces read failures for the active path', async () => {
    const file = join(tmp, 'broken.md');
    writeFileSync(file, 'contents\n');
    reviewStore.setReviewFile(file);

    const reader: ReviewContentReader = async () => {
      throw new Error('boom');
    };

    ui = renderFeature(<Harness reader={reader} />);

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toBe(`Failed to read ${file}: boom`);
      expect(feedbackStore.get().isError).toBe(true);
      expect(ui?.lastFrame()).toContain('empty');
    });
  });

  itUnix(
    'keeps the finalized artifact text when its old candidate becomes an oversized symlink',
    async () => {
      const reviewedText = 'reviewed immutable artifact';
      const candidatePath = join(tmp, 'candidate');
      const replacementPath = join(tmp, 'replacement');
      writeFileSync(candidatePath, reviewedText);
      writeFileSync(replacementPath, 'attacker-canary'.repeat(10_000));
      reviewStore.setReviewArtifact(reviewedText);
      unlinkSync(candidatePath);
      symlinkSync(replacementPath, candidatePath);
      const reader = vi.fn<ReviewContentReader>(async () => {
        throw new Error('artifact reviews must not read a path');
      });

      ui = renderFeature(<Harness reader={reader} />);

      await vi.waitFor(() => {
        expect(ui?.lastFrame()).toContain(`content=${reviewedText}`);
      });
      expect(reviewStore.get()).toMatchObject({
        source: { kind: 'artifact', text: reviewedText },
        filePath: null,
      });
      expect(ui?.lastFrame()).not.toContain('attacker-canary');
      expect(reader).not.toHaveBeenCalled();
      expect(feedbackStore.get().message).toBeNull();
    },
  );
});
