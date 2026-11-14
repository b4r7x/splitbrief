import { describe, expect, it } from 'vitest';
import { build, planner } from '#testing/helpers/crew-identity.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { ELLIPSIS } from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import { configuredReviewerRunner } from '../../config/accessors/reviewer-runner.js';
import type { RunnerConfig } from '../../config/accessors/runner-config.js';
import { resolveTheme } from '../../theme/resolve.js';
import { PLANNER_INHERITANCE, REVIEW_NONE } from '../identity.js';
import { CREW_SEAT_ROLES } from '../seats.js';
import {
  formatCollapsedSeatSpans,
  formatCollapsedSeatSpansFromIdentities,
  type SeatLineSpan,
  seatLineText,
} from './collapse.js';

describe('seatLineText', () => {
  it('projects fitted seat spans without changing their copy or separator ownership', () => {
    const spans = formatCollapsedSeatSpansFromIdentities({
      plan: 'GPT-6-Astra · xhigh',
      build: 'Gemini 3.8 Flash (High)',
      review: null,
      budget: 200,
    });
    expect(spans).toEqual([
      { text: 'PLAN GPT-6-Astra · xhigh', seat: 'plan' },
      { text: ' · ' },
      { text: 'BUILD Gemini 3.8 Flash (High)', seat: 'build' },
      { text: ' · ' },
      { text: 'REVIEW = PLAN', seat: 'review' },
    ]);
    expect(seatLineText(spans)).toBe(
      'PLAN GPT-6-Astra · xhigh · BUILD Gemini 3.8 Flash (High) · REVIEW = PLAN',
    );
  });
});

