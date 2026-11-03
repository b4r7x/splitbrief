import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { probeActivitySnapshot, subscribeProbeActivity } from '../probe-activity.js';
import { collectArgVectorPreflightChecks } from './arg-vector-preflight.js';

const tempDirs: string[] = [];
const fakePids: number[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const pid of fakePids.splice(0)) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
});

function tempDir(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.push(directory);
  return directory;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function optionsProbeStarted(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const running = () => probeActivitySnapshot().probes.some((probe) => probe.check === 'options');
  const unsubscribe = subscribeProbeActivity(() => {
    if (!running()) return;
    unsubscribe();
    resolve();
  });
  return promise;
}

describe('collectArgVectorPreflightChecks — abort', () => {
  it('stops a hanging help read on abort and leaves no probe or process behind', {
    timeout: 10_000,
  }, async () => {
    const project = tempDir('preflight-abort-project');
    const toolDir = tempDir('preflight-abort-tools');
    const pidFile = join(toolDir, 'pids');
    writeFileSync(
      join(toolDir, 'codex'),
      ['#!/bin/sh', 'sleep 300 &', `echo "$$ $!" > ${JSON.stringify(pidFile)}`, 'wait', ''].join(
        '\n',
      ),
      'utf8',
    );
    chmodSync(join(toolDir, 'codex'), 0o755);
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);
    const controller = new AbortController();
    const started = optionsProbeStarted();

    const checks = collectArgVectorPreflightChecks({
      config: makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      projectDir: project,
      roles: ['planner'],
      signal: controller.signal,
    });
    const settled = checks.then(
      () => 'resolved',
      () => 'rejected',
    );
    await started;
    const pids = await vi.waitFor(
      () => {
        const recorded = existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : '';
        expect(recorded).toMatch(/^\d+ \d+\n$/u);
        return recorded.trim().split(' ').map(Number);
      },
      { timeout: 5_000 },
    );
    fakePids.push(...pids);

    controller.abort();

    expect(await settled).toBe('rejected');
    expect(probeActivitySnapshot().probes).toEqual([]);
    await vi.waitFor(() => expect(pids.filter(isAlive)).toEqual([]), { timeout: 3_000 });
  });
});
