import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from './dispatch.js';
import { setProcessLedger } from '../../lib/process/registry.js';
import type { EngineEvent } from '../events/types.js';
import { taskId } from '../../core/schemas/task.js';
import { makeCommandHookEntry } from '#testing/helpers/factories/hook-entry.js';

const event: EngineEvent = {
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

const ctx = { projectDir: '/tmp', sessionId: 'sess-1' };

function mkEntry(overrides?: Parameters<typeof makeCommandHookEntry>[0]) {
  return makeCommandHookEntry({ command: 'echo', ...overrides });
}

const reportArgvScript =
  'process.stdout.write(JSON.stringify({ decision: "deny", message: process.argv.slice(2).join(" ") }))';

async function withTempScript<T>(
  source: string,
  run: (scriptPath: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), 'splitbrief-hook-script-'));
  const scriptPath = join(tempDir, 'hook.mjs');
  try {
    await writeFile(scriptPath, source);
    return await run(scriptPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe('runHook', () => {
  it('returns allow for a successful command (echo)', async () => {
    const outcome = await runHook(mkEntry({ command: 'echo', args: ['hello'] }), event, ctx);
    expect(outcome.kind).toBe('allow');
  });

  it('command hook spawns bypass the runner-pid ledger', async () => {
    const recorded: number[] = [];
    const released: number[] = [];
    setProcessLedger({
      record: (pid) => recorded.push(pid),
      release: (pid) => released.push(pid),
    });
    try {
      await runHook(mkEntry({ command: 'echo', args: ['hello'] }), event, ctx);
    } finally {
      setProcessLedger(null);
    }

    expect(recorded).toEqual([]);
    expect(released).toEqual([]);
  });

  it('returns deny on non-zero exit (false) when on_failure=block', async () => {
    const outcome = await runHook(mkEntry({ command: 'false', on_failure: 'block' }), event, ctx);
    expect(outcome.kind).toBe('deny');
  });

  it('returns warn on non-zero exit when on_failure=warn', async () => {
    const outcome = await runHook(mkEntry({ command: 'false', on_failure: 'warn' }), event, ctx);
    expect(outcome.kind).toBe('warn');
  });

  it('returns warn when command not found (ENOENT)', async () => {
    const outcome = await runHook(
      mkEntry({ command: 'this-command-does-not-exist-xyz' }),
      event,
      ctx,
    );
    expect(outcome.kind).toBe('warn');
  });

  it('returns crash or deny on timeout when on_failure=block', async () => {
    const outcome = await runHook(
      mkEntry({ command: 'sleep', args: ['10'], timeout_ms: 100, on_failure: 'block' }),
      event,
      ctx,
    );
    expect(['crash', 'deny']).toContain(outcome.kind);
  });

  it('parses stdout JSON for decision: deny', async () => {
    const outcome = await runHook(
      mkEntry({
        command: 'node',
        args: ['-e', 'process.stdout.write(JSON.stringify({decision:"deny",message:"nope"}))'],
      }),
      event,
      ctx,
    );
    expect(outcome.kind).toBe('deny');
    if (outcome.kind === 'deny') expect(outcome.message).toBe('nope');
  });

  it('rejects an unrecognized decision value as a malformed response', async () => {
    const outcome = await runHook(
      mkEntry({
        command: 'node',
        args: ['-e', 'process.stdout.write(JSON.stringify({decision:"block"}))'],
      }),
      event,
      ctx,
    );
    expect(outcome.kind).toBe('warn');
    if (outcome.kind === 'warn') expect(outcome.message).toContain('malformed hook response');
  });

  it('maps malformed command responses through on_failure', async () => {
    const outcome = await runHook(
      mkEntry({
        command: 'node',
        args: ['-e', 'process.stdout.write(JSON.stringify({decision:"deny",message:42}))'],
        on_failure: 'block',
      }),
      event,
      ctx,
    );
    expect(outcome.kind).toBe('deny');
    if (outcome.kind === 'deny') expect(outcome.message).toContain('malformed hook response');
  });

  it('rejects malformed JSON object stdout', async () => {
    const outcome = await runHook(
      mkEntry({
        command: 'node',
        args: ['-e', 'process.stdout.write("{")'],
        on_failure: 'block',
      }),
      event,
      ctx,
    );
    expect(outcome.kind).toBe('deny');
    if (outcome.kind === 'deny') expect(outcome.message).toContain('malformed hook response');
  });

  it('extracts the decision from the last JSON line of mixed stdout', async () => {
    const outcome = await runHook(
      mkEntry({
        command: 'node',
        args: [
          '-e',
          'console.log("scanning files...");console.log(JSON.stringify({decision:"deny",message:"blocked by policy"}))',
        ],
      }),
      event,
      ctx,
    );
    expect(outcome.kind).toBe('deny');
    if (outcome.kind === 'deny') expect(outcome.message).toBe('blocked by policy');
  });

  it('parses a pretty-printed multi-line JSON object', async () => {
    const outcome = await runHook(
      mkEntry({
        command: 'node',
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({decision:"deny",message:"x"}, null, 2))',
        ],
      }),
      event,
      ctx,
    );
    expect(outcome.kind).toBe('deny');
  });

  it('allows when stdout has no JSON object line', async () => {
    const outcome = await runHook(
      mkEntry({
        command: 'node',
        args: ['-e', 'console.log("just a log line");console.log("done")'],
      }),
      event,
      ctx,
    );
    expect(outcome.kind).toBe('allow');
  });

  it('inserts a -- guard before a flag-shaped interpolated value so it reaches argv as data', async () => {
    const placeholder = ['$', '{event.file}'].join('');
    const flagEvent: EngineEvent = { ...event, file: '--unexpected-flag' };
    await withTempScript(reportArgvScript, async (scriptPath) => {
      const outcome = await runHook(
        mkEntry({ command: 'node', args: [scriptPath, placeholder] }),
        flagEvent,
        ctx,
      );
      expect(outcome.kind).toBe('deny');
      if (outcome.kind === 'deny') expect(outcome.message).toBe('-- --unexpected-flag');
    });
  });

  it('does not insert a guard for author-controlled flag templates with interpolated values', async () => {
    const placeholder = ['--mode=$', '{event.phase}'].join('');
    await withTempScript(reportArgvScript, async (scriptPath) => {
      const outcome = await runHook(
        mkEntry({ command: 'node', args: [scriptPath, placeholder] }),
        event,
        ctx,
      );
      expect(outcome.kind).toBe('deny');
      if (outcome.kind === 'deny') expect(outcome.message).toBe('--mode=implementing');
    });
  });
});
