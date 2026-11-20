import { planPresetRows } from '../preset-row.js';
import type { ListLine } from '../../../components/list-row/plan.js';
import type { CrewLabVerdict } from '../../../core/crew/labs.js';
import type { CrewPreset } from '../../../core/crew/presets.js';
import type { CrewRow } from '../../../core/crew/rows.js';
import { assertNever } from '../../../utils/type-guards.js';
import { type SeatBlockLayout, planSeatBlock } from '../format.js';

export const PRESET_SECTION = 'Ready-made crews';
const CREW_SECTION = 'Crew';
export const CONTINUE_SECTION = '';

export type SetupItem =
  | Readonly<{ kind: 'preset'; preset: CrewPreset; key: string }>
  | Readonly<{ kind: 'crew'; row: CrewRow; key: string }>
  | Readonly<{ kind: 'continue'; key: string }>;

/**
 * The panel yields in one order until it fits: the cross-lab verdict first (inside
 * `planSeatBlock`), then the section headers, then the blank rows between blocks and under the
 * sign-in step, then the ready-made crews.
 */
const LADDER = [
  { headers: true, gaps: true, presets: true },
  { headers: false, gaps: true, presets: true },
  { headers: false, gaps: false, presets: true },
  { headers: false, gaps: false, presets: true, compact: true },
  { headers: false, gaps: false, presets: false },
] as const;

type SetupListPlan = Readonly<{
  layout: SeatBlockLayout;
  showPresets: boolean;
  showHeaders: boolean;
  showGaps: boolean;
}>;

type SetupListInput = Readonly<{
  crewRows: readonly CrewRow[];
  verdict: CrewLabVerdict | undefined;
  presets: readonly CrewPreset[];
  signIn: boolean;
  innerWidth: number;
  budget: number;
}>;

function planStage(
  input: SetupListInput,
  stage: (typeof LADDER)[number],
  lines: readonly ListLine[],
): Readonly<{ plan: SetupListPlan; rows: number }> {
  const presetRows = stage.presets ? lines.length : 0;
  const blocks = presetRows > 0 ? 2 : 1;
  const gaps = blocks + (input.signIn ? 1 : 0);
  const around = presetRows + (stage.headers ? blocks : 0) + (stage.gaps ? gaps : 0) + 1;
  const layout = planSeatBlock({
    rows: input.crewRows,
    verdict: input.verdict,
    innerWidth: input.innerWidth,
    rowBudget: input.budget - around,
  });
  return {
    plan: {
      layout,
      showPresets: presetRows > 0,
      showHeaders: stage.headers,
      showGaps: stage.gaps,
    },
    rows: layout.rows + around,
  };
}

export function planSetupList(input: SetupListInput) {
  let presetLines = planPresetRows(input.presets, input.innerWidth);
  let staged = planStage(input, LADDER[0], presetLines);
  for (const stage of LADDER.slice(1)) {
    if (staged.rows <= input.budget) return { ...staged.plan, presetLines };
    if ('compact' in stage) presetLines = planPresetRows(input.presets, input.innerWidth, true);
    staged = planStage(input, stage, presetLines);
  }
  return { ...staged.plan, presetLines };
}

export function sectionOf(item: SetupItem): string {
  switch (item.kind) {
    case 'preset':
      return PRESET_SECTION;
    case 'crew':
      return CREW_SECTION;
    case 'continue':
      return CONTINUE_SECTION;
    default:
      return assertNever(item);
  }
}

export function crewKeysHint(item: SetupItem | undefined): string {
  if (item === undefined) return '⏎ change seat';
  switch (item.kind) {
    case 'preset':
      return item.preset.notReady.length > 0 ? 'this crew needs ready tools' : '⏎ use this crew';
    case 'crew':
      return '⏎ change seat';
    case 'continue':
      return '⏎ continue';
    default:
      return assertNever(item);
  }
}
