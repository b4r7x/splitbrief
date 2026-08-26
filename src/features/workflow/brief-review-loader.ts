import { basename, join } from 'node:path';
import { error } from '../../utils/error.js';
import { isRecord } from '../../utils/type-guards.js';
import type { Task } from '../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../core/plan-review/types.js';
import {
  BRIEF_QUALITY_FILE,
  BRIEF_READINESS_FILE,
  STATE_FILE,
  isValidSessionId,
} from '../../core/paths.js';
import {
  type BriefRecoveryProjectionV1,
  BriefRecoveryProjectionV1Schema,
} from '../../core/schemas/brief-recovery/document.js';
import { WorkflowStateSchema } from '../../core/schemas/workflow.js';
import { readSessionFileConfined } from '../../core/sessions/confinement.js';
import { isBriefQualityReport, type BriefQualityReport } from '../../engine/spec/brief-quality.js';
import type { BriefReadinessGateReport } from '../../engine/orchestrator/planning/brief-readiness-gate.js';
import { projectBriefRecovery } from '../../engine/orchestrator/planning/brief-recovery-controller.js';
import { parseTaskSourceBlocks, parseTasksStrict } from '../../engine/spec/tasks/parse.js';
import { refreshPlanReviewMetadata } from './plan-review-metadata.js';

interface LoadBriefReviewDataOptions {
  filePath: string;
  sessionDirPath: string;
  signal?: AbortSignal | undefined;
}

export interface LoadBriefReviewDataResult {
  tasks: Task[];
  quality: BriefQualityReport | null;
  readiness: BriefReadinessGateReport | null;
  recovery: BriefRecoveryProjectionV1 | null;
  reviewMetadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
  briefSources: string[];
}

function parseQualityReport(text: string | null): BriefQualityReport | null {
  if (!text) return null;
  try {
    const parsedQuality: unknown = JSON.parse(text);
    return isBriefQualityReport(parsedQuality) ? parsedQuality : null;
  } catch {
    return null;
  }
}

function isReadinessReport(value: unknown): value is BriefReadinessGateReport {
  if (!isRecord(value)) return false;
  return typeof value.ok === 'boolean' && Array.isArray(value.blocks);
}

function parseReadinessReport(text: string | null): BriefReadinessGateReport | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isReadinessReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseRecoveryProjection(
  text: string | null,
  sessionDirPath: string,
): BriefRecoveryProjectionV1 | null {
  if (!text) return null;
  const sessionId = basename(sessionDirPath);
  if (!isValidSessionId(sessionId)) return null;

  try {
    const parsedState: unknown = JSON.parse(text);
    const state = WorkflowStateSchema.safeParse(parsedState);
    if (!state.success || state.data.briefRecovery === null) return null;
    return BriefRecoveryProjectionV1Schema.parse(
      projectBriefRecovery({
        sessionId,
        now: new Date().toISOString(),
        state: {
          stateVersion: state.data.stateVersion,
          stateRevision: state.data.stateRevision ?? 0,
          stateFence: state.data.stateFence ?? { token: 0, ownerId: 'brief-review-loader' },
          phase: state.data.phase,
          briefRecovery: state.data.briefRecovery,
        },
      }),
    );
  } catch {
    return null;
  }
}

function metadataMap(
  metadata: readonly PlanTaskReviewMetadata[] | null,
): ReadonlyMap<string, PlanTaskReviewMetadata> {
  const map = new Map<string, PlanTaskReviewMetadata>();
  for (const item of metadata ?? []) map.set(item.taskId, item);
  return map;
}

function alignBriefSources(tasksText: string, tasks: Task[]): string[] {
  const sourceById = new Map(
    parseTaskSourceBlocks(tasksText).map((block) => [block.id, block.source]),
  );
  return tasks.map((task) => sourceById.get(task.id) ?? '');
}

export async function loadBriefReviewData(
  opts: LoadBriefReviewDataOptions,
): Promise<LoadBriefReviewDataResult> {
  const emptyMetadata = new Map<string, PlanTaskReviewMetadata>();
  const aborted: LoadBriefReviewDataResult = {
    tasks: [],
    quality: null,
    readiness: null,
    recovery: null,
    reviewMetadata: emptyMetadata,
    briefSources: [],
  };
  if (opts.signal?.aborted) return aborted;
  const [tasksText, qualityText, readinessText, stateText] = await Promise.all([
    readSessionFileConfined(opts.sessionDirPath, opts.filePath),
    readSessionFileConfined(opts.sessionDirPath, join(opts.sessionDirPath, BRIEF_QUALITY_FILE)),
    readSessionFileConfined(opts.sessionDirPath, join(opts.sessionDirPath, BRIEF_READINESS_FILE)),
    readSessionFileConfined(opts.sessionDirPath, join(opts.sessionDirPath, STATE_FILE)),
  ]);
  if (opts.signal?.aborted) return aborted;
  if (tasksText === null) {
    throw error('brief-file-missing', `Task Brief file is missing: ${opts.filePath}`, {
      filePath: opts.filePath,
    });
  }

  const tasks = parseTasksStrict(tasksText);
  const quality = parseQualityReport(qualityText);
  const readiness = parseReadinessReport(readinessText);
  const recovery = parseRecoveryProjection(stateText, opts.sessionDirPath);
  const briefSources = alignBriefSources(tasksText, tasks);
  const metadata = await refreshPlanReviewMetadata(tasks);
  if (opts.signal?.aborted) {
    return { tasks, quality, readiness, recovery, reviewMetadata: emptyMetadata, briefSources };
  }
  return {
    tasks,
    quality,
    readiness,
    recovery,
    reviewMetadata: metadataMap(metadata),
    briefSources,
  };
}
