import { useEffect, useState } from 'react';
import fs from 'node:fs/promises';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { labelError } from '../../../utils/format-errors.js';

export function useReviewContent(filePath: string | null): string {
  const [content, setContent] = useState('');

  useEffect(() => {
    if (!filePath) {
      setContent('');
      reviewStore.setLineCount(0);
      return;
    }

    const controller = new AbortController();
    fs.readFile(filePath, { signal: controller.signal, encoding: 'utf8' }).then((data) => {
      setContent(data);
      reviewStore.setLineCount(data.split('\n').length);
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      setContent('');
      reviewStore.setLineCount(0);
      feedbackStore.setError(labelError(`Failed to read ${filePath}`, err));
    });

    return () => {
      controller.abort();
    };
  }, [filePath]);

  return content;
}
