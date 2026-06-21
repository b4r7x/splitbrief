import { useEffect, useState } from 'react';
import type { Config } from '../../../core/schemas/config.js';
import { collectReadiness } from '../../../core/readiness/collect.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { buildReadinessFailureReport } from '../readiness-failure.js';

export type CollectReadinessFn = typeof collectReadiness;

export function useReadinessFetch(opts: {
  isAttachedClient: boolean;
  routeReadiness: ReadinessReport | undefined;
  projectDir: string;
  config: Config;
  collectReadiness?: CollectReadinessFn | undefined;
}): ReadinessReport | undefined {
  const { isAttachedClient, routeReadiness, projectDir, config } = opts;
  const collect = opts.collectReadiness ?? collectReadiness;
  const [computedReadiness, setComputedReadiness] = useState<ReadinessReport | undefined>(
    routeReadiness,
  );

  useEffect(() => {
    if (isAttachedClient || routeReadiness || !projectDir) return undefined;
    let cancelled = false;
    collect({ projectDir, config })
      .then(({ report }) => {
        if (!cancelled) setComputedReadiness(report);
      })
      .catch((err) => {
        if (!cancelled) {
          setComputedReadiness(buildReadinessFailureReport(projectDir, err));
          feedbackStore.setError('Readiness check failed.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isAttachedClient, routeReadiness, projectDir, config, collect]);

  return routeReadiness ?? computedReadiness;
}
