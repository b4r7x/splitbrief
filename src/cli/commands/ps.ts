import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { resolveProjectDir } from '../setup.js';
import { assertNotWindows } from '../platform.js';
import { checkServerStatus, readLockfile } from '../../engine/ipc/lockfile.js';
import type { LockfileData } from '../../engine/ipc/lockfile.js';
import { sessionsRoot } from '../../core/paths.js';

type SessionRow = {
  sessionId: string;
  status: 'running' | 'exited' | 'crashed' | 'unknown';
  pid: number | null;
  mode: string;
  startTimeMs: number;
  endTimeMs: number | null;
  feature: string;
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

async function buildRow(sessDir: string, sessionId: string): Promise<SessionRow> {
  const data: LockfileData | null = await readLockfile(sessDir);

  if (!data) {
    return {
      sessionId,
      status: 'unknown',
      pid: null,
      mode: '-',
      startTimeMs: 0,
      endTimeMs: null,
      feature: '-',
    };
  }

  const status = await checkServerStatus(sessDir);

  let rowStatus: SessionRow['status'];
  if (status.alive) {
    rowStatus = 'running';
  } else if (!status.alive && status.crashed) {
    rowStatus = 'crashed';
  } else {
    rowStatus = 'exited';
  }

  return {
    sessionId,
    status: rowStatus,
    pid: data.pid,
    mode: data.mode,
    startTimeMs: data.startTimeMs,
    endTimeMs: data.exitedAt ?? null,
    feature: data.feature,
  };
}

export async function psCommand(opts: { projectDir: string }): Promise<void> {
  assertNotWindows();

  const root = sessionsRoot(opts.projectDir);

  if (!existsSync(root)) {
    console.log('No sessions found in this project.');
    return;
  }

  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());

  if (entries.length === 0) {
    console.log('No sessions found in this project.');
    return;
  }

  const rows = await Promise.all(
    entries.map((e) => buildRow(join(root, e.name), e.name)),
  );

  rows.sort((a, b) => b.startTimeMs - a.startTimeMs);

  const now = Date.now();

  const SID_W = Math.max(10, 'SESSION ID'.length, ...rows.map((r) => r.sessionId.length));
  const STATUS_W = Math.max(7, 'STATUS'.length);
  const PID_W = Math.max(5, 'PID'.length, ...rows.map((r) => String(r.pid ?? '-').length));
  const MODE_W = Math.max(8, 'MODE'.length, ...rows.map((r) => r.mode.length));
  const ELAPSED_W = Math.max(9, 'ELAPSED'.length);

  const header = [
    'SESSION ID'.padEnd(SID_W),
    'STATUS'.padEnd(STATUS_W),
    'PID'.padEnd(PID_W),
    'MODE'.padEnd(MODE_W),
    'ELAPSED'.padEnd(ELAPSED_W),
    'FEATURE',
  ].join('  ');

  console.log(header);

  for (const row of rows) {
    const endMs = row.endTimeMs ?? (row.status === 'running' ? now : row.startTimeMs);
    const elapsed = row.startTimeMs > 0 ? formatElapsed(row.startTimeMs, endMs) : '-';
    const line = [
      row.sessionId.padEnd(SID_W),
      row.status.padEnd(STATUS_W),
      String(row.pid ?? '-').padEnd(PID_W),
      row.mode.padEnd(MODE_W),
      elapsed.padEnd(ELAPSED_W),
      row.feature,
    ].join('  ');
    console.log(line);
  }
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
