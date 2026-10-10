import { describe, expect, it } from 'vitest';
import { ELLIPSIS, getTerminalCellWidth } from '../../utils/display-text.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import {
  cutSeatIdentity,
  formatCollapsedSeatLine,
  formatCollapsedSeatLineFromIdentities,
  formatSeatIdentity,
  formatShortSeatIdentity,
  PLANNER_INHERITANCE,
  seatIdsOf,
  wrapSeatIdentity,
} from './identity.js';

const planner: RunnerConfig = { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' };
const build: RunnerConfig = {
  kind: 'api',
  provider: 'ollama',
  service: 'ollama',
  offering: 'local',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://127.0.0.1:11434/v1',
};
const cursorMultiAxis: RunnerConfig = {
  kind: 'cli',
  tool: 'cursor',
  model: 'claude-opus-5-thinking-xhigh-fast',
};
const openCodeMax: RunnerConfig = {
  kind: 'cli',
  tool: 'opencode',
  model: 'openai/gpt-5.6-luna',
  variant: 'max',
};

describe('formatSeatIdentity', () => {
  it('names the tool and the model, separated once', () => {
    const identity = formatSeatIdentity({ seat: planner });

    expect(identity).toContain('Claude Code CLI');
    expect(identity).toContain(' · ');
    expect(identity).toContain('Claude Sonnet 4');
    expect(identity).not.toContain('›');
  });

  it('says the automatic word instead of resolving a catalog default', () => {
    expect(formatSeatIdentity({ seat: { kind: 'cli', tool: 'claude-code' } })).toContain('auto');
    expect(formatSeatIdentity({ seat: { kind: 'cli', tool: 'cursor', model: 'auto' } })).toBe(
      'Cursor Agent CLI · auto',
    );
    expect(
      formatSeatIdentity({
        seat: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          model: 'auto',
          apiBase: 'https://api.example.test/v1',
        },
      }),
    ).toContain('auto');
  });

  it('renders a hostile model id as measurable, control-free text', () => {
    const identity = formatSeatIdentity({
      seat: {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        model: '\u001b[31mvendor/\u001b]0;pwned\u0007model\u001b[0m',
        apiBase: 'http://127.0.0.1:11434/v1',
      },
    });

    expect(identity).not.toContain('\u001b');
    expect(identity).not.toContain('\u0007');
    expect(identity).not.toContain('pwned');
    expect(getTerminalCellWidth(identity)).toBe(identity.length);
  });

  it('prefers displayName when provided over formatModelName fallback', () => {
    expect(formatSeatIdentity({ seat: planner, displayName: 'Claude Sonnet 5' })).toBe(
      'Claude Code CLI · Claude Sonnet 5',
    );
    expect(formatSeatIdentity({ seat: planner })).toBe('Claude Code CLI · Claude Sonnet 4');
  });

  it('sanitizes displayName before measuring and formatting', () => {
    const identity = formatSeatIdentity({
      seat: planner,
      displayName: '\u001b[31mClaude\u001b]0;pwned\u0007 Sonnet 5\u001b[0m',
    });
    expect(identity).toBe('Claude Code CLI · Claude Sonnet 5');
    expect(identity).not.toContain('\u001b');
    expect(identity).not.toContain('pwned');
  });

  it('states the effort a flag seat carries and nothing when it carries none', () => {
    const effort = 'high';

    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'claude-code', model: 'claude-opus-5', effort },
      }),
    ).toBe(`Claude Code CLI · Claude Opus 5 · ${effort}`);
    expect(
      formatSeatIdentity({ seat: { kind: 'cli', tool: 'claude-code', model: 'claude-opus-5' } }),
    ).toBe('Claude Code CLI · Claude Opus 5');
  });

  it("states an opencode seat's variant as the config spells it", () => {
    expect(formatSeatIdentity({ seat: openCodeMax })).toBe(
      `OpenCode CLI · GPT-5.6 Luna · ${openCodeMax.variant}`,
    );
  });

  it('spells each axis of a cursor id exactly once, in effort, thinking, fast order', () => {
    expect(formatSeatIdentity({ seat: cursorMultiAxis })).toBe(
      'Cursor Agent CLI · Claude Opus 5 · xhigh · thinking · fast',
    );
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-opus-5-thinking-high' },
        displayName: 'Claude Opus 5 1M Thinking',
      }),
    ).toBe('Cursor Agent CLI · Claude Opus 5 · high · thinking');
    expect(
      formatSeatIdentity({ seat: { kind: 'cli', tool: 'cursor', model: 'gpt-5.5-none' } }),
    ).toBe('Cursor Agent CLI · GPT-5.5 · none');
  });

  it("keeps the catalog's own words when a cursor id spells no axis to peel", () => {
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-4.5-sonnet' },
        displayName: 'Claude Sonnet 4.5',
      }),
    ).toBe('Cursor Agent CLI · Claude Sonnet 4.5');
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'gpt-5.3-codex' },
        displayName: 'Codex 5.3',
      }),
    ).toBe('Cursor Agent CLI · Codex 5.3');
  });

  it('spells a cursor family by its catalog name with the axis words peeled, never by the id', () => {
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'gpt-5.3-codex-high' },
        displayName: 'Codex 5.3 High',
      }),
    ).toBe('Cursor Agent CLI · Codex 5.3 · high');
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-4.5-sonnet-thinking' },
        displayName: 'Claude Sonnet 4.5 Thinking',
      }),
    ).toBe('Cursor Agent CLI · Claude Sonnet 4.5 · thinking');
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-4-sonnet-thinking' },
        displayName: 'Claude Sonnet 4 Thinking',
      }),
    ).toBe('Cursor Agent CLI · Claude Sonnet 4 · thinking');
  });

  it('never carries a parenthesised vendor flag or a context word into the identity', () => {
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-fable-5-thinking-high' },
        displayName: 'Claude Fable 5 1M Thinking (NO ZDR)',
      }),
    ).toBe('Cursor Agent CLI · Claude Fable 5 · high · thinking');
  });

  it('falls back to the peeled id when the catalog name is nothing but axis words', () => {
    expect(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'acme-1-high' },
        displayName: 'High',
      }),
    ).toBe('Cursor Agent CLI · Acme 1 · high');
  });

  it('reads one string for the word and the peel, so a padded id still states its axes', () => {
    expect(
      formatSeatIdentity({
        seat: {
          kind: 'cli',
          tool: 'cursor',
          model: 'claude-opus-5-thinking-xhigh-fast ',
        },
      }),
    ).toBe('Cursor Agent CLI · Claude Opus 5 · xhigh · thinking · fast');
  });

  it('names an id made only of axis words instead of splitting it into name and axis', () => {
    expect(formatSeatIdentity({ seat: { kind: 'cli', tool: 'cursor', model: 'extra-high' } })).toBe(
      'Cursor Agent CLI · Extra High',
    );
    expect(
      formatSeatIdentity({ seat: { kind: 'cli', tool: 'cursor', model: 'thinking-fast' } }),
    ).toBe('Cursor Agent CLI · Thinking Fast');
  });

  it('adds nothing on a channel that carries no effort, whatever the config holds', () => {
    // SeatIds now names a kind too, so the effort literal no longer narrows against the union.
    expect(formatSeatIdentity({ seat: { ...build, effort: 'high' as const } })).toBe(
      'Ollama · Qwen2.5 Coder 7B',
    );
  });

  it('renders a hostile variant as measurable, control-free text', () => {
    const identity = formatSeatIdentity({
      seat: {
        kind: 'cli',
        tool: 'opencode',
        model: 'openai/gpt-5.6-luna',
        variant: '\u001b[31mhigh\u001b]0;pwned\u0007',
      },
    });

    expect(identity).not.toContain('\u001b');
    expect(identity).not.toContain('\u0007');
    expect(identity).not.toContain('pwned');
    expect(getTerminalCellWidth(identity)).toBe(identity.length);
  });

  it('names a claude-code alias by its resolved name, and by its known row label when none resolved', () => {
    const seat: RunnerConfig = { kind: 'cli', tool: 'claude-code', model: 'fable' };

    expect(formatSeatIdentity({ seat: seat, displayName: 'Fable 5.1' })).toBe(
      'Claude Code CLI · Fable 5.1',
    );
    expect(formatSeatIdentity({ seat: seat })).toBe('Claude Code CLI · Fable 5.1');
  });
});

