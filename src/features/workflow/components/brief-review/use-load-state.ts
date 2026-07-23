import { useEffect, useState } from 'react';
import { dirname } from 'node:path';
import type { Task } from '../../../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../../../core/plan-review/types.js';
import type { BriefQualityReport } from '../../../../engine/spec/brief-quality.js';
import { toErrorMessage } from '../../../../utils/format-errors.js';
import { loadBriefReviewData } from '../../brief-review-loader.js';
import { reviewStore } from '../../../../stores/workflow/review.js';

export interface BriefData {
  tasks: Task[];
  quality: BriefQualityReport | null;
  reviewMetadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
  briefSources: string[];
}

const emptyBriefData = (): BriefData => ({
  tasks: [],
  quality: null,
  reviewMetadata: new Map<string, PlanTaskReviewMetadata>(),
  briefSources: [],
});

export function useBriefData(filePath: string): BriefData {
  const [data, setData] = useState<BriefData>(emptyBriefData);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function load() {
      const { tasks, quality, reviewMetadata, briefSources } = await loadBriefReviewData({
        filePath,
        sessionDirPath: dirname(filePath),
        signal,
      });
      if (signal.aborted) return;
      setData({ tasks, quality, reviewMetadata, briefSources });
      reviewStore.setLoadError(null);
    }

    load().catch((err) => {
      if (!signal.aborted) {
        setData(emptyBriefData());
        reviewStore.setLoadError(toErrorMessage(err));
      }
    });
    return () => {
      controller.abort();
    };
  }, [filePath]);

  return data;
}
