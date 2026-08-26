import { useEffect, useState } from 'react';
import { dirname } from 'node:path';
import type { Task } from '../../../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../../../core/plan-review/types.js';
import type { BriefRecoveryProjectionV1 } from '../../../../core/schemas/brief-recovery/document.js';
import type { BriefQualityReport } from '../../../../engine/spec/brief-quality.js';
import type { BriefReadinessGateReport } from '../../../../engine/orchestrator/planning/brief-readiness-gate.js';
import { briefQualityReportFromProjection } from '../../../../engine/orchestrator/planning/brief-quality-preparation.js';
import { toErrorMessage } from '../../../../utils/format-errors.js';
import { loadBriefReviewData } from '../../brief-review-loader.js';
import { reviewStore } from '../../../../stores/workflow/review.js';

interface BriefDataFields {
  tasks: Task[];
  quality: BriefQualityReport | null;
  readiness: BriefReadinessGateReport | null;
  recovery: BriefRecoveryProjectionV1 | null;
  reviewMetadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
  briefSources: string[];
}

interface LoadingBriefData extends BriefDataFields {
  status: 'loading';
  tasks: [];
  quality: null;
  readiness: null;
  recovery: null;
  reviewMetadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
  briefSources: [];
}

interface LoadedBriefData extends BriefDataFields {
  status: 'loaded';
  filePath: string;
  ownerToken: number;
  revision: number;
}

type BriefData = LoadingBriefData | LoadedBriefData;

const EMPTY_BRIEF_DATA: LoadingBriefData = {
  status: 'loading',
  tasks: [],
  quality: null,
  readiness: null,
  reviewMetadata: new Map<string, PlanTaskReviewMetadata>(),
  briefSources: [],
  recovery: null,
};

export type BriefDataLoader = typeof loadBriefReviewData;

export function useBriefData(
  filePath: string,
  load: BriefDataLoader = loadBriefReviewData,
): BriefData {
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

    async function run() {
      const result = await load({
        filePath,
        sessionDirPath: dirname(filePath),
        signal,
      });
      if (!loadStillCurrent()) return;
      const recovery = result.recovery ?? null;
      setLoaded({
        status: 'loaded',
        filePath,
        ownerToken: loadOwnerToken,
        revision: loadRevision,
        tasks: result.tasks,
        quality: recovery === null ? result.quality : briefQualityReportFromProjection(recovery),
        readiness: result.readiness,
        recovery,
        reviewMetadata: result.reviewMetadata,
        briefSources: result.briefSources,
      });
      reviewStore.setLoadError(null);
    }

    run().catch((err) => {
      if (!loadStillCurrent()) return;
      setLoaded(null);
      reviewStore.setLoadError(toErrorMessage(err));
    });
    return () => {
      controller.abort();
    };
  }, [filePath, ownerToken, revision, load]);

  return loaded?.filePath === filePath &&
    loaded.ownerToken === ownerToken &&
    loaded.revision === revision
    ? loaded
    : EMPTY_BRIEF_DATA;
}
