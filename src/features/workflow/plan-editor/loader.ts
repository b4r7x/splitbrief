import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import {
  isBriefQualityReport,
  type BriefQualityReport,
} from '../../../engine/spec/brief-quality.js';
import { parseTasksStrict } from '../../../engine/spec/parser.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { refreshPlanReviewMetadata } from '../plan-review-metadata.js';

interface LoadPlanEditorDataOptions {
  filePath: string;
  sessionDirPath: string;
  signal?: AbortSignal | undefined;
  skipInitEditor?: boolean | undefined;
}

interface LoadPlanEditorDataResult {
  tasks: Task[];
  quality: BriefQualityReport | null;
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

export async function loadPlanEditorData(
  opts: LoadPlanEditorDataOptions,
): Promise<LoadPlanEditorDataResult> {
  const [tasksText, qualityText] = await Promise.all([
    readFile(opts.filePath, { encoding: 'utf8', signal: opts.signal }),
    readFile(join(opts.sessionDirPath, 'brief-quality.json'), {
      encoding: 'utf8',
      signal: opts.signal,
    }).catch(() => null),
  ]);
  if (opts.signal?.aborted) return { tasks: [], quality: null };

  const tasks = parseTasksStrict(tasksText);
  const quality = parseQualityReport(qualityText);
  if (!opts.skipInitEditor) planEditorStore.initEditor(tasks);
  const metadata = await refreshPlanReviewMetadata(tasks);
  if (opts.signal?.aborted) return { tasks, quality };
  if (metadata !== null) planEditorStore.setReviewMetadata(metadata);

  return { tasks, quality };
}
