import { useEffect, useState } from 'react';
import fs from 'node:fs/promises';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { reviewStore, type ReviewSource } from '../../../stores/workflow/review.js';
import { labelError } from '../../../utils/format-errors.js';

type ReviewContentReader = (
  path: string,
  options: { signal: AbortSignal; encoding: 'utf8' },
) => Promise<string>;

interface LoadedReviewContent {
  content: string;
  filePath: string;
  ownerToken: number;
  revision: number;
}

export function useReviewContent(
  source: ReviewSource | null,
  reader: ReviewContentReader = fs.readFile,
): string {
  const [loaded, setLoaded] = useState<LoadedReviewContent | null>(null);
  const revision = reviewStore.use((s) => s.revision);
  const ownerToken = reviewStore.use((s) => s.ownerToken);

  useEffect(() => {
    if (source?.kind !== 'file') {
      setLoaded(null);
      reviewStore.setRenderedLineCount(0);
      return;
    }

    const filePath = source.filePath;
    const controller = new AbortController();
    const readOwnerToken = ownerToken;
    const readRevision = revision;
    const readStillCurrent = (): boolean => {
      const current = reviewStore.get();
      return (
        !controller.signal.aborted &&
        current.ownerToken === readOwnerToken &&
        current.revision === readRevision
      );
    };
    reader(filePath, { signal: controller.signal, encoding: 'utf8' })
      .then((data) => {
        if (!readStillCurrent()) return;
        setLoaded({
          content: data,
          filePath,
          ownerToken: readOwnerToken,
          revision: readRevision,
        });
      })
      .catch((err: unknown) => {
        if (!readStillCurrent()) return;
        setLoaded(null);
        reviewStore.setRenderedLineCount(0);
        feedbackStore.setError(labelError(`Failed to read ${filePath}`, err));
      });

    return () => {
      controller.abort();
    };
  }, [source, ownerToken, revision, reader]);

  if (source?.kind === 'artifact') return source.text;

  return source?.kind === 'file' &&
    loaded?.filePath === source.filePath &&
    loaded.ownerToken === ownerToken &&
    loaded.revision === revision
    ? loaded.content
    : '';
}
