import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { isCliError } from '../errors.js';
import { registerSnapshotCommand } from './snapshot.js';

let tmp: string;
let consoleSpy: ReturnType<typeof vi.spyOn>;

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
  await program.parseAsync(['node', 'diptych', 'snapshot', ...args]);
}

describe('snapshot create', () => {
  it('exits 1 with actionable message when no active session and no --session', async () => {
    let captured: unknown;
    try {
      await runSnapshot(['create', '--project', tmp]);
    } catch (err) {
      captured = err;
    }
    expect(isCliError(captured)).toBe(true);
    const msg = (captured as Error).message;
    expect(msg).toMatch(/active session|--session/i);
  });

  it('creates a snapshot and prints the ID when --session is provided', async () => {
    await writeFile(join(tmp, 'src.ts'), 'export {}');

    await runSnapshot(['create', '--project', tmp, '--session', 'test-sess']);

    const out = captureOutput();
    expect(out).toMatch(/Snapshot created:/);
    expect(out).toMatch(/Files:/);
    expect(out).toMatch(/Location:/);
    // The very first snapshot must NOT print just "baseline" — that is an
    // internal identifier the user can never list or restore by name. The
    // CLI follows up with a real, listable snapshot.
    expect(out).toMatch(/Initialized snapshot baseline/);
    expect(out).not.toMatch(/Snapshot created: baseline$/m);
  });

  it('first invocation produces a snapshot that subsequently appears in list output', async () => {
    await writeFile(join(tmp, 'src.ts'), 'v1');

    await runSnapshot(['create', '--project', tmp, '--session', 'first-sess', '--name', 'kickoff']);
    consoleSpy.mockClear();

    await runSnapshot(['list', '--project', tmp, '--session', 'first-sess']);
    const out = captureOutput();
    expect(out).not.toMatch(/No snapshots found/);
    expect(out).toMatch(/kickoff/);
    expect(out).toMatch(/files=/);
  });

  it('prints the name when --name is provided', async () => {
    await runSnapshot(['create', '--project', tmp, '--session', 'test-sess', '--name', 'my snap']);

    const out = captureOutput();
    expect(out).toContain('my snap');
  });
});

describe('snapshot list', () => {
  it('prints "No snapshots found" when no non-baseline snapshots exist', async () => {
    await runSnapshot(['list', '--project', tmp, '--session', 'test-sess']);
    const out = captureOutput();
    expect(out).toMatch(/No snapshots found for session test-sess/);
  });

  it('lists created snapshots after creating them', async () => {
    await writeFile(join(tmp, 'src.ts'), 'version 1');

    // Create baseline
    await runSnapshot(['create', '--project', tmp, '--session', 'test-sess']);
    consoleSpy.mockClear();

    // Modify and create a delta snapshot
    await writeFile(join(tmp, 'src.ts'), 'version 2');
    await runSnapshot(['create', '--project', tmp, '--session', 'test-sess']);
    consoleSpy.mockClear();

    // List
    await runSnapshot(['list', '--project', tmp, '--session', 'test-sess']);
    const out = captureOutput();

    // Should show at least one non-baseline snapshot
    expect(out).toMatch(/files=/);
    expect(out).toMatch(/phase=manual/);
  });

  it('exits 1 with actionable message when no active session and no --session', async () => {
    let captured: unknown;
    try {
      await runSnapshot(['list', '--project', tmp]);
    } catch (err) {
      captured = err;
    }
    expect(isCliError(captured)).toBe(true);
    const msg = (captured as Error).message;
    expect(msg).toMatch(/active session|--session/i);
  });
});
