import { join } from 'node:path';
import type { Command } from 'commander';
import { resolveProjectDir } from '../setup.js';
import { assertNotWindows } from '../windows-guard.js';
import { checkServerStatus, readLockfile, type LockfileData } from '../../engine/ipc/lockfile.js';
import { sessionsRoot } from '../../core/paths.js';
import { assignSessionAliases, listSessionDirs } from '../session-aliases.js';
import { renderTable } from '../render-table.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';

export type PsDeps = {
  readLockfile: (sessionDir: string) => Promise<LockfileData | null>;
  checkServerStatus: typeof checkServerStatus;
};

const defaultDeps: PsDeps = {
  readLockfile,
  checkServerStatus,
};

type SessionRow = {
  alias: number | null;
  sessionId: string;
  status: 'running' | 'exited' | 'crashed' | 'unknown';
  pid: number | null;
  mode: WorkflowMode | '-';
  startTimeMs: number;
  endTimeMs: number | null;
  lastAliveMs: number | null;
  feature: string;
  lockfile: LockfileData | null;
};

function formatElapsed(startMs: number, endMs: number): string {
  const totalSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function buildRow(sessDir: string, sessionId: string, deps: PsDeps): Promise<SessionRow> {
  const data: LockfileData | null = await deps.readLockfile(sessDir);

  if (!data) {
    return {
      alias: null,
      sessionId,
      status: 'unknown',
      pid: null,
      mode: '-',
      startTimeMs: 0,
      endTimeMs: null,
      lastAliveMs: null,
      feature: '-',
      lockfile: null,
    };
  }

  const status = await deps.checkServerStatus(sessDir);

  let rowStatus: SessionRow['status'];
  if (status.alive) {
    rowStatus = 'running';
  } else if (!status.alive && status.crashed) {
    rowStatus = 'crashed';
  } else {
    rowStatus = 'exited';
  }

  return {
    alias: null,
    sessionId,
    status: rowStatus,
    pid: data.pid,
    mode: data.mode,
    startTimeMs: data.startTimeMs,
    endTimeMs: data.exitedAt ?? null,
    lastAliveMs: data.lastAliveMs,
    feature: data.feature,
    lockfile: data,
  };
}

function assignDisplayedAliases(rows: SessionRow[]): SessionRow[] {
  const aliases = assignSessionAliases(
    rows
      .filter((row): row is SessionRow & { lockfile: LockfileData } => row.lockfile !== null)
      .map((row) => ({ sessionId: row.sessionId, lockfile: row.lockfile })),
  );
  const aliasBySession = new Map(aliases.map((row) => [row.sessionId, row.alias]));
  return rows.map((row) => ({ ...row, alias: aliasBySession.get(row.sessionId) ?? null }));
}

export async function psCommand(
  opts: { projectDir: string },
  deps: PsDeps = defaultDeps,
): Promise<void> {
  assertNotWindows();

  const root = sessionsRoot(opts.projectDir);
  const names = listSessionDirs(opts.projectDir);

  if (names.length === 0) {
    console.log('No sessions found in this project.');
    return;
  }

  const rows = assignDisplayedAliases(
    await Promise.all(names.map((name) => buildRow(join(root, name), name, deps))),
  );

  rows.sort((a, b) => b.startTimeMs - a.startTimeMs);

  const now = Date.now();

  function elapsedOf(row: SessionRow): string {
    const endMs =
      row.endTimeMs ?? (row.status === 'running' ? now : (row.lastAliveMs ?? row.startTimeMs));
    return row.startTimeMs > 0 ? formatElapsed(row.startTimeMs, endMs) : '-';
  }

  const lines = renderTable<SessionRow>({
    columns: [
      { header: '#', min: 2, value: (r) => (r.alias === null ? '-' : String(r.alias)) },
      { header: 'SESSION ID', min: 10, value: (r) => r.sessionId },
      { header: 'STATUS', min: 7, value: (r) => r.status },
      { header: 'PID', min: 5, value: (r) => String(r.pid ?? '-') },
      { header: 'MODE', min: 8, value: (r) => r.mode },
      { header: 'ELAPSED', min: 9, value: elapsedOf },
      { header: 'FEATURE', min: 0, value: (r) => r.feature },
    ],
    rows,
  });

  for (const line of lines) console.log(line);
}

export function registerPsCommand(program: Command): void {
  program
    .command('ps')
    .description('List all sessions in the current project with their status')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (opts: { project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      await psCommand({ projectDir });
    });
}
