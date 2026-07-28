import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { registerApprovalCommand } from './approval.js';
import { isCliError } from '../errors.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import type { ApprovalsStore } from '../../core/schemas/approval-store.js';

let tmp: string;

function seedApprovals(projectDir: string, store: ApprovalsStore): void {
  const splitbriefDir = join(projectDir, SPLITBRIEF_DIR);
  mkdirSync(splitbriefDir, { recursive: true });
  writeFileSync(join(splitbriefDir, 'approvals.json'), JSON.stringify(store));
}

function readApprovals(projectDir: string): ApprovalsStore {
  return JSON.parse(readFileSync(join(projectDir, SPLITBRIEF_DIR, 'approvals.json'), 'utf-8'));
}

async function runApproval(args: string[]): Promise<string[]> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...parts) => logs.push(parts.join(' ')));

  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerApprovalCommand(program);
  await program.parseAsync(['node', 'splitbrief', 'approval', ...args]);
  return logs;
}

const sessionGrant = {
  pattern: 'npm install',
  class: 'package_change' as const,
  scope: 'session' as const,
  sessionId: 'sess-1',
  grantedAt: '2026-01-01T00:00:00.000Z',
};

const alwaysGrant = {
  pattern: 'rm -rf node_modules',
  class: 'destructive' as const,
  scope: 'always' as const,
  grantedAt: '2026-01-02T00:00:00.000Z',
};

const filledStore: ApprovalsStore = { version: 1, grants: [sessionGrant, alwaysGrant] };

const DEAD_PID = 2_147_483_647;

beforeEach(() => {
  tmp = createTempDir('approval-cmd-test');
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

describe('approval list', () => {
  it('prints "No sticky approvals" when store is empty', async () => {
    const logs = await runApproval(['list', '--project', tmp]);

    expect(logs.some((l) => l.includes('No sticky approvals'))).toBe(true);
  });

  it('prints grant rows when store has entries', async () => {
    seedApprovals(tmp, filledStore);

    const logs = await runApproval(['list', '--project', tmp]);

    const output = logs.join('\n');
    expect(output).toContain('npm install');
    expect(output).toContain('rm -rf node_modules');
    expect(output).toContain('session');
    expect(output).toContain('always');
    expect(output).toContain('package_change');
    expect(output).toContain('destructive');
  });
});

describe('approval clear', () => {
  it('clears all grants by default and prints count', async () => {
    seedApprovals(tmp, filledStore);

    const logs = await runApproval(['clear', '--project', tmp]);

    expect(logs.some((l) => l.includes('Cleared 2 approval grant(s)'))).toBe(true);
    const after = readApprovals(tmp);
    expect(after.grants).toHaveLength(0);
  });

  it('clears only session-scoped grants with --scope session', async () => {
    seedApprovals(tmp, filledStore);

    const logs = await runApproval(['clear', '--scope', 'session', '--project', tmp]);

    expect(logs.some((l) => l.includes('Cleared 1 approval grant(s)'))).toBe(true);
    const after = readApprovals(tmp);
    expect(after.grants).toHaveLength(1);
    expect(after.grants[0]!.scope).toBe('always');
  });

  it('clears only always-scoped grants with --scope always', async () => {
    seedApprovals(tmp, filledStore);

    const logs = await runApproval(['clear', '--scope', 'always', '--project', tmp]);

    expect(logs.some((l) => l.includes('Cleared 1 approval grant(s)'))).toBe(true);
    const after = readApprovals(tmp);
    expect(after.grants).toHaveLength(1);
    expect(after.grants[0]!.scope).toBe('session');
  });

  it('exits with error for unknown --scope value', async () => {
    seedApprovals(tmp, filledStore);

    let captured: unknown;
    try {
      await runApproval(['clear', '--scope', 'bogus', '--project', tmp]);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('bogus');
  });

  it('reports 0 cleared when store is already empty', async () => {
    const logs = await runApproval(['clear', '--project', tmp]);

    expect(logs.some((l) => l.includes('Cleared 0 approval grant(s)'))).toBe(true);
  });

  it('reclaims a stale lock left by a dead process and clears anyway', async () => {
    seedApprovals(tmp, filledStore);
    writeFileSync(
      join(tmp, SPLITBRIEF_DIR, 'approvals.json.lock'),
      JSON.stringify({ pid: DEAD_PID, acquiredAt: Date.now() }),
    );

    const logs = await runApproval(['clear', '--project', tmp]);

    expect(logs.some((l) => l.includes('Cleared 2 approval grant(s)'))).toBe(true);
    expect(readApprovals(tmp).grants).toHaveLength(0);
    const files = readdirSync(join(tmp, SPLITBRIEF_DIR));
    expect(files.some((file) => file.endsWith('.lock'))).toBe(false);
  });
});
