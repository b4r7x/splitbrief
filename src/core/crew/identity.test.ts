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
    expect(identity).toContain('Claude Sonnet 4');
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
    expect(formatSeatIdentity(planner)).toBe('Claude Code CLI · Claude Sonnet 4');
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
    ).toBe(`Claude Code CLI · Claude Opus 5 · ${effort}`);
    expect(formatSeatIdentity({ kind: 'cli', tool: 'claude-code', model: 'claude-opus-5' })).toBe(
      'Claude Code CLI · Claude Opus 5',
    );
  });

  it("states an opencode seat's variant as the config spells it", () => {
    expect(formatSeatIdentity(openCodeMax)).toBe(
      `OpenCode CLI · GPT-5.6 Luna · ${openCodeMax.variant}`,
    );
  });

  it('spells each axis of a cursor id exactly once, in effort, thinking, fast order', () => {
    expect(formatSeatIdentity(cursorMultiAxis)).toBe(
      'Cursor Agent CLI · Claude Opus 5 · xhigh · thinking · fast',
    );
    expect(
      formatSeatIdentity(
        { kind: 'cli', tool: 'cursor', model: 'claude-opus-5-thinking-high' },
        'Claude Opus 5 1M Thinking',
      ),
    ).toBe('Cursor Agent CLI · Claude Opus 5 · high · thinking');
    expect(formatSeatIdentity({ kind: 'cli', tool: 'cursor', model: 'gpt-5.5-none' })).toBe(
      'Cursor Agent CLI · GPT-5.5 · none',
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
      'Cursor Agent CLI · Acme 1 · high',
    );
  });

  it('reads one string for the word and the peel, so a padded id still states its axes', () => {
    expect(
      formatSeatIdentity({
        kind: 'cli',
        tool: 'cursor',
        model: 'claude-opus-5-thinking-xhigh-fast ',
      }),
    ).toBe('Cursor Agent CLI · Claude Opus 5 · xhigh · thinking · fast');
  });

  it('names an id made only of axis words instead of splitting it into name and axis', () => {
    expect(formatSeatIdentity({ kind: 'cli', tool: 'cursor', model: 'extra-high' })).toBe(
      'Cursor Agent CLI · Extra High',
    );
    expect(formatSeatIdentity({ kind: 'cli', tool: 'cursor', model: 'thinking-fast' })).toBe(
      'Cursor Agent CLI · Thinking Fast',
    );
  });

  it('adds nothing on a channel that carries no effort, whatever the config holds', () => {
    expect(formatSeatIdentity({ ...build, effort: 'high' })).toBe('Ollama · Qwen 2.5 Coder 7B');
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
});

describe('formatShortSeatIdentity', () => {
  it('drops the brand and keeps every remaining word', () => {
    expect(formatShortSeatIdentity(planner)).toBe('Sonnet 4');
    expect(formatShortSeatIdentity(build)).toBe('Qwen 2.5 Coder 7B');
    expect(formatShortSeatIdentity({ kind: 'cli', tool: 'claude-code' })).toBe('auto');
  });

  it('carries no axis word, in the suffix or inside the model word', () => {
    expect(formatShortSeatIdentity(cursorMultiAxis)).toBe('Opus 5');
    expect(formatShortSeatIdentity(openCodeMax)).toBe('GPT-5.6 Luna');
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
      'Claude',
    );
  });
});

describe('formatCollapsedSeatLine', () => {
  it('states all three seats on one line, with the inheritance mark', () => {
    expect(formatCollapsedSeatLine({ planner, build, reviewer: undefined })).toBe(
      `PLAN Sonnet 4 · BUILD Qwen 2.5 Coder 7B · REVIEW ${PLANNER_INHERITANCE.mark}`,
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

  it('gives up one whole identity rather than cutting a model name in half', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };
    const budget = getTerminalCellWidth(formatCollapsedSeatLine({ planner, build, reviewer })) - 4;
    const line = formatCollapsedSeatLine({ planner, build, reviewer, budget });

    expect(line).toBe(`PLAN Sonnet 4 · BUILD Qwen 2.5 Coder 7B · REVIEW ${ELLIPSIS}`);
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(budget);
  });

  it('names the same seats at every width one identity can pay for', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };
    const paid = `PLAN Sonnet 4 · BUILD Qwen 2.5 Coder 7B · REVIEW ${ELLIPSIS}`;
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

    expect(line).toBe(`PLAN ${ELLIPSIS} · BUILD Sonnet 4 · REVIEW ${PLANNER_INHERITANCE.mark}`);
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(56);
  });

  it('draws no line at all when the budget leaves no name standing', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    expect(formatCollapsedSeatLine({ planner, build, reviewer, budget: 34 })).toContain('Sonnet 4');
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
  it('takes the trailing separator run with the cut when it ends in ellipsis', () => {
    const cut = cutSeatIdentity('Claude Code CLI · Claude Sonnet 4 · high', 36);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/[ ·]…$/);
  });

  it('returns an identity that already fits unchanged', () => {
    expect(cutSeatIdentity('Claude Code CLI · Claude Sonnet 4', 100)).toBe(
      'Claude Code CLI · Claude Sonnet 4',
    );
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
