import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from './engine/events/types.js';
import { taskId } from './core/schemas/task.js';
import { makeCommandHookEntry } from '#testing/helpers/factories/hook-entry.js';

const original = process.env.NODE_ENV;

afterEach(() => {
  if (original === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original;
});

const printNodeEnv = 'process.stdout.write(process.env.NODE_ENV ?? "unset")';

const hookEvent: EngineEvent = {
  type: 'task_started',
  ts: 1,
  phase: 'implementing',
  taskId: taskId('T001'),
  title: 't',
  index: 0,
  total: 1,
  file: 'a.ts',
  action: 'create',
};

async function startSplitbrief(userNodeEnv: string | undefined) {
  if (userNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = userNodeEnv;
  vi.resetModules();
  await import('./node-env.js');
  const { runCommand } = await import('./lib/process/spawn/run-command.js');
  const { runHook } = await import('./engine/hooks/dispatch.js');
  const { spawnEditorProcess } = await import('./features/workflow/review-parser.js');
  return { runCommand, runHook, spawnEditorProcess };
}

async function childNodeEnvs(splitbrief: Awaited<ReturnType<typeof startSplitbrief>>) {
  const check = await splitbrief.runCommand(process.execPath, ['-e', printNodeEnv]);
  const hook = await splitbrief.runHook(
    makeCommandHookEntry({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({ decision: "deny", message: process.env.NODE_ENV ?? "unset" }))',
      ],
    }),
    hookEvent,
    { projectDir: tmpdir(), workspaceDir: tmpdir(), sessionId: 'sess-1' },
  );
  const dir = await mkdtemp(join(tmpdir(), 'splitbrief-node-env-'));
  try {
    const out = join(dir, 'editor.txt');
    await new Promise<void>((resolve, reject) => {
      const editor = splitbrief.spawnEditorProcess(process.execPath, [
        '-e',
        `require("node:fs").writeFileSync(${JSON.stringify(out)}, process.env.NODE_ENV ?? "unset")`,
      ]);
      editor.once('error', reject);
      editor.once('close', () => resolve());
    });
    return {
      check: check.stdout,
      hook: hook.kind === 'deny' ? hook.message : hook.kind,
      editor: await readFile(out, 'utf8'),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('node-env', () => {
  it('runs React in production mode', async () => {
    await startSplitbrief(undefined);
    expect(process.env.NODE_ENV).toBe('production');
  });

  it('starts children without NODE_ENV when the user had none', async () => {
    const splitbrief = await startSplitbrief(undefined);

    expect(await childNodeEnvs(splitbrief)).toEqual({
      check: 'unset',
      hook: 'unset',
      editor: 'unset',
    });
    expect(process.env.NODE_ENV).toBe('production');
  });

  it("starts children with the user's own NODE_ENV", async () => {
    const splitbrief = await startSplitbrief('development');

    expect(await childNodeEnvs(splitbrief)).toEqual({
      check: 'development',
      hook: 'development',
      editor: 'development',
    });
    expect(process.env.NODE_ENV).toBe('production');
  });
});
