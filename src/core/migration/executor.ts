import { existsSync, renameSync, readFileSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
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
import { deriveSessionId, migrateState, migrateEventLines } from './legacy.js';
import { toErrorMessage } from '../../utils/format-errors.js';

export type MigrationResult =
  | { status: 'not-needed' }
  | { status: 'skipped'; sourceDir: string; warnings: string[] }
  | { status: 'migrated'; sourceDir: string; sessionId: string; warnings: string[] };

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertLegacyDirConfined(projectDir: string, dir: string): void {
  const realProject = realpathSync(projectDir);
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return;
  }
  if (!isInsideRoot(realProject, realDir)) {
    throw new Error(
      `Legacy directory ${dir} resolves outside project root ${realProject}. Refusing to migrate.`,
    );
  }
}

function findLegacySourceDir(projectDir: string): string | null {
  const candidates = [
    join(projectDir, DIPTYCH_DIR, 'current'),
    join(projectDir, '.tiny-spec', 'current'),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    assertLegacyDirConfined(projectDir, dir);
    return dir;
  }
  return null;
}

export async function migrateCommand(projectDir: string): Promise<MigrationResult> {
  const sourceDir = findLegacySourceDir(projectDir);
  if (sourceDir === null) return { status: 'not-needed' };

  let oldState: Record<string, unknown>;
  try {
    const stateRaw = readFileSync(join(sourceDir, STATE_FILE), 'utf-8');
    const parsed = narrowRecord(JSON.parse(stateRaw));
    if (!parsed) {
      return {
        status: 'skipped',
        sourceDir,
        warnings: [
          `Legacy state at ${sourceDir}/${STATE_FILE} is not an object. Skipping migration.`,
        ],
      };
    }
    oldState = parsed;
  } catch (err) {
    return {
      status: 'skipped',
      sourceDir,
      warnings: [
        `Cannot read legacy state at ${sourceDir}/${STATE_FILE}: ${toErrorMessage(err)}`,
        'Skipping migration. Delete the legacy directory manually if you want to start fresh.',
      ],
    };
  }

  const feature = String(oldState.feature ?? 'unknown');
  const startedAt = String(oldState.startedAt ?? new Date().toISOString());
  const sessionId = deriveSessionId({ feature, startedAt, projectDir });

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
      const { lines, warnings: eventWarnings } = migrateEventLines(
        readFileSync(eventsSource, 'utf-8'),
      );
      warnings.push(...eventWarnings);
      if (lines.length > 0) {
        writeSecureFile(join(tempDir, SESSION_LOG_FILE), `${lines.join('\n')}\n`);
      }
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

  writeActive({ projectDir: projectDir, sessionId: sessionId });
  assertLegacyDirConfined(projectDir, sourceDir);
  rmSync(sourceDir, { recursive: true, force: true });

  return { status: 'migrated', sourceDir, sessionId, warnings };
}

export async function maybeMigrate(projectDir: string): Promise<MigrationResult> {
  return findLegacySourceDir(projectDir) === null
    ? { status: 'not-needed' }
    : migrateCommand(projectDir);
}