describe('formatCollapsedSeatSpans', () => {
  it('states all three seats on one line, with the inheritance mark', () => {
    expect(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer: undefined }))).toBe(
      `PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B · REVIEW ${PLANNER_INHERITANCE.mark}`,
    );
  });

  it('names every seat by its tool when the models do not fit', () => {
    const config = makeConfig();
    const line = seatLineText(
      formatCollapsedSeatSpans({
        planner: config.planner,
        build: resolveImplementerProfiles(config).defaultProfile.config,
        reviewer: configuredReviewerRunner(config),
        budget: 47,
      }),
    );

    expect(line).toBe(`PLAN claude · BUILD ollama · REVIEW ${PLANNER_INHERITANCE.mark}`);
  });

  it('names a reviewer that has its own setup', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    expect(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer }))).toContain(
      'REVIEW GPT-5 Codex',
    );
  });

  it('uses displayNames when provided', () => {
    expect(
      seatLineText(
        formatCollapsedSeatSpans({
          planner,
          build,
          reviewer: undefined,
          displayNames: { planner: 'Claude Sonnet 5', build: 'Qwen 2.5 7B' },
        }),
      ),
    ).toBe(`PLAN Sonnet 5 · BUILD Qwen 2.5 7B · REVIEW ${PLANNER_INHERITANCE.mark}`);
  });

  it('states every seat when the budget holds them', () => {
    const line = seatLineText(
      formatCollapsedSeatSpans({ planner, build, reviewer: undefined, budget: 80 }),
    );

    expect(line).toBe(
      seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer: undefined })),
    );
  });

  it('binds a seat note to its own seat', () => {
    const line = seatLineText(
      formatCollapsedSeatSpans({
        planner,
        build,
        reviewer: undefined,
        notes: { build: 'resets 17:00' },
      }),
    );

    expect(line).toContain('BUILD Qwen2.5 Coder 7B (resets 17:00)');
    expect(line).toContain('PLAN Sonnet 4');
  });

  it('spends another seat name before the noted seat when the note crowds the line', () => {
    const notes = { build: 'resets 17:00' };
    // One cell under the complete tool line with the note, the note still has to crowd the
    // named line.
    const budget =
      getTerminalCellWidth(
        seatLineText(
          formatCollapsedSeatSpans({ planner, build, reviewer: undefined, notes, line: 'tool' }),
        ),
      ) - 1;
    const line = seatLineText(
      formatCollapsedSeatSpans({ planner, build, reviewer: undefined, notes, budget }),
    );

    expect(line).toBe('PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B (resets 17:00)');
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(budget);
    expect(line).not.toContain(ELLIPSIS);
  });

  it('keeps the noted seat named and drops the seats the note crowds out', () => {
    const line = seatLineText(
      formatCollapsedSeatSpans({
        planner,
        build,
        reviewer: undefined,
        notes: { build: 'resets 17:00' },
        budget: 45,
      }),
    );

    expect(line).toBe('BUILD Qwen2.5 Coder 7B (resets 17:00)');
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(45);
  });

  it('gives up one whole seat rather than cutting a model name in half', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };
    // The complete tool line answers every wider budget; one cell under it the named line
    // keeps two seats whole.
    const budget =
      getTerminalCellWidth(
        seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer, line: 'tool' })),
      ) - 1;
    const line = seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer, budget }));

    expect(line).toBe('PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B');
    expect(line).not.toContain(ELLIPSIS);
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(budget);
  });

  it('names the same seats at every width one identity can pay for', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };
    const paid = 'PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B';
    const toolPaid = 'PLAN claude · BUILD ollama · REVIEW codex';
    const lines: string[] = [];

    for (
      let budget =
        getTerminalCellWidth(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer }))) -
        1;
      budget >= getTerminalCellWidth(paid);
      budget -= 1
    ) {
      lines.push(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer, budget })));
    }

    // Every width names all three seats: by tool while that line fits, then by the two model
    // names it can pay for. No width states half a name.
    expect([...new Set(lines)]).toEqual([toolPaid, paid]);
  });

  it('names every seat by its tool when one model name is long', () => {
    const longPlanner: RunnerConfig = {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      model: 'qwen3-coder-plus-instruct-preview',
      apiBase: 'http://127.0.0.1:11434/v1',
    };
    const line = seatLineText(
      formatCollapsedSeatSpans({
        planner: longPlanner,
        build: planner,
        reviewer: undefined,
        budget: 54,
      }),
    );

    expect(line).toBe(`PLAN ollama · BUILD claude · REVIEW ${PLANNER_INHERITANCE.mark}`);
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(54);
  });

  it('keeps the seats it can name and states nothing about the rest', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    expect(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer, budget: 34 }))).toBe(
      'PLAN Sonnet 4 · REVIEW GPT-5 Codex',
    );
    expect(seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer, budget: 27 }))).toBe(
      'PLAN Sonnet 4',
    );
    expect(
      seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer: undefined, budget: 28 })),
    ).toBe('PLAN Sonnet 4');
  });

  it('states no line wider than the budget it was given', () => {
    const reviewer: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

    for (const budget of [20, 12, 4]) {
      const line = seatLineText(formatCollapsedSeatSpans({ planner, build, reviewer, budget }));

      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(budget);
    }
  });
});

describe('formatCollapsedSeatSpansFromIdentities', () => {
  const identities = { plan: 'Sonnet 4', build: 'Qwen2.5 Coder 7B', review: 'GPT-5 Codex' };
  const planSpan: SeatLineSpan = { text: 'PLAN Sonnet 4', seat: 'plan' };
  const buildSpan: SeatLineSpan = { text: 'BUILD Qwen2.5 Coder 7B', seat: 'build' };
  const reviewSpan: SeatLineSpan = { text: 'REVIEW GPT-5 Codex', seat: 'review' };
  const separator: SeatLineSpan = { text: ' · ' };

  it.each([
    {
      name: 'all three named seats',
      input: identities,
      expected: [planSpan, separator, buildSpan, separator, reviewSpan],
    },
    {
      name: 'an inherited reviewer',
      input: { ...identities, review: null },
      expected: [
        planSpan,
        separator,
        buildSpan,
        separator,
        { text: `REVIEW ${PLANNER_INHERITANCE.mark}`, seat: 'review' },
      ],
    },
    {
      name: 'a review seat set to None',
      input: { ...identities, review: REVIEW_NONE },
      expected: [
        planSpan,
        separator,
        buildSpan,
        separator,
        { text: 'REVIEW None', seat: 'review' },
      ],
    },
    {
      name: 'a note on build',
      input: { ...identities, notes: { build: 'resets 17:00' } },
      expected: [
        planSpan,
        separator,
        { text: 'BUILD Qwen2.5 Coder 7B (resets 17:00)', seat: 'build' },
        separator,
        reviewSpan,
      ],
    },
    {
      name: 'an elided reviewer without a dangling separator',
      input: {
        ...identities,
        budget: getTerminalCellWidth('PLAN Sonnet 4 · BUILD Qwen2.5 Coder 7B'),
      },
      expected: [planSpan, separator, buildSpan],
    },
    {
      name: 'a budget that names nobody',
      input: { ...identities, budget: 4 },
      expected: [],
    },
  ])('preserves seat tags and string bytes for $name', ({ input, expected }) => {
    const spans = formatCollapsedSeatSpansFromIdentities(input);

    expect(spans).toEqual(expected);
    expect(spans.map((span) => span.text).join('')).toBe(
      seatLineText(formatCollapsedSeatSpansFromIdentities(input)),
    );
  });

  it.each(['dark', 'light'] as const)(
    'routes each seat and separator through its theme token in %s',
    (variant) => {
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      const spans = formatCollapsedSeatSpansFromIdentities({ ...identities, review: null });

      expect(
        spans.map((span) =>
          span.seat === undefined ? theme.textDim : theme[CREW_SEAT_ROLES[span.seat]],
        ),
      ).toEqual([theme.planner, theme.textDim, theme.implementer, theme.textDim, theme.reviewer]);
    },
  );
});