describe('formatShortSeatIdentity', () => {
  it('drops the brand and keeps every remaining word', () => {
    expect(formatShortSeatIdentity({ seat: planner })).toBe('Sonnet 4');
    expect(formatShortSeatIdentity({ seat: build })).toBe('Qwen2.5 Coder 7B');
    expect(formatShortSeatIdentity({ seat: { kind: 'cli', tool: 'claude-code' } })).toBe('auto');
  });

  it('carries no axis word, in the suffix or inside the model word', () => {
    expect(formatShortSeatIdentity({ seat: cursorMultiAxis })).toBe('Opus 5');
    expect(formatShortSeatIdentity({ seat: openCodeMax })).toBe('GPT-5.6 Luna');
  });

  it('peels the catalog name of a cursor seat the same way the full form does', () => {
    expect(
      formatShortSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'gpt-5.3-codex-high' },
        displayName: 'Codex 5.3 High',
      }),
    ).toBe('Codex 5.3');
  });

  it('still names a model whose only word is the brand', () => {
    expect(
      formatShortSeatIdentity({ seat: { kind: 'cli', tool: 'claude-code', model: 'claude' } }),
    ).toBe('Claude');
  });
});

describe('a seat named by the ids a run recorded', () => {
  it('reads exactly as the configured seat the ids were taken from', () => {
    const opusMax: RunnerConfig = {
      kind: 'cli',
      tool: 'claude-code',
      model: 'opus',
      effort: 'max',
    };
    for (const runner of [planner, build, cursorMultiAxis, openCodeMax, opusMax]) {
      const ids = seatIdsOf(runner);
      expect(formatSeatIdentity({ seat: ids })).toBe(formatSeatIdentity({ seat: runner }));
      expect(formatSeatIdentity({ seat: ids, displayName: 'Label 1' })).toBe(
        formatSeatIdentity({ seat: runner, displayName: 'Label 1' }),
      );
      expect(formatShortSeatIdentity({ seat: ids })).toBe(
        formatShortSeatIdentity({ seat: runner }),
      );
    }
    expect(formatSeatIdentity({ seat: seatIdsOf(opusMax), displayName: 'Opus 5.5' })).toBe(
      'Claude Code CLI · Opus 5.5 · max',
    );
  });

  it('shortens a label the way the rail does: the brand dropped, a cursor axis peeled', () => {
    expect(
      formatShortSeatIdentity({
        seat: { tool: 'ollama', model: 'claude-sonnet-5' },
        displayName: 'Claude Sonnet 5',
      }),
    ).toBe('Sonnet 5');
    expect(
      formatShortSeatIdentity({
        seat: { tool: 'cursor', model: 'gpt-5.3-codex-high' },
        displayName: 'Codex 5.3 High',
      }),
    ).toBe('Codex 5.3');
    expect(formatShortSeatIdentity({ seat: { tool: 'cursor', model: 'gpt-5.3-codex-high' } })).toBe(
      'GPT-5.3 Codex',
    );
    expect(formatShortSeatIdentity({ seat: { tool: 'codex' } })).toBe('auto');
  });
});

