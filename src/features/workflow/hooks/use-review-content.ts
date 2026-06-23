import { useEffect, useState } from 'react';
import fs from 'node:fs/promises';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { labelError } from '../../../utils/format-errors.js';

export function useReviewContent(filePath: string | null): string {
  const [content, setContent] = useState('');
  const revision = reviewStore.use((s) => s.revision);

  useEffect(() => {
    if (!filePath) {
      setContent('');
      reviewStore.setRenderedLineCount(0);
      return;
    }

    const controller = new AbortController();
    setContent('');
    fs.readFile(filePath, { signal: controller.signal, encoding: 'utf8' })
      .then((data) => {
        setContent(data);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setContent('');
        reviewStore.setRenderedLineCount(0);
        feedbackStore.setError(labelError(`Failed to read ${filePath}`, err));
      });

    return () => {
      controller.abort();
    };
  }, [filePath, revision]);

  return content;
}
