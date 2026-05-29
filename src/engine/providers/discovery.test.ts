import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { discoverAllCliTools } from './discovery.js';

/**
 * CLI discovery exercises real subprocesses. We install shell shims named
 * `aider`, `opencode` (and leave out / break them deliberately) on PATH so
 * the real `runCommand` spawns them. The third source (kilo) is HTTP-only
 * and stubs fetch at the global boundary (sanctioned).
 */

let shimDir: string;
let originalPath: string | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

function installShim(command: string, bodyLines: string[]): void {
  const shimPath = join(shimDir, command);
  const body = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(shimPath, `#!/bin/bash\n${body}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
}

function installFailingShim(command: string, exitCode: number): void {
  const shimPath = join(shimDir, command);
  writeFileSync(shimPath, `#!/bin/bash\nexit ${exitCode}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
}

beforeEach(() => {
  shimDir = createTempDir('discovery-shim');
  originalPath = process.env['PATH'];
  // Prepend shimDir so our fake CLIs win over any real installations.
  process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  cleanupTempDir(shimDir);
  vi.unstubAllGlobals();
});

describe('discoverAllCliTools', () => {
  it('runs aider, opencode, and kilo discovery in parallel and merges results', async () => {
    installShim('aider', ['openai/gpt-4o']);
    installShim('opencode', ['anthropic/claude-3']);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'kilo/model-1' }] }), { status: 200 }),
    );

    const result = await discoverAllCliTools();

    expect(result.aider).toEqual([{ id: 'openai/gpt-4o' }]);
    expect(result.opencode).toEqual([{ id: 'anthropic/claude-3' }]);
    expect(result['kilo-code']).toEqual([{ id: 'kilo/model-1' }]);
  });

  it('omits tools that produced no models', async () => {
    // No aider shim → ENOENT from spawn → empty list → omitted.
    installShim('opencode', ['anthropic/claude-3']);
    fetchMock.mockResolvedValue(new Response('error', { status: 500 }));

    const result = await discoverAllCliTools();

    expect(result.aider).toBeUndefined();
    expect(result.opencode).toEqual([{ id: 'anthropic/claude-3' }]);
    expect(result['kilo-code']).toBeUndefined();
  });

  it('parses aider multi-line stdout into model ids', async () => {
    installShim('aider', ['openai/gpt-4o', 'openai/gpt-4-turbo', 'anthropologic/claude-3']);
    installFailingShim('opencode', 0); // empty stdout → empty models
    fetchMock.mockResolvedValue(new Response('error', { status: 500 }));

    const result = await discoverAllCliTools();

    expect(result.aider).toEqual([
      { id: 'openai/gpt-4o' },
      { id: 'openai/gpt-4-turbo' },
      { id: 'anthropologic/claude-3' },
    ]);
  });

  it('filters aider header and error lines', async () => {
    installShim('aider', [
      '=== Available Models ===',
      '- some-header',
      'openai/gpt-4o',
      'Error: something',
    ]);
    installFailingShim('opencode', 0);
    fetchMock.mockResolvedValue(new Response('error', { status: 500 }));

    const result = await discoverAllCliTools();

    expect(result.aider).toEqual([{ id: 'openai/gpt-4o' }]);
  });

  it('parses opencode stdout into model ids', async () => {
    installFailingShim('aider', 0);
    installShim('opencode', ['anthropic/claude-3-5-sonnet', 'openai/gpt-4o', 'google/gemini-pro']);
    fetchMock.mockResolvedValue(new Response('error', { status: 500 }));

    const result = await discoverAllCliTools();

    expect(result.opencode).toEqual([
      { id: 'anthropic/claude-3-5-sonnet' },
      { id: 'openai/gpt-4o' },
      { id: 'google/gemini-pro' },
    ]);
  });

  it('parses kilo JSON response with pricing and context length', async () => {
    installFailingShim('aider', 0);
    installFailingShim('opencode', 0);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'anthropic/claude-3-5-sonnet',
              context_length: 200000,
              pricing: { prompt: 0.000003, completion: 0.000015 },
            },
            {
              id: 'openai/gpt-4o',
              context_length: 128000,
              pricing: { prompt: 0.000005, completion: 0.000015 },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await discoverAllCliTools();

    expect(result['kilo-code']).toEqual([
      {
        id: 'anthropic/claude-3-5-sonnet',
        contextLength: 200000,
        pricingInput: 3,
        pricingOutput: 15,
        isFree: false,
      },
      {
        id: 'openai/gpt-4o',
        contextLength: 128000,
        pricingInput: 5,
        pricingOutput: 15,
        isFree: false,
      },
    ]);
  });

  it('returns no kilo entry on invalid response shape', async () => {
    installFailingShim('aider', 0);
    installFailingShim('opencode', 0);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ wrong: 'shape' }), { status: 200 }));

    const result = await discoverAllCliTools();

    expect(result['kilo-code']).toBeUndefined();
  });

  it('handles kilo models without optional pricing/context fields', async () => {
    installFailingShim('aider', 0);
    installFailingShim('opencode', 0);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'minimal/model' }] }), { status: 200 }),
    );

    const result = await discoverAllCliTools();

    expect(result['kilo-code']).toEqual([{ id: 'minimal/model' }]);
  });
});
