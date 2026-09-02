import { describe, expect, it } from 'vitest';
import { CLI_TOOL_CATALOG } from '../runners/cli-tool-catalog.js';
import { API_PROVIDER_CATALOG } from './api-provider-catalog.js';
import { PROVIDER_IDS } from '../schemas/enums.js';
import { PROVIDER_CATALOG, getProviderBaseURL, getProviderDisplayName } from './catalog.js';

describe('provider catalog', () => {
  it('projects admitted Cursor as a CLI, not an API provider', () => {
    expect(Object.keys(PROVIDER_CATALOG).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(PROVIDER_CATALOG.cursor).toMatchObject({
      id: 'cursor',
      displayName: CLI_TOOL_CATALOG.cursor.displayName,
      category: 'cli',
    });
    expect(API_PROVIDER_CATALOG).not.toHaveProperty('cursor');
    expect(getProviderDisplayName('cursor')).toBe(CLI_TOOL_CATALOG.cursor.displayName);
    expect(getProviderBaseURL('cursor')).toBe('');
  });

  it('projects admitted Command Code as a CLI, not an API provider', () => {
    expect(PROVIDER_CATALOG['command-code']).toMatchObject({
      id: 'command-code',
      displayName: CLI_TOOL_CATALOG['command-code'].displayName,
      category: 'cli',
    });
    expect(API_PROVIDER_CATALOG).not.toHaveProperty('command-code');
    expect(getProviderDisplayName('command-code')).toBe(
      CLI_TOOL_CATALOG['command-code'].displayName,
    );
    expect(getProviderBaseURL('command-code')).toBe('');
  });
});
