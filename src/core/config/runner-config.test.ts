import { describe, expect, it } from 'vitest';
import { getRunnerDisplayName, getRunnerCommand, getRunnerApiKey } from './runner-config.js';

describe('getRunnerDisplayName', () => {
  it('returns tool name for cli kind', () => {
    expect(getRunnerDisplayName({ kind: 'cli', tool: 'claude-code' } as any)).toBe('claude-code');
  });

  it('returns provider for api kind', () => {
    expect(getRunnerDisplayName({ kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1' } as any)).toBe('ollama');
  });

  it('returns "shell" for shell kind', () => {
    expect(getRunnerDisplayName({ kind: 'shell', command: '/usr/bin/my-tool' } as any)).toBe('shell');
  });

  it('returns "agent" for agent kind', () => {
    expect(getRunnerDisplayName({ kind: 'agent', command: 'claude' } as any)).toBe('agent');
  });

  it('returns "agent-sdk" for agent-sdk kind', () => {
    expect(getRunnerDisplayName({ kind: 'agent-sdk' } as any)).toBe('agent-sdk');
  });
});

describe('getRunnerCommand', () => {
  it('returns command for shell kind', () => {
    expect(getRunnerCommand({ kind: 'shell', command: 'my-tool' } as any)).toBe('my-tool');
  });

  it('returns command for agent kind', () => {
    expect(getRunnerCommand({ kind: 'agent', command: 'claude' } as any)).toBe('claude');
  });

  it('returns undefined for cli kind', () => {
    expect(getRunnerCommand({ kind: 'cli', tool: 'claude-code' } as any)).toBeUndefined();
  });

  it('returns undefined for api kind', () => {
    expect(getRunnerCommand({ kind: 'api', provider: 'ollama' } as any)).toBeUndefined();
  });
});

describe('getRunnerApiKey', () => {
  it('returns apiKey when present', () => {
    expect(getRunnerApiKey({ kind: 'api', apiKey: 'sk-123' } as any)).toBe('sk-123');
  });

  it('returns apiKey for agent-sdk kind', () => {
    expect(getRunnerApiKey({ kind: 'agent-sdk', apiKey: 'sk-456' } as any)).toBe('sk-456');
  });

  it('returns undefined when apiKey is missing', () => {
    expect(getRunnerApiKey({ kind: 'cli', tool: 'claude-code' } as any)).toBeUndefined();
  });
});
