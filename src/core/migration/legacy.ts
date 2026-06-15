import { narrowRecord } from '../../utils/type-guards.js';
import { parseJsonlLine } from '../../lib/fs.js';
import { slugify } from '../../utils/slugify.js';
import { sessionsRoot } from '../paths.js';
import { MAX_SLUG_LENGTH } from '../sessions/lifecycle.js';
import { CURRENT_STATE_VERSION } from '../state/machine.js';
import { sessionError } from '../sessions/errors.js';
import { findUnusedId } from '../sessions/find-unused-id.js';

const MAX_MIGRATION_COLLISION_ATTEMPTS = 999;

function datePartFromStartedAt(startedAt: string, fallback: Date): string {
  const parsed = new Date(startedAt);
  const date = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  return date.toISOString().slice(0, 10);
}

export interface DeriveSessionIdInput {
  feature: string;
  startedAt: string;
  projectDir: string;
  now?: Date;
}

export function deriveSessionId(input: DeriveSessionIdInput): string {
  const { feature, startedAt, projectDir, now = new Date() } = input;
  const date = datePartFromStartedAt(startedAt, now);
  const slug = slugify(feature, MAX_SLUG_LENGTH) || 'unknown';
  const base = `${date}-${slug}`;
  const root = sessionsRoot(projectDir);
  const id = findUnusedId({
    root,
    base,
    suffixer: (candidateBase, collisionIndex) =>
      collisionIndex === 1
        ? `${candidateBase}-migrated`
        : `${candidateBase}-migrated-${collisionIndex}`,
    maxCollisionAttempts: MAX_MIGRATION_COLLISION_ATTEMPTS,
  });
  if (id !== null) return id;
  throw sessionError.idCollision(base, MAX_MIGRATION_COLLISION_ATTEMPTS);
}

export function migrateState(old: Record<string, unknown>): object {
  const { sessionId, ...rest } = old;
  return {
    ...rest,
    stateVersion: CURRENT_STATE_VERSION,
    plannerSessionId: sessionId ?? null,
    awaitingContinue: false,
    messageQueue: [],
  };
}

export function migrateEventLines(content: string): { lines: string[]; warnings: string[] } {
  const migrated: string[] = [];
  const warnings: string[] = [];
  for (const line of content.split('\n')) {
    const result = parseJsonlLine(line);
    if (result.kind === 'blank') continue;
    if (result.kind === 'corrupt') {
      warnings.push(`Skipping corrupt events line: ${line}`);
      continue;
    }
    const obj = narrowRecord(result.value);
    if (!obj) {
      warnings.push(`Skipping non-object events line: ${line}`);
      continue;
    }
    if (!('kind' in obj)) obj.kind = 'event';
    migrated.push(JSON.stringify(obj));
  }
  return { lines: migrated, warnings };
}
