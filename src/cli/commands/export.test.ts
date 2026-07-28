import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { isCliError } from '../errors.js';
import { registerExportCommand } from './export.js';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('export-command-test');
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDir(projectDir);
});

function writeSession(sessionId: string, startedAt = 1_000): void {
  const sessionDirectory = join(projectDir, '.splitbrief', 'sessions', sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(
    join(sessionDirectory, 'summary.json'),
    JSON.stringify(
      makeSession({
        id: sessionId,
        status: 'complete',
        feature: sessionId,
        startedAt,
        completedAt: Date.parse('2026-05-04T12:00:00Z'),
        summary: makeSummary({ feature: sessionId, totalTasks: 1, completedByLocal: 1 }),
      }),
    ),
  );
}

async function runExport(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerExportCommand(program);
  await program.parseAsync(['node', 'splitbrief', 'export', ...args]);
}

describe('export command', () => {
  it('writes report.html for an explicit session', async () => {
    writeSession('session-one');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message) => {
      logs.push(message);
    });

    await runExport(['session-one', '--project', projectDir]);

    const reportPath = join(projectDir, '.splitbrief', 'sessions', 'session-one', 'report.html');
    expect(readFileSync(reportPath, 'utf-8')).toMatch(/^<!DOCTYPE html>/);
    expect(logs).toContain(`Report written to ${reportPath}`);
  });

  it('writes to --out when provided', async () => {
    writeSession('session-one');
    const outPath = join(projectDir, 'custom-report.html');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runExport(['session-one', '--project', projectDir, '--out', outPath]);

    expect(readFileSync(outPath, 'utf-8')).toContain('<title>SPLITBRIEF — session-one</title>');
  });

  it('uses the most recent completed session when no session is specified', async () => {
    writeSession('old-session', 1_000);
    writeSession('new-session', 2_000);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runExport(['--project', projectDir]);

    const reportPath = join(projectDir, '.splitbrief', 'sessions', 'new-session', 'report.html');
    expect(readFileSync(reportPath, 'utf-8')).toContain('new-session');
  });

  it('fails clearly when summary.json is missing', async () => {
    let captured: unknown;
    try {
      await runExport(['missing-session', '--project', projectDir]);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect(captured instanceof Error ? captured.message : '').toContain('summary.json');
  });
});
