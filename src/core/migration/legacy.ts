import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecureFile } from '../../lib/fs.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { sessionsRoot } from '../paths.js';
import { CURRENT_STATE_VERSION } from '../state/machine.js';

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

export function deriveSessionId(feature: string, startedAt: string, projectDir: string): string {
  const date = new Date(startedAt).toISOString().slice(0, 10);
  const slug = slugify(feature).slice(0, 50);
  const base = `${date}-${slug}`;
  const root = sessionsRoot(projectDir);
  if (!existsSync(join(root, base))) return base;
  if (!existsSync(join(root, `${base}-migrated`))) return `${base}-migrated`;
  return `${base}-migrated-2`;
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

export function migrateEvents(input: string, output: string): void {
  const lines = readFileSync(input, 'utf-8').split('\n');
  const migrated: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = narrowRecord(JSON.parse(trimmed));
      if (!obj) {
        console.warn(`Skipping non-object events line: ${line}`);
        continue;
      }
      if (!('kind' in obj)) obj.kind = 'event';
      migrated.push(JSON.stringify(obj));
    } catch {
      console.warn(`Skipping corrupt events line: ${line}`);
    }
  }
  writeSecureFile(output, migrated.join('\n') + '\n');
}
