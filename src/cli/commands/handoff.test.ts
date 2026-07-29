import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { writeHandoffWriterSessionState } from '#testing/helpers/handoff-writer-fixture.js';
import { isCliError } from '../errors.js';
import { listCustomRenderers } from '../../engine/handoff/load-renderer.js';
import { writeHandoffPack } from '../../engine/handoff/write.js';
import { registerHandoffCommand } from './handoff.js';
import type { HandoffDeps } from './handoff.js';

let tmp: string;

const realDeps = (): HandoffDeps => ({
  listCustomRenderers,
  writeHandoffPack,
});

function makeAliasableSession(sessionId: string, sortKeyMs: number): void {
  const dir = join(tmp, '.splitbrief', 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  const summaryPath = join(dir, 'summary.json');
  writeFileSync(summaryPath, '{}');
  const seconds = sortKeyMs / 1000;
  utimesSync(summaryPath, seconds, seconds);
}

beforeEach(() => {
  tmp = createTempDir('handoff-command-test');
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

async function runHandoff(args: string[], deps: HandoffDeps = realDeps()): Promise<string[]> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...parts) => logs.push(parts.join(' ')));

  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerHandoffCommand(program, deps);
  await program.parseAsync(['node', 'splitbrief', 'handoff', '--project', tmp, ...args]);
  return logs;
}

describe('handoff command — target validation', () => {
  it('rejects path-like targets before deriving the default output directory', async () => {
    writeHandoffWriterSessionState(tmp, 'validation-session');
    let captured: unknown;
    try {
      await runHandoff(['../escape', '--mode', 'overwrite', '--session', 'validation-session']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('Invalid target "../escape"');
  });
});

describe('handoff command — mode validation', () => {
  it('exits with error for unknown --mode value', async () => {
    writeHandoffWriterSessionState(tmp, 'validation-session');
    let captured: unknown;
    try {
      await runHandoff(['--mode', 'invalid-mode', '--session', 'validation-session']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('invalid-mode');
  });
});

describe('handoff command — --list flag', () => {
  it('prints built-in targets without writing a pack', async () => {
    const logs = await runHandoff(['--list']);

    expect(logs.some((line) => line.includes('Built-in targets'))).toBe(true);
    expect(logs.some((line) => line.includes('spec-kit'))).toBe(true);
  });

  it('prints custom renderers when renderer files exist', async () => {
    const renderersDir = join(tmp, '.splitbrief', 'handoff-renderers');
    mkdirSync(renderersDir, { recursive: true });
    writeFileSync(join(renderersDir, 'linear-ticket.ts'), '');
    writeFileSync(join(renderersDir, 'jira-task.ts'), '');

    const logs = await runHandoff(['--list']);

    expect(logs.some((line) => line.includes('Custom renderers'))).toBe(true);
    expect(logs.some((line) => line.includes('linear-ticket'))).toBe(true);
    expect(logs.some((line) => line.includes('jira-task'))).toBe(true);
  });

  it('omits Custom renderers section when no custom renderers exist', async () => {
    const logs = await runHandoff(['--list']);

    expect(logs.some((line) => line.includes('Custom renderers'))).toBe(false);
  });
});

describe('handoff command — artifact output', () => {
  it('writes the default spec-kit pack for selected tasks and the newest session alias', async () => {
    writeHandoffWriterSessionState(tmp, 'older-session');
    writeHandoffWriterSessionState(tmp, 'newer-session');
    makeAliasableSession('older-session', 1_000);
    makeAliasableSession('newer-session', 2_000);

    const outDir = join(tmp, '.splitbrief', 'handoffs', 'spec-kit');
    const logs = await runHandoff(['--task', 'T001,T002', '--session', '1']);

    expect(logs.join('\n')).toContain(outDir);
    expect(existsSync(join(outDir, 'README.md'))).toBe(true);
    expect(existsSync(join(outDir, 'tasks', 'T001.md'))).toBe(true);
    expect(existsSync(join(outDir, 'tasks', 'T002.md'))).toBe(true);
    expect(existsSync(join(outDir, 'tasks', 'T003.md'))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifest.sessionId).toBe('newer-session');
    expect(manifest.taskIds).toEqual(['T001', 'T002']);
  });

  it('normalizes the speckit alias to spec-kit on disk', async () => {
    writeHandoffWriterSessionState(tmp, 'handoff-session');

    const outDir = join(tmp, '.splitbrief', 'handoffs', 'spec-kit');
    await runHandoff(['speckit', '--session', 'handoff-session']);

    expect(existsSync(join(outDir, 'README.md'))).toBe(true);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
  });
});

describe('handoff command — custom renderer routing', () => {
  it('routes unknown safe targets through writeHandoffPack with a fixed custom renderer result', async () => {
    writeHandoffWriterSessionState(tmp, 'handoff-session');
    const writer = vi.fn<HandoffDeps['writeHandoffPack']>().mockResolvedValue({
      outputDir: `${tmp}/.splitbrief/handoffs/custom-target`,
      files: ['custom-target.md'],
    });
    const logs = await runHandoff(['custom-target', '--session', 'handoff-session'], {
      listCustomRenderers,
      writeHandoffPack: writer,
    });

    expect(writer).toHaveBeenCalledWith(expect.objectContaining({ target: 'custom-target' }));
    expect(logs.join('\n')).toContain(`${tmp}/.splitbrief/handoffs/custom-target`);
    expect(logs.join('\n')).toContain('custom-target.md');
  });
});
