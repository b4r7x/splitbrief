import { describe, expect, it } from 'vitest';
import { ELLIPSIS, getTerminalCellWidth } from '../../utils/display-text.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import {
  cutSeatIdentity,
  fitSeatIdentity,
  formatCollapsedSeatLine,
  formatSeatIdentity,
  formatShortSeatIdentity,
  PLANNER_INHERITANCE,
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
    const identity = formatSeatIdentity(planner);

    expect(identity).toContain('Claude Code CLI');
    expect(identity).toContain(' · ');
    expect(identity).toContain('claude-sonnet-4');
    expect(identity).not.toContain('›');
  });

  it('says the automatic word instead of resolving a catalog default', () => {
    expect(formatSeatIdentity({ kind: 'cli', tool: 'claude-code' })).toContain('auto');
    expect(formatSeatIdentity({ kind: 'cli', tool: 'cursor', model: 'auto' })).toBe(
      'Cursor Agent CLI · auto',
    );
    expect(
      formatSeatIdentity({
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        model: 'auto',
        apiBase: 'https://api.example.test/v1',
      }),
    ).toContain('auto');
  });

  it('reads price routing with the same words the picker row that sets it uses', () => {
    expect(formatSeatIdentity({ kind: 'cli', tool: 'claude-code', model: 'auto:cheapest' })).toBe(
      'Claude Code CLI · Auto (cheapest capable)',
    );
    expect(
      formatShortSeatIdentity({ kind: 'cli', tool: 'claude-code', model: 'auto:cheapest' }),
    ).toBe('Auto (cheapest capable)');
  });

  it('renders a hostile model id as measurable, control-free text', () => {
    const identity = formatSeatIdentity({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      model: '\u001b[31mvendor/\u001b]0;pwned\u0007model\u001b[0m',
      apiBase: 'http://127.0.0.1:11434/v1',
    });

    expect(identity).not.toContain('\u001b');
    expect(identity).not.toContain('\u0007');
    expect(identity).not.toContain('pwned');
    expect(getTerminalCellWidth(identity)).toBe(identity.length);
  });

  it('prefers displayName when provided over formatModelName fallback', () => {
    expect(formatSeatIdentity(planner, 'Claude Sonnet 5')).toBe(
      'Claude Code CLI · Claude Sonnet 5',
    );
    expect(formatSeatIdentity(planner)).toBe('Claude Code CLI · claude-sonnet-4');
  });

  it('sanitizes displayName before measuring and formatting', () => {
    const identity = formatSeatIdentity(
      planner,
      '\u001b[31mClaude\u001b]0;pwned\u0007 Sonnet 5\u001b[0m',
    );
    expect(identity).toBe('Claude Code CLI · Claude Sonnet 5');
    expect(identity).not.toContain('\u001b');
    expect(identity).not.toContain('pwned');
  });

  it('states the effort a flag seat carries and nothing when it carries none', () => {
    const effort = 'high';

    expect(
      formatSeatIdentity({ kind: 'cli', tool: 'claude-code', model: 'claude-opus-5', effort }),
    ).toBe(`Claude Code CLI · claude-opus-5 · ${effort}`);
    expect(formatSeatIdentity({ kind: 'cli', tool: 'claude-code', model: 'claude-opus-5' })).toBe(
      'Claude Code CLI · claude-opus-5',
    );
  });

  it("states an opencode seat's variant as the config spells it", () => {
    expect(formatSeatIdentity(openCodeMax)).toBe(
      `OpenCode CLI · openai/gpt-5.6-luna · ${openCodeMax.variant}`,
    );
  });

  it('spells each axis of a cursor id exactly once, in effort, thinking, fast order', () => {
    expect(formatSeatIdentity(cursorMultiAxis)).toBe(
      'Cursor Agent CLI · claude-opus-5 · xhigh · thinking · fast',
    );
    expect(
      formatSeatIdentity(
        { kind: 'cli', tool: 'cursor', model: 'claude-opus-5-thinking-high' },
        'Claude Opus 5 1M Thinking',
      ),
    ).toBe('Cursor Agent CLI · Claude Opus 5 · high · thinking');
    expect(formatSeatIdentity({ kind: 'cli', tool: 'cursor', model: 'gpt-5.5-none' })).toBe(
      'Cursor Agent CLI · gpt-5.5 · none',
    );
  });

  it("keeps the catalog's own words when a cursor id spells no axis to peel", () => {
    expect(
      formatSeatIdentity(
        { kind: 'cli', tool: 'cursor', model: 'claude-4.5-sonnet' },
        'Claude Sonnet 4.5',
      ),
    ).toBe('Cursor Agent CLI · Claude Sonnet 4.5');
    expect(
      formatSeatIdentity({ kind: 'cli', tool: 'cursor', model: 'gpt-5.3-codex' }, 'Codex 5.3'),
    ).toBe('Cursor Agent CLI · Codex 5.3');
  });

  it('spells a cursor family by its catalog name with the axis words peeled, never by the id', () => {
    expect(
      formatSeatIdentity(
        { kind: 'cli', tool: 'cursor', model: 'gpt-5.3-codex-high' },
        'Codex 5.3 High',
      ),
    ).toBe('Cursor Agent CLI · Codex 5.3 · high');
    expect(
      formatSeatIdentity(
        { kind: 'cli', tool: 'cursor', model: 'claude-4.5-sonnet-thinking' },
        'Claude Sonnet 4.5 Thinking',
      ),
    ).toBe('Cursor Agent CLI · Claude Sonnet 4.5 · thinking');
    expect(
      formatSeatIdentity(
        { kind: 'cli', tool: 'cursor', model: 'claude-4-sonnet-thinking' },
        'Claude Sonnet 4 Thinking',
      ),
    ).toBe('Cursor Agent CLI · Claude Sonnet 4 · thinking');
  });

  it('never carries a parenthesised vendor flag or a context word into the identity', () => {
    expect(
      formatSeatIdentity(
        { kind: 'cli', tool: 'cursor', model: 'claude-fable-5-thinking-high' },
        'Claude Fable 5 1M Thinking (NO ZDR)',
      ),
    ).toBe('Cursor Agent CLI · Claude Fable 5 · high · thinking');
  });

  it('falls back to the peeled id when the catalog name is nothing but axis words', () => {
    expect(formatSeatIdentity({ kind: 'cli', tool: 'cursor', model: 'acme-1-high' }, 'High')).toBe(
      'Cursor Agent CLI · acme-1 · high',
    );
  });

  it('reads one string for the word and the peel, so a padded id still states its axes', () => {
    expect(
      formatSeatIdentity({
        kind: 'cli',
        tool: 'cursor',
        model: 'claude-opus-5-thinking-xhigh-fast ',
      }),
    ).toBe('Cursor Agent CLI · claude-opus-5 · xhigh · thinking · fast');
  });

  it('names an id made only of axis words instead of splitting it into name and axis', () => {
    expect(formatSeatIdentity({ kind: 'cli', tool: 'cursor', model: 'extra-high' })).toBe(
      'Cursor Agent CLI · extra-high',
    );
    expect(formatSeatIdentity({ kind: 'cli', tool: 'cursor', model: 'thinking-fast' })).toBe(
      'Cursor Agent CLI · thinking-fast',
    );
  });

  it('adds nothing on a channel that carries no effort, whatever the config holds', () => {
    expect(formatSeatIdentity({ ...build, effort: 'high' })).toBe('Ollama · qwen2.5-coder:7b');
  });

  it('renders a hostile variant as measurable, control-free text', () => {
    const identity = formatSeatIdentity({
      kind: 'cli',
      tool: 'opencode',
      model: 'openai/gpt-5.6-luna',
      variant: '\u001b[31mhigh\u001b]0;pwned\u0007',
    });

    expect(identity).not.toContain('\u001b');
    expect(identity).not.toContain('\u0007');
    expect(identity).not.toContain('pwned');
    expect(getTerminalCellWidth(identity)).toBe(identity.length);
  });

  it('names a claude-code alias by its resolved name, and by its id when none resolved', () => {
    const seat: RunnerConfig = { kind: 'cli', tool: 'claude-code', model: 'fable' };

    expect(formatSeatIdentity(seat, 'Fable 5.1')).toBe('Claude Code CLI · Fable 5.1');
    expect(formatSeatIdentity(seat)).toBe('Claude Code CLI · fable');
  });
});

