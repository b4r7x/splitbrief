import { useEffect, useState } from 'react';
import fs from 'node:fs/promises';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { reviewStore } from '../../../stores/workflow/review.js';
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
  filePath: string | null,
  reader: ReviewContentReader = fs.readFile,
): string {
  const [loaded, setLoaded] = useState<LoadedReviewContent | null>(null);
  const revision = reviewStore.use((s) => s.revision);
  const ownerToken = reviewStore.use((s) => s.ownerToken);

  useEffect(() => {
    if (!filePath) {
      setLoaded(null);
      reviewStore.setRenderedLineCount(0);
      return;
    }

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
  }, [filePath, ownerToken, revision, reader]);

  return loaded?.filePath === filePath &&
    loaded.ownerToken === ownerToken &&
    loaded.revision === revision
    ? loaded.content
    : '';
}
