import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupFetchMock } from './test-helpers.js';
import { discoverAllCliTools } from './discovery.js';

vi.mock('../../lib/process/spawn.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../../lib/process/spawn.js';

const mockRunCommand = vi.mocked(runCommand);

describe('discoverAllCliTools', () => {
  setupFetchMock();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs discovery for aider, opencode, and kilo-code in parallel and returns non-empty results', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ stdout: 'openai/gpt-4o\n', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'anthropic/claude-3\n', stderr: '', code: 0 });

    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: 'kilo/model-1' }] }),
        { status: 200 },
      ),
    );

    const result = await discoverAllCliTools();
    expect(result.aider).toEqual([{ id: 'openai/gpt-4o' }]);
    expect(result.opencode).toEqual([{ id: 'anthropic/claude-3' }]);
    expect(result['kilo-code']).toEqual([{ id: 'kilo/model-1' }]);
  });

  it('omits tools that returned empty arrays', async () => {
    mockRunCommand
      .mockRejectedValueOnce(new Error('aider not found'))
      .mockResolvedValueOnce({ stdout: 'anthropic/claude-3\n', stderr: '', code: 0 });

    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('error', { status: 500 }));

    const result = await discoverAllCliTools();
    expect(result.aider).toBeUndefined();
    expect(result.opencode).toEqual([{ id: 'anthropic/claude-3' }]);
    expect(result['kilo-code']).toBeUndefined();
  });

  it('parses aider stdout lines into model ids and calls aider with --list-models', async () => {
    mockRunCommand
      .mockResolvedValueOnce({
        stdout: 'openai/gpt-4o\nopenai/gpt-4-turbo\nanthropologic/claude-3\n',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('error', { status: 500 }));

    const result = await discoverAllCliTools();
    expect(result.aider).toEqual([
      { id: 'openai/gpt-4o' },
      { id: 'openai/gpt-4-turbo' },
      { id: 'anthropologic/claude-3' },
    ]);
    expect(mockRunCommand).toHaveBeenCalledWith('aider', ['--list-models', ''], { timeout: 10_000 });
  });

  it('filters out aider header and error lines', async () => {
    mockRunCommand
      .mockResolvedValueOnce({
        stdout: '=== Available Models ===\n- some-header\nopenai/gpt-4o\nError: something\n',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('error', { status: 500 }));

    const result = await discoverAllCliTools();
    expect(result.aider).toEqual([{ id: 'openai/gpt-4o' }]);
  });

  it('calls opencode with "models" arg and parses output', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({
        stdout: 'anthropic/claude-3-5-sonnet\nopenai/gpt-4o\ngoogle/gemini-pro\n',
        stderr: '',
        code: 0,
      });

    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('error', { status: 500 }));

    const result = await discoverAllCliTools();
    expect(result.opencode).toEqual([
      { id: 'anthropic/claude-3-5-sonnet' },
      { id: 'openai/gpt-4o' },
      { id: 'google/gemini-pro' },
    ]);
    expect(mockRunCommand).toHaveBeenCalledWith('opencode', ['models'], { timeout: 10_000 });
  });

  it('parses kilo JSON response with pricing and context length', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    vi.mocked(globalThis.fetch).mockResolvedValue(
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

  it('returns empty kilo list on invalid kilo response shape', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ wrong: 'shape' }), { status: 200 }),
    );

    const result = await discoverAllCliTools();
    expect(result['kilo-code']).toBeUndefined();
  });

  it('handles kilo models without optional fields', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: 'minimal/model' }] }),
        { status: 200 },
      ),
    );

    const result = await discoverAllCliTools();
    expect(result['kilo-code']).toEqual([{ id: 'minimal/model' }]);
  });
});
