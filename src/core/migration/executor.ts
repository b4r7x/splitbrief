import { existsSync, renameSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecureFile } from '../../lib/fs.js';
import { narrowRecord } from '../../utils/type-guards.js';
import {
  DIPTYCH_DIR,
  STATE_FILE,
  SESSION_LOG_FILE,
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
  sessionsRoot,
  sessionDir,
} from '../paths.js';
import { writeActive } from '../sessions/lifecycle.js';
import { deriveSessionId, migrateState, migrateEvents } from './legacy.js';

export type MigrationResult =
  | { status: 'not-needed' }
  | { status: 'skipped'; sourceDir: string; warnings: string[] }
  | { status: 'migrated'; sourceDir: string; sessionId: string; warnings: string[] };

export async function migrateCommand(projectDir: string): Promise<MigrationResult> {
  const legacyCurrent = join(projectDir, DIPTYCH_DIR, 'current');
  const tinySpecCurrent = join(projectDir, '.tiny-spec', 'current');

  let sourceDir: string;
  if (existsSync(legacyCurrent)) {
    sourceDir = legacyCurrent;
  } else if (existsSync(tinySpecCurrent)) {
    sourceDir = tinySpecCurrent;
  } else {
    return { status: 'not-needed' };
  }

  let oldState: Record<string, unknown>;
  try {
    const stateRaw = readFileSync(join(sourceDir, STATE_FILE), 'utf-8');
    const parsed = narrowRecord(JSON.parse(stateRaw));
    if (!parsed) {
      return {
        status: 'skipped',
        sourceDir,
        warnings: [`Legacy state at ${sourceDir}/${STATE_FILE} is not an object. Skipping migration.`],
      };
    }
    oldState = parsed;
  } catch (err) {
    return {
      status: 'skipped',
      sourceDir,
      warnings: [
        `Cannot read legacy state at ${sourceDir}/${STATE_FILE}: ${err instanceof Error ? err.message : String(err)}`,
        'Skipping migration. Delete the legacy directory manually if you want to start fresh.',
      ],
    };
  }

  const feature = String(oldState.feature ?? 'unknown');
  const startedAt = String(oldState.startedAt ?? new Date().toISOString());
  const sessionId = deriveSessionId(feature, startedAt, projectDir);

  const tempDir = `${sessionDir(projectDir, sessionId)}.tmp`;
  const finalDir = sessionDir(projectDir, sessionId);
  const warnings: string[] = [];

  mkdirSync(sessionsRoot(projectDir), { recursive: true, mode: 0o700 });

  rmSync(tempDir, { recursive: true, force: true });

  try {
    const newState = migrateState(oldState);
    writeSecureFile(join(tempDir, STATE_FILE), JSON.stringify(newState, null, 2) + '\n');

    const eventsSource = join(sourceDir, 'events.jsonl');
    if (existsSync(eventsSource)) {
      warnings.push(...migrateEvents(eventsSource, join(tempDir, SESSION_LOG_FILE)));
    }

    for (const fname of [SPEC_FILE, PLAN_FILE, TASKS_FILE] as const) {
      const src = join(sourceDir, fname);
      if (existsSync(src)) {
        writeSecureFile(join(tempDir, fname), readFileSync(src, 'utf-8'));
      }
    }

    renameSync(tempDir, finalDir);
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  writeActive(projectDir, sessionId);
  rmSync(sourceDir, { recursive: true, force: true });

  return { status: 'migrated', sourceDir, sessionId, warnings };
}

export async function maybeMigrate(projectDir: string): Promise<MigrationResult> {
  const legacyCurrent = join(projectDir, DIPTYCH_DIR, 'current');
  const tinySpecCurrent = join(projectDir, '.tiny-spec', 'current');
  if (!existsSync(legacyCurrent) && !existsSync(tinySpecCurrent)) return { status: 'not-needed' };
  return migrateCommand(projectDir);
}