describe('formatCollapsedSeatLine', () => {
  it('states all three seats on one line, with the inheritance mark', () => {
    expect(formatCollapsedSeatLine({ planner, build, reviewer: undefined })).toBe(
      `PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B · REVIEW ${PLANNER_INHERITANCE.mark}`,
    );
  });

  it('names a reviewer that has its own setup', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    expect(formatCollapsedSeatLine({ planner, build, reviewer })).toContain('REVIEW GPT-5 Codex');
  });

  it('uses displayNames when provided', () => {
    expect(
      formatCollapsedSeatLine({
        planner,
        build,
        reviewer: undefined,
        displayNames: { planner: 'Claude Sonnet 5', build: 'Qwen 2.5 7B' },
      }),
    ).toBe(`PLAN Sonnet 5 · BUILD Qwen 2.5 7B · REVIEW ${PLANNER_INHERITANCE.mark}`);
  });

  it('states every seat when the budget holds them', () => {
    const line = formatCollapsedSeatLine({ planner, build, reviewer: undefined, budget: 80 });

    expect(line).toBe(formatCollapsedSeatLine({ planner, build, reviewer: undefined }));
  });

  it('binds a seat note to its own seat', () => {
    const line = formatCollapsedSeatLine({
      planner,
      build,
      reviewer: undefined,
      notes: { build: 'resets 17:00' },
    });

    expect(line).toContain('BUILD Qwen2.5 Coder 7B (resets 17:00)');
    expect(line).toContain('PLAN Sonnet 4');
  });

  it('spends another seat name before the noted seat when the note crowds the line', () => {
    const notes = { build: 'resets 17:00' };
    const line = formatCollapsedSeatLine({
      planner,
      build,
      reviewer: undefined,
      notes,
      budget: 60,
    });

    expect(line).toBe('PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B (resets 17:00)');
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(60);
    expect(line).not.toContain(ELLIPSIS);
  });

  it('keeps the noted seat named and drops the seats the note crowds out', () => {
    const line = formatCollapsedSeatLine({
      planner,
      build,
      reviewer: undefined,
      notes: { build: 'resets 17:00' },
      budget: 45,
    });

    expect(line).toBe('BUILD Qwen2.5 Coder 7B (resets 17:00)');
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(45);
  });

  it('gives up one whole seat rather than cutting a model name in half', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };
    const budget = getTerminalCellWidth(formatCollapsedSeatLine({ planner, build, reviewer })) - 4;
    const line = formatCollapsedSeatLine({ planner, build, reviewer, budget });

    expect(line).toBe('PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B');
    expect(line).not.toContain(ELLIPSIS);
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(budget);
  });

  it('names the same seats at every width one identity can pay for', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };
    const paid = 'PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B';
    const lines: string[] = [];

    for (
      let budget = getTerminalCellWidth(formatCollapsedSeatLine({ planner, build, reviewer })) - 1;
      budget >= getTerminalCellWidth(paid);
      budget -= 1
    ) {
      lines.push(formatCollapsedSeatLine({ planner, build, reviewer, budget }));
    }

    expect([...new Set(lines)]).toEqual([paid]);
  });

  it('spends the one long identity and keeps the seats beside it named', () => {
    const longPlanner: RunnerConfig = {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      model: 'qwen3-coder-plus-instruct-preview',
      apiBase: 'http://127.0.0.1:11434/v1',
    };
    const line = formatCollapsedSeatLine({
      planner: longPlanner,
      build: planner,
      reviewer: undefined,
      budget: 54,
    });

    expect(line).toBe(
      `PLAN Qwen3 Coder Plus Instruct Preview · REVIEW ${PLANNER_INHERITANCE.mark}`,
    );
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(54);
  });

  it('keeps the seats it can name and states nothing about the rest', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    expect(formatCollapsedSeatLine({ planner, build, reviewer, budget: 34 })).toBe(
      'PLAN Sonnet 4 · REVIEW GPT-5 Codex',
    );
    expect(formatCollapsedSeatLine({ planner, build, reviewer, budget: 27 })).toBe('PLAN Sonnet 4');
    expect(formatCollapsedSeatLine({ planner, build, reviewer: undefined, budget: 28 })).toBe(
      'PLAN Sonnet 4',
    );
  });

  it('states no line wider than the budget it was given', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    for (const budget of [20, 12, 4]) {
      const line = formatCollapsedSeatLine({ planner, build, reviewer, budget });

      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(budget);
    }
  });
});