describe('formatCollapsedSeatSpans', () => {
  it('shares identity resolution and halted-seat fitting with the string entry point', () => {
    const input = {
      planner,
      build,
      reviewer: undefined,
      displayNames: { plan: 'Claude Sonnet 5', build: 'Qwen 2.5 7B' },
      notes: { build: 'resets 17:00' },
    };

    for (const budget of [80, 45, 34, 19, 4]) {
      const fittedInput = { ...input, budget, haltedSeat: 'build' as const };
      const spans = formatCollapsedSeatSpans(fittedInput);

      expect(spans).toEqual(
        formatCollapsedSeatSpansFromIdentities({
          plan: 'Sonnet 5',
          build: 'Qwen 2.5 7B',
          review: null,
          budget,
          haltedSeat: 'build',
          notes: input.notes,
        }),
      );
      expect(spans.map((span) => span.text).join('')).toBe(
        seatLineText(formatCollapsedSeatSpans(fittedInput)),
      );
    }
  });
});

describe('formatCollapsedSeatSpans with a halted seat', () => {
  const input = { planner, build, reviewer: undefined, budget: 34 };

  it('spends another seat before the halted one', () => {
    expect(seatLineText(formatCollapsedSeatSpans(input))).toBe('PLAN Sonnet 4 · REVIEW = PLAN');
    const halted = seatLineText(formatCollapsedSeatSpans({ ...input, haltedSeat: 'build' }));

    expect(halted).toBe('BUILD Qwen2.5 Coder 7B');
    expect(getTerminalCellWidth(halted)).toBeLessThanOrEqual(34);
    expect(halted).not.toContain(ELLIPSIS);
  });

  it('keeps the halted seat when its reset note no longer fits', () => {
    expect(
      seatLineText(
        formatCollapsedSeatSpans({
          ...input,
          haltedSeat: 'build',
          notes: { build: 'resets 17:00' },
        }),
      ),
    ).toBe('BUILD Qwen2.5 Coder 7B');
  });

  it('falls back to the plain rule when the halted name itself cannot fit', () => {
    expect(
      seatLineText(formatCollapsedSeatSpans({ ...input, budget: 19, haltedSeat: 'build' })),
    ).toBe('PLAN Sonnet 4');
  });

  it('falls back to the plain rule when the protected line would name nobody', () => {
    // An inherited review seat is a mark that points at the planner; keeping it alone names no one.
    expect(
      seatLineText(formatCollapsedSeatSpans({ ...input, budget: 20, haltedSeat: 'review' })),
    ).toBe('PLAN Sonnet 4');
  });

  it('protects the halted seat through the identities entry point', () => {
    expect(
      seatLineText(
        formatCollapsedSeatSpansFromIdentities({
          plan: 'Sonnet 4',
          build: 'Qwen2.5 Coder 7B',
          review: null,
          budget: 34,
          haltedSeat: 'build',
        }),
      ),
    ).toBe('BUILD Qwen2.5 Coder 7B');
  });
});
