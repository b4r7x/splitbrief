import { describe, expect, it } from 'vitest';
import { CURSOR_CLI_CANDIDATE } from '../runners/cli-tool-catalog.js';
import { PROVIDER_IDS } from '../schemas/enums.js';
import { PROVIDER_CATALOG, getProviderBaseURL, getProviderDisplayName } from './catalog.js';

describe('provider catalog', () => {
  it('does not project the non-admitted Cursor candidate as a provider', () => {
    expect(Object.keys(PROVIDER_CATALOG).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(PROVIDER_CATALOG).not.toHaveProperty(CURSOR_CLI_CANDIDATE.id);
    expect(getProviderDisplayName(CURSOR_CLI_CANDIDATE.id)).toBe(CURSOR_CLI_CANDIDATE.id);
    expect(getProviderBaseURL(CURSOR_CLI_CANDIDATE.id)).toBe('');
  });
});
