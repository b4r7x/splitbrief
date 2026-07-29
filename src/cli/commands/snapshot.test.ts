import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdirSync, utimesSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { isCliError } from '../errors.js';
import { registerSnapshotCommand } from './snapshot.js';

let tmp: string;
let consoleSpy: ReturnType<typeof vi.spyOn>;

function makeSessionDir(sessionId: string): void {
  mkdirSync(join(tmp, '.splitbrief', 'sessions', sessionId), { recursive: true });
}

async function makeAliasableSession(sessionId: string, sortKeyMs: number): Promise<void> {
  makeSessionDir(sessionId);
  const summaryPath = join(tmp, '.splitbrief', 'sessions', sessionId, 'summary.json');
  await writeFile(summaryPath, '{}');
  const time = new Date(sortKeyMs);
  utimesSync(summaryPath, time, time);
}

beforeEach(() => {
  tmp = createTempDir('snapshot-command-test');
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

function captureOutput(): string {
  return consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

async function runSnapshot(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerSnapshotCommand(program);
  await program.parseAsync(['node', 'splitbrief', 'snapshot', ...args]);
}

describe('snapshot create', () => {
  it('creates a snapshot and prints the ID when --session is provided', async () => {
    makeSessionDir('test-sess');
    await writeFile(join(tmp, 'src.ts'), 'export {}');

    await runSnapshot(['create', '--project', tmp, '--session', 'test-sess']);

    const out = captureOutput();
    expect(out).toMatch(/Snapshot created:/);
    expect(out).toMatch(/Files:/);
    expect(out).toMatch(/Location:/);
    expect(out).toMatch(/Initialized snapshot baseline/);
    expect(out).not.toMatch(/Snapshot created: baseline$/m);
  });

  it('first invocation produces a snapshot that subsequently appears in list output', async () => {
    makeSessionDir('first-sess');
    await writeFile(join(tmp, 'src.ts'), 'v1');

    await runSnapshot(['create', '--project', tmp, '--session', 'first-sess', '--name', 'kickoff']);
    expect(captureOutput()).toContain('kickoff');
    consoleSpy.mockClear();

    await runSnapshot(['list', '--project', tmp, '--session', 'first-sess']);
    const out = captureOutput();
    expect(out).not.toMatch(/No snapshots found/);
    expect(out).toMatch(/kickoff/);
    expect(out).toMatch(/files=/);
  });

  it('refuses to create a snapshot for a session id with no existing session dir', async () => {
    await writeFile(join(tmp, 'src.ts'), 'export {}');

    let captured: unknown;
    try {
      await runSnapshot(['create', '--project', tmp, '--session', 'missing-sess']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toMatch(/session 'missing-sess' not found/);
    expect(existsSync(join(tmp, '.splitbrief', 'sessions', 'missing-sess'))).toBe(false);
  });
});

describe('snapshot list', () => {
  it('prints "No snapshots found" when no non-baseline snapshots exist', async () => {
    await runSnapshot(['list', '--project', tmp, '--session', 'test-sess']);
    const out = captureOutput();
    expect(out).toMatch(/No snapshots found for session test-sess/);
  });

  it('lists created snapshots after creating them', async () => {
    makeSessionDir('test-sess');
    await writeFile(join(tmp, 'src.ts'), 'version 1');

    await runSnapshot(['create', '--project', tmp, '--session', 'test-sess']);
    consoleSpy.mockClear();

    await writeFile(join(tmp, 'src.ts'), 'version 2');
    await runSnapshot(['create', '--project', tmp, '--session', 'test-sess']);
    consoleSpy.mockClear();

    await runSnapshot(['list', '--project', tmp, '--session', 'test-sess']);
    const out = captureOutput();

    expect(out).toMatch(/files=/);
    expect(out).toMatch(/phase=manual/);
  });
});

describe('snapshot session resolution', () => {
  it.each([
    ['create'],
    ['list'],
  ])('%s exits 1 with actionable message when no active session and no --session', async (subcommand) => {
    let captured: unknown;
    try {
      await runSnapshot([subcommand, '--project', tmp]);
    } catch (err) {
      captured = err;
    }
    expect(isCliError(captured)).toBe(true);
    const msg = (captured as Error).message;
    expect(msg).toMatch(/active session|--session/i);
  });

  it('resolves numeric --session aliases for create, list, restore, and diff', async () => {
    await makeAliasableSession('older-session', 1_000);
    await makeAliasableSession('snapshot-session', 2_000);
    await writeFile(join(tmp, 'src.ts'), 'version 1');

    await runSnapshot(['create', '--project', tmp, '--session', '1']);
    const createOutput = captureOutput();
    const snapshotId = createOutput.match(/Snapshot created: (\S+)/)?.[1];
    if (snapshotId === undefined) throw new Error('snapshot id not printed');

    consoleSpy.mockClear();
    await runSnapshot(['list', '--project', tmp, '--session', '1']);
    expect(captureOutput()).toMatch(/phase=manual/);

    consoleSpy.mockClear();
    await runSnapshot(['diff', snapshotId, '--project', tmp, '--session', '1']);
    expect(captureOutput()).toContain(`No differences from snapshot ${snapshotId}`);

    consoleSpy.mockClear();
    await runSnapshot(['restore', snapshotId, '--project', tmp, '--session', '1']);
    expect(captureOutput()).toContain(`from snapshot ${snapshotId}`);
  });
});
