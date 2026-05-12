import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { isCliError } from '../errors.js';
import { listCustomRenderers } from '../../engine/handoff/load-renderer.js';
import { registerHandoffCommand } from './handoff.js';
import type { HandoffDeps } from './handoff.js';

type HandoffWrite = Parameters<HandoffDeps['writeHandoffPack']>[0];

let tmp: string;
let writes: HandoffWrite[];

function createDeps(): HandoffDeps {
  return {
    listCustomRenderers,
    writeHandoffPack: async (options) => {
      writes.push(options);
      return {
        outputDir: options.outDir,
        files: [`${options.target}.md`],
      };
    },
  };
}

beforeEach(() => {
  tmp = createTempDir('handoff-command-test');
  writes = [];
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

async function runHandoff(args: string[], deps = createDeps()): Promise<string[]> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...parts) => logs.push(parts.join(' ')));

  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerHandoffCommand(program, deps);
  await program.parseAsync(['node', 'diptych', 'handoff', '--project', tmp, '--session', 'test-session', ...args]);
  return logs;
}

describe('handoff command — target validation', () => {
  it('passes unknown target through to writeHandoffPack for custom renderer support', async () => {
    const logs = await runHandoff(['custom-target']);

    expect(writes).toMatchObject([{ target: 'custom-target' }]);
    expect(logs.join('\n')).toContain(`${tmp}/handoff/custom-target`);
    expect(logs.join('\n')).toContain('custom-target.md');
  });

  it('rejects path-like targets before deriving the default output directory', async () => {
    let captured: unknown;
    try {
      await runHandoff(['../escape', '--mode', 'overwrite']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('Invalid target "../escape"');
    expect(writes).toEqual([]);
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
    expect((captured as Error).message).toContain('invalid-mode');
    expect(writes).toEqual([]);
  });
});

describe('handoff command — task parsing', () => {
  it('parses comma-separated task ids before writing the pack', async () => {
    await runHandoff(['--task', 'T001,T002']);

    expect(writes).toMatchObject([
      {
        selectedTaskIds: ['T001', 'T002'],
      },
    ]);
  });
});

describe('handoff command — --list flag', () => {
  it('prints built-in targets without writing a pack', async () => {
    const logs = await runHandoff(['--list']);

    expect(writes).toEqual([]);
    expect(logs.some((line) => line.includes('Built-in targets'))).toBe(true);
    expect(logs.some((line) => line.includes('spec-kit'))).toBe(true);
  });

  it('prints custom renderers when renderer files exist', async () => {
    const renderersDir = join(tmp, '.diptych', 'handoff-renderers');
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

describe('handoff command — defaults', () => {
  it('defaults target to spec-kit when not specified', async () => {
    await runHandoff([]);

    expect(writes).toMatchObject([{ target: 'spec-kit' }]);
  });

  it('defaults outDir to <projectDir>/handoff/spec-kit', async () => {
    const logs = await runHandoff([]);

    expect(writes).toMatchObject([{ outDir: join(tmp, 'handoff', 'spec-kit') }]);
    expect(logs.join('\n')).toContain(join(tmp, 'handoff', 'spec-kit'));
  });
});
