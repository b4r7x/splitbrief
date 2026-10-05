import { error } from '../../utils/error.js';
import { REVIEW_JSON_FILE } from '../paths.js';
import { readSpecFile } from '../paths-io.js';
import { ReviewRecordSchema, type ReviewRecord } from '../schemas/workflow.js';
import type { SessionRef } from '../types/session-ref.js';

export function parseReviewRecord(text: string): ReviewRecord {
  try {
    return ReviewRecordSchema.parse(JSON.parse(text));
  } catch (cause) {
    throw error('invalid-typed-review', 'Invalid typed review in review.json', {}, cause);
  }
}

export function readReviewRecord(ref: {
  projectDir: string;
  sessionId: string;
}): ReviewRecord | null {
  const text = readSpecFile(ref, REVIEW_JSON_FILE);
  return text === null ? null : parseReviewRecord(text);
}

export function readFinalReviewRecord(
  ref: SessionRef,
): { kind: 'final'; record: ReviewRecord } | { kind: 'task-only' } | { kind: 'none' } {
  const record = readReviewRecord(ref);
  if (record === null) return { kind: 'none' };
  return record.scope === 'task' ? { kind: 'task-only' } : { kind: 'final', record };
}
