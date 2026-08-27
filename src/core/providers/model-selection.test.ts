import { describe, it, expect } from 'vitest';
import { resolveCliModel } from './automatic-model.js';
import { hasAutomaticModelDefault, resolveAutoModel } from './model-selection.js';
import { KNOWN_API_PROVIDER_IDS } from './api-provider-catalog.js';
import { CLI_TOOL_IDS } from '../runners/cli-tool-catalog.js';

describe('resolveAutoModel', () => {
  it.each([
    ['auto', undefined],
    [undefined, undefined],
    ['', undefined],
    ['   ', undefined],
    ['aUtO', undefined],
  ])('resolves %j (tool=%j) to undefined', (model, tool) => {
    expect(resolveAutoModel(model, tool as string | undefined)).toBeUndefined();
  });

  it.each([
    ['claude-sonnet-5', undefined, 'claude-sonnet-5'],
    ['auto', 'openai', 'gpt-5.6-sol'],
    ['auto', 'anthropic', 'claude-sonnet-5'],
    ['auto', 'agent-sdk', 'claude-sonnet-5'],
  ])('resolves %j (tool=%j) to %j', (model, tool, expected) => {
    expect(resolveAutoModel(model, tool as string | undefined)).toBe(expected);
  });

  it('has no catalog default to substitute for a CLI tool', () => {
    expect(resolveAutoModel('auto', 'codex')).toBeUndefined();
  });

  it('keeps the legacy Claude Code "default" alias resolving to automatic selection', () => {
    expect(resolveAutoModel('default', 'claude-code')).toBeUndefined();
    expect(resolveAutoModel('default', 'codex')).toBe('default');
  });
});

describe('resolveCliModel', () => {
  // CLI automatic mode is structural: it must stay independent of catalog data
  // so a bundled row gaining isDefault can never start passing --model.
  it.each(CLI_TOOL_IDS)('resolves auto to no model for %s regardless of catalog', () => {
    expect(resolveCliModel('auto')).toBeUndefined();
  });
});

describe('hasAutomaticModelDefault', () => {
  it.each([...KNOWN_API_PROVIDER_IDS, 'agent-sdk'])('reports a default for %s', (providerId) => {
    expect(hasAutomaticModelDefault(providerId)).toBe(true);
  });

  it('reports no default for a custom provider', () => {
    expect(hasAutomaticModelDefault('my-gateway')).toBe(false);
  });

  it.each(CLI_TOOL_IDS)('reports no default for the CLI tool %s', (toolId) => {
    expect(hasAutomaticModelDefault(toolId)).toBe(false);
  });
});
