import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createEventBus } from '../../events/bus.js';
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

function publishThroughSinks(
  name: string,
  opts: { headless: boolean; plain?: boolean },
  events: readonly EngineEvent[] = [STARTED],
): string {
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
  for (const event of events) bus.publish(event);
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

  it('writes each plain warning to stderr on one line and keeps stdout unchanged', () => {
    const warnings: EngineEvent[] = [
      { type: 'warning', ts: STARTED.ts + 1, phase: 'planning', message: 'First warning.' },
      { type: 'warning', ts: STARTED.ts + 2, phase: 'planning', message: 'Second warning.' },
    ];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = publishThroughSinks('sinks-plain-warnings', { headless: true, plain: true }, [
      STARTED,
      ...warnings,
    ]);

    expect(out).toBe('phase: planning\n');
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual([
      'First warning.\n',
      'Second warning.\n',
    ]);
  });

  it('strips terminal controls from plain warnings on stderr', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = publishThroughSinks(
      'sinks-plain-warning-controls',
      { headless: true, plain: true },
      [
        {
          type: 'warning',
          ts: STARTED.ts,
          phase: 'planning',
          message: 'Cannot read /tmp/\u001b[2Jconfig.yaml.',
        },
      ],
    );

    expect(out).toBe('phase: planning\n');
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual(['Cannot read /tmp/config.yaml.\n']);
  });

  it('redacts secrets from plain warnings on stderr', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = publishThroughSinks(
      'sinks-plain-warning-secrets',
      { headless: true, plain: true },
      [
        {
          type: 'warning',
          ts: STARTED.ts,
          phase: 'planning',
          message: 'token sk-abcdefghijklmnopqrst',
        },
      ],
    );

    expect(out).toBe('phase: planning\n');
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual(['token sk-***REDACTED***\n']);
  });

  it('keeps warnings off stderr for a headless JSON run', () => {
    const warning: EngineEvent = {
      type: 'warning',
      ts: STARTED.ts,
      phase: 'planning',
      message: 'A warning.',
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = publishThroughSinks('sinks-json-warning', { headless: true }, [warning]);

    expect(JSON.parse(out)).toMatchObject({ type: 'event', data: warning });
    expect(stderr.mock.calls).toEqual([]);
  });

  it('writes each warning once after reattaching the plain sinks', () => {
    const projectDir = createTempDir('sinks-plain-warning-reattach');
    dirs.push(projectDir);
    const sessionId = 'sess-plain-warning-reattach';
    ensureSessionDir(projectDir, sessionId);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const input = {
      opts: { eventBus: createEventBus(), headless: true, plain: true },
      config: makeConfig(),
      projectDir,
      sessionId,
    };
    attachRunSinks(input);
    const bus = attachRunSinks(input);

    bus.publish({
      type: 'warning',
      ts: STARTED.ts,
      phase: 'planning',
      message: 'A warning.',
    });

    expect(stdout.mock.calls.map(([chunk]) => chunk)).toEqual(['phase: planning\n']);
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual(['A warning.\n']);
  });
});
