import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { LISTED_CLI_TOOL_IDS } from '../../core/runners/cli-tool/catalog.js';
import { detectAvailableCliTools } from './detect.js';

describe('all-admitted-tools auth detection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps an unresolvable tool unavailable without any auth probe', async () => {
    const emptyPathDir = createTempDir('detect-admitted-empty-path');
    vi.stubEnv('PATH', emptyPathDir);
    try {
      const results = await detectAvailableCliTools();

      expect(
        results.map((result) => ({
          tool: result.tool,
          state: result.diagnostic.state,
          auth: result.auth,
        })),
      ).toEqual(
        LISTED_CLI_TOOL_IDS.map((tool) => ({ tool, state: 'unavailable', auth: 'not-checked' })),
      );
    } finally {
      cleanupTempDir(emptyPathDir);
    }
  });
});
