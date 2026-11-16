import { describe, it, expect } from 'vitest';
import { CLI_TOOL_CATALOG, CLI_TOOL_IDS } from '../runners/cli-tool/catalog.js';
import { TOOL_EFFORT_LADDERS } from './tool-effort-ladders.js';

describe('TOOL_EFFORT_LADDERS', () => {
  it('carries a ladder for exactly the four tools that publish their own effort levels', () => {
    expect(Object.keys(TOOL_EFFORT_LADDERS).sort()).toEqual([
      'claude-code',
      'codex',
      'command-code',
      'copilot',
    ]);
  });

  it('spells every ladder exactly as the tool it was transcribed from printed it', () => {
    expect(TOOL_EFFORT_LADDERS['claude-code']?.levels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(TOOL_EFFORT_LADDERS.copilot?.levels).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(TOOL_EFFORT_LADDERS['command-code']?.levels).toEqual(['low', 'medium', 'high']);
  });

  it.each([
    ['claude-code', 'claude --help'],
    ['copilot', 'copilot --help'],
    ['command-code', 'cmd --help'],
  ] as const)('dates the command %s levels were read from', (tool, command) => {
    expect(TOOL_EFFORT_LADDERS[tool]?.provenance).toContain(command);
    expect(TOOL_EFFORT_LADDERS[tool]?.provenance).toMatch(/\d+(?:\.\d+)+ \(\d{4}-\d{2}-\d{2}\)/);
  });

  it('carries a ladder for every tool that spends its effort on its own flag', () => {
    const flagTools = CLI_TOOL_IDS.filter(
      (tool) => CLI_TOOL_CATALOG[tool].effortChannel === 'effort-flag',
    );

    for (const tool of flagTools) {
      expect(TOOL_EFFORT_LADDERS[tool], tool).toBeDefined();
    }
  });

  it('records the ladders their tools document as examples rather than closed sets', () => {
    const openLadders = Object.entries(TOOL_EFFORT_LADDERS)
      .filter(([, ladder]) => ladder?.exhaustive === false)
      .map(([tool]) => tool);

    // Both are per model: command-code says so in its own help text, and codex publishes a
    // different set per model, `ultra` on some — so these floors may order an offer but must
    // never reject a carried value.
    expect(openLadders).toEqual(['codex', 'command-code']);
    expect(TOOL_EFFORT_LADDERS['command-code']?.provenance).toContain('depends on the model');
    expect(TOOL_EFFORT_LADDERS['command-code']?.provenance).toContain(
      'the per-model ladder comes from the catalog cache that cmd --list-models writes',
    );
    expect(TOOL_EFFORT_LADDERS.codex?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(TOOL_EFFORT_LADDERS.codex?.provenance).toContain(
      "ultra comes only from the model's own ladder",
    );
  });
});
