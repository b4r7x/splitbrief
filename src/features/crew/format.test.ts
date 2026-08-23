import { describe, expect, it } from 'vitest';
import type { CrewEscalateEntry, CrewSeat } from '../../core/crew/seats.js';
import type { RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import {
  CREW_COLUMN_GAP,
  formatCrewEscalateRow,
  formatCrewSeatRow,
  type CrewRow,
} from './format.js';

/** Mirrors how seat-rows.tsx lays the row out, so the assertion covers what is displayed. */
function renderedWidth(row: CrewRow): number {
  const index = row.index === undefined ? '' : `${row.index}${CREW_COLUMN_GAP}`;
  const posture = row.posture === undefined ? '' : `${CREW_COLUMN_GAP}${row.posture}`;
  return `${index}${row.label}${CREW_COLUMN_GAP}${row.identity}${posture}`.length;
}

const WIDTHS = [120, 80, 60];

const LONG_DISPLAY_NAME = 'Some Extremely Long Runner Display Name From The Catalog';
const LONG_MODEL = 'vendor/some-extremely-long-model-identifier-2026-preview';
const REVIEWER_NAME = 'Codex CLI';
const REVIEWER_MODEL = 'gpt-5-codex';

function planSeat(
  input: Readonly<{ model?: string | undefined; posture?: RunnerBillingPosture | undefined }> = {},
): CrewSeat {
  return {
    id: 'plan',
    label: 'PLAN',
    runner: { kind: 'cli', tool: 'claude-code' },
    displayName: LONG_DISPLAY_NAME,
    model: input.model,
    posture: input.posture ?? 'subscription-included',
  };
}

function reviewSeat(source: 'configured' | 'planner'): CrewSeat {
  return {
    id: 'review',
    label: 'REVIEW',
    source,
    runner: { kind: 'cli', tool: 'claude-code' },
    displayName: REVIEWER_NAME,
    model: REVIEWER_MODEL,
    posture: 'subscription-included',
  };
}

const escalate: CrewEscalateEntry = {
  label: 'escalate',
  displayName: LONG_DISPLAY_NAME,
  model: LONG_MODEL,
  posture: 'api-metered',
};

const ESCAPE = '\u001b';
const BELL = '\u0007';
const HOSTILE_MODEL = '\u001b[31mvendor/\u001b]0;pwned\u0007model\u001b[0m';

describe('formatCrewSeatRow', () => {
  it.each(WIDTHS)('strips terminal control sequences from the identity at %i columns', (width) => {
    const row = formatCrewSeatRow({
      seat: { ...planSeat({ model: HOSTILE_MODEL }), displayName: 'Ollama' },
      position: 1,
      width,
    });

    expect(row.identity).not.toContain(ESCAPE);
    expect(row.identity).not.toContain(BELL);
    expect(row.identity).not.toContain('pwned');
    expect(renderedWidth(row)).toBeLessThanOrEqual(width);
  });

  it.each(WIDTHS)('keeps the composed seat row inside %i columns', (width) => {
    const row = formatCrewSeatRow({ seat: planSeat({ model: LONG_MODEL }), position: 1, width });

    expect(renderedWidth(row)).toBeLessThanOrEqual(width);
  });

  it('keeps the composed seat row inside a width narrower than its own prefix', () => {
    const row = formatCrewSeatRow({
      seat: planSeat({ model: LONG_MODEL }),
      position: 1,
      width: 10,
    });

    expect(renderedWidth(row)).toBeLessThanOrEqual(10);
  });

  it('drops the posture tag rather than truncating the model past recognition', () => {
    const narrow = formatCrewSeatRow({
      seat: planSeat({ model: LONG_MODEL }),
      position: 1,
      width: 48,
    });
    const wide = formatCrewSeatRow({
      seat: planSeat({ model: LONG_MODEL }),
      position: 1,
      width: 120,
    });

    expect(narrow.posture).toBeUndefined();
    expect(narrow.identity.length).toBeGreaterThan(28);
    expect(wide.posture).toBeDefined();
  });

  it('keeps the posture tag when a short identity leaves room for both', () => {
    const row = formatCrewSeatRow({
      seat: { ...planSeat(), displayName: 'Ollama' },
      position: 1,
      width: 48,
    });

    expect(row.posture).toBeDefined();
    expect(row.identity).toBe('Ollama');
  });

  it.each(WIDTHS)('omits an absent model instead of filling the gap at %i columns', (width) => {
    const row = formatCrewSeatRow({ seat: planSeat(), position: 1, width });

    expect(row.identity.length).toBeLessThanOrEqual(LONG_DISPLAY_NAME.length);
    expect(LONG_DISPLAY_NAME.startsWith(row.identity.slice(0, -1))).toBe(true);
    expect(renderedWidth(row)).toBeLessThanOrEqual(width);
  });

  it.each(WIDTHS)('omits the posture tag when billing is unresolved at %i columns', (width) => {
    const row = formatCrewSeatRow({
      seat: planSeat({ model: LONG_MODEL, posture: 'unknown' }),
      position: 2,
      width,
    });

    expect(row.posture).toBeUndefined();
    expect(renderedWidth(row)).toBeLessThanOrEqual(width);
  });

  it.each(WIDTHS)('points the review seat at the planner rather than naming a runner', (width) => {
    const row = formatCrewSeatRow({ seat: reviewSeat('planner'), position: 3, width });

    expect(row.identity).not.toContain(REVIEWER_NAME);
    expect(row.identity).not.toContain(REVIEWER_MODEL);
    expect(row.posture).toBeUndefined();
  });

  it('names the runner on a review seat that has its own', () => {
    const row = formatCrewSeatRow({ seat: reviewSeat('configured'), position: 3, width: 120 });

    expect(row.identity).toContain(REVIEWER_NAME);
    expect(row.identity).toContain(REVIEWER_MODEL);
  });
});

describe('formatCrewEscalateRow', () => {
  it.each(WIDTHS)('keeps the composed escalate row inside %i columns', (width) => {
    const row = formatCrewEscalateRow({ escalate, width });

    expect(renderedWidth(row)).toBeLessThanOrEqual(width);
    expect(row.index).toBeUndefined();
  });

  it.each(WIDTHS)('strips terminal control sequences from the identity at %i columns', (width) => {
    const row = formatCrewEscalateRow({
      escalate: { ...escalate, displayName: 'Ollama', model: HOSTILE_MODEL },
      width,
    });

    expect(row.identity).not.toContain(ESCAPE);
    expect(row.identity).not.toContain(BELL);
    expect(row.identity).not.toContain('pwned');
    expect(renderedWidth(row)).toBeLessThanOrEqual(width);
  });
});