describe('cutSeatIdentity with a formatted seat', () => {
  it('cuts the full identity to the budget instead of shortening it', () => {
    const fitted = cutSeatIdentity(formatSeatIdentity({ seat: planner }), 10);

    expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(10);
    expect(fitted.startsWith('Claude Co')).toBe(true);
  });

  it('leaves an identity that already fits alone', () => {
    expect(cutSeatIdentity(formatSeatIdentity({ seat: planner }), 80)).toBe(
      formatSeatIdentity({ seat: planner }),
    );
  });

  it('cuts the suffixed identity, keeping the tool name and losing the axis tail', () => {
    const full = formatSeatIdentity({ seat: cursorMultiAxis });
    const fitted = cutSeatIdentity(full, full.length - 8);

    expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(full.length - 8);
    expect(full.startsWith(fitted.replace(/\u2026$/, ''))).toBe(true);
  });

  it('uses the seat displayName', () => {
    expect(
      cutSeatIdentity(formatSeatIdentity({ seat: planner, displayName: 'Claude Sonnet 5' }), 80),
    ).toBe('Claude Code CLI · Claude Sonnet 5');
  });
});

describe('cutSeatIdentity', () => {
  it('takes the trailing space with the cut when the leading segment is the one cut', () => {
    const label = 'Automatic (tool decides)';
    for (let budget = 4; budget < getTerminalCellWidth(label); budget++) {
      const cut = cutSeatIdentity(label, budget);
      expect(cut.endsWith('…')).toBe(true);
      expect(cut).not.toMatch(/[ ·]…$/);
    }
  });

  it('sheds the whole model segment rather than cutting inside its id', () => {
    expect(cutSeatIdentity('Claude Code CLI · Claude Sonnet 4', 32)).toBe('Claude Code CLI');
  });

  it('sheds the mirrored identity from an inherited review row instead of cutting its id', () => {
    const row = `${PLANNER_INHERITANCE.mark} · Claude Code CLI · Claude Sonnet 4`;
    expect(cutSeatIdentity(row, 41)).toBe(`${PLANNER_INHERITANCE.mark} · Claude Code CLI`);
    expect(cutSeatIdentity(row, 20)).toBe(PLANNER_INHERITANCE.mark);
  });

  it('returns an identity that already fits unchanged', () => {
    expect(cutSeatIdentity('Claude Code CLI · Claude Sonnet 4', 100)).toBe(
      'Claude Code CLI · Claude Sonnet 4',
    );
  });

  it('sheds the whole axis segment instead of cutting inside its word', () => {
    const seat: RunnerConfig = {
      kind: 'cli',
      tool: 'claude-code',
      model: 'claude-sonnet-4',
      effort: 'high',
    };
    const identity = formatSeatIdentity({ seat: seat });

    expect(identity).toBe('Claude Code CLI · Claude Sonnet 4 · high');
    for (let budget = 33; budget < getTerminalCellWidth(identity); budget++) {
      const fitted = cutSeatIdentity(identity, budget);

      expect(fitted).toBe('Claude Code CLI · Claude Sonnet 4');
    }
    // Below the model's own budget the model segment goes too: every segment is an atom.
    expect(cutSeatIdentity(identity, 32)).toBe('Claude Code CLI');
  });

  it('never leaves a trailing separator before the ellipsis at any budget', () => {
    const identity = formatSeatIdentity({ seat: planner });
    for (let budget = 4; budget <= identity.length; budget++) {
      expect(cutSeatIdentity(identity, budget)).not.toMatch(/[ ·]…$/);
    }
  });
});