describe('formatShortSeatIdentity', () => {
  it('drops the brand and keeps every remaining word', () => {
    expect(formatShortSeatIdentity(planner)).toBe('claude-sonnet-4');
    expect(formatShortSeatIdentity(build)).toBe('qwen2.5-coder:7b');
    expect(formatShortSeatIdentity({ kind: 'cli', tool: 'claude-code' })).toBe('auto');
  });

  it('carries no axis word, in the suffix or inside the model word', () => {
    expect(formatShortSeatIdentity(cursorMultiAxis)).toBe('claude-opus-5');
    expect(formatShortSeatIdentity(openCodeMax)).toBe('openai/gpt-5.6-luna');
  });

  it('peels the catalog name of a cursor seat the same way the full form does', () => {
    expect(
      formatShortSeatIdentity(
        { kind: 'cli', tool: 'cursor', model: 'gpt-5.3-codex-high' },
        'Codex 5.3 High',
      ),
    ).toBe('Codex 5.3');
  });

  it('still names a model whose only word is the brand', () => {
    expect(formatShortSeatIdentity({ kind: 'cli', tool: 'claude-code', model: 'claude' })).toBe(
      'claude',
    );
  });
});

describe('formatCollapsedSeatLine', () => {
  it('states all three seats on one line, with the inheritance mark', () => {
    expect(formatCollapsedSeatLine({ planner, build, reviewer: undefined })).toBe(
      `PLAN claude-sonnet-4 · BUILD qwen2.5-coder:7b · REVIEW ${PLANNER_INHERITANCE.mark}`,
    );
  });

  it('names a reviewer that has its own setup', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    expect(formatCollapsedSeatLine({ planner, build, reviewer })).toContain('REVIEW gpt-5-codex');
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

    expect(line).toContain('BUILD qwen2.5-coder:7b (resets 17:00)');
    expect(line).toContain('PLAN claude-sonnet-4');
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

    expect(line).toBe(
      `PLAN ${ELLIPSIS} · BUILD qwen2.5-coder:7b (resets 17:00) · REVIEW ${ELLIPSIS}`,
    );
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(60);
  });

  it('drops the note rather than leaving its seat unnamed', () => {
    const plain = formatCollapsedSeatLine({ planner, build, reviewer: undefined, budget: 45 });
    const line = formatCollapsedSeatLine({
      planner,
      build,
      reviewer: undefined,
      notes: { build: 'resets 17:00' },
      budget: 45,
    });

    expect(line).toBe(plain);
    expect(line).not.toContain('resets');
  });

  it('gives up one whole identity rather than cutting a model name in half', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };
    const budget = getTerminalCellWidth(formatCollapsedSeatLine({ planner, build, reviewer })) - 4;
    const line = formatCollapsedSeatLine({ planner, build, reviewer, budget });

    expect(line).toBe(`PLAN claude-sonnet-4 · BUILD qwen2.5-coder:7b · REVIEW ${ELLIPSIS}`);
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(budget);
  });

  it('names the same seats at every width one identity can pay for', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };
    const paid = `PLAN claude-sonnet-4 · BUILD qwen2.5-coder:7b · REVIEW ${ELLIPSIS}`;
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
      budget: 56,
    });

    expect(line).toBe(
      `PLAN ${ELLIPSIS} · BUILD claude-sonnet-4 · REVIEW ${PLANNER_INHERITANCE.mark}`,
    );
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(56);
  });

  it('draws no line at all when the budget leaves no name standing', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    expect(formatCollapsedSeatLine({ planner, build, reviewer, budget: 41 })).toContain(
      'claude-sonnet-4',
    );
    expect(formatCollapsedSeatLine({ planner, build, reviewer, budget: 27 })).toBe('');
    // The mark points at the planner's name, so it cannot stand in for one:
    // an anonymous planner takes `= planner` down with it.
    expect(formatCollapsedSeatLine({ planner, build, reviewer: undefined, budget: 32 })).toBe('');
  });

  it('states no line wider than the budget it was given', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    for (const budget of [20, 12, 4]) {
      const line = formatCollapsedSeatLine({ planner, build, reviewer, budget });

      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(budget);
    }
  });
});

