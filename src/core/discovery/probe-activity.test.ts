import { describe, expect, it } from 'vitest';
import type { CliToolId } from '../runners/cli-tool/types.js';
import { type ProbeActivity, slowProbeText } from './probe-activity.js';

function probe(input: Omit<ProbeActivity, 'id'> & { tool: CliToolId; id?: number }): ProbeActivity {
  return { id: input.id ?? 1, tool: input.tool, check: input.check, startedAt: input.startedAt };
}

describe('slowProbeText', () => {
  it('names a probe only once it has run for ten seconds', () => {
    const signIn = probe({ tool: 'opencode', check: 'sign-in', startedAt: 0 });

    expect(slowProbeText([], 12_000)).toBeNull();
    expect(slowProbeText([signIn], 9_999)).toBeNull();
    expect(slowProbeText([signIn], 10_000)).toBe('OpenCode CLI sign-in 10s');
    expect(slowProbeText([signIn], 12_000)).toBe('OpenCode CLI sign-in 12s');
  });

  it('names the probe that has run the longest, wherever it sits in the list', () => {
    const probes = [
      probe({ id: 1, tool: 'opencode', check: 'sign-in', startedAt: 5_000 }),
      probe({ id: 2, tool: 'kilo-code', check: 'model list', startedAt: 0 }),
      probe({ id: 3, tool: 'codex', check: 'version', startedAt: 19_000 }),
    ];

    expect(slowProbeText(probes, 20_000)).toBe('Kilo Code CLI model list 20s');
  });

  it('breaks a tie by the order the tool catalog lists the tools in', () => {
    const probes = [
      probe({ id: 1, tool: 'antigravity', check: 'options', startedAt: 0 }),
      probe({ id: 2, tool: 'codex', check: 'version', startedAt: 0 }),
    ];

    expect(slowProbeText(probes, 15_000)).toBe('OpenAI Codex CLI version 15s');
  });
});
