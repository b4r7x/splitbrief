import { existsSync, renameSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { writeSecureFile } from '../../utils/fs.js';
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
} from '../../core/paths.js';
import { writeActive } from '../../core/sessions/active.js';
import { deriveSessionId, migrateState, migrateEvents } from '../../core/migration/legacy.js';

export async function migrateCommand(projectDir: string): Promise<void> {
  const legacyCurrent = join(projectDir, DIPTYCH_DIR, 'current');
  const tinySpecCurrent = join(projectDir, '.tiny-spec', 'current');

  let sourceDir: string;
  if (existsSync(legacyCurrent)) {
    sourceDir = legacyCurrent;
  } else if (existsSync(tinySpecCurrent)) {
    sourceDir = tinySpecCurrent;
  } else {
    console.log('Nothing to migrate.');
    return;
  }

  let oldState: Record<string, unknown>;
  try {
    const stateRaw = readFileSync(join(sourceDir, STATE_FILE), 'utf-8');
    const parsed = narrowRecord(JSON.parse(stateRaw));
    if (!parsed) {
      console.warn(`Legacy state at ${sourceDir}/${STATE_FILE} is not an object. Skipping migration.`);
      return;
    }
    oldState = parsed;
  } catch (err) {
    console.warn(`Cannot read legacy state at ${sourceDir}/${STATE_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    console.warn('Skipping migration. Delete the legacy directory manually if you want to start fresh.');
    return;
  }

  const feature = String(oldState.feature ?? 'unknown');
  const startedAt = String(oldState.startedAt ?? new Date().toISOString());
  const sessionId = deriveSessionId(feature, startedAt, projectDir);

  const tempDir = `${sessionDir(projectDir, sessionId)}.tmp`;
  const finalDir = sessionDir(projectDir, sessionId);

  mkdirSync(sessionsRoot(projectDir), { recursive: true, mode: 0o700 });

  const newState = migrateState(oldState);
  writeSecureFile(join(tempDir, STATE_FILE), JSON.stringify(newState, null, 2) + '\n');

  const eventsSource = join(sourceDir, 'events.jsonl');
  if (existsSync(eventsSource)) {
    migrateEvents(eventsSource, join(tempDir, SESSION_LOG_FILE));
  }

  for (const fname of [SPEC_FILE, PLAN_FILE, TASKS_FILE] as const) {
    const src = join(sourceDir, fname);
    if (existsSync(src)) {
      writeSecureFile(join(tempDir, fname), readFileSync(src, 'utf-8'));
    }
  }

  renameSync(tempDir, finalDir);

  writeActive(projectDir, sessionId);

  rmSync(sourceDir, { recursive: true, force: true });

  console.log(`Migrated ${sessionId}. Run 'diptych resume' to continue.`);
}

export async function maybeMigrate(projectDir: string): Promise<void> {
  const legacyCurrent = join(projectDir, DIPTYCH_DIR, 'current');
  const tinySpecCurrent = join(projectDir, '.tiny-spec', 'current');
  if (!existsSync(legacyCurrent) && !existsSync(tinySpecCurrent)) return;
  await migrateCommand(projectDir);
}

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Migrate pre-v3 .diptych/current/ state to new session folder layout')
    .option('-p, --project <dir>', 'Project directory', '.')
    .action(async (opts: { project: string }) => {
      const projectDir = resolve(opts.project);
      await migrateCommand(projectDir);
    });
}
