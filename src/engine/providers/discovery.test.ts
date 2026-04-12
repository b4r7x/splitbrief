import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupFetchMock } from './testing.js';
import {
  discoverAiderModels,
  discoverOpencodeModels,
  discoverKiloModels,
  discoverCliToolModels,
  discoverAllCliTools,
} from './discovery.js';

vi.mock('../../utils/process.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../../utils/process.js';

const mockRunCommand = vi.mocked(runCommand);

describe('discoverAiderModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses stdout lines into model ids', async () => {
    mockRunCommand.mockResolvedValueOnce({
      stdout: 'openai/gpt-4o\nopenai/gpt-4-turbo\nanthropologic/claude-3\n',
      stderr: '',
      code: 0,
    });

    const models = await discoverAiderModels();
    expect(models).toEqual([
      { id: 'openai/gpt-4o' },
      { id: 'openai/gpt-4-turbo' },
      { id: 'anthropologic/claude-3' },
    ]);
    expect(mockRunCommand).toHaveBeenCalledWith('aider', ['--list-models', ''], {
      timeout: 10_000,
    });
  });

  it('filters out header and error lines', async () => {
    mockRunCommand.mockResolvedValueOnce({
      stdout: '=== Available Models ===\n- some-header\nopenai/gpt-4o\nError: something\n',
      stderr: '',
      code: 0,
    });

    const models = await discoverAiderModels();
    expect(models).toEqual([{ id: 'openai/gpt-4o' }]);
  });

  it('returns empty array on command not found', async () => {
    mockRunCommand.mockRejectedValueOnce(
      Object.assign(new Error('Command not found: aider'), { code: 'ENOENT' }),
    );

    const models = await discoverAiderModels();
    expect(models).toEqual([]);
  });

  it('returns empty array on timeout', async () => {
    mockRunCommand.mockRejectedValueOnce(new Error('timeout'));

    const models = await discoverAiderModels();
    expect(models).toEqual([]);
  });
});

describe('discoverOpencodeModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses provider/model format lines', async () => {
    mockRunCommand.mockResolvedValueOnce({
      stdout: 'anthropic/claude-3-5-sonnet\nopenai/gpt-4o\ngoogle/gemini-pro\n',
      stderr: '',
      code: 0,
    });

    const models = await discoverOpencodeModels();
    expect(models).toEqual([
      { id: 'anthropic/claude-3-5-sonnet' },
      { id: 'openai/gpt-4o' },
      { id: 'google/gemini-pro' },
    ]);
    expect(mockRunCommand).toHaveBeenCalledWith('opencode', ['models'], { timeout: 10_000 });
  });

  it('returns empty array on error', async () => {
    mockRunCommand.mockRejectedValueOnce(new Error('opencode not found'));

    const models = await discoverOpencodeModels();
    expect(models).toEqual([]);
  });
});

describe('discoverKiloModels', () => {
  setupFetchMock();

  it('parses JSON response with pricing and context length', async () => {
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

    const models = await discoverKiloModels();
    expect(models).toEqual([
      {
        id: 'anthropic/claude-3-5-sonnet',
        contextLength: 200000,
        pricingInput: 3,
        pricingOutput: 15,
      },
      {
        id: 'openai/gpt-4o',
        contextLength: 128000,
        pricingInput: 5,
        pricingOutput: 15,
      },
    ]);
  });

  it('returns empty array on network error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('network error'));

    const models = await discoverKiloModels();
    expect(models).toEqual([]);
  });

  it('returns empty array on non-ok HTTP response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('error', { status: 500 }));

    const models = await discoverKiloModels();
    expect(models).toEqual([]);
  });

  it('returns empty array on invalid response shape', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ wrong: 'shape' }), { status: 200 }),
    );

    const models = await discoverKiloModels();
    expect(models).toEqual([]);
  });

  it('handles models without optional fields', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: 'minimal/model' }] }),
        { status: 200 },
      ),
    );

    const models = await discoverKiloModels();
    expect(models).toEqual([{ id: 'minimal/model' }]);
  });
});

describe('discoverCliToolModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches to discoverAiderModels for aider', async () => {
    mockRunCommand.mockResolvedValueOnce({ stdout: 'openai/gpt-4o\n', stderr: '', code: 0 });

    const models = await discoverCliToolModels('aider');
    expect(models).toEqual([{ id: 'openai/gpt-4o' }]);
    expect(mockRunCommand).toHaveBeenCalledWith('aider', ['--list-models', ''], expect.any(Object));
  });

  it('dispatches to discoverOpencodeModels for opencode', async () => {
    mockRunCommand.mockResolvedValueOnce({ stdout: 'anthropic/claude-3\n', stderr: '', code: 0 });

    const models = await discoverCliToolModels('opencode');
    expect(models).toEqual([{ id: 'anthropic/claude-3' }]);
    expect(mockRunCommand).toHaveBeenCalledWith('opencode', ['models'], expect.any(Object));
  });

  it('returns empty array for claude-code', async () => {
    const models = await discoverCliToolModels('claude-code');
    expect(models).toEqual([]);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('returns empty array for codex', async () => {
    const models = await discoverCliToolModels('codex');
    expect(models).toEqual([]);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('returns empty array for copilot', async () => {
    const models = await discoverCliToolModels('copilot');
    expect(models).toEqual([]);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});

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
});
