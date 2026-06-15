import { join } from 'node:path';
import type { Command } from 'commander';
import { resolveProjectDir } from '../setup.js';
import { assertNotWindows } from '../windows-guard.js';
import { checkServerStatus, readLockfile, type LockfileData } from '../../engine/ipc/lockfile.js';
import { sessionsRoot } from '../../core/paths.js';
import { assignSessionAliases, listSessionDirs, sessionSortKeyMs } from '../sessions/aliases.js';
import { renderTable } from '../render-table.js';
import { formatTime } from '../../utils/format-time.js';
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
  sortKeyMs: number;
  endTimeMs: number | null;
  lastAliveMs: number | null;
  feature: string;
  lockfile: LockfileData | null;
};

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
      sortKeyMs: sessionSortKeyMs(sessDir, null),
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
  } else if (status.crashed) {
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
    sortKeyMs: data.startTimeMs,
    endTimeMs: data.exitedAt ?? null,
    lastAliveMs: data.lastAliveMs,
    feature: data.feature,
    lockfile: data,
  };
}

function assignDisplayedAliases(rows: SessionRow[]): SessionRow[] {
  const aliases = assignSessionAliases(
    rows
      .filter((row) => row.lockfile !== null || row.sortKeyMs > 0)
      .map((row) => ({
        sessionId: row.sessionId,
        sortKeyMs: row.sortKeyMs,
        lockfile: row.lockfile,
      })),
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

  rows.sort((a, b) => b.sortKeyMs - a.sortKeyMs);

  const now = Date.now();

  function elapsedOf(row: SessionRow): string {
    const endMs =
      row.endTimeMs ?? (row.status === 'running' ? now : (row.lastAliveMs ?? row.startTimeMs));
    return row.startTimeMs > 0 ? formatTime(endMs - row.startTimeMs) : '-';
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
