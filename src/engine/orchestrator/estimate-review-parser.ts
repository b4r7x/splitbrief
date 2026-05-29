import type { PlannerEstimateReviewClassification } from '../../core/schemas/summary.js';
import type { TaskId } from '../../core/schemas/task.js';
import { TaskIdSchema } from '../../core/schemas/task.js';
import { includes, narrowRecord } from '../../utils/type-guards.js';
import { extractJsonBlock } from '../../utils/extract-json-block.js';

export type PlannerEstimateReviewDecision = {
  classification: PlannerEstimateReviewClassification;
  affectedTaskIds: TaskId[];
  reason: string;
  recommendedUserDecision: string;
};

const CLASSIFICATIONS = [
  'ok',
  'split-suggested',
  'risk',
  'needs-user-decision',
] as const satisfies readonly PlannerEstimateReviewClassification[];

function parseTaskIds(value: unknown): TaskId[] {
  if (!Array.isArray(value)) return [];
  const ids: TaskId[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length === 0) continue;
    const parsed = TaskIdSchema.safeParse(entry);
    if (parsed.success) ids.push(parsed.data);
  }
  return ids;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

export function parsePlannerEstimateReview(text: string): PlannerEstimateReviewDecision | null {
  const record = narrowRecord(extractJsonBlock(text));
  if (!record || !includes(CLASSIFICATIONS, record.classification)) return null;

  const affectedTaskIds = parseTaskIds(record.affectedTaskIds ?? record.affected_task_ids);
  const reason = stringField(record, 'reason');
  const recommendedUserDecision = stringField(
    record,
    'recommendedUserDecision',
    'recommended_user_decision',
    'recommendedDecision',
    'recommendation',
  );

  if (reason.length === 0 || recommendedUserDecision.length === 0) return null;
  if (record.classification !== 'ok' && affectedTaskIds.length === 0) return null;

  return {
    classification: record.classification,
    affectedTaskIds,
    reason,
    recommendedUserDecision,
  };
}
