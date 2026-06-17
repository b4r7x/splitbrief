import { SessionSchema, type Session } from '../schemas/session.js';
import { SummarySchema, type Summary } from '../schemas/summary.js';
import { narrowRecord } from '../../utils/type-guards.js';

export type ParsedPersistedSession =
  | { status: 'ok'; session: Session; migrated: boolean }
  | { status: 'invalid'; error: string };

export type ParsedPersistedSummary =
  | { status: 'ok'; summary: Summary; migrated: boolean }
  | { status: 'invalid'; error: string };

export function parsePersistedSession(value: unknown): ParsedPersistedSession {
  const normalized = normalizePersistedSessionPayload(value);
  const result = SessionSchema.safeParse(normalized.value);
  if (!result.success) return { status: 'invalid', error: result.error.message };
  return { status: 'ok', session: result.data, migrated: normalized.migrated };
}

export function parsePersistedSummary(value: unknown): ParsedPersistedSummary {
  const normalized = normalizePersistedSummaryPayload(value);
  const result = SummarySchema.safeParse(normalized.value);
  if (!result.success) return { status: 'invalid', error: result.error.message };
  return { status: 'ok', summary: result.data, migrated: normalized.migrated };
}

function normalizePersistedSessionPayload(value: unknown): {
  value: unknown;
  migrated: boolean;
} {
  const record = narrowRecord(value);
  if (!record || record.summary === null || record.summary === undefined) {
    return { value, migrated: false };
  }

  const normalized = normalizePersistedSummaryPayload(record.summary);
  if (!normalized.migrated) return { value, migrated: false };

  return {
    value: {
      ...record,
      summary: normalized.value,
    },
    migrated: true,
  };
}

function normalizePersistedSummaryPayload(value: unknown): {
  value: unknown;
  migrated: boolean;
} {
  const summary = narrowRecord(value);
  const costPrediction = narrowRecord(summary?.costPrediction);
  const deterministic = narrowRecord(costPrediction?.deterministic);
  const counts = narrowRecord(deterministic?.contextConfidenceCounts);

  if (!summary || !costPrediction || !deterministic || !counts) {
    return { value, migrated: false };
  }
  if (counts.contextDetected !== undefined) return { value, migrated: false };

  return {
    value: {
      ...summary,
      costPrediction: {
        ...costPrediction,
        deterministic: {
          ...deterministic,
          contextConfidenceCounts: {
            ...counts,
            contextDetected: countContextDetectedTasks(deterministic.tasks),
          },
        },
      },
    },
    migrated: true,
  };
}

function countContextDetectedTasks(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let count = 0;
  for (const entry of value) {
    const task = narrowRecord(entry);
    if (task?.contextConfidence === 'context-detected') count++;
  }
  return count;
}
