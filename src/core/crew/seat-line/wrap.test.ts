import { describe, expect, it } from 'vitest';
import { cursorMultiAxis, planner } from '#testing/helpers/crew-identity.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import type { RunnerConfig } from '../../config/accessors/runner-config.js';
import { formatSeatIdentity, PLANNER_INHERITANCE } from '../identity.js';
import { cutSeatIdentity, wrapSeatIdentity } from './wrap.js';

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
