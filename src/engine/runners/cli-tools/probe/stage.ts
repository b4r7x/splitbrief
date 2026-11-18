import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { throwIfAborted } from '../../../../utils/abort.js';
import { removeSandboxTempDirs } from '../../sandbox/state/paths.js';

const quit = new AbortController();
const stages = new Set<Promise<unknown>>();

/** Tracks a tool call until its cleanup finishes and gives it the process stop signal. */
export function withToolStage<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const stageSignal = signal === undefined ? quit.signal : AbortSignal.any([signal, quit.signal]);
  const stage = (async () => {
    throwIfAborted(stageSignal);
    return run(stageSignal);
  })();
  stages.add(stage);
  const forget = () => stages.delete(stage);
  stage.then(forget, forget);
  return stage;
}

/** Runs a tool check in a fresh directory and removes it and its sandbox temp folders. */
export function withProbeStage<T>(
  prefix: string,
  signal: AbortSignal | undefined,
  run: (dir: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withToolStage(signal, async (stageSignal) => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    try {
      return await run(dir, stageSignal);
    } finally {
      await rm(dir, { recursive: true, force: true });
      removeSandboxTempDirs(dir);
    }
  });
}

/** Aborts active tool stages and refuses new stages. */
export function stopToolStages(): void {
  quit.abort();
}

/** Waits for active tool stages and their cleanup. */
export async function awaitToolStages(): Promise<void> {
  while (stages.size > 0) await Promise.allSettled(stages);
}
