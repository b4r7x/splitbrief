import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { isCliError } from '../errors.js';
import { registerMcpCommand } from './mcp.js';
import type { McpDeps } from './mcp.js';

let tmp: string;
let closeCount: number;

function createSessionFixture(projectDir: string, sessionId: string): void {
  const dir = join(projectDir, '.diptych', 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({
    id: sessionId,
    feature: 'test',
    startedAt: 1,
    completedAt: null,
    stateVersion: 1,
    stateFile: null,
    status: 'interrupted',
    summary: null,
  }));
}

function createDeps(port = 4321): McpDeps {
  return {
    startMcpServer: async () => ({
      port,
      close: async () => {
        closeCount += 1;
      },
    }),
  };
}

beforeEach(() => {
  tmp = createTempDir('mcp-command-test');
  closeCount = 0;
  createSessionFixture(tmp, '2026-04-26-test-session');
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

async function runMcpServe(args: string[], deps = createDeps()): Promise<string> {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });

  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerMcpCommand(program, deps);
  await program.parseAsync(['node', 'diptych', 'mcp', 'serve', '--project', tmp, ...args]);
  return writes.join('');
}

describe('mcp serve — flag exclusivity', () => {
  it('exits with code 1 when both --session and --all-sessions are provided', async () => {
    let captured: unknown;
    try {
      await runMcpServe(['--session', 'foo', '--all-sessions']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('mutually exclusive');
  });
});

describe('mcp serve — port validation', () => {
  it('exits with code 1 for non-numeric port', async () => {
    let captured: unknown;
    try {
      await runMcpServe(['--session', 'foo', '--port', 'abc']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('--port');
  });

  it('exits with code 1 for port 0', async () => {
    let captured: unknown;
    try {
      await runMcpServe(['--session', 'foo', '--port', '0']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
  });

  it('exits with code 1 for port above 65535', async () => {
    let captured: unknown;
    try {
      await runMcpServe(['--session', 'foo', '--port', '99999']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
  });
});

describe('mcp serve — no active session', () => {
  it('exits with code 1 with a useful message when no active session and no flags given', async () => {
    let captured: unknown;
    try {
      await runMcpServe([]);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toMatch(/active session|--session|--all-sessions/i);
  });
});

describe('mcp serve — startup announcement', () => {
  it('prints startup announcement with token and url to stdout', async () => {
    const output = await runMcpServe(['--session', '2026-04-26-test-session']);

    expect(output).toContain('diptych MCP server ready');
    expect(output).toMatch(/resources/i);
    expect(output).toMatch(/\d+ evidence tools/i);
    expect(output).toContain('http://127.0.0.1:4321/mcp');
    expect(output).toMatch(/Token:\s+[A-Za-z0-9_-]{20,}/);
    expect(output).toContain('Sessions: 2026-04-26-test-session');
    expect(closeCount).toBe(0);
  });

  it('announces five evidence tools in the startup output', async () => {
    const output = await runMcpServe(['--session', '2026-04-26-test-session']);

    expect(output).toMatch(/5 evidence tools/i);
  });

  it('shows "all" in Sessions when --all-sessions is provided', async () => {
    createSessionFixture(tmp, 'sess1');
    createSessionFixture(tmp, 'sess2');

    const output = await runMcpServe(['--all-sessions']);

    expect(output).toContain('Sessions: all');
  });
});
