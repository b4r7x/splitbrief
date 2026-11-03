import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HookEntrySchema } from '../../core/schemas/hooks.js';
import { taskId } from '../../core/schemas/task.js';
import { isAbortError } from '../../utils/abort.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../events/workflow-cancel.js';
import type { EngineEvent } from '../events/types.js';
import { runHook } from './dispatch.js';

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

const waitingHookScript = [
  "import { writeFileSync } from 'node:fs';",
  'writeFileSync(process.argv[2], "started " + process.pid + "\\n");',
  'setInterval(() => {}, 1 << 30);',
].join('\n');

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runHook stop', () => {
  it('stops a hook with no time limit when the run signal aborts, and rejects with the abort', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'splitbrief-hook-stop-'));
    const script = join(dir, 'hook.mjs');
    const startedFile = join(dir, 'started');
    await writeFile(script, waitingHookScript);
    const controller = new AbortController();
    try {
      const entry = HookEntrySchema.parse({
        command: process.execPath,
        args: [script, startedFile],
      });
      const pending = runHook(entry, event, {
        projectDir: dir,
        workspaceDir: dir,
        sessionId: 'sess-1',
        signal: controller.signal,
      });
      const settled = pending.then(
        () => undefined,
        (err: unknown) => err,
      );
      const pid = await vi.waitFor(
        async () => {
          const match = /^started (\d+)$/m.exec(await readFile(startedFile, 'utf8'));
          if (match?.[1] === undefined) throw new Error('the hook has not started');
          return Number(match[1]);
        },
        { timeout: 10_000, interval: 20 },
      );

      controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);

      expect(isAbortError(await settled)).toBe(true);
      await vi.waitFor(
        () => {
          if (isLive(pid)) throw new Error(`hook ${pid} is still running`);
        },
        { timeout: 5_000, interval: 20 },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
