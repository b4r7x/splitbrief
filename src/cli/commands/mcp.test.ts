import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { isCliError } from '../errors.js';

vi.mock('../../engine/mcp/server.js', () => ({
  startMcpServer: vi.fn(),
}));

vi.mock('../../engine/mcp/auth-token.js', () => ({
  generateToken: vi.fn().mockReturnValue('test-token-abc123'),
}));

vi.mock('../../engine/mcp/discovery.js', () => ({
  resolveSessionIds: vi.fn(),
}));

import { registerMcpCommand } from './mcp.js';
import { startMcpServer } from '../../engine/mcp/server.js';
import { resolveSessionIds } from '../../engine/mcp/discovery.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('mcp-command-test');
  vi.mocked(startMcpServer).mockResolvedValue({
    port: 4321,
    close: vi.fn().mockResolvedValue(undefined),
  });
  vi.mocked(resolveSessionIds).mockReturnValue(['2026-04-26-test-session']);
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

async function runMcpServe(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerMcpCommand(program);
  await program.parseAsync(['node', 'diptych', 'mcp', 'serve', '--project', tmp, ...args]);
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
    const msg = (captured as Error).message;
    expect(msg).toContain('mutually exclusive');
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
    const msg = (captured as Error).message;
    expect(msg).toContain('--port');
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
    vi.mocked(resolveSessionIds).mockImplementation(() => {
      throw new Error('No active session. Use --session <id> or --all-sessions.');
    });

    let captured: unknown;
    try {
      await runMcpServe([]);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const msg = (captured as Error).message;
    expect(msg).toMatch(/active session|--session|--all-sessions/i);
  });
});

describe('mcp serve — startup announcement', () => {
  it('prints startup announcement with token and url to stdout', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await runMcpServe(['--session', '2026-04-26-test-session']);

    const output = writes.join('');
    expect(output).toContain('diptych MCP server ready');
    expect(output).toContain('Read-only');
    expect(output).toContain('no MCP tools or writes');
    expect(output).toContain('http://127.0.0.1:4321/mcp');
    expect(output).toContain('test-token-abc123');
    expect(output).toContain('Sessions: 2026-04-26-test-session');
  });

  it('shows "all" in Sessions when --all-sessions is provided', async () => {
    vi.mocked(resolveSessionIds).mockReturnValue(['sess1', 'sess2']);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await runMcpServe(['--all-sessions']);

    const output = writes.join('');
    expect(output).toContain('Sessions: all');
  });
});
