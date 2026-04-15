import { existsSync, renameSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { DIPTYCH_DIR, writeSecureFile } from '../../utils/fs.js';
import {
  STATE_FILE,
  SESSION_LOG_FILE,
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
  sessionsRoot,
  sessionDir,
} from '../../core/paths.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { writeActive } from '../../core/sessions/active.js';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function deriveSessionId(feature: string, startedAt: string, projectDir: string): string {
  const date = new Date(startedAt).toISOString().slice(0, 10);
  const slug = slugify(feature).slice(0, 50);
  const base = `${date}-${slug}`;
  const root = sessionsRoot(projectDir);
  if (!existsSync(join(root, base))) return base;
  if (!existsSync(join(root, `${base}-migrated`))) return `${base}-migrated`;
  return `${base}-migrated-2`;
}

function migrateState(old: Record<string, unknown>): object {
  const { sessionId, ...rest } = old;
  return {
    ...rest,
    stateVersion: CURRENT_STATE_VERSION,
    plannerSessionId: sessionId ?? null,
    awaitingContinue: false,
    messageQueue: [],
  };
}

function migrateEvents(input: string, output: string): void {
  const lines = readFileSync(input, 'utf-8').split('\n');
  const migrated: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (!('kind' in obj)) obj.kind = 'event';
      migrated.push(JSON.stringify(obj));
    } catch {
      console.warn(`Skipping corrupt events line: ${line}`);
    }
  }
  writeSecureFile(output, migrated.join('\n') + '\n');
}

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
    oldState = JSON.parse(stateRaw) as Record<string, unknown>;
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
