import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Command } from 'commander';
import { canonicalizeProjectDir } from '../setup.js';
import { assertNotWindows } from '../windows-guard.js';
import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';
import { checkServerStatus, readLockfile, type LockfileData } from '../../engine/ipc/lockfile.js';
import {
  sessionsRoot,
  sessionDir,
  isolationMarkerPath,
  ISOLATION_TREES_DIR,
  isolationWorktreeRoot,
  isValidSessionId,
} from '../../core/paths.js';
import { listOrphanSessionIds, pruneOrphanSessions } from '../../core/sessions/orphans.js';
import { getGitCommonDir } from '../../lib/git/repository.js';
import { assertIsolationDirReadable } from '../../engine/worktree/path.js';
import {
  type IsolationMarker,
  parseIsolationMarker,
} from '../../engine/orchestrator/isolation/worktree.js';
import { warnError } from '../../lib/warn.js';
import {
  assignSessionAliases,
  listValidSessionDirs,
  sessionSortKeyMs,
} from '../sessions/aliases.js';
import { renderTable } from '../render-table.js';
import { formatTime } from '../../utils/format-time.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { formatShellArgv } from '../../utils/shell-quote.js';
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

type IsolationWorktreeReport = {
  kind: 'orphaned' | 'unowned';
  path: string;
  sessionId: string;
};

async function listIsolationWorktreeReports(
  projectDir: string,
): Promise<IsolationWorktreeReport[]> {
  // A project that is not a git repository never had an isolation worktree to
  // orphan, so there is nothing to report rather than something to warn about.
  let gitCommonDir: string;
  try {
    gitCommonDir = await getGitCommonDir(projectDir);
  } catch {
    return [];
  }
  const reports: IsolationWorktreeReport[] = [];
  try {
    assertIsolationDirReadable({ projectDir, gitCommonDir });
    const isolationDir = isolationWorktreeRoot(gitCommonDir);
    if (!existsSync(isolationDir)) return [];
    for (const entry of readdirSync(isolationDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const wtDir = join(isolationDir, entry.name);
      if (!existsSync(join(wtDir, '.git')) || !statSync(join(wtDir, '.git')).isFile()) continue;
      let marker: IsolationMarker;
      try {
        marker = parseIsolationMarker(readFileSync(isolationMarkerPath(wtDir), 'utf8'));
      } catch {
        continue;
      }
      // The isolation root is shared by every linked worktree of the repository
      // while sessions are per-checkout, so only the marker's own project can
      // decide the question. Without one the worktree is listed, never judged.
      if (marker.projectDir === null) {
        reports.push({ kind: 'unowned', path: wtDir, sessionId: marker.sessionId });
        continue;
      }
      if (
        !isValidSessionId(marker.sessionId) ||
        !existsSync(sessionDir(marker.projectDir, marker.sessionId))
      ) {
        reports.push({ kind: 'orphaned', path: wtDir, sessionId: marker.sessionId });
      }
    }
  } catch (err) {
    warnError(`isolation worktrees: cannot scan ${ISOLATION_TREES_DIR}`, err);
    return [];
  }
  return reports;
}

async function printCollectionHints(projectDir: string, pruned: boolean): Promise<void> {
  if (!pruned) {
    const collectable = listOrphanSessionIds({ projectDir }).length;
    if (collectable === 1) {
      console.log(
        '1 collectable session directory exists; run "splitbrief ps --prune" to collect it.',
      );
    } else if (collectable > 1) {
      console.log(
        `${collectable} collectable session directories exist; run "splitbrief ps --prune" to collect them.`,
      );
    }
  }
  for (const worktree of await listIsolationWorktreeReports(projectDir)) {
    const path = stripTerminalControls(worktree.path);
    if (worktree.kind === 'unowned') {
      console.log(
        `Isolation worktree "${path}" records no owning project; check that no run is using it before removing it.`,
      );
      continue;
    }
    const branch = `${SPLITBRIEF_IDENTITY.branchPrefix}${stripTerminalControls(basename(worktree.path))}`;
    const removeCommand = formatShellArgv(['git', 'worktree', 'remove', path, '--force']);
    const deleteBranchCommand = formatShellArgv(['git', 'branch', '-D', branch]);
    console.log(
      `Orphaned isolation worktree "${path}" (session ${stripTerminalControls(worktree.sessionId)} no longer exists); remove it with "${removeCommand}" then "${deleteBranchCommand}".`,
    );
  }
}

export async function psCommand(
  opts: { projectDir: string; prune?: boolean },
  deps: PsDeps = defaultDeps,
): Promise<void> {
  assertNotWindows();

  if (opts.prune) {
    const pruned = pruneOrphanSessions({ projectDir: opts.projectDir });
    for (const sessionId of pruned.removed) {
      console.log(`Removed collectable session directory ${sessionId}.`);
    }
    console.log(
      `Collected ${pruned.removed.length} orphaned session director${pruned.removed.length === 1 ? 'y' : 'ies'}.`,
    );
  }

  const root = sessionsRoot(opts.projectDir);
  const names = listValidSessionDirs(opts.projectDir);

  if (names.length === 0) {
    console.log('No sessions found in this project.');
    await printCollectionHints(opts.projectDir, opts.prune ?? false);
    return;
  }

  const rows = assignDisplayedAliases(
    await Promise.all(names.map((name) => buildRow(join(root, name), name, deps))),
  ).filter((row) => row.lockfile !== null || row.sortKeyMs > 0);

  if (rows.length === 0) {
    console.log('No sessions found in this project.');
    await printCollectionHints(opts.projectDir, opts.prune ?? false);
    return;
  }

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
      { header: 'SESSION ID', min: 10, value: (r) => stripTerminalControls(r.sessionId) },
      { header: 'STATUS', min: 7, value: (r) => r.status },
      { header: 'PID', min: 5, value: (r) => String(r.pid ?? '-') },
      { header: 'MODE', min: 8, value: (r) => r.mode },
      { header: 'ELAPSED', min: 9, value: elapsedOf },
      { header: 'FEATURE', min: 0, value: (r) => stripTerminalControls(r.feature) },
    ],
    rows,
  });

  for (const line of lines) console.log(line);
  await printCollectionHints(opts.projectDir, opts.prune ?? false);
}

export function registerPsCommand(program: Command): void {
  program
    .command('ps')
    .description('List all sessions in the current project with their status')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--prune', 'Remove collectable session directories before listing')
    .action(async (opts: { project?: string; prune?: boolean }) => {
      const projectDir = await canonicalizeProjectDir(opts);
      await psCommand({ projectDir, prune: opts.prune ?? false });
    });
}
