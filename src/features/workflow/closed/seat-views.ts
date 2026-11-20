import {
  formatShortSeatIdentity,
  formatSeatIdentity,
  formatSeatToolWord,
} from '../../../core/crew/identity.js';
import {
  getProviderDisplayName,
  getRunnerIdentityDisplayName,
} from '../../../core/providers/catalog.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { RunnerKind } from '../../../core/schemas/enums.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { BriefExecution } from '../../../core/schemas/brief-execution.js';
import { resolveModelDisplayName } from '../../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { uniqueSorted } from '../../../utils/collections.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';
import type { SeatView } from './view-model.js';

/** A seat the run recorded, spelled by the same formatters the live crew surfaces use. */
function seatView(input: {
  tool: string | undefined;
  model: string | undefined;
  axes?: readonly string[] | undefined;
  role: ActiveRunnerRole;
  kind: RunnerKind | undefined;
}): SeatView {
  const { tool, model, axes, role, kind } = input;
  if (tool === undefined) return { kind: 'unset' };
  const seat = {
    tool,
    ...(model !== undefined && { model }),
    ...(axes !== undefined && { axes }),
  };
  const displayName =
    model === undefined
      ? undefined
      : resolveModelDisplayName({ providerId: tool, model, role, cache: modelCacheStore, kind });
  return {
    kind: 'named',
    short: formatShortSeatIdentity({ seat, displayName, kind }),
    full: formatSeatIdentity({ seat, displayName, kind }),
    tool: formatSeatToolWord({ seat, kind }),
  };
}

export function plannerSeatView(summary: Summary): SeatView {
  const tool = summary.plannerTool;
  return seatView({
    tool,
    model: summary.plannerModel,
    axes: summary.plannerAxes,
    role: 'planner',
    kind: summary.plannerKind,
  });
}

/**
 * The build seat of record, unless the briefs ran elsewhere too: briefs routed to more than one
 * profile name the profiles, and one seat that changed tools mid-run says where it went.
 */
export function buildSeatView(summary: Summary): SeatView {
  const breakdown = summary.taskBreakdown ?? [];
  const profiles = uniqueSorted(
    breakdown
      .map((task) => task.implementerProfile)
      .filter((profile): profile is string => profile !== undefined),
  );
  if (profiles.length > 1) {
    return {
      kind: 'mixed',
      profiles: profiles.map((profile) => sanitizeTerminalDisplayText(profile)),
    };
  }
  const implementerTool = summary.implementerTool;
  return (
    movedBuildSeat(breakdown, summary) ??
    seatView({
      tool: implementerTool,
      model: summary.implementerModel,
      axes: summary.implementerAxes,
      role: 'implementer',
      kind: summary.implementerKind,
    })
  );
}

/**
 * The seats the briefs ran on, in the order the plan first used each, when there was more than
 * one. Two seats a short form cannot tell apart (one model on two tools) are named with their
 * tool; a short form that already is the tool word stays as it is.
 */
function movedBuildSeat(
  breakdown: readonly BriefExecution[],
  primary: Pick<Summary, 'implementerTool' | 'implementerKind'>,
): SeatView | null {
  const seats = new Map<
    string,
    { tool: string; kind: RunnerKind | undefined; short: string; briefs: number }
  >();
  const keys: string[] = [];
  for (const task of breakdown) {
    if (task.tool === undefined) continue;
    const kind =
      task.kind ?? (task.tool === primary.implementerTool ? primary.implementerKind : undefined);
    const named = seatView({ tool: task.tool, model: task.model, role: 'implementer', kind });
    if (named.kind !== 'named') continue;
    const key = `${task.tool}\u0000${named.short}`;
    const seat = seats.get(key) ?? { tool: task.tool, kind, short: named.short, briefs: 0 };
    seats.set(key, { ...seat, briefs: seat.briefs + 1 });
    keys.push(key);
  }
  if (seats.size < 2) return null;
  const shorts = [...seats.values()].map((seat) => seat.short);
  const ambiguous = new Set(shorts).size < shorts.length;
  return {
    kind: 'moved',
    seats: [...seats.values()].map((seat) => {
      const tool = sanitizeTerminalDisplayText(runnerWord(seat.tool, seat.kind));
      return {
        short: ambiguous && seat.short !== tool ? `${tool} ${seat.short}` : seat.short,
        briefs: seat.briefs,
      };
    }),
    contiguous: eachRunsOneStretch(keys),
  };
}

/** A recorded tool name in its own kind's words; without a kind the merged catalog answers. */
function runnerWord(tool: string, kind: RunnerKind | undefined): string {
  return kind === undefined
    ? getProviderDisplayName(tool)
    : getRunnerIdentityDisplayName(kind, tool);
}

/** Whether every seat ran one unbroken stretch of the plan, so the plan order is the move order. */
function eachRunsOneStretch(keys: readonly string[]): boolean {
  const left = new Set<string>();
  let current: string | undefined;
  for (const key of keys) {
    if (key === current) continue;
    if (left.has(key)) return false;
    if (current !== undefined) left.add(current);
    current = key;
  }
  return true;
}

export function reviewSeatView(summary: Summary): SeatView {
  if (summary.reviewerSeat === 'none') return { kind: 'none' };
  if (summary.reviewerTool !== undefined) {
    return seatView({
      tool: summary.reviewerTool,
      model: summary.reviewerModel,
      axes: summary.reviewerAxes,
      role: 'reviewer',
      kind: summary.reviewerKind,
    });
  }
  return summary.plannerTool === undefined ? { kind: 'unset' } : { kind: 'inherits' };
}