describe('fitSeatIdentity', () => {
  it('cuts the full identity to the budget instead of shortening it', () => {
    const fitted = fitSeatIdentity({ runner: planner, budget: 10 });

    expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(10);
    expect(fitted.startsWith('Claude Co')).toBe(true);
  });

  it('leaves an identity that already fits alone', () => {
    expect(fitSeatIdentity({ runner: planner, budget: 80 })).toBe(formatSeatIdentity(planner));
  });

  it('cuts the suffixed identity, keeping the tool name and losing the axis tail', () => {
    const full = formatSeatIdentity(cursorMultiAxis);
    const fitted = fitSeatIdentity({ runner: cursorMultiAxis, budget: full.length - 8 });

    expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(full.length - 8);
    expect(full.startsWith(fitted.replace(/\u2026$/, ''))).toBe(true);
  });

  it('uses displayName in fitSeatIdentity', () => {
    expect(fitSeatIdentity({ runner: planner, budget: 80, displayName: 'Claude Sonnet 5' })).toBe(
      'Claude Code CLI · Claude Sonnet 5',
    );
  });
});

describe('cutSeatIdentity', () => {
  it('takes the trailing space with the cut when the leading segment is the one cut', () => {
    const policy = 'Auto (cheapest capable)';
    for (let budget = 4; budget < getTerminalCellWidth(policy); budget++) {
      const cut = cutSeatIdentity(policy, budget);
      expect(cut.endsWith('…')).toBe(true);
      expect(cut).not.toMatch(/[ ·]…$/);
    }
  });

  it('sheds the whole model segment rather than cutting inside its id', () => {
    expect(cutSeatIdentity('Claude Code CLI · claude-sonnet-4', 32)).toBe('Claude Code CLI');
  });

  it('sheds the mirrored identity from an inherited review row instead of cutting its id', () => {
    const row = `${PLANNER_INHERITANCE.mark} · Claude Code CLI · claude-sonnet-4`;
    expect(cutSeatIdentity(row, 44)).toBe(`${PLANNER_INHERITANCE.mark} · Claude Code CLI`);
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
    const identity = formatSeatIdentity(seat);

    expect(identity).toBe('Claude Code CLI · claude-sonnet-4 · high');
    for (let budget = 33; budget < getTerminalCellWidth(identity); budget++) {
      const fitted = fitSeatIdentity({ runner: seat, budget });

      expect(fitted).toBe('Claude Code CLI · claude-sonnet-4');
    }
    // Below the model's own budget the model segment goes too: every segment is an atom.
    expect(fitSeatIdentity({ runner: seat, budget: 32 })).toBe('Claude Code CLI');
  });

  it('matches fitSeatIdentity for every budget from 4 to identity length', () => {
    const identity = formatSeatIdentity(planner);
    for (let budget = 4; budget <= identity.length; budget++) {
      expect(fitSeatIdentity({ runner: planner, budget })).toBe(cutSeatIdentity(identity, budget));
    }
  });

  it('never leaves a trailing separator before the ellipsis at any budget', () => {
    const identity = formatSeatIdentity(planner);
    for (let budget = 4; budget <= identity.length; budget++) {
      expect(fitSeatIdentity({ runner: planner, budget })).not.toMatch(/[ ·]…$/);
    }
  });
});
