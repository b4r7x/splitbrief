import type { EffortLevel, ProviderId } from '../schemas/enums.js';

/**
 * The ladder a tool's own `--effort` flag accepts, read from the tool's help output.
 * It is a floor for rows no catalog knows — a model's own published ladder always wins.
 * `exhaustive` is false when the help documents an example rather than a closed set, so
 * the ladder may order an offer but must never be used to reject a carried value.
 */
interface ToolEffortLadder {
  readonly levels: readonly EffortLevel[];
  readonly exhaustive: boolean;
  readonly provenance: string;
}

export const TOOL_EFFORT_LADDERS: Readonly<Partial<Record<ProviderId, ToolEffortLadder>>> =
  Object.freeze({
    'claude-code': {
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      exhaustive: true,
      provenance: 'claude --help 2.1.263 (2026-09-07): "(low, medium, high, xhigh, max)"',
    },
    copilot: {
      levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      exhaustive: true,
      provenance: 'copilot --help 1.0.77 (2026-09-07): choices: "none", … , "max"',
    },
    codex: {
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      exhaustive: false,
      provenance:
        "codex debug models 0.164.0 (2026-11-08): the rungs every listed model publishes; ultra comes only from the model's own ladder",
    },
    'command-code': {
      levels: ['low', 'medium', 'high'],
      exhaustive: false,
      provenance:
        'cmd --help 1.50.0 (2026-09-07): "(e.g. low, medium, high) — depends on the model"; the per-model ladder comes from the catalog cache that cmd --list-models writes',
    },
  });
