import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { prependPath, writeCommandShim } from '#testing/helpers/command-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createImplementer, createPlanner } from './factory.js';
import type { CliStartGate } from './start-gate.js';

function withPlanner(planner: Config['planner']): Config {
  return { ...makeConfig(), planner };
}

function withImplementer(implementer: Config['implementer']): Config {
  return { ...makeConfig(), implementer };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPlanner', () => {
  it.each([
    [
      'API planner',
      withPlanner({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'test',
      }),
    ],
    ['shell planner', withPlanner({ kind: 'shell', command: 'cat', outputFormat: 'text' })],
    ['agent planner', withPlanner({ kind: 'agent', command: 'cat', outputFormat: 'text' })],
  ] as const)('creates a usable %s', async (_name, config) => {
    const planner = await createPlanner(config);

    expect(planner).toBeDefined();
    expect(planner.capabilities).toMatchObject({
      supportsConversationalPlanning: expect.any(Boolean),
      supportsHintEscalation: expect.any(Boolean),
      supportsSessionResume: expect.any(Boolean),
      supportsEffort: expect.any(Boolean),
      supportsImages: expect.any(Boolean),
      supportsSelfSummarisation: expect.any(Boolean),
    });
  });

  it('writes an effort warning to stderr when the backend does not support it', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withPlanner({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'test',
      effort: 'high',
    });

    await createPlanner(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('planner-effort');
  });

  it('writes a temperature warning to stderr when the backend cannot deliver it', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withPlanner({
      kind: 'shell',
      command: 'cat',
      outputFormat: 'text',
      temperature: 0.7,
    });

    await createPlanner(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('planner-temperature');
  });

  it('does not warn about temperature for the api planner kind', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withPlanner({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'test',
      temperature: 0.7,
    });

    await createPlanner(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('planner-temperature');
  });

  describe('claude-code idle wiring', () => {
    let shimDir: string;
    let restorePath: () => void;

    beforeEach(() => {
      shimDir = createTempDir('factory-claude-code-idle');
      restorePath = prependPath(shimDir);
    });

    afterEach(() => {
      restorePath();
      cleanupTempDir(shimDir);
    });

    it('threads a configured idleWarnMs override into the claude-code planner spawn', async () => {
      writeCommandShim({
        dir: shimDir,
        command: 'claude',
        lines: [JSON.stringify({ type: 'result', result: 'slow response' })],
        sleepSeconds: 0.15,
      });

      const config = withPlanner({
        kind: 'cli',
        tool: 'claude-code',
        authChannel: 'session',
        model: 'test',
        idleWarnMs: 30,
      });
      const path = realpathSync(join(shimDir, 'claude'));
      const info = statSync(path);
      const trustedCli: CliStartGate = {
        tool: 'claude-code',
        executable: {
          path,
          fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
        },
      };
      const planner = await createPlanner(config, undefined, { trustedCli });

      const events: RunnerCallEvent[] = [];
      const result = await planner.review('prompt', shimDir, {
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      });

      expect(result.text).toContain('slow response');
      expect(events.some((event) => event.type === 'call_stalled')).toBe(true);
    });
  });
});

describe('createImplementer', () => {
  it.each([
    [
      'CLI implementer',
      withImplementer({ kind: 'cli', tool: 'codex', authChannel: 'session', model: 'test' }),
    ],
    [
      'API implementer',
      withImplementer({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'test',
      }),
    ],
    [
      'shell implementer',
      withImplementer({ kind: 'shell', command: 'cat', outputFormat: 'text', model: 'test' }),
    ],
    [
      'agent implementer',
      withImplementer({ kind: 'agent', command: 'cat', outputFormat: 'text', model: 'test' }),
    ],
  ] as const)('creates a usable %s', async (_name, config) => {
    const implementer = await createImplementer(config);

    expect(implementer).toBeDefined();
    expect(implementer.capabilities).toBeDefined();
    expect(implementer.capabilities?.writesFiles).toMatch(/^(direct|extracted-code)$/);
  });

  it('writes a temperature warning to stderr when the backend cannot deliver it', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withImplementer({
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
      model: 'test',
      temperature: 0.3,
    });

    await createImplementer(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('implementer-temperature');
  });

  it('does not warn about temperature for the api implementer kind', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withImplementer({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'test',
      temperature: 0.3,
    });

    await createImplementer(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('implementer-temperature');
  });
});

describe('CLI role enforcement', () => {
  it('rejects CLI tools outside the planner tuple before planner construction', async () => {
    const config = withPlanner({
      kind: 'cli',
      tool: 'cursor' as Config['planner'] extends { kind: 'cli'; tool: infer T } ? T : never,
      authChannel: 'session',
      model: 'test',
    });

    await expect(createPlanner(config)).rejects.toThrow(/planner configuration/);
  });

  it('rejects unknown CLI tools before planner construction', async () => {
    const config = withPlanner({
      kind: 'cli',
      tool: 'kiro' as Config['planner'] extends { kind: 'cli'; tool: infer T } ? T : never,
      authChannel: 'session',
      model: 'test',
    });

    await expect(createPlanner(config)).rejects.toThrow(/planner configuration/);
  });

  it('rejects unknown CLI tools before implementer construction', async () => {
    const config = withImplementer({
      kind: 'cli',
      tool: 'kiro' as Config['implementer'] extends { kind: 'cli'; tool: infer T } ? T : never,
      authChannel: 'session',
      model: 'test',
    });

    await expect(createImplementer(config)).rejects.toThrow(/implementer/);
  });
});
