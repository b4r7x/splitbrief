import { join } from 'node:path';
import type { Task } from '../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../core/plan-review/types.js';
import { BRIEF_QUALITY_FILE } from '../../core/paths.js';
import { readSessionFileConfined } from '../../core/sessions/confinement.js';
import { isBriefQualityReport, type BriefQualityReport } from '../../engine/spec/brief-quality.js';
import { parseTaskSourceBlocks, parseTasksStrict } from '../../engine/spec/parser.js';
import { refreshPlanReviewMetadata } from './plan-review-metadata.js';

interface LoadBriefReviewDataOptions {
  filePath: string;
  sessionDirPath: string;
  signal?: AbortSignal | undefined;
}

interface LoadBriefReviewDataResult {
  tasks: Task[];
  quality: BriefQualityReport | null;
  reviewMetadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
  briefSources: string[];
}

function parseQualityReport(text: string | null): BriefQualityReport | null {
  if (!text) return null;
  try {
    const parsedQuality = JSON.parse(text) as unknown;
    return isBriefQualityReport(parsedQuality) ? parsedQuality : null;
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
    reviewMetadata: emptyMetadata,
    briefSources: [],
  };
  if (opts.signal?.aborted) return aborted;
  const [tasksText, qualityText] = await Promise.all([
    readSessionFileConfined(opts.sessionDirPath, opts.filePath),
    readSessionFileConfined(opts.sessionDirPath, join(opts.sessionDirPath, BRIEF_QUALITY_FILE)),
  ]);
  if (opts.signal?.aborted) return aborted;
  if (tasksText === null) throw new Error(`Task Brief file is missing: ${opts.filePath}`);

  const tasks = parseTasksStrict(tasksText);
  const quality = parseQualityReport(qualityText);
  const briefSources = alignBriefSources(tasksText, tasks);
  const metadata = await refreshPlanReviewMetadata(tasks);
  if (opts.signal?.aborted) {
    return { tasks, quality, reviewMetadata: emptyMetadata, briefSources };
  }
  return { tasks, quality, reviewMetadata: metadataMap(metadata), briefSources };
}
