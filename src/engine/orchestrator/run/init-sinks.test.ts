import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import type { EngineEvent } from '../../events/types.js';
import { attachRunSinks } from './init-sinks.js';

let dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const STARTED: EngineEvent = {
  type: 'workflow_started',
  ts: 1_780_000_000_000,
  phase: 'planning',
  feature: 'a feature',
};

function publishThroughSinks(name: string, opts: { headless: boolean; plain?: boolean }): string {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  const sessionId = `sess-${name}`;
  ensureSessionDir(projectDir, sessionId);
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  const bus = attachRunSinks({
    opts: { headless: opts.headless, ...(opts.plain !== undefined && { plain: opts.plain }) },
    config: makeConfig(),
    projectDir,
    sessionId,
  });
  bus.publish(STARTED);
  return written.join('');
}

describe('attachRunSinks — stdout sinks', () => {
  it('installs the NDJSON sink for a headless run', () => {
    const out = publishThroughSinks('sinks-json', { headless: true });

    expect(out).toContain('"type":"event"');
    expect(out).not.toContain('phase: planning\n');
  });

  it('installs the plain text sink instead of the NDJSON one under --plain', () => {
    const out = publishThroughSinks('sinks-plain', { headless: true, plain: true });

    expect(out).toContain('phase: planning\n');
    expect(out).not.toContain('"type":"event"');
  });

  it('installs neither stdout sink for an interactive run', () => {
    const out = publishThroughSinks('sinks-interactive', { headless: false, plain: true });

    expect(out).toBe('');
  });
});
