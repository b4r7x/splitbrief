import { useEffect, useState } from 'react';
import { dirname } from 'node:path';
import type { Task } from '../../../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../../../core/plan-review/types.js';
import type { BriefQualityReport } from '../../../../engine/spec/brief-quality.js';
import { toErrorMessage } from '../../../../utils/format-errors.js';
import { loadBriefReviewData } from '../../brief-review-loader.js';
import { reviewStore } from '../../../../stores/workflow/review.js';

interface BriefData {
  tasks: Task[];
  quality: BriefQualityReport | null;
  reviewMetadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
  briefSources: string[];
}

interface LoadedBriefData extends BriefData {
  filePath: string;
  ownerToken: number;
  revision: number;
}

const EMPTY_BRIEF_DATA: BriefData = {
  tasks: [],
  quality: null,
  reviewMetadata: new Map<string, PlanTaskReviewMetadata>(),
  briefSources: [],
};

export function useBriefData(filePath: string): BriefData {
  const [loaded, setLoaded] = useState<LoadedBriefData | null>(null);
  const revision = reviewStore.use((state) => state.revision);
  const ownerToken = reviewStore.use((state) => state.ownerToken);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const loadOwnerToken = ownerToken;
    const loadRevision = revision;
    const loadStillCurrent = (): boolean => {
      const current = reviewStore.get();
      return (
        !signal.aborted &&
        current.ownerToken === loadOwnerToken &&
        current.revision === loadRevision
      );
    };
    if (loadStillCurrent()) reviewStore.setLoadError(null);

    async function load() {
      const { tasks, quality, reviewMetadata, briefSources } = await loadBriefReviewData({
        filePath,
        sessionDirPath: dirname(filePath),
        signal,
      });
      if (!loadStillCurrent()) return;
      setLoaded({
        filePath,
        ownerToken: loadOwnerToken,
        revision: loadRevision,
        tasks,
        quality,
        reviewMetadata,
        briefSources,
      });
      reviewStore.setLoadError(null);
    }

    load().catch((err) => {
      if (!loadStillCurrent()) return;
      setLoaded(null);
      reviewStore.setLoadError(toErrorMessage(err));
    });
    return () => {
      controller.abort();
    };
  }, [filePath, ownerToken, revision]);

  return loaded?.filePath === filePath &&
    loaded.ownerToken === ownerToken &&
    loaded.revision === revision
    ? loaded
    : EMPTY_BRIEF_DATA;
}