describe('kind-aware seat identity', () => {
  const apiTwin = (provider: string, model?: string): RunnerConfig => ({
    kind: 'api',
    provider,
    service: provider,
    offering: 'payg',
    ...(model !== undefined && { model }),
    apiBase: 'https://my-endpoint.example/v1',
    apiKey: 'sk-inline',
  });

  it('keeps a custom API provider word literal and spells its model pretty when it reuses a CLI tool id', () => {
    expect(formatSeatIdentity({ seat: apiTwin('opencode', 'gpt-5') })).toBe('opencode · GPT-5');
    expect(formatSeatIdentity({ seat: apiTwin('claude-code', 'sonnet') })).toBe(
      'claude-code · Sonnet',
    );
  });

  it('keeps a catalogued API provider under its display name', () => {
    expect(formatSeatIdentity({ seat: build })).toBe('Ollama · Qwen2.5 Coder 7B');
  });

  it('keeps a CLI seat under its catalog display name', () => {
    expect(formatSeatIdentity({ seat: openCodeMax })).toBe(
      `OpenCode CLI · GPT-5.6 Luna · ${openCodeMax.variant}`,
    );
  });

  it('never reads an API seat model through the CLI tool vocabulary it is named after', () => {
    // `cursor` is a CLI tool id whose model-id channel peels axis words; an API
    // seat that reuses the name spells its model id pretty, never through the cursor peel.
    expect(formatSeatIdentity({ seat: apiTwin('cursor', 'gpt-5.3-codex-high') })).toBe(
      'cursor · GPT-5.3 Codex High',
    );
    expect(formatShortSeatIdentity({ seat: apiTwin('cursor', 'gpt-5.3-codex-high') })).toBe(
      'GPT-5.3 Codex High',
    );
  });

  it('spells a recorded identity with the kind the caller recovered for it', () => {
    const recorded = { tool: 'opencode', model: 'gpt-5' };
    expect(formatSeatIdentity({ seat: recorded })).toBe('OpenCode CLI · GPT-5');
    expect(formatSeatIdentity({ seat: recorded, displayName: undefined, kind: 'api' })).toBe(
      'opencode · GPT-5',
    );
    expect(formatShortSeatIdentity({ seat: recorded, displayName: undefined, kind: 'api' })).toBe(
      'GPT-5',
    );
  });

  it('reads a recorded seat by the kind the record kept for it', () => {
    const recorded = seatIdsOf(apiTwin('opencode', 'gpt-5'));

    expect(recorded.kind).toBe('api');
    expect(formatSeatIdentity({ seat: recorded })).toBe('opencode · GPT-5');
    expect(formatShortSeatIdentity({ seat: recorded })).toBe('GPT-5');
  });

  it('keeps a kind-qualified recorded API provider word literal, with no axis words', () => {
    // The exported union accepts this exact shape: a record that kept its kind but not
    // its axes. It must not be read as a live runner block, which has no tool word.
    const recorded = { tool: 'opencode', model: 'gpt-5', kind: 'api' as const };

    expect(formatSeatIdentity({ seat: recorded })).toBe('opencode · GPT-5');
    expect(formatShortSeatIdentity({ seat: recorded })).toBe('GPT-5');
  });

  it('keeps the tool word literal for a recorded CLI identity whose tool left the catalog', () => {
    // The exported union accepts any tool word: a record may outlive its CLI tool's
    // catalog entry. It must format as a record, not crash the live catalog lookup.
    const recorded = { tool: 'retired-tool', model: 'gpt-5', kind: 'cli' as const };

    expect(formatSeatIdentity({ seat: recorded })).toBe('retired-tool · GPT-5');
    expect(formatShortSeatIdentity({ seat: recorded })).toBe('GPT-5');
  });

  it('keeps the recorded axis words when a recorded CLI seat carries its kind', () => {
    const recorded = seatIdsOf({ kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' });

    expect(formatSeatIdentity({ seat: recorded })).toBe('Claude Code CLI · Opus 5.5 · max');
    expect(formatShortSeatIdentity({ seat: recorded })).toBe('Opus 5.5');
  });

  it('carries the API kind into the collapsed crew line', () => {
    const line = formatCollapsedSeatLine({
      planner: apiTwin('cursor', 'gpt-5.3-codex-high'),
      build: apiTwin('my-endpoint', 'gpt-5'),
      reviewer: undefined,
    });
    expect(line).toContain('GPT-5.3 Codex High');
    expect(line).not.toContain('Cursor Agent CLI');
  });
});

describe('wrapSeatIdentity', () => {
  it('returns an identity that fits as one row', () => {
    expect(wrapSeatIdentity('Ollama · Qwen2.5 Coder 7B', 36)).toEqual([
      'Ollama · Qwen2.5 Coder 7B',
    ]);
  });

  it('puts the tool on the first row and the model with its axes on the second', () => {
    expect(wrapSeatIdentity('OpenAI Codex CLI · GPT-6-Astra · xhigh', 36)).toEqual([
      'OpenAI Codex CLI',
      'GPT-6-Astra · xhigh',
    ]);
    expect(wrapSeatIdentity('Google Antigravity CLI · Gemini 3.8 Flash (High)', 36)).toEqual([
      'Google Antigravity CLI',
      'Gemini 3.8 Flash (High)',
    ]);
  });

  it('cuts each row by the segment rule when a row still overruns', () => {
    const rows = wrapSeatIdentity('OpenAI Codex CLI · GPT-6-Astra · xhigh', 12);

    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe('GPT-6-Astra');
    for (const row of rows) expect(getTerminalCellWidth(row)).toBeLessThanOrEqual(12);
  });
});

describe('formatCollapsedSeatLine with a halted seat', () => {
  const input = { planner, build, reviewer: undefined, budget: 34 };

  it('spends another seat before the halted one', () => {
    expect(formatCollapsedSeatLine(input)).toBe('PLAN Sonnet 4 · REVIEW = PLAN');
    const halted = formatCollapsedSeatLine({ ...input, haltedSeat: 'build' });

    expect(halted).toBe('BUILD Qwen2.5 Coder 7B');
    expect(getTerminalCellWidth(halted)).toBeLessThanOrEqual(34);
    expect(halted).not.toContain(ELLIPSIS);
  });

  it('keeps the halted seat when its reset note no longer fits', () => {
    expect(
      formatCollapsedSeatLine({ ...input, haltedSeat: 'build', notes: { build: 'resets 17:00' } }),
    ).toBe('BUILD Qwen2.5 Coder 7B');
  });

  it('falls back to the plain rule when the halted name itself cannot fit', () => {
    expect(formatCollapsedSeatLine({ ...input, budget: 19, haltedSeat: 'build' })).toBe(
      'PLAN Sonnet 4',
    );
  });

  it('falls back to the plain rule when the protected line would name nobody', () => {
    // An inherited review seat is a mark that points at the planner; keeping it alone names no one.
    expect(formatCollapsedSeatLine({ ...input, budget: 20, haltedSeat: 'review' })).toBe(
      'PLAN Sonnet 4',
    );
  });

  it('protects the halted seat through the identities entry point', () => {
    expect(
      formatCollapsedSeatLineFromIdentities({
        plan: 'Sonnet 4',
        build: 'Qwen2.5 Coder 7B',
        review: null,
        budget: 34,
        haltedSeat: 'build',
      }),
    ).toBe('BUILD Qwen2.5 Coder 7B');
  });
});
