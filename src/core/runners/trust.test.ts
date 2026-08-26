import { describe, expect, it } from 'vitest';
import { CLI_TOOL_IDS } from './cli-tool-catalog.js';
import { getRunnerTrustMeta } from './trust.js';

describe('runner trust metadata', () => {
  it('keeps every CLI planner seat read-only and approval-bound', () => {
    for (const tool of CLI_TOOL_IDS) {
      expect(getRunnerTrustMeta('planner', { kind: 'cli', tool })).toEqual({
        executesLocalCommand: true,
        mayUseNetwork: true,
        mayWriteFilesDirectly: false,
        autoAllowFlags: [],
      });
    }
  });

  it('auto-allows CLI implementer flags only for tools that declare them', () => {
    expect(getRunnerTrustMeta('implementer', { kind: 'cli', tool: 'claude-code' })).toEqual({
      executesLocalCommand: true,
      mayUseNetwork: true,
      mayWriteFilesDirectly: true,
      autoAllowFlags: ['--permission-mode acceptEdits'],
    });
    expect(
      getRunnerTrustMeta('implementer', { kind: 'cli', tool: 'codex' }).autoAllowFlags,
    ).toEqual(['--sandbox workspace-write']);
    expect(
      getRunnerTrustMeta('implementer', { kind: 'cli', tool: 'opencode' }).autoAllowFlags,
    ).toEqual([]);
  });

  it('pins trust for non-CLI runner kinds', () => {
    expect(getRunnerTrustMeta('implementer', { kind: 'api' })).toEqual({
      executesLocalCommand: false,
      mayUseNetwork: true,
      mayWriteFilesDirectly: false,
      autoAllowFlags: [],
    });

    for (const kind of ['shell', 'agent'] as const) {
      expect(getRunnerTrustMeta('implementer', { kind })).toEqual({
        executesLocalCommand: true,
        mayUseNetwork: true,
        mayWriteFilesDirectly: true,
        autoAllowFlags: [],
      });
    }

    expect(getRunnerTrustMeta('planner', { kind: 'agent-sdk' }).mayWriteFilesDirectly).toBe(false);
    expect(getRunnerTrustMeta('implementer', { kind: 'agent-sdk' }).mayWriteFilesDirectly).toBe(
      true,
    );
  });
});
