import { useEffect, useRef, useState } from 'react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../../../core/schemas/config.js';
import { collectReadiness } from '../../../../core/readiness/collect.js';
import type { ReadinessReport } from '../../../../core/readiness/types.js';
import { createStartReadinessRecord } from '../../../../core/readiness/format.js';
import { READINESS_FILE, sessionDir } from '../../../../core/paths.js';
import { readActive } from '../../../../core/sessions/lifecycle.js';
import { writeSecureFile } from '../../../../lib/fs.js';
import { feedbackStore } from '../../../../stores/ui/feedback.js';
import { buildReadinessFailureReport } from '../../readiness-failure.js';

export type CollectReadinessFn = typeof collectReadiness;

function persistTuiReadiness(projectDir: string, report: ReadinessReport): void {
  const sessionId = readActive(projectDir);
  if (!sessionId) return;
  const target = join(sessionDir(projectDir, sessionId), READINESS_FILE);
  if (existsSync(target)) return;
  writeSecureFile(target, JSON.stringify(createStartReadinessRecord(report), null, 2) + '\n');
}

export function useWorkflowReadiness(opts: {
  isAttachedClient: boolean;
  routeReadiness: ReadinessReport | undefined;
  projectDir: string;
  config: Config;
  phase: string;
  collectReadiness?: CollectReadinessFn | undefined;
}): {
  readiness: ReadinessReport | undefined;
  readinessLoaded: boolean;
  readinessBlocked: boolean;
} {
  const { isAttachedClient, routeReadiness, projectDir, config, phase } = opts;
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

  const readiness = routeReadiness ?? computedReadiness;
  const readinessLoaded = isAttachedClient || readiness !== undefined;
  const readinessBlocked = !isAttachedClient && readiness?.status === 'blocked';

  const readinessPersistedRef = useRef(false);
  useEffect(() => {
    if (isAttachedClient || routeReadiness || readinessPersistedRef.current) return;
    if (phase === 'idle' || !readiness || readiness.status === 'blocked') return;
    readinessPersistedRef.current = true;
    persistTuiReadiness(projectDir, readiness);
  }, [isAttachedClient, routeReadiness, phase, readiness, projectDir]);

  return { readiness, readinessLoaded, readinessBlocked };
}
