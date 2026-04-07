import { describe, it, expect } from 'vitest';
import { createImplementer } from './factory.js';
import { makeConfig } from '#testing/helpers/fixtures.js';

describe('createImplementer', () => {
  it('creates an openai backend for type api', async () => {
    const config = makeConfig({ implementer: { type: 'api' } });
    const implementer = await createImplementer(config);
    expect(implementer.name).toBe('openai');
  });

  it('creates an openai backend when type is undefined', async () => {
    const config = makeConfig();
    delete (config.implementer as any).type;
    const implementer = await createImplementer(config);
    expect(implementer.name).toBe('openai');
  });

  it('creates a shell backend for type shell', async () => {
    const config = makeConfig({ implementer: { type: 'shell', command: 'echo' } });
    const implementer = await createImplementer(config);
    expect(implementer.name).toBe('shell');
  });

  it('creates an agent backend for type agent', async () => {
    const config = makeConfig({ implementer: { type: 'agent', command: 'echo' } });
    const implementer = await createImplementer(config);
    expect(implementer.name).toBe('agent');
  });

  it('creates a tool-based backend for type claude-code', async () => {
    const config = makeConfig({ implementer: { type: 'claude-code' } });
    const implementer = await createImplementer(config);
    expect(implementer.name).toBe('tool:claude-code');
  });

  it('creates a tool-based backend for type codex', async () => {
    const config = makeConfig({ implementer: { type: 'codex' } });
    const implementer = await createImplementer(config);
    expect(implementer.name).toBe('tool:codex');
  });

  it('creates an agent-sdk backend for type agent-sdk', async () => {
    const config = makeConfig({ implementer: { type: 'agent-sdk' } });
    const implementer = await createImplementer(config);
    expect(implementer.name).toBe('agent-sdk');
  });

  it('throws on unknown type', async () => {
    const config = makeConfig();
    (config.implementer as any).type = 'unknown';
    await expect(createImplementer(config)).rejects.toThrow('Unknown implementer type: unknown');
  });
});
