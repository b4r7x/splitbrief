import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecureFile } from '../../lib/fs.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { slugify } from '../../utils/slugify.js';
import { sessionsRoot } from '../paths.js';
import { CURRENT_STATE_VERSION } from '../state/machine.js';
import { sessionError } from '../sessions/errors.js';

const MAX_MIGRATION_COLLISION_ATTEMPTS = 999;

function datePartFromStartedAt(startedAt: string, fallback: Date): string {
  const parsed = new Date(startedAt);
  const date = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  return date.toISOString().slice(0, 10);
}

function collisionCandidates(base: string): string[] {
  const candidates = [base, `${base}-migrated`];
  for (let n = 2; n <= MAX_MIGRATION_COLLISION_ATTEMPTS; n++) {
    candidates.push(`${base}-migrated-${n}`);
  }
  return candidates;
}

export function deriveSessionId(
  feature: string,
  startedAt: string,
  projectDir: string,
  now: Date = new Date(),
): string {
  const date = datePartFromStartedAt(startedAt, now);
  const slug = slugify(feature).slice(0, 50) || 'unknown';
  const base = `${date}-${slug}`;
  const root = sessionsRoot(projectDir);
  for (const candidate of collisionCandidates(base)) {
    if (!existsSync(join(root, candidate))) return candidate;
  }
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

export function migrateEvents(input: string, output: string): string[] {
  const lines = readFileSync(input, 'utf-8').split('\n');
  const migrated: string[] = [];
  const warnings: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = narrowRecord(JSON.parse(trimmed));
      if (!obj) {
        warnings.push(`Skipping non-object events line: ${line}`);
        continue;
      }
      if (!('kind' in obj)) obj.kind = 'event';
      migrated.push(JSON.stringify(obj));
    } catch {
      warnings.push(`Skipping corrupt events line: ${line}`);
    }
  }
  writeSecureFile(output, migrated.join('\n') + '\n');
  return warnings;
}
