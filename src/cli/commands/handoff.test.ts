import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { isCliError } from '../errors.js';

vi.mock('../../engine/handoff/write.js', () => ({
  writeHandoffPack: vi.fn().mockResolvedValue({ outputDir: '/tmp/out', files: [] }),
}));

vi.mock('../../engine/handoff/load-renderer.js', () => ({
  listCustomRenderers: vi.fn().mockReturnValue([]),
}));

import { registerHandoffCommand } from './handoff.js';
import { writeHandoffPack } from '../../engine/handoff/write.js';
import { listCustomRenderers } from '../../engine/handoff/load-renderer.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('handoff-command-test');
  vi.mocked(writeHandoffPack).mockClear();
  vi.mocked(writeHandoffPack).mockResolvedValue({ outputDir: '/tmp/out', files: [] });
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

async function runHandoff(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  // suppress commander output
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerHandoffCommand(program);
  await program.parseAsync(['node', 'diptych', 'handoff', '--project', tmp, '--session', 'test-session', ...args]);
}

describe('handoff command — target validation', () => {
  it('passes unknown target through to writeHandoffPack (custom renderer support)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runHandoff(['custom-target']);

    const callArg = vi.mocked(writeHandoffPack).mock.calls[0]?.[0];
    expect(callArg?.target).toBe('custom-target');

    vi.restoreAllMocks();
  });
});

describe('handoff command — mode validation', () => {
  it('exits with error for unknown --mode value', async () => {
    let captured: unknown;
    try {
      await runHandoff(['--mode', 'invalid-mode']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const msg = (captured as Error).message;
    expect(msg).toContain('invalid-mode');
  });
});

describe('handoff command — task parsing', () => {
  it('parses --task T001,T002 to ["T001", "T002"]', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runHandoff(['--task', 'T001,T002']);

    const callArg = vi.mocked(writeHandoffPack).mock.calls[0]?.[0];
    expect(callArg?.selectedTaskIds).toEqual(['T001', 'T002']);

    vi.restoreAllMocks();
  });
});

describe('handoff command — --list flag', () => {
  it('prints built-in targets and does not call writeHandoffPack', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    await runHandoff(['--list']);

    expect(vi.mocked(writeHandoffPack)).not.toHaveBeenCalled();
    expect(logs.some(l => l.includes('Built-in targets'))).toBe(true);
    expect(logs.some(l => l.includes('spec-kit'))).toBe(true);

    vi.restoreAllMocks();
  });

  it('prints custom renderers when listCustomRenderers returns names', async () => {
    vi.mocked(listCustomRenderers).mockReturnValueOnce(['linear-ticket', 'jira-task']);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    await runHandoff(['--list']);

    expect(logs.some(l => l.includes('Custom renderers'))).toBe(true);
    expect(logs.some(l => l.includes('linear-ticket'))).toBe(true);
    expect(logs.some(l => l.includes('jira-task'))).toBe(true);

    vi.restoreAllMocks();
  });

  it('omits Custom renderers section when no custom renderers exist', async () => {
    vi.mocked(listCustomRenderers).mockReturnValueOnce([]);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    await runHandoff(['--list']);

    expect(logs.some(l => l.includes('Custom renderers'))).toBe(false);

    vi.restoreAllMocks();
  });
});

describe('handoff command — defaults', () => {
  it('defaults target to spec-kit when not specified', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runHandoff([]);

    const callArg = vi.mocked(writeHandoffPack).mock.calls[0]?.[0];
    expect(callArg?.target).toBe('spec-kit');

    vi.restoreAllMocks();
  });

  it('defaults outDir to <projectDir>/handoff/spec-kit', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runHandoff([]);

    const callArg = vi.mocked(writeHandoffPack).mock.calls[0]?.[0];
    const expectedOutDir = `${tmp}/handoff/spec-kit`;
    expect(callArg?.outDir).toBe(expectedOutDir);

    vi.restoreAllMocks();
  });
});
